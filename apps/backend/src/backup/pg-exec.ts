import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Logger } from '@nestjs/common';
import {
  orderEntries,
  RestoreVetError,
  selectDataEntries,
} from './pg-restore-vet';
import { restoreConnectionUrl } from './restore-role';
import { loadVettedData, restoreLimits } from './restore-load';
import { psqlQuery as psql, runPg } from './pg-run';
import { parseSequences, simpleName } from './restore-sequences';

const logger = new Logger('PgRestore');
export const UNSAFE_OPT_IN_ENV = 'NVENTRA_ALLOW_UNSAFE_SUPERUSER_RESTORE';
/** Append-only, hash-chained fiscal ledger: never truncated or overwritten. */
const LEDGER_TABLE = 'verifactu_records';

/**
 * True when the restore role (or any role it is effectively a member of)
 * could run code on the DB host, read/write its files, create roles/DBs or
 * objects, or plant triggers that the app would later execute.
 */
const UNSAFE_ROLE_SQL = `WITH members AS (
  SELECT * FROM pg_roles WHERE rolname=current_user OR pg_has_role(current_user, oid, 'member')
)
SELECT EXISTS (SELECT 1 FROM members m WHERE
  m.rolsuper OR m.rolcreaterole OR m.rolcreatedb OR m.rolreplication OR m.rolbypassrls
  OR m.rolname LIKE 'pg\\_%' ESCAPE '\\'
  OR has_database_privilege(m.oid, current_database(), 'CREATE')
  OR has_schema_privilege(m.oid,'public','CREATE')
  OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND
             (n.nspowner=m.oid OR has_schema_privilege(m.oid,n.oid,'CREATE')))
  OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relowner=m.oid)
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname !~ '^pg_' AND p.proowner=m.oid)
  OR EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname='public'
             AND has_table_privilege(m.oid, format('%I.%I', t.schemaname, t.tablename), 'TRIGGER'))
) AS unsafe`;
const APP_TABLES_SQL =
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1";
const FK_EDGES_SQL =
  "SELECT c.relname || '|' || p.relname FROM pg_constraint k " +
  'JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid ' +
  "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE k.contype = 'f' AND n.nspname = 'public'";
const LEDGER_COUNT_SQL = `SELECT CASE WHEN to_regclass('public.${LEDGER_TABLE}') IS NULL THEN 0 ELSE (SELECT count(*) FROM public.${LEDGER_TABLE}) END`;
const COLUMNS_SQL = `SELECT c.relname || '|' || a.attname FROM pg_attribute a
JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`;
const SEQUENCES_SQL = `SELECT c.relname || '|' || COALESCE(t.relname,'?') || '|' || COALESCE(a.attname,'?') || '|' ||
s.seqmin || '|' || s.seqmax || '|' || s.seqincrement || '|' || CASE WHEN s.seqcycle THEN 't' ELSE 'f' END
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_sequence s ON s.seqrelid=c.oid
LEFT JOIN pg_depend d ON d.objid=c.oid AND d.classid='pg_class'::regclass AND d.deptype IN ('a','i')
LEFT JOIN pg_class t ON t.oid=d.refobjid AND t.relnamespace=n.oid
LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
WHERE n.nspname='public' AND c.relkind='S'`;

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
      'access, database/schema CREATE, schema/table/sequence/function ' +
      'ownership or TRIGGER, including member roles). Use the ' +
      'limited "nventra_restore" role (provisioned by stock database setup) ' +
      'or set DATABASE_RESTORE_URL to a ' +
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

/**
 * Restores the DATA of `file` into the live (already migrated) schema as the
 * limited restore role, in ONE transaction together with the deletes of the
 * current data: any failure leaves the original data intact. Nothing
 * structural or executable text from the dump is ever passed to psql.
 */
export async function restoreDatabase(file: string): Promise<void> {
  restoreLimits((await fs.stat(file)).size); // before TOC parsing or any DB client
  const url = restoreConnectionUrl();
  await assertRestoreRoleIsLimited(url);
  const tables = new Set(
    (await psql(APP_TABLES_SQL, url))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map(simpleName),
  );
  const columnsByTable = new Map<string, Set<string>>();
  for (const line of (await psql(COLUMNS_SQL, url))
    .trim()
    .split('\n')
    .filter(Boolean)) {
    const [table, column, extra] = line.split('|');
    if (!column || extra)
      throw new RestoreVetError('invalid live column metadata');
    const columns = columnsByTable.get(simpleName(table)) ?? new Set<string>();
    columns.add(simpleName(column));
    columnsByTable.set(table, columns);
  }
  const sequences = parseSequences(await psql(SEQUENCES_SQL, url));
  const toc = await runPg('pg_restore', ['-l', file], url);
  const entries = selectDataEntries(toc, tables, new Set(sequences.keys())); // before anything destructive
  await assertLedgerEmpty(url);

  const edges = (await psql(FK_EDGES_SQL, url))
    .split('\n')
    .map((l) => l.trim().split('|'))
    .filter((p): p is [string, string] => p.length === 2);
  const wipe = deleteOrder(tables, edges).filter(
    (t) => t !== '_prisma_migrations',
  );
  // A full dump has no FK-aware data order; load parents before children.
  const ordered = orderEntries(entries, [...wipe].reverse());
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nventra-restore-'));
  try {
    await loadVettedData({
      file,
      entries: ordered,
      url,
      workDir,
      wipe,
      columnsByTable,
      sequences,
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
