import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { Logger } from '@nestjs/common';
import {
  describeExecError,
  knownDbSecrets,
  pgEnvFromUrl,
  redactSecrets,
} from './pg-env';
import { orderEntries, selectDataEntries } from './pg-restore-vet';
import { restoreConnectionUrl } from './restore-role';
import { runStreamedRestore } from './restore-stream';

const execFileAsync = promisify(execFile);
const logger = new Logger('PgRestore');
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_ERROR_CHARS = 500;
export const UNSAFE_OPT_IN_ENV = 'NVENTRA_ALLOW_UNSAFE_SUPERUSER_RESTORE';
/** Append-only, hash-chained fiscal ledger: never truncated or overwritten. */
const LEDGER_TABLE = 'verifactu_records';

/**
 * True when the restore role (or any role it is effectively a member of)
 * could run code on the DB host, read/write its files, create roles/DBs or
 * objects, or plant triggers that the app would later execute.
 */
const UNSAFE_ROLE_SQL = `SELECT (
  EXISTS (SELECT 1 FROM pg_roles m WHERE pg_has_role(current_user, m.oid, 'member')
          AND (m.rolsuper OR m.rolcreaterole OR m.rolcreatedb OR m.rolreplication OR m.rolbypassrls))
  OR pg_has_role(current_user,'pg_execute_server_program','member')
  OR pg_has_role(current_user,'pg_write_server_files','member')
  OR pg_has_role(current_user,'pg_read_server_files','member')
  OR has_schema_privilege(current_user,'public','CREATE')
  OR EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname='public'
             AND pg_has_role(current_user, t.tableowner, 'usage'))
  OR EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname='public'
             AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'TRIGGER'))
) AS unsafe`;
const APP_TABLES_SQL =
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1";
const FK_EDGES_SQL =
  "SELECT c.relname || '|' || p.relname FROM pg_constraint k " +
  'JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid ' +
  "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE k.contype = 'f' AND n.nspname = 'public'";
const LEDGER_COUNT_SQL = `SELECT CASE WHEN to_regclass('public.${LEDGER_TABLE}') IS NULL THEN 0 ELSE (SELECT count(*) FROM public.${LEDGER_TABLE}) END`;

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
      `${UNSAFE_OPT_IN_ENV}=1: restoring as a role with elevated privileges. This is DANGEROUS.`,
    );
    return;
  }
  throw new Error(
    'Restore refused: the database role used for restores has elevated ' +
      'privileges (superuser, CREATEROLE/CREATEDB, server file/program ' +
      'access, CREATE on the schema, table ownership or TRIGGER). Use the ' +
      'limited "nventra_restore" role (created automatically when the ' +
      'backend starts as a superuser) or set DATABASE_RESTORE_URL to a ' +
      `limited role. ${UNSAFE_OPT_IN_ENV}=1 overrides this and is dangerous.`,
  );
}

async function assertLedgerEmpty(url: string | undefined) {
  const n = Number((await psql(LEDGER_COUNT_SQL, url)).trim());
  if (!Number.isFinite(n) || n > 0) {
    throw new Error(
      `Restore refused: ${LEDGER_TABLE} (the append-only fiscal ledger) is not ` +
        'empty and a restore must never overwrite it. Restore into a freshly ' +
        'migrated, empty database instead.',
    );
  }
}

/** Child tables first, so DELETEs never hit a foreign-key RESTRICT. */
export function deleteOrder(
  tables: ReadonlySet<string>,
  edges: [child: string, parent: string][],
): string[] {
  const remaining = new Set(tables);
  const out: string[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(
      (t) => !edges.some(([c, p]) => p === t && c !== t && remaining.has(c)),
    );
    const batch = ready.length ? ready : [...remaining]; // cycle: let PG decide
    for (const t of batch) {
      remaining.delete(t);
      out.push(t);
    }
  }
  return out;
}

const q = (t: string) => `"${t.replace(/"/g, '""')}"`;

/**
 * Restores the DATA of `file` into the live (already migrated) schema as the
 * limited restore role, in ONE transaction together with the deletes of the
 * current data: any failure leaves the original data intact. Nothing
 * structural from the dump is ever executed, and the script passed to psql is
 * line-vetted (see restore-stream.ts).
 */
export async function restoreDatabase(file: string): Promise<void> {
  const url = restoreConnectionUrl();
  await assertRestoreRoleIsLimited(url);
  const tables = new Set(
    (await psql(APP_TABLES_SQL, url))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const toc = await runPg('pg_restore', ['-l', file], url);
  const entries = selectDataEntries(toc, tables); // before anything destructive
  await assertLedgerEmpty(url);

  const edges = (await psql(FK_EDGES_SQL, url))
    .split('\n')
    .map((l) => l.trim().split('|'))
    .filter((p): p is [string, string] => p.length === 2);
  const wipe = deleteOrder(tables, edges).filter(
    (t) => t !== '_prisma_migrations',
  );
  const prelude =
    // Do not replay the restore to sync peers.
    "SET app.sync_origin = '__skip';\n" +
    `${wipe.map((t) => `DELETE FROM ${q(t)};`).join('\n')}\n`;

  const listFile = `${file}.list`;
  // A full dump has no FK-aware data order; load parents before children.
  const ordered = orderEntries(entries, [...wipe].reverse());
  await fs.writeFile(listFile, `${ordered.join('\n')}\n`);
  await runStreamedRestore({ file, listFile, url, prelude, tables });
}
