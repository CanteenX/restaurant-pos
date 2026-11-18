import { BranchPath, SYNC_TABLES, SyncTable } from './tables';

/**
 * SQL functions generated from tables.ts and (re)installed at every boot, so
 * the trigger-side classification can never drift from the TypeScript one.
 * The trigger itself (sync_log_change) is static, see migration
 * 20261104130000_sync_outbox.
 */

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

function synced(tables: Record<string, SyncTable>) {
  return Object.keys(tables).sort();
}

/** True only for classified, non-local tables (unknown tables never sync). */
export function isSyncedTableSql(tables = SYNC_TABLES): string {
  const list = synced(tables).map(lit).join(', ');
  return `CREATE OR REPLACE FUNCTION sync_is_synced_table(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT t = ANY (ARRAY[${list}]::text[])
$fn$;`;
}

function branchExpr(path: BranchPath): string {
  if (!path) return 'NULL';
  if ('col' in path) return `rec ->> ${lit(path.col)}`;
  return `sync_branch_of(${lit(path.via)}, (SELECT to_jsonb(p) FROM ${ident(path.via)} p WHERE p.id = rec ->> ${lit(path.fk)}))`;
}

/** Branch id of a captured row, following parent rows for child tables. */
export function branchOfSql(tables = SYNC_TABLES): string {
  const arms = synced(tables)
    .filter((t) => tables[t].branch)
    .map(
      (t) => `    WHEN ${lit(t)} THEN RETURN ${branchExpr(tables[t].branch)};`,
    )
    .join('\n');
  return `CREATE OR REPLACE FUNCTION sync_branch_of(t text, rec jsonb) RETURNS text
LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  IF rec IS NULL THEN RETURN NULL; END IF;
  CASE t
${arms}
    ELSE RETURN NULL;
  END CASE;
END $fn$;`;
}

/**
 * Row as it goes on the wire: sealed columns removed (G11) and permission
 * rows carrying the permission key instead of this install's id (G5).
 */
export function captureRowSql(tables = SYNC_TABLES): string {
  const arms: string[] = [];
  for (const t of synced(tables)) {
    const s = tables[t];
    if (s.strip?.length)
      arms.push(
        `    WHEN ${lit(t)} THEN RETURN rec - ARRAY[${s.strip.map(lit).join(', ')}]::text[];`,
      );
    else if (s.permissionKeyed)
      arms.push(
        `    WHEN ${lit(t)} THEN RETURN rec || jsonb_build_object('permissionKey', (SELECT p.key FROM permissions p WHERE p.id = rec ->> 'permissionId'));`,
      );
  }
  return `CREATE OR REPLACE FUNCTION sync_capture_row(t text, rec jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  CASE t
${arms.join('\n')}
    ELSE RETURN rec;
  END CASE;
END $fn$;`;
}

export function captureSql(tables = SYNC_TABLES): string[] {
  return [isSyncedTableSql(tables), branchOfSql(tables), captureRowSql(tables)];
}
