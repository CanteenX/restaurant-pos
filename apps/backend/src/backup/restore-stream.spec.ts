import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RestoreVetError } from './pg-restore-vet';
import { runStreamedRestore, ScriptGuard } from './restore-stream';

const TABLES = new Set(['Order', 'User']);

const GOOD_SCRIPT = [
  '\\restrict xbC3RfKaLmIREaJnA1D49UVgGASEZh',
  '--',
  '-- Data for Name: Order; Type: TABLE DATA; Schema: public; Owner: nventra',
  '',
  'SET statement_timeout = 0;',
  "SET client_encoding = 'UTF8';",
  "SELECT pg_catalog.set_config('search_path', '', false);",
  'COPY public."Order" (id, total) FROM stdin;',
  '1\t100',
  '\\N\t\\\\x',
  '\\.',
  '',
  'COPY public."User" (id) FROM stdin;',
  '\\.',
  `SELECT pg_catalog.setval('public."Order_id_seq"', 2, true);`,
  '',
  '\\unrestrict xbC3RfKaLmIREaJnA1D49UVgGASEZh',
  '',
].join('\n');

function feed(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const guard = new ScriptGuard(TABLES, () => undefined);
    let out = '';
    guard.on('data', (d: Buffer | string) => (out += d.toString()));
    guard.on('end', () => resolve(out));
    guard.on('error', reject);
    guard.end(script);
  });
}

describe('ScriptGuard', () => {
  it('passes a normal pg_restore data script through unchanged', async () => {
    // Only the empty-search_path line is dropped (it would break app triggers).
    expect(await feed(GOOD_SCRIPT)).toBe(
      GOOD_SCRIPT.replace(
        "SELECT pg_catalog.set_config('search_path', '', false);\n",
        '',
      ),
    );
  });

  it.each([
    ['a psql shell escape', '\\! touch /tmp/pwn'],
    ['an ALTER ROLE', "ALTER ROLE CURRENT_USER PASSWORD 'x';"],
    [
      'a function',
      'CREATE FUNCTION f() RETURNS int AS $$ select 1 $$ LANGUAGE sql;',
    ],
    [
      'a trigger',
      'CREATE TRIGGER t BEFORE INSERT ON "Order" EXECUTE FUNCTION f();',
    ],
    ['COPY TO PROGRAM', "COPY (SELECT 1) TO PROGRAM 'sh';"],
    ['COPY into a foreign table', 'COPY public.pg_authid (a) FROM stdin;'],
    [
      'a stacked statement',
      'COPY public."Order" (id) FROM stdin; DROP TABLE x;',
    ],
    [
      'a setval on an unknown sequence',
      "SELECT pg_catalog.setval('pg_catalog.x', 1, true);",
    ],
    ['a psql meta command', '\\i /etc/passwd'],
    ['a restrict line with extras', '\\restrict abc; \\! id'],
  ])('rejects %s outside a COPY block', async (_n, line) => {
    await expect(feed(`${GOOD_SCRIPT}${line}\n`)).rejects.toBeInstanceOf(
      RestoreVetError,
    );
  });

  it('treats backslash lines inside COPY data as data', async () => {
    const s = 'COPY public."Order" (id) FROM stdin;\n\\! not a command\n\\.\n';
    expect(await feed(s)).toBe(s);
  });

  it('rejects a script that ends inside a COPY block', async () => {
    await expect(
      feed('COPY public."Order" (id) FROM stdin;\n1\n'),
    ).rejects.toBeInstanceOf(RestoreVetError);
  });
});

/** Minimal fake of a spawned child process. */
function fakeChild() {
  const c = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: jest.Mock;
    written: string;
  };
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  c.written = '';
  c.stdin.on('data', (d: Buffer) => (c.written += d.toString()));
  c.kill = jest.fn();
  return c;
}

const spawned: Record<string, ReturnType<typeof fakeChild>> = {};
jest.mock('node:child_process', () => ({
  ...jest.requireActual<object>('node:child_process'),
  spawn: (cmd: string) => {
    spawned[cmd] = fakeChild();
    return spawned[cmd];
  },
}));

describe('runStreamedRestore', () => {
  const opts = () => ({
    file: '/tmp/x/db.dump',
    listFile: '/tmp/x/db.dump.list',
    url: 'postgresql://u:pw@db:5432/app',
    prelude: 'SET app.sync_origin = \'__skip\';\nDELETE FROM "Order";\n',
    tables: TABLES,
  });

  it('streams prelude + vetted script into one psql transaction', async () => {
    const p = runStreamedRestore(opts());
    const { pg_restore: r, psql } = spawned;
    r.stdout.end(GOOD_SCRIPT);
    r.emit('close', 0);
    await new Promise((res) => setImmediate(res));
    psql.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
    expect(psql.written).toMatch(/^SET app\.sync_origin/);
    expect(psql.written).toContain('DELETE FROM "Order";');
    expect(psql.written).toContain(
      'COPY public."Order" (id, total) FROM stdin;',
    );
    expect(psql.written).not.toContain('search_path');
  });

  it('kills psql BEFORE it can commit when the script is hostile', async () => {
    const p = runStreamedRestore(opts());
    const { pg_restore: r, psql } = spawned;
    r.stdout.end('\\! touch /tmp/pwn\n');
    await expect(p).rejects.toBeInstanceOf(RestoreVetError);
    expect(psql.kill).toHaveBeenCalled();
    expect(psql.written).not.toContain('touch');
  });

  it('does not let psql commit when pg_restore fails midway', async () => {
    const p = runStreamedRestore(opts());
    const { pg_restore: r, psql } = spawned;
    r.stdout.end('COPY public."Order" (id) FROM stdin;\n1\n');
    r.stderr.end('pg_restore: error: could not read');
    r.emit('close', 1);
    await expect(p).rejects.toBeTruthy();
    expect(psql.kill).toHaveBeenCalled();
  });
});
