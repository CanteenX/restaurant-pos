import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';

export async function hostedAccessCases(t: TestContext, db: PrismaClient, root: string, origin: string) {
  async function actor(grants: string[], age = 0) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.staff.create({ data: { id, email: id + '@example.test', grants, passwordHash: 'inert' } });
    const digest = createHmac('sha256', 'a5'.repeat(32)).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { staffId: id, digest, verifiedAt: new Date(Date.now() - age),
      expiresAt: new Date(Date.now() + 900_000) } });
    return '__Host-control_staff=' + token;
  }
  const reader = await actor(['cc.hosted.read']), owner = await actor(['cc.hosted.manage']);
  const other = await actor(['cc.hosted.manage']), stale = await actor(['cc.hosted.manage'], 660_000);
  const business = () => db.business.create({ data: { id: randomUUID(), legalName: 'Hosted fixture', displayName: 'Fixture' } });
  const [a,b] = await Promise.all([business(),business()]);
  const request = (id: string, cookie: string, body?: unknown, version?: string, from = origin) =>
    fetch(new URL('businesses/' + id + '/hosted-access', root), { method: body ? 'PATCH' : 'GET',
      headers: { origin: from, cookie, 'content-type': 'application/json', ...(version && { 'if-match': version }) },
      body: JSON.stringify(body) });
  const suspend = { status: 'suspended', reason: 'Pilot invoice overdue', requestKey: randomUUID() };
  const initial = '"0"';

  await t.test('requires dedicated permission, verified staff and recent 2FA for writes', async () => {
    assert.equal((await request(a.id, '')).status, 401);
    assert.equal((await request(a.id, owner)).status, 403);
    assert.equal((await request(a.id, reader.replace('__Host-control_staff','__Host-control_portal'))).status, 401);
    assert.equal((await request(a.id, reader, suspend, initial)).status, 403);
    assert.equal((await request(a.id, stale, suspend, initial)).status, 403);
    assert.equal((await request(a.id, owner, suspend, initial, 'https://wrong.example.test')).status, 403);
    assert.equal((await request(a.id, owner, suspend)).status, 428);
    assert.equal((await request(a.id, owner, suspend, '*')).status, 400);
    assert.equal((await request(a.id, owner, { ...suspend, reason: '' }, initial)).status, 400);
    assert.equal((await request(randomUUID(), reader)).status, 404);
    const first = await request(a.id, reader);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.headers.get('etag'), initial);
    assert.deepEqual(await first.json(), { status: 'active', version: '0' });
  });

  await t.test('suspends and restores one business, rejecting stale or conflicting writes and preserving exact replay', async () => {
    const first = await request(a.id, owner, suspend, initial);
    assert.equal(first.status, 200);
    const tag = '"' + suspend.requestKey + '"';
    assert.equal(first.headers.get('etag'), tag);
    const suspended = await first.json() as { status: string; reason: string; version: string; changedAt: string };
    assert.deepEqual([suspended.status,suspended.reason,suspended.version], ['suspended',suspend.reason,suspend.requestKey]);
    assert.ok(Number.isFinite(Date.parse(suspended.changedAt)));
    assert.deepEqual(await (await request(b.id, reader)).json(), { status: 'active', version: '0' });
    const restore = { status: 'active', reason: 'Payment confirmed', requestKey: randomUUID() };
    assert.equal((await request(a.id, owner, restore, initial)).status, 412);
    assert.equal((await request(a.id, owner, restore, tag)).status, 200);
    assert.deepEqual(await (await request(a.id, owner, suspend, initial)).json(), suspended);
    assert.equal((await request(a.id, owner, { ...suspend, reason: 'Changed' }, initial)).status, 409);
    assert.equal((await request(a.id, other, suspend, initial)).status, 409);
    const current = await request(a.id, reader);
    assert.equal(current.headers.get('etag'), '"' + restore.requestKey + '"');
    const audits = await db.auditEvent.findMany({ where: { businessId: a.id, subjectType: 'business' }, orderBy: { sequence: 'asc' } });
    assert.deepEqual(audits.map((event) => event.action), ['hostedAccess.suspend','hostedAccess.restore']);
    assert.ok(audits.every((event) => !JSON.stringify(event.changedFields).includes(suspend.reason)));
  });

  await t.test('serializes competing commands and rolls back state if the audit write fails', async () => {
    const contender = { ...suspend, requestKey: randomUUID() };
    const both = await Promise.all([request(b.id, owner, suspend, initial), request(b.id, other, contender, initial)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200,412]);
    const before = await request(b.id, reader), tag = before.headers.get('etag');
    assert.ok(tag);
    await db.$executeRaw`ALTER TABLE control.audit_event ADD CONSTRAINT test_hosted_failure CHECK (action <> 'hostedAccess.restore') NOT VALID`;
    try {
      const restore = { status: 'active', reason: 'Test rollback', requestKey: randomUUID() };
      assert.equal((await request(b.id, owner, restore, tag)).status, 500);
      const after = await request(b.id, reader);
      assert.equal(after.headers.get('etag'), tag);
      assert.deepEqual(await after.json(), await before.json());
      assert.equal(await db.auditEvent.count({ where: { requestId: restore.requestKey } }), 0);
    } finally { await db.$executeRaw`ALTER TABLE control.audit_event DROP CONSTRAINT test_hosted_failure`; }
  });

  await t.test('keeps archived history visible and denies new transitions or direct history rewrites', async () => {
    await db.business.update({ where: { id: a.id }, data: { archived: true } });
    const before = await request(a.id, reader), tag = before.headers.get('etag');
    assert.ok(tag);
    const next = { ...suspend, requestKey: randomUUID() };
    assert.equal((await request(a.id, owner, next, tag)).status, 409);
    assert.equal((await request(a.id, owner, suspend, initial)).status, 200);
    assert.equal((await request(a.id, reader)).headers.get('etag'), tag);
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
      await tx.$executeRaw`UPDATE control.hosted_access_event SET reason = 'forged' WHERE business_id = ${a.id}::uuid`;
    }), (error: unknown) => (error as { meta?: { code?: string } }).meta?.code === '42501');
  });
}
