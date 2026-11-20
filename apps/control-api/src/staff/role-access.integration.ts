import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { CONTROL_PERMISSIONS, effectiveControlGrants } from '@nventra/types';
import { Prisma, type PrismaClient } from '../../node_modules/.prisma/control-client/index.js';
import { ensureAnotherAdmin } from './role-access.js';

export async function roleAccessCases(t: TestContext, db: PrismaClient, root: string, origin: string) {
  const call = (cookie: string, method: string, path: string, body?: unknown) => fetch(new URL(path, root), {
    method, headers: { cookie, origin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const roleRow = (key: string) => db.staffRole.findUniqueOrThrow({ where: { key } });
  async function actor(label: string, roleKey: string) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), role = await roleRow(roleKey);
    await db.staff.create({ data: { id, email: label + '-' + id + '@example.test', passwordHash: 'inert', grants: role.grants, roleId: role.id } });
    const digest = createHmac('sha256', 'a5'.repeat(32)).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { staffId: id, digest, verifiedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 600_000) } });
    return { id, cookie: '__Host-control_staff=' + token };
  }
  const admin = await actor('rl-admin', 'admin'), manager = await actor('rl-manager', 'manager');
  const support = await actor('rl-support', 'support'), marketing = await actor('rl-marketing', 'marketing');
  const member = async (label: string, roleKey: string) => (await actor(label, roleKey)).id;
  const staffRow = (id: string) => db.staff.findUniqueOrThrow({ where: { id } });
  const actions = async (actorId: string) => (await db.auditEvent.findMany({ where: { actorId }, orderBy: { sequence: 'asc' } })).map((e) => e.action);
  const invariantHolds = async () => {
    for (const s of await db.staff.findMany({ where: { roleId: { not: null } }, include: { role: true } })) {
      assert.deepEqual(s.grants, effectiveControlGrants(s.role?.grants ?? [], s.extraGrants, s.removedGrants), s.email);
    }
  };

  await t.test('seeded roles are database rows: Admin locked with every permission, Manager without billing', async () => {
    const rows = await db.staffRole.findMany({ where: { key: { in: ['admin', 'manager', 'support', 'marketing'] } } });
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.filter((r) => r.isSystem).map((r) => r.key), ['admin']);
    assert.deepEqual((await roleRow('admin')).grants.sort(), [...CONTROL_PERMISSIONS].sort());
    assert.deepEqual((await roleRow('manager')).grants.sort(), CONTROL_PERMISSIONS.filter((k) => !k.startsWith('cc.billing.')).sort());
    assert.deepEqual((await roleRow('support')).grants.sort(),
      ['cc.business.read', 'cc.plan.read', 'cc.ticket.manage', 'cc.ticket.read', 'cc.ticket.reply']);
    assert.deepEqual((await roleRow('marketing')).grants.sort(),
      ['cc.business.manage', 'cc.business.read', 'cc.plan.read', 'cc.portal.create', 'cc.portal.read']);
  });

  let ops = '';
  await t.test('role CRUD: create, duplicate key, list, update, validation, unknown id and missing permission', async () => {
    assert.equal((await call('', 'GET', 'staff/roles')).status, 401);
    assert.equal((await call(support.cookie, 'GET', 'staff/roles')).status, 403); // no cc.staff.read
    assert.equal((await call(marketing.cookie, 'POST', 'staff/roles', { key: 'nope', name: 'Nope', grants: [] })).status, 403);
    const created = await call(manager.cookie, 'POST', 'staff/roles', { key: 'ops-lead', name: 'Ops lead', grants: ['cc.ticket.read', 'cc.business.read'] });
    assert.equal(created.status, 201);
    ops = ((await created.json()) as { id: string }).id;
    assert.equal((await call(manager.cookie, 'POST', 'staff/roles', { key: 'ops-lead', name: 'Again', grants: [] })).status, 409);
    for (const bad of [{ key: 'Bad Key', name: 'x', grants: [] }, { key: 'okay', name: 'x', grants: ['cc.unknown'] }, { key: 'okay', name: 'x', grants: [], isSystem: true }]) {
      assert.equal((await call(manager.cookie, 'POST', 'staff/roles', bad)).status, 400);
    }
    const list = await call(manager.cookie, 'GET', 'staff/roles?limit=50');
    const page = await list.json() as { items: { key: string; isSystem: boolean }[] };
    assert.ok(['admin', 'manager', 'support', 'marketing', 'ops-lead'].every((k) => page.items.some((r) => r.key === k)));
    const updated = await call(manager.cookie, 'PATCH', 'staff/roles/' + ops, { name: 'Ops', description: 'Floor ops' });
    assert.equal(updated.status, 200);
    assert.equal((await roleRow('ops-lead')).name, 'Ops');
    assert.equal((await call(manager.cookie, 'PATCH', 'staff/roles/' + ops, {})).status, 400);
    assert.equal((await call(manager.cookie, 'PATCH', 'staff/roles/' + randomUUID(), { name: 'x' })).status, 404);
    assert.equal((await call(manager.cookie, 'DELETE', 'staff/roles/' + randomUUID())).status, 404);
    assert.equal((await call(manager.cookie, 'PATCH', 'staff/roles/not-a-uuid', { name: 'x' })).status, 400);
  });

  await t.test('ceiling: a Manager cannot grant billing, touch billing roles or the Admin role, or assign them', async () => {
    assert.equal((await call(manager.cookie, 'POST', 'staff/roles', { key: 'bill-x', name: 'x', grants: ['cc.billing.read'] })).status, 403);
    assert.equal((await call(manager.cookie, 'PATCH', 'staff/roles/' + ops, { grants: ['cc.billing.manage'] })).status, 403);
    const billing = await call(admin.cookie, 'POST', 'staff/roles', { key: 'billing-clerk', name: 'Billing clerk', grants: ['cc.billing.read'] });
    assert.equal(billing.status, 201);
    const billingId = ((await billing.json()) as { id: string }).id;
    assert.equal((await call(manager.cookie, 'PATCH', 'staff/roles/' + billingId, { name: 'Mine' })).status, 403);
    assert.equal((await call(manager.cookie, 'DELETE', 'staff/roles/' + billingId)).status, 403);
    const adminRole = await roleRow('admin'), subject = await member('rl-ceiling-subject', 'support');
    const put = (target: string, body: unknown, cookie = manager.cookie) => call(cookie, 'PUT', 'staff/users/' + target + '/role', body);
    assert.equal((await put(subject, { roleId: billingId })).status, 403);
    assert.equal((await put(subject, { roleId: adminRole.id })).status, 403);
    assert.equal((await put(subject, { roleId: (await roleRow('support')).id, extraGrants: ['cc.billing.read'] })).status, 403);
    assert.equal((await put(admin.id, { roleId: (await roleRow('support')).id })).status, 403); // cannot demote an Admin
    assert.equal((await put(manager.id, { roleId: adminRole.id })).status, 403); // no self-escalation
    assert.equal((await put(subject, { roleId: (await roleRow('marketing')).id }, support.cookie)).status, 403);
    assert.deepEqual((await staffRow(subject)).grants, (await roleRow('support')).grants);
    assert.equal((await staffRow(admin.id)).roleId, adminRole.id);
    assert.equal((await call(admin.cookie, 'DELETE', 'staff/roles/' + billingId)).status, 200);
  });

  await t.test('Admin is locked for everyone, in the API and in the database', async () => {
    const adminRole = await roleRow('admin');
    assert.equal((await call(admin.cookie, 'PATCH', 'staff/roles/' + adminRole.id, { grants: [] })).status, 403);
    assert.equal((await call(admin.cookie, 'PATCH', 'staff/roles/' + adminRole.id, { name: 'Boss' })).status, 403);
    assert.equal((await call(admin.cookie, 'DELETE', 'staff/roles/' + adminRole.id)).status, 403);
    assert.equal((await call(admin.cookie, 'POST', 'staff/roles', { key: 'admin', name: 'Admin', grants: [] })).status, 409);
    const subject = await member('rl-lock-subject', 'support');
    assert.equal((await call(manager.cookie, 'PUT', 'staff/users/' + subject + '/role', { roleId: adminRole.id })).status, 403);
    const denied = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.meta?.code === '42501';
    for (const sql of [Prisma.sql`UPDATE control.staff_role SET grants = '{}' WHERE key = 'admin'`,
      Prisma.sql`DELETE FROM control.staff_role WHERE key = 'admin'`,
      Prisma.sql`INSERT INTO control.staff_role (key, name, is_system) VALUES ('fake-system', 'Fake', true)`]) {
      await assert.rejects(db.$transaction(async (tx) => { await tx.$executeRaw`SET LOCAL ROLE control_runtime`; await tx.$executeRaw(sql); }), denied);
    }
    assert.deepEqual((await roleRow('admin')).grants.sort(), [...CONTROL_PERMISSIONS].sort());
    const withTweak = await call(admin.cookie, 'PUT', 'staff/users/' + subject + '/role', { roleId: adminRole.id, removedGrants: ['cc.audit.read'] });
    assert.equal(withTweak.status, 400); // an Admin always has every permission
  });

  await t.test('per-person tweaks add or remove single permissions within the actor ceiling and are stored minimally', async () => {
    const subject = await member('rl-tweak', 'support'), support_ = await roleRow('support');
    const res = await call(manager.cookie, 'PUT', 'staff/users/' + subject + '/role', { roleId: support_.id,
      extraGrants: ['cc.plan.manage', 'cc.ticket.read'], removedGrants: ['cc.ticket.reply', 'cc.audit.read'] });
    assert.equal(res.status, 200);
    const row = await staffRow(subject);
    assert.deepEqual([row.extraGrants, row.removedGrants], [['cc.plan.manage'], ['cc.ticket.reply']]);
    assert.deepEqual(row.grants, effectiveControlGrants(support_.grants, ['cc.plan.manage'], ['cc.ticket.reply']));
    assert.equal((await call(manager.cookie, 'PATCH', 'staff/users/' + subject + '/grants', { grants: ['cc.ticket.read'] })).status, 200);
    const after = await staffRow(subject);
    assert.deepEqual(after.grants, ['cc.ticket.read']);
    assert.deepEqual(after.removedGrants.sort(), ['cc.business.read', 'cc.plan.read', 'cc.ticket.manage', 'cc.ticket.reply']);
    assert.equal((await call(manager.cookie, 'PUT', 'staff/users/' + subject + '/role', { roleId: randomUUID() })).status, 404);
    assert.equal((await call(manager.cookie, 'PUT', 'staff/users/' + subject + '/role', { roleId: support_.id, extra: [] })).status, 400);
  });

  await t.test('editing a role propagates live to every member, honours tweaks and is audited', async () => {
    const plain = await member('rl-live-1', 'support'), tweaked = await member('rl-live-2', 'support');
    for (const id of [plain, tweaked]) {
      assert.equal((await call(manager.cookie, 'PUT', 'staff/users/' + id + '/role', { roleId: ops })).status, 200);
    }
    assert.equal((await call(manager.cookie, 'PUT', 'staff/users/' + tweaked + '/role',
      { roleId: ops, extraGrants: ['cc.plan.read'], removedGrants: ['cc.business.read'] })).status, 200);
    const before = (await actions(manager.id)).length;
    const res = await call(manager.cookie, 'PATCH', 'staff/roles/' + ops, { grants: ['cc.ticket.read', 'cc.ticket.reply', 'cc.business.read'] });
    assert.equal(res.status, 200);
    assert.deepEqual((await staffRow(plain)).grants, ['cc.business.read', 'cc.ticket.read', 'cc.ticket.reply']);
    assert.deepEqual((await staffRow(tweaked)).grants, ['cc.plan.read', 'cc.ticket.read', 'cc.ticket.reply']);
    const events = (await actions(manager.id)).slice(before);
    assert.deepEqual(events.sort(), ['role.update', 'staff.grants.replace', 'staff.grants.replace']);
    const roleEvent = await db.auditEvent.findFirstOrThrow({ where: { actorId: manager.id, action: 'role.update', subjectId: ops }, orderBy: { sequence: 'desc' } });
    assert.deepEqual(roleEvent.changedFields, ['grants']);
    // A member the editor outranks nothing of: an extra the Manager lacks blocks the edit.
    await db.staff.update({ where: { id: plain }, data: { extraGrants: ['cc.billing.read'], grants: [...(await staffRow(plain)).grants, 'cc.billing.read'] } });
    assert.equal((await call(manager.cookie, 'PATCH', 'staff/roles/' + ops, { grants: ['cc.ticket.read'] })).status, 403);
    await db.staff.update({ where: { id: plain }, data: { extraGrants: [], grants: ['cc.business.read', 'cc.ticket.read', 'cc.ticket.reply'] } });
    await invariantHolds();
  });

  await t.test('a role with members cannot be deleted; an empty one can, with audit', async () => {
    assert.equal((await call(manager.cookie, 'DELETE', 'staff/roles/' + ops)).status, 409);
    assert.ok(await db.staffRole.findUnique({ where: { id: ops } }));
    const members = await db.staff.findMany({ where: { roleId: ops }, select: { id: true } });
    const target = (await roleRow('support')).id;
    for (const m of members) assert.equal((await call(manager.cookie, 'PUT', 'staff/users/' + m.id + '/role', { roleId: target })).status, 200);
    assert.equal((await call(manager.cookie, 'DELETE', 'staff/roles/' + ops)).status, 200);
    assert.equal(await db.staffRole.findUnique({ where: { id: ops } }), null);
    const trail = await actions(manager.id);
    for (const a of ['role.create', 'role.update', 'role.delete', 'staff.role.assign']) assert.ok(trail.includes(a), a);
  });

  await t.test('last-Admin guard refuses to remove the only enabled Admin member', async () => {
    const adminRole = await roleRow('admin');
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.staff.updateMany({ where: { roleId: adminRole.id, id: { not: admin.id } }, data: { enabled: false } });
      await assert.rejects(ensureAnotherAdmin(tx, admin.id), ConflictException);
      await tx.staff.updateMany({ where: { roleId: adminRole.id, id: admin.id }, data: { enabled: true } });
      throw new Error('roll back');
    }), /roll back/);
    const spare = await actor('rl-spare-admin', 'admin');
    await db.$transaction((tx) => ensureAnotherAdmin(tx, admin.id));
    assert.ok(spare.id);
  });

  await t.test('concurrent role edits, assignments and deletes keep every member\'s grants equal to role + tweaks', async () => {
    const race = await call(admin.cookie, 'POST', 'staff/roles', { key: 'race-role', name: 'Race', grants: ['cc.ticket.read', 'cc.business.read'] });
    const raceId = ((await race.json()) as { id: string }).id;
    const people = await Promise.all([1, 2, 3, 4].map((n) => member('rl-race-' + n, 'support')));
    const results = await Promise.all([
      ...people.map((id, n) => call(manager.cookie, 'PUT', 'staff/users/' + id + '/role', { roleId: raceId, extraGrants: n % 2 ? ['cc.plan.read'] : [] })),
      call(manager.cookie, 'PATCH', 'staff/roles/' + raceId, { grants: ['cc.ticket.read', 'cc.ticket.reply'] }),
      call(manager.cookie, 'PATCH', 'staff/roles/' + raceId, { grants: ['cc.business.read'] }),
      call(manager.cookie, 'DELETE', 'staff/roles/' + raceId),
    ]);
    for (const r of results) assert.ok([200, 403, 404, 409].includes(r.status), 'status ' + r.status);
    await invariantHolds();
    const left = await db.staffRole.findUnique({ where: { id: raceId } });
    assert.equal(await db.staff.count({ where: { roleId: raceId } }) > 0, left !== null);
  });
}
