import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';

export async function staffAccessCases(t: TestContext, db: PrismaClient, root: string, origin: string,
  password: string, passwordHash: string) {
  const manager = randomUUID(), target = randomUUID(), peer = randomUUID();
  const request = (path: string, cookie = '', method = 'GET', body?: unknown, from = origin) => fetch(root + path, {
    method, headers: { cookie, origin: from, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await t.test('staff directory and mutations require a verified Control session', async () => {
    assert.equal((await request('users')).status, 401);
    assert.equal((await request('users/' + target + '/reset-factor', '', 'POST', {})).status, 401);
  });
  const session = async (staffId: string, age = 0) => {
    const token = randomBytes(32).toString('base64url');
    const digest = createHmac('sha256', 'a5'.repeat(32)).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { digest, staffId, verifiedAt: new Date(Date.now() - age),
      expiresAt: new Date(Date.now() + 600_000) } });
    return '__Host-control_staff=' + token;
  };
  await db.authLimit.deleteMany();
  for (const id of [manager, target, peer]) {
    await db.staff.create({ data: { id, email: id + '@example.test', passwordHash } });
  }
  const rights = ['cc.staff.manage', 'cc.staff.read', 'cc.ticket.read'];
  const set = (id: string, grants: string[]) => db.$executeRaw`UPDATE control.staff SET grants = ${grants}::text[] WHERE id = ${id}::uuid`;
  await set(manager, rights);
  await set(peer, rights);
  const cookie = await session(manager);
  const change = (id: string, grants: string[], creds = cookie, from = origin) =>
    request('users/' + id + '/grants', creds, 'PATCH', { grants }, from);
  const action = (name: string) => request('users/' + target + '/' + name, cookie, 'POST', {});
  await t.test('derives authority, target and recent verification from storage', async () => {
    const unprivileged = await session(target);
    assert.equal((await request('users', unprivileged)).status, 403);
    assert.equal((await change(target, [], unprivileged)).status, 403);
    assert.equal((await change(manager.toUpperCase(), [])).status, 403);
    assert.equal((await change(peer, [])).status, 403);
    assert.equal((await change(target, ['cc.plan.manage'])).status, 403);
    assert.equal((await change(target, [], await session(manager, 660_000))).status, 403);
    assert.equal((await change(target, [], cookie, 'https://other.example.test')).status, 403);
    assert.equal((await request('users/' + peer + '/grants', cookie, 'PATCH', { grants: [], subjectGrants: [] })).status, 400);
    const res = await request('users?limit=1', cookie);
    assert.equal(res.status, 200);
    const page = await res.json() as { items: { id: string }[]; nextCursor: string };
    assert.equal(page.items.length, 1);
    assert.deepEqual(Object.keys(page.items[0]).sort(), ['email', 'enabled', 'grants', 'id']);
    assert.ok(page.nextCursor);
    const next = await request('users?limit=1&cursor=' + page.nextCursor, cookie);
    assert.notEqual((await next.json() as typeof page).items[0].id, page.items[0].id);
    assert.equal((await change(target, ['cc.ticket.read'])).status, 200);
    const event = await db.auditEvent.findFirstOrThrow({ where: { actorId: manager, subjectId: target } });
    assert.equal(event.action, 'staff.grants.replace');
  });
  await t.test('rechecks authority after a concurrent actor demotion releases its lock', async () => {
    let pending: Promise<Response> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE control.staff SET grants = '{}' WHERE id = ${manager}::uuid`;
      pending = change(target, []);
      let blocked = false;
      const deadline = Date.now() + 5_000;
      while (!blocked && Date.now() < deadline) {
        const [row] = await tx.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
          SELECT FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
        ) AS blocked`;
        blocked = row.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true);
    }, { timeout: 10_000 });
    assert.equal((await pending)?.status, 403);
    await set(manager, rights);
  });
  await t.test('rolls back grants with a failed audit append', async () => {
    await db.$executeRaw`ALTER TABLE control.audit_event ADD CONSTRAINT test_grant_failure
      CHECK (action <> 'staff.grants.replace') NOT VALID`;
    try {
      assert.equal((await change(target, [])).status, 500);
      const [row] = await db.$queryRaw<{ grants: string[] }[]>`SELECT grants FROM control.staff WHERE id = ${target}::uuid`;
      assert.deepEqual(row.grants, ['cc.ticket.read']);
    } finally { await db.$executeRaw`ALTER TABLE control.audit_event DROP CONSTRAINT test_grant_failure`; }
  });
  await t.test('revocation is permanent across enablement and factor reset requires a fresh independent proof', async () => {
    const old = await session(target);
    await db.staff.update({ where: { id: target }, data: { enabled: false } });
    await db.staff.update({ where: { id: target }, data: { enabled: true } });
    assert.equal((await request('session', old)).status, 401);
    const active = await session(target);
    assert.equal((await action('revoke-sessions')).status, 200);
    assert.equal((await request('session', active)).status, 401);
    const last = await session(target);
    const challenge = randomBytes(32).toString('base64url');
    const digest = createHmac('sha256', 'a5'.repeat(32)).update('challenge\0' + challenge).digest('hex');
    await db.staff.update({ where: { id: target }, data: { encryptedSeed: 'old', lastStep: 7,
      recoveryDigests: ['old'], challengeDigest: digest, challengeExpiresAt: new Date(Date.now() + 60_000) } });
    const issue = (bytes: Buffer) => db.$executeRaw`INSERT INTO control.staff_enrollment_proof VALUES
      (${target}::uuid, sha256(${bytes}), now() + interval '5 minutes')`;
    const oldProof = Buffer.alloc(32, 0x5a);
    await issue(oldProof);
    assert.equal((await action('reset-factor')).status, 200);
    assert.equal((await request('session', last)).status, 401);
    const subject = await db.staff.findUniqueOrThrow({ where: { id: target } });
    assert.deepEqual([subject.encryptedSeed, subject.lastStep, subject.pendingSeed, subject.challengeDigest,
      subject.challengeExpiresAt, subject.recoveryDigests], [null, null, null, null, null, []]);
    const login = (proof?: Buffer) => request('session/challenge', '', 'POST', {
      email: subject.email, password, enrollmentProof: proof?.toString('base64url'),
    });
    assert.equal((await request('session/verify', '', 'POST', { challenge, code: 'ABCD-ABCD-ABCD' })).status, 401);
    assert.equal((await login()).status, 401);
    assert.equal((await login(oldProof)).status, 401);
    const fresh = Buffer.alloc(32, 0xb6);
    await issue(fresh);
    assert.equal((await login(fresh)).status, 200);
    const events = await db.auditEvent.findMany({ where: { actorId: manager, subjectId: target }, orderBy: { sequence: 'asc' } });
    assert.deepEqual(events.map((e) => e.action), ['staff.grants.replace', 'staff.sessions.revoke', 'staff.factor.reset']);
  });
}
