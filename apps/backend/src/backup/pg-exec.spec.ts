import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deleteOrder,
  dumpDatabase,
  restoreDatabase,
  UNSAFE_OPT_IN_ENV,
} from './pg-exec';
import { deriveRestorePassword } from './restore-role';
import { runStreamedRestore } from './restore-stream';

interface Call {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
}
const calls: Call[] = [];
let roleUnsafe = 'f';
let ledgerRows = '0';
const tables = 'Branch\nOrder\nUser\n_prisma_migrations\nverifactu_records\n';
const edges = 'Order|Branch\nverifactu_records|Branch\nOrder|User\n';
let toc = '';

jest.mock('./restore-stream', () => ({
  runStreamedRestore: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('node:child_process', () => ({
  ...jest.requireActual<object>('node:child_process'),
  execFile: (
    cmd: string,
    args: string[],
    opts: { env: Record<string, string | undefined> },
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push({ cmd, args, env: opts.env });
    const ok = (stdout = '') => cb(null, { stdout, stderr: '' });
    if (cmd === 'psql') {
      const sql = args[args.length - 1];
      if (sql.includes('AS unsafe')) return ok(`${roleUnsafe}\n`);
      if (sql.includes('pg_tables WHERE schemaname')) return ok(tables);
      if (sql.includes('pg_constraint')) return ok(edges);
      if (sql.includes('count(*)')) return ok(`${ledgerRows}\n`);
      return ok();
    }
    if (cmd === 'pg_restore' && args[0] === '-l') return ok(toc);
    ok();
  },
}));

const DATA = '3345; 0 16400 TABLE DATA public Order nventra';
const SEQ = '3347; 0 0 SEQUENCE SET public Order_id_seq nventra';
const GOOD_TOC = [
  ';',
  '5; 1255 16999 FUNCTION public s(cstring) nventra',
  '6; 2620 17000 TRIGGER public Order evil nventra',
  '9; 0 0 COMMENT - EXTENSION pgcrypto',
  DATA,
  SEQ,
  '3348; 0 16410 TABLE DATA public _prisma_migrations nventra',
].join('\n');

const streamed = runStreamedRestore as jest.Mock;
const sqlSent = () =>
  calls.filter((c) => c.cmd === 'psql').map((c) => c.args[c.args.length - 1]);

describe('pg-exec restore', () => {
  let work: string;
  let dump: string;
  beforeEach(async () => {
    calls.length = 0;
    streamed.mockClear();
    roleUnsafe = 'f';
    ledgerRows = '0';
    toc = GOOD_TOC;
    process.env.DATABASE_URL = 'postgresql://nventra:s3cr3tpw@db:5432/app';
    delete process.env.DATABASE_RESTORE_URL;
    delete process.env[UNSAFE_OPT_IN_ENV];
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-exec-spec-'));
    dump = path.join(work, 'db.dump');
  });
  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true });
  });

  it('never puts the connection URL or password on argv', async () => {
    await dumpDatabase(dump);
    await restoreDatabase(dump);
    for (const c of calls) {
      expect(c.args.join(' ')).not.toContain('s3cr3tpw');
      expect(c.args.join(' ')).not.toContain('postgresql://');
    }
    const o = streamed.mock.calls[0][0] as { url: string };
    expect(o.url).toContain(deriveRestorePassword('s3cr3tpw'));
  });

  it('checks the restore role as the limited role, not the app superuser', async () => {
    await restoreDatabase(dump);
    for (const c of calls) {
      expect(c.env.PGUSER).toBe('nventra_restore');
      expect(c.env.PGPASSWORD).toBe(deriveRestorePassword('s3cr3tpw'));
    }
  });

  it('checks effective privileges, not just the superuser flag', async () => {
    await restoreDatabase(dump);
    const check = sqlSent().find((s) => s.includes('AS unsafe'))!;
    for (const needle of [
      'rolsuper',
      'rolcreaterole',
      'rolcreatedb',
      'pg_execute_server_program',
      'pg_write_server_files',
      'pg_read_server_files',
      "has_schema_privilege(current_user,'public','CREATE')",
      'tableowner',
      "'TRIGGER'",
    ]) {
      expect(check).toContain(needle);
    }
  });

  it('refuses an over-privileged restore role by default', async () => {
    roleUnsafe = 't';
    await expect(restoreDatabase(dump)).rejects.toThrow(/Restore refused/);
    expect(streamed).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.cmd === 'pg_restore')).toHaveLength(0);
  });

  it('allows it only with the explicit opt-in', async () => {
    roleUnsafe = 't';
    process.env[UNSAFE_OPT_IN_ENV] = '1';
    await expect(restoreDatabase(dump)).resolves.toBeUndefined();
    expect(streamed).toHaveBeenCalled();
  });

  it('restores only vetted data entries through the streamed transaction', async () => {
    await restoreDatabase(dump);
    const o = streamed.mock.calls[0][0] as {
      listFile: string;
      prelude: string;
    };
    const list = await fs.readFile(o.listFile, 'utf8');
    expect(list).toContain(DATA);
    expect(list).toContain(SEQ);
    expect(list).not.toMatch(/FUNCTION|TRIGGER|COMMENT|_prisma_migrations/);
  });

  it('deletes (never truncates) children first and skips sync + migrations', async () => {
    await restoreDatabase(dump);
    const { prelude } = streamed.mock.calls[0][0] as { prelude: string };
    expect(prelude).toMatch(/^SET app\.sync_origin = '__skip';/);
    expect(prelude).not.toMatch(/TRUNCATE/i);
    expect(prelude).not.toContain('_prisma_migrations');
    const at = (t: string) => prelude.indexOf(`DELETE FROM "${t}";`);
    expect(at('Order')).toBeGreaterThan(-1);
    expect(at('Order')).toBeLessThan(at('Branch'));
    expect(at('Order')).toBeLessThan(at('User'));
    expect(at('verifactu_records')).toBeLessThan(at('Branch'));
    expect(sqlSent().some((s) => /TRUNCATE/i.test(s))).toBe(false);
  });

  it('refuses to touch a non-empty fiscal ledger', async () => {
    ledgerRows = '7';
    await expect(restoreDatabase(dump)).rejects.toThrow(
      /verifactu_records.*append-only.*never overwrite/s,
    );
    expect(streamed).not.toHaveBeenCalled();
  });

  it('rejects a dump with foreign data before anything destructive', async () => {
    toc = `${GOOD_TOC}\n3350; 0 16500 TABLE DATA public pg_authid x`;
    await expect(restoreDatabase(dump)).rejects.toThrow(/not an app table/);
    expect(streamed).not.toHaveBeenCalled();
  });
});

describe('deleteOrder', () => {
  it('puts child tables before their parents', () => {
    const order = deleteOrder(new Set(['a', 'b', 'c']), [
      ['b', 'a'],
      ['c', 'b'],
    ]);
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('ignores self references and survives cycles', () => {
    expect(deleteOrder(new Set(['a']), [['a', 'a']])).toEqual(['a']);
    expect(
      deleteOrder(new Set(['a', 'b']), [
        ['a', 'b'],
        ['b', 'a'],
      ]).sort(),
    ).toEqual(['a', 'b']);
  });
});
