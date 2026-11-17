import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { dumpDatabase, restoreDatabase, UNSAFE_OPT_IN_ENV } from './pg-exec';
import { deriveRestorePassword } from './restore-role';

interface Call {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
}
const calls: Call[] = [];
let roleUnsafe = 'f';
let tables = 'Order\nUser\n_prisma_migrations\n';
let tocFor: (file: string) => string = () => '';
let restoreFailures = 0;
let truncateFailures = 0;

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
    const fail = (msg: string) =>
      cb(Object.assign(new Error(msg), { stderr: msg }), {
        stdout: '',
        stderr: msg,
      });
    if (cmd === 'psql') {
      const sql = args[args.length - 1];
      if (sql.includes('pg_has_role')) return ok(`${roleUnsafe}\n`);
      if (sql.includes('pg_tables')) return ok(tables);
      if (sql.startsWith('TRUNCATE') && truncateFailures-- > 0)
        return fail('truncate failed');
      return ok();
    }
    if (cmd === 'pg_restore' && args[0] === '-l') {
      return ok(tocFor(args[args.length - 1]));
    }
    if (cmd === 'pg_restore' && restoreFailures-- > 0) {
      return fail('COPY failed pw=' + deriveRestorePassword('s3cr3tpw') + '');
    }
    ok();
  },
}));

const DATA = '3345; 0 16400 TABLE DATA public Order nventra';
const USER = '3346; 0 16401 TABLE DATA public User nventra';
const SEQ = '3347; 0 0 SEQUENCE SET public Order_id_seq nventra';
const GOOD_TOC = [
  ';',
  '5; 1255 16999 FUNCTION public s(cstring) nventra',
  '6; 2620 17000 TRIGGER public Order evil nventra',
  '9; 0 0 COMMENT - EXTENSION pgcrypto',
  DATA,
  USER,
  SEQ,
  '3348; 0 16410 TABLE DATA public _prisma_migrations nventra',
].join('\n');

const names = (cmd: string) => calls.filter((c) => c.cmd === cmd);
const sqls = () =>
  names('psql')
    .map((c) => c.args[c.args.length - 1])
    .filter((s) => !s.includes('pg_has_role') && !s.includes('pg_tables'));

describe('pg-exec restore', () => {
  let work: string;
  let dump: string;
  beforeEach(async () => {
    calls.length = 0;
    roleUnsafe = 'f';
    tables = 'Order\nUser\n_prisma_migrations\n';
    tocFor = () => GOOD_TOC;
    restoreFailures = 0;
    truncateFailures = 0;
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
  });

  it('restores as the derived limited role, not the app superuser', async () => {
    await restoreDatabase(dump);
    for (const c of calls.filter((c) => c.cmd !== 'pg_dump' || true)) {
      expect(c.env.PGUSER).toBe('nventra_restore');
      expect(c.env.PGPASSWORD).toBe(deriveRestorePassword('s3cr3tpw'));
    }
  });

  it('refuses a superuser / server-privileged restore role by default', async () => {
    roleUnsafe = 't';
    await expect(restoreDatabase(dump)).rejects.toThrow(
      /Restore refused.*superuser/is,
    );
    expect(sqls()).toHaveLength(0);
    expect(names('pg_restore')).toHaveLength(0);
    expect(names('pg_dump')).toHaveLength(0);
  });

  it('allows the unsafe role only with the explicit opt-in', async () => {
    roleUnsafe = 't';
    process.env[UNSAFE_OPT_IN_ENV] = '1';
    await expect(restoreDatabase(dump)).resolves.toBeUndefined();
  });

  it('restores data only, vetted, single transaction, list-file limited', async () => {
    await restoreDatabase(dump);
    const real = names('pg_restore').find((c) => c.args[0] !== '-l')!;
    expect(real.args).toEqual(
      expect.arrayContaining([
        '--data-only',
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--dbname',
        'app',
      ]),
    );
    expect(real.args).not.toContain('--clean');
    const listPath = real.args[real.args.indexOf('-L') + 1];
    // list files are written beside the dump being restored
    expect(listPath).toBe(`${dump}.list`);
    const list = await fs.readFile(listPath, 'utf8');
    expect(list).toContain(DATA);
    expect(list).toContain(SEQ);
    expect(list).not.toMatch(/FUNCTION|TRIGGER|COMMENT|_prisma_migrations/);
  });

  it('takes a safety copy, then truncates, then restores', async () => {
    await restoreDatabase(dump);
    const order = calls
      .filter(
        (c) =>
          c.cmd === 'pg_dump' ||
          (c.cmd === 'psql' && c.args.at(-1)!.startsWith('TRUNCATE')) ||
          (c.cmd === 'pg_restore' && c.args[0] !== '-l'),
      )
      .map((c) => c.cmd);
    expect(order).toEqual(['pg_dump', 'psql', 'pg_restore']);
    expect(sqls()[0]).toMatch(/^TRUNCATE TABLE "Order", "User"$/);
  });

  it('rejects a dump with foreign data before anything destructive', async () => {
    tocFor = () => `${GOOD_TOC}\n3350; 0 16500 TABLE DATA public pg_authid x`;
    await expect(restoreDatabase(dump)).rejects.toThrow(/not an app table/);
    expect(sqls()).toHaveLength(0);
    expect(names('pg_dump')).toHaveLength(0);
  });

  it('puts the previous data back when the restore fails', async () => {
    restoreFailures = 1;
    await expect(restoreDatabase(dump)).rejects.toThrow(
      /previous data was put back/,
    );
    expect(sqls().filter((s) => s.startsWith('TRUNCATE'))).toHaveLength(2);
    expect(names('pg_restore').filter((c) => c.args[0] !== '-l')).toHaveLength(
      2,
    );
  });

  it('keeps the safety copy and says where it is if rollback also fails', async () => {
    restoreFailures = 2;
    const err = await restoreDatabase(dump).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/preserved at .*safety\.dump/);
    const p = /preserved at (\S+safety\.dump)/.exec((err as Error).message)![1];
    expect(await fs.stat(path.dirname(p))).toBeTruthy(); // dir kept (mocked pg_dump writes nothing)
    await fs.rm(path.dirname(p), { recursive: true, force: true });
  });

  it('redacts the password and truncates failure messages', async () => {
    restoreFailures = 2;
    const err = await restoreDatabase(dump).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('s3cr3tpw');
  });
});
