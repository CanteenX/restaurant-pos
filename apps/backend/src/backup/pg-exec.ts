import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Logger } from '@nestjs/common';
import {
  describeExecError,
  knownDbSecrets,
  pgEnvFromUrl,
  redactSecrets,
} from './pg-env';
import { selectDataEntries } from './pg-restore-vet';
import { restoreConnectionUrl } from './restore-role';

const execFileAsync = promisify(execFile);
const logger = new Logger('PgRestore');
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_ERROR_CHARS = 500;
export const UNSAFE_OPT_IN_ENV = 'NVENTRA_ALLOW_UNSAFE_SUPERUSER_RESTORE';

/** True when the role could run code on the DB host or read/write its files. */
const UNSAFE_ROLE_SQL =
  "SELECT (r.rolsuper OR pg_has_role(current_user,'pg_execute_server_program','member') " +
  "OR pg_has_role(current_user,'pg_write_server_files','member') " +
  "OR pg_has_role(current_user,'pg_read_server_files','member')) AS unsafe " +
  'FROM pg_roles r WHERE r.rolname = current_user';
const APP_TABLES_SQL =
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1";

/** Runs a pg client binary with credentials in env (never argv) and a redacted error. */
async function runPg(
  cmd: 'pg_dump' | 'pg_restore' | 'psql',
  args: string[],
  url: string | undefined,
): Promise<string> {
  const env = { ...process.env, ...pgEnvFromUrl(url) };
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      env,
      maxBuffer: MAX_BUFFER,
    });
    return String(stdout);
  } catch (err) {
    const msg = redactSecrets(describeExecError(cmd, err), knownDbSecrets(url));
    throw new Error(
      msg.length > MAX_ERROR_CHARS
        ? `${msg.slice(0, MAX_ERROR_CHARS)}...`
        : msg,
    );
  }
}

const psql = (sql: string, url: string | undefined) =>
  runPg(
    'psql',
    ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    url,
  );

export async function dumpDatabase(file: string): Promise<void> {
  await runPg(
    'pg_dump',
    ['--format=custom', '--file', file],
    process.env.DATABASE_URL,
  );
}

async function assertRestoreRoleIsLimited(url: string | undefined) {
  const out = (await psql(UNSAFE_ROLE_SQL, url)).trim();
  if (out === 'f') return;
  if (process.env[UNSAFE_OPT_IN_ENV] === '1') {
    logger.warn(
      `${UNSAFE_OPT_IN_ENV}=1: restoring as a role with superuser or server file/program privileges. This is DANGEROUS.`,
    );
    return;
  }
  throw new Error(
    'Restore refused: the database role used for restores has superuser or ' +
      'server file/program privileges. Use the limited "nventra_restore" role ' +
      '(created automatically when the backend starts as a superuser) or set ' +
      `DATABASE_RESTORE_URL to a limited role. ${UNSAFE_OPT_IN_ENV}=1 overrides ` +
      'this and is dangerous.',
  );
}

async function listAppTables(url: string | undefined): Promise<Set<string>> {
  const out = await psql(APP_TABLES_SQL, url);
  return new Set(
    out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

const truncateSql = (tables: Set<string>) =>
  `TRUNCATE TABLE ${[...tables]
    .filter((t) => t !== '_prisma_migrations')
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(', ')}`;

/** Data-only, allow-listed, single-transaction restore of one dump file. */
async function restoreDataFrom(
  file: string,
  url: string | undefined,
  tables: Set<string>,
): Promise<void> {
  const toc = await runPg('pg_restore', ['-l', file], url);
  const entries = selectDataEntries(toc, tables);
  const listFile = `${file}.list`;
  await fs.writeFile(listFile, `${entries.join('\n')}\n`);
  const dbName = pgEnvFromUrl(url).PGDATABASE;
  if (!dbName) throw new Error('Database name missing from connection URL');
  await runPg(
    'pg_restore',
    [
      '--data-only',
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      '-L',
      listFile,
      '--dbname',
      dbName,
      file,
    ],
    url,
  );
}

/**
 * Restores the DATA of `file` into the live (already migrated) schema as the
 * limited restore role. Nothing structural from the dump is ever executed.
 * A data-only copy of the current database is taken first and put back if
 * the restore fails after the tables were emptied.
 */
export async function restoreDatabase(file: string): Promise<void> {
  const url = restoreConnectionUrl();
  await assertRestoreRoleIsLimited(url);
  const tables = await listAppTables(url);
  // Vets the dump BEFORE any destructive step.
  selectDataEntries(await runPg('pg_restore', ['-l', file], url), tables);

  const safetyDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nventra-pre-restore-'),
  );
  const safety = path.join(safetyDir, 'safety.dump');
  await runPg(
    'pg_dump',
    ['--format=custom', '--data-only', '--file', safety],
    url,
  );
  try {
    await psql(truncateSql(tables), url);
    await restoreDataFrom(file, url, tables);
  } catch (err) {
    try {
      await psql(truncateSql(tables), url);
      await restoreDataFrom(safety, url, tables);
    } catch {
      throw new Error(
        `${(err as Error).message}. The previous data could NOT be put back automatically; ` +
          `a data-only copy of it is preserved at ${safety}`,
      );
    }
    await fs.rm(safetyDir, { recursive: true, force: true });
    throw new Error(
      `${(err as Error).message}. The previous data was put back.`,
    );
  }
  await fs.rm(safetyDir, { recursive: true, force: true });
}
