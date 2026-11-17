import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  describeExecError,
  knownDbSecrets,
  pgEnvFromUrl,
  redactSecrets,
} from './pg-env';

const execFileAsync = promisify(execFile);
const TOC_MAX_BUFFER = 64 * 1024 * 1024;

/** Extensions and languages a restore may create; anything else is refused. */
const ALLOWED_EXTENSIONS = new Set([
  'plpgsql',
  'pgcrypto',
  'uuid-ossp',
  'pg_trgm',
  'citext',
]);
/** TOC entry types a restore must never contain. */
const FORBIDDEN_TYPES = [
  'PROCEDURAL LANGUAGE',
  'EVENT TRIGGER',
  'FOREIGN DATA WRAPPER',
  'FOREIGN TABLE',
  'SERVER',
  'USER MAPPING',
  'PUBLICATION',
  'SUBSCRIPTION',
  'ROLE',
  'TRANSFORM',
  'ACCESS METHOD',
];
const TOC_LINE = /^\d+;\s+\d+\s+\d+\s+(.+)$/;

function connectionUrl(restore: boolean): string | undefined {
  return restore
    ? (process.env.DATABASE_RESTORE_URL ?? process.env.DATABASE_URL)
    : process.env.DATABASE_URL;
}

/** Runs a pg client binary with credentials in env (never argv) and a redacted error. */
async function runPg(
  cmd: 'pg_dump' | 'pg_restore',
  args: string[],
  url: string | undefined,
): Promise<string> {
  const env = { ...process.env, ...pgEnvFromUrl(url) };
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      env,
      maxBuffer: TOC_MAX_BUFFER,
    });
    return String(stdout);
  } catch (err) {
    throw new Error(
      redactSecrets(describeExecError(cmd, err), knownDbSecrets(url)),
    );
  }
}

/**
 * Refuses a dump whose table of contents holds objects that can run code or
 * widen privileges (roles, untrusted languages, event triggers, FDWs,
 * unlisted extensions). Fails closed on an empty listing.
 */
export function assertSafeToc(toc: string): void {
  const entries = toc
    .split('\n')
    .map((l) => TOC_LINE.exec(l.trim())?.[1])
    .filter((e): e is string => Boolean(e));
  if (entries.length === 0) {
    throw new Error('Backup database dump is empty or unreadable');
  }
  for (const entry of entries) {
    const forbidden = FORBIDDEN_TYPES.find(
      (t) => entry === t || entry.startsWith(`${t} `),
    );
    const ext = /^EXTENSION\s+\S+\s+(\S+)/.exec(entry)?.[1];
    if (forbidden || (ext && !ALLOWED_EXTENSIONS.has(ext))) {
      const what = forbidden ?? `EXTENSION ${ext}`;
      throw new Error(
        `Backup database dump rejected: object type ${what} is not allowed in a restore`,
      );
    }
  }
}

export async function dumpDatabase(file: string): Promise<void> {
  await runPg(
    'pg_dump',
    ['--format=custom', '--file', file],
    connectionUrl(false),
  );
}

/**
 * Restores `file` into the database. The TOC is vetted first, then the
 * restore runs in one transaction without ownership or ACLs. Set
 * DATABASE_RESTORE_URL to a non-superuser role to also remove the
 * code-execution ceiling of a superuser connection.
 */
export async function restoreDatabase(file: string): Promise<void> {
  const url = connectionUrl(true);
  const toc = await runPg('pg_restore', ['-l', file], url);
  assertSafeToc(toc);
  const dbName = pgEnvFromUrl(url).PGDATABASE;
  if (!dbName) throw new Error('Database name missing from connection URL');
  await runPg(
    'pg_restore',
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--single-transaction',
      '--exit-on-error',
      '--dbname',
      dbName,
      file,
    ],
    url,
  );
}
