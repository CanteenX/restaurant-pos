import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';

const migrations = 'prisma/migrations/';
const target = '20261120100000_control_staff_roles';
const oldAdmin = ['cc.staff.read', 'cc.staff.manage', 'cc.business.read', 'cc.business.manage', 'cc.plan.read', 'cc.plan.manage',
  'cc.audit.read', 'cc.billing.read', 'cc.billing.manage', 'cc.hosted.read', 'cc.hosted.manage', 'cc.portal.read', 'cc.portal.manage',
  'cc.ticket.read', 'cc.ticket.manage', 'cc.ticket.reply'];

/** Replays the earlier migrations in a scratch database, then proves backfill, rollback and re-apply. */
export async function roleMigrationCases(t: TestContext, db: PrismaClient, fixtureUrl: string) {
  const name = 'control_roles_backfill', url = new URL(fixtureUrl);
  url.pathname = '/' + name;
  await db.$executeRawUnsafe(`CREATE DATABASE ${name}`);
  const scratch = new PrismaClient({ datasourceUrl: url.toString() });
  t.after(async () => { await scratch.$disconnect(); await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name}`); });
  const sql = (file: string) => execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'execute',
    '--file', file, '--schema', 'prisma/schema.prisma'], { env: { ...process.env, CONTROL_DATABASE_URL: url.toString() },
    stdio: 'ignore', timeout: 60_000 });
  const earlier = readdirSync(migrations).filter((d) => d < target && /^\d/.test(d)).sort();
  for (const dir of earlier) sql(migrations + dir + '/migration.sql');

  const fixtures: Record<string, string[]> = {
    admin: oldAdmin, 'admin-reordered': [...oldAdmin].reverse(),
    support: ['cc.business.read', 'cc.plan.read', 'cc.ticket.read', 'cc.ticket.manage', 'cc.ticket.reply'],
    marketing: ['cc.portal.create', 'cc.portal.read', 'cc.plan.read', 'cc.business.manage', 'cc.business.read'],
    'old-marketing': ['cc.portal.manage', 'cc.portal.read', 'cc.plan.read', 'cc.business.manage', 'cc.business.read'],
    'old-sales': ['cc.business.read', 'cc.business.manage', 'cc.plan.read'],
    empty: [], odd: ['cc.ticket.read', 'legacy.unknown'], reader: ['cc.audit.read'],
  };
  const ids: Record<string, string> = {};
  for (const [label, grants] of Object.entries(fixtures)) {
    const [row] = await scratch.$queryRaw<{ id: string }[]>`INSERT INTO control.staff (id, email, password_hash, grants)
      VALUES (gen_random_uuid(), ${label + '@example.test'}, 'inert', ${grants}::text[]) RETURNING id`;
    ids[label] = row.id;
  }
  const snapshot = async () => scratch.$queryRaw<{ email: string; grants: string[]; key: string | null }[]>`
    SELECT s.email, s.grants, r.key FROM control.staff s LEFT JOIN control.staff_role r ON r.id = s.role_id ORDER BY s.email`;
  const before = await scratch.$queryRaw<{ email: string; grants: string[] }[]>`SELECT email, grants FROM control.staff ORDER BY email`;
  const apply = () => sql(migrations + target + '/migration.sql');

  const check = async () => {
    const after = await snapshot();
    for (const row of after) {
      const old = before.find((b) => b.email === row.email)!;
      const admin = row.email.startsWith('admin');
      // Existing access never changes; only new permissions are added: role management for Admin, portal create wherever portal manage was held.
      const added = row.grants.filter((g) => !old.grants.includes(g)).sort();
      assert.deepEqual(row.grants.filter((g) => old.grants.includes(g)).sort(), [...old.grants].sort(), row.email);
      const hadManage = old.grants.includes('cc.portal.manage');
      assert.deepEqual(added, [...(admin ? ['cc.role.manage'] : []), ...(hadManage ? ['cc.portal.create'] : [])].sort(), row.email);
      if (admin) assert.ok(row.grants.includes('cc.role.manage'));
    }
    const keys = Object.fromEntries(after.map((r) => [r.email.split('@')[0], r.key]));
    assert.deepEqual(keys, { admin: 'admin', 'admin-reordered': 'admin', support: 'support', marketing: 'marketing',
      'old-sales': 'legacy-' + ids['old-sales'], 'old-marketing': 'legacy-' + ids['old-marketing'], empty: 'legacy-' + ids.empty, odd: 'legacy-' + ids.odd, reader: 'legacy-' + ids.reader });
    const [{ n }] = await scratch.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM control.staff_role WHERE key IN ('admin','manager','support','marketing')`;
    assert.equal(n, 4n);
  };

  await t.test('backfill leaves every existing user\'s effective grants identical and keeps odd ones under a legacy role', async () => {
    apply();
    await check();
  });
  await t.test('down removes the tables, columns and the new permission; re-apply restores the same state', async () => {
    sql(migrations + target + '/down.sql');
    const [gone] = await scratch.$queryRaw<{ t: string | null; c: bigint }[]>`SELECT to_regclass('control.staff_role')::text AS t,
      (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'control' AND table_name = 'staff' AND column_name = 'role_id') AS c`;
    assert.deepEqual([gone.t, gone.c], [null, 0n]);
    const down = await scratch.$queryRaw<{ email: string; grants: string[] }[]>`SELECT email, grants FROM control.staff ORDER BY email`;
    for (const row of down) assert.deepEqual([...row.grants].sort(), before.find((b) => b.email === row.email)!.grants.filter((g) => g !== 'cc.portal.create').sort(), row.email);
    // Rolling back drops the new create-only permission; restore the pre-migration fixtures before re-applying.
    for (const b of before) await scratch.$executeRaw`UPDATE control.staff SET grants = ${b.grants}::text[] WHERE email = ${b.email}`;
    apply();
    await check();
  });
  await t.test('staff invitation migration rolls back and reapplies without removing existing staff accounts', async () => {
    const base = migrations + '20261120110000_control_staff_invites/';
    const exists = async () => (await scratch.$queryRaw<{ relation: string | null }[]>
      `SELECT to_regclass('control.staff_invite')::text AS relation`)[0].relation;
    const baseline = await snapshot();
    sql(base + 'migration.sql');
    assert.ok(await exists());
    sql(base + 'down.sql');
    assert.equal(await exists(), null);
    assert.deepEqual(await snapshot(), baseline);
    sql(base + 'migration.sql');
    assert.ok(await exists());
  });
}
