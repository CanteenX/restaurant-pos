import { assertSafeToc, dumpDatabase, restoreDatabase } from './pg-exec';

interface Call {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
}
const calls: Call[] = [];
let tocOutput = '';
let failWith: (Error & { stderr?: string }) | null = null;

jest.mock('node:child_process', () => ({
  ...jest.requireActual<object>('node:child_process'),
  execFile: (
    cmd: string,
    args: string[],
    opts: { env: Record<string, string | undefined> },
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push({ cmd, args, env: opts.env });
    if (failWith) return cb(failWith, { stdout: '', stderr: '' });
    cb(null, { stdout: args.includes('-l') ? tocOutput : '', stderr: '' });
  },
}));

const GOOD_TOC = [
  ';',
  '; Archive created at 2026-11-17',
  '215; 1259 16400 TABLE public Order nventra',
  '3345; 0 16400 TABLE DATA public Order nventra',
  '2; 3079 16385 EXTENSION - pgcrypto',
  '3; 3079 16386 EXTENSION - plpgsql',
  '4; 0 0 COMMENT - EXTENSION pgcrypto',
].join('\n');

describe('pg-exec', () => {
  beforeEach(() => {
    calls.length = 0;
    failWith = null;
    tocOutput = GOOD_TOC;
    process.env.DATABASE_URL = 'postgresql://nventra:s3cr3tpw@db:5432/app';
    delete process.env.DATABASE_RESTORE_URL;
  });

  it('never puts the connection URL or password on argv', async () => {
    await dumpDatabase('/tmp/x/db.dump');
    await restoreDatabase('/tmp/x/db.dump');
    for (const c of calls) {
      expect(c.args.join(' ')).not.toContain('s3cr3tpw');
      expect(c.args.join(' ')).not.toContain('postgresql://');
      expect(c.env.PGPASSWORD).toBe('s3cr3tpw');
    }
  });

  it('lists the TOC before restoring, with least-privilege flags', async () => {
    await restoreDatabase('/tmp/x/db.dump');
    expect(calls[0].args).toContain('-l');
    const restore = calls[1];
    expect(restore.args).toEqual(
      expect.arrayContaining([
        '--no-owner',
        '--no-privileges',
        '--single-transaction',
        '--exit-on-error',
        '--dbname',
        'app',
      ]),
    );
  });

  it('uses DATABASE_RESTORE_URL (a non-superuser role) when set', async () => {
    process.env.DATABASE_RESTORE_URL = 'postgresql://restorer:rpw@db:5432/app';
    await restoreDatabase('/tmp/x/db.dump');
    expect(calls[1].env.PGUSER).toBe('restorer');
    expect(calls[1].env.PGPASSWORD).toBe('rpw');
  });

  it.each([
    ['untrusted language', '5; 2612 16999 PROCEDURAL LANGUAGE - plperlu'],
    ['untrusted extension', '5; 3079 16999 EXTENSION - adminpack'],
    ['event trigger', '5; 3466 16999 EVENT TRIGGER - evt'],
    ['foreign server', '5; 1417 16999 SERVER - srv'],
    ['subscription', '5; 6104 16999 SUBSCRIPTION - sub'],
    ['role', '5; 1260 16999 ROLE - backdoor'],
  ])('refuses a dump containing a %s before restoring', async (_n, line) => {
    tocOutput = `${GOOD_TOC}\n${line}`;
    await expect(restoreDatabase('/tmp/x/db.dump')).rejects.toThrow(
      /not allowed/i,
    );
    expect(calls.some((c) => !c.args.includes('-l'))).toBe(false);
  });

  it('fails closed on an empty TOC', () => {
    expect(() => assertSafeToc('')).toThrow(/empty|unreadable/i);
  });

  it('redacts the password from failure messages', async () => {
    failWith = Object.assign(
      new Error('Command failed: pg_restore postgresql://nventra:s3cr3tpw@db'),
      { stderr: 'could not connect as nventra password=s3cr3tpw' },
    );
    const err = await restoreDatabase('/tmp/x/db.dump').catch((e: Error) => e);
    expect((err as Error).message).not.toContain('s3cr3tpw');
  });
});
