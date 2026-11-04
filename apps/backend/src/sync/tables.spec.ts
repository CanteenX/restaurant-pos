import { readFileSync } from 'fs';
import { join } from 'path';
import { branchOfSql, captureRowSql, isSyncedTableSql } from './capture-sql';
import { LOCAL_TABLES, SYNC_TABLES } from './tables';

/** table name -> column names, parsed from schema.prisma. */
function prismaTables(): Map<string, Set<string>> {
  const src = readFileSync(
    join(__dirname, '../../prisma/schema.prisma'),
    'utf8',
  );
  const out = new Map<string, Set<string>>();
  for (const m of src.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const body = m[2];
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? m[1];
    const cols = new Set<string>();
    for (const line of body.split('\n')) {
      const f = /^\s+(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
      if (!f || line.trim().startsWith('//') || line.includes('@relation'))
        continue;
      // Relation fields point at other models; columns have scalar/enum types.
      if (/^[A-Z]/.test(f[2]) && !isScalar(f[2], src)) continue;
      cols.add(f[1]);
    }
    out.set(table, cols);
  }
  return out;
}
function isScalar(type: string, src: string) {
  return (
    [
      'String',
      'Int',
      'BigInt',
      'Boolean',
      'DateTime',
      'Decimal',
      'Json',
      'Float',
      'Bytes',
    ].includes(type) || new RegExp(`^enum ${type} \\{`, 'm').test(src)
  );
}

describe('sync table classification', () => {
  const models = prismaTables();

  it('classifies every Prisma table exactly once', () => {
    const unclassified = [...models.keys()].filter(
      (t) => !(t in SYNC_TABLES) && !(t in LOCAL_TABLES),
    );
    expect(unclassified).toEqual([]);
    const both = Object.keys(SYNC_TABLES).filter((t) => t in LOCAL_TABLES);
    expect(both).toEqual([]);
  });

  it('only classifies tables that exist', () => {
    const stale = [
      ...Object.keys(SYNC_TABLES),
      ...Object.keys(LOCAL_TABLES),
    ].filter((t) => t !== '_prisma_migrations' && !models.has(t));
    expect(stale).toEqual([]);
  });

  it('keeps device-local and per-install-sealed tables local (G5, G10, G11)', () => {
    for (const t of [
      'local_backup_config',
      'integration_logs',
      'integration_connections',
      'webhook_endpoints',
      'staff_api_keys',
      'integration_api_keys',
      'device_tokens',
      'notifications',
      'permissions',
      'verifactu_records',
    ])
      expect(LOCAL_TABLES[t]).toBeDefined();
  });

  it('every branch path points at real columns and synced parents', () => {
    for (const [t, spec] of Object.entries(SYNC_TABLES)) {
      const cols = models.get(t)!;
      const b = spec.branch;
      if (!b) continue;
      if ('col' in b) {
        expect(`${t}.${b.col}:${cols.has(b.col)}`).toBe(`${t}.${b.col}:true`);
      } else {
        expect(`${t}.${b.fk}:${cols.has(b.fk)}`).toBe(`${t}.${b.fk}:true`);
        const parent = SYNC_TABLES[b.via];
        expect(`${t}->${b.via}:${!!parent?.branch}`).toBe(
          `${t}->${b.via}:true`,
        );
      }
    }
  });

  it('derived, stripped and permission columns exist', () => {
    for (const [t, spec] of Object.entries(SYNC_TABLES)) {
      const cols = models.get(t)!;
      for (const c of [...(spec.derived ?? []), ...(spec.strip ?? [])])
        expect(`${t}.${c}:${cols.has(c)}`).toBe(`${t}.${c}:true`);
      if (spec.permissionKeyed) expect(cols.has('permissionId')).toBe(true);
    }
  });

  it('keeps VERI*FACTU settings local: sealed cert and per-install invoice counters (#81 audit)', () => {
    expect(LOCAL_TABLES.verifactu_settings).toBeDefined();
    expect(SYNC_TABLES.verifactu_settings).toBeUndefined();
  });

  it('strips the sealed 2FA secret from users', () => {
    expect(SYNC_TABLES.users.strip).toContain('twoFactorSecret');
    expect(captureRowSql()).toContain(
      `WHEN 'users' THEN RETURN rec - ARRAY['twoFactorSecret']::text[];`,
    );
  });

  it('generates branch lookups through parent rows', () => {
    const sql = branchOfSql();
    expect(sql).toContain(`WHEN 'orders' THEN RETURN rec ->> 'branchId';`);
    expect(sql).toContain(`WHEN 'branches' THEN RETURN rec ->> 'id';`);
    expect(sql).toContain(
      `WHEN 'kot_items' THEN RETURN sync_branch_of('kots', (SELECT to_jsonb(p) FROM "kots" p WHERE p.id = rec ->> 'kotId'));`,
    );
    expect(sql).not.toContain(`WHEN 'users'`);
  });

  it('the synced-table function lists exactly the synced tables', () => {
    const sql = isSyncedTableSql();
    for (const t of Object.keys(SYNC_TABLES)) expect(sql).toContain(`'${t}'`);
    for (const t of Object.keys(LOCAL_TABLES))
      expect(sql).not.toContain(`'${t}'`);
  });
});
