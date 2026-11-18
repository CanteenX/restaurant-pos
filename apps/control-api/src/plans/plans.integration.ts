import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';

export async function planCases(t: TestContext, db: PrismaClient, url: string, origin: string) {
  const actor = async (grants: string[], age = 0) => {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.staff.create({ data: { id, email: id + '@example.test', grants, passwordHash: 'inert' } });
    const digest = createHmac('sha256', 'a5'.repeat(32)).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { staffId: id, digest, verifiedAt: new Date(Date.now() - age),
      expiresAt: new Date(Date.now() + 1_200_000) } });
    return { id, cookie: '__Host-control_staff=' + token };
  };
  const reader = await actor(['cc.plan.read']), writer = await actor(['cc.plan.manage']);
  const other = await actor(['cc.plan.manage']), stale = await actor(['cc.plan.manage'], 660_000);
  const parent = await db.business.create({ data: { id: randomUUID(), legalName: 'Plan fixtures', displayName: 'Fixture' } });
  const outlet = await db.outlet.create({ data: { id: randomUUID(), businessId: parent.id, displayName: 'Fixture', timeZone: 'UTC' } });
  const history = 'outlets/' + outlet.id + '/service-plans';
  const at = (days: number) => new Date(Date.now() + 86_400_000 * days).toISOString();
  const term = { requestKey: randomUUID(), planCode: 'starter', planVersion: 1, startsAt: at(-1), endsAt: at(1) };
  const request = (path: string, cookie: string, body?: object, from = origin) =>
    fetch(url + path, { method: body ? 'POST' : 'GET', headers: { cookie, origin: from,
      'content-type': 'application/json' }, body: JSON.stringify(body) });
  const assign = (body: object = term, cookie = writer.cookie) => request(history + '/assign', cookie, body);

  await t.test('queues only the latest upcoming renewals for active outlets and pages in order', async () => {
    const add = (name: string, archived = false) => db.outlet.create({
      data: { id: randomUUID(), businessId: parent.id, displayName: name, timeZone: 'Asia/Kolkata', archived },
    });
    const next = await add('First due'), later = await add('Second due'), ignored = await add('Archived outlet', true);
    const record = (id: string, days: number, revision = 1) => db.outletServiceTerm.create({
      data: { id: randomUUID(), businessId: parent.id, outletId: id, revision, requestKey: randomUUID(),
        operation: revision === 1 ? 'assign' : 'renew', planCode: 'starter', planVersion: 1,
        startsAt: at(revision === 1 ? -1 : 1), endsAt: at(days) },
    });
    await record(next.id, 2);
    await record(later.id, 1);
    await record(later.id, 3, 2);
    await record(ignored.id, 1);
    assert.equal((await request('plans/renewals', '')).status, 401);
    assert.equal((await request('plans/renewals', writer.cookie)).status, 403);
    assert.equal((await request('plans/renewals?cursor=invalid', reader.cookie)).status, 400);
    const first = await request('plans/renewals?limit=1', reader.cookie);
    assert.equal(first.status, 200);
    const { items, nextCursor } = await first.json() as { items: { outletId: string }[]; nextCursor: string };
    assert.deepEqual(items.map((row) => row.outletId), [next.id]);
    const second = await request('plans/renewals?limit=1&cursor=' + encodeURIComponent(nextCursor), reader.cookie);
    assert.equal(second.status, 200);
    const secondPage = await second.json() as { items: { outletId: string }[]; nextCursor: string | null };
    assert.deepEqual(secondPage.items.map((row) => row.outletId), [later.id]);
    assert.equal(secondPage.nextCursor, null);
  });

  await t.test('authorizes catalog, history and mutations with explicit permissions and recent 2FA', async () => {
    assert.equal((await request('plans', '')).status, 401);
    assert.equal((await request('plans', writer.cookie)).status, 403);
    const catalog = await request('plans', reader.cookie);
    assert.equal(catalog.status, 200);
    assert.equal(catalog.headers.get('cache-control'), 'no-store');
    assert.equal((await request('plans?businessId=' + parent.id, reader.cookie)).status, 400);
    assert.ok((await catalog.json() as { code: string; version: number }[])
      .some(({ code, version }) => code === 'starter' && version === 1));
    assert.equal((await request(history, writer.cookie)).status, 403);
    assert.equal((await assign(term, reader.cookie)).status, 403);
    assert.equal((await assign(term, stale.cookie)).status, 403);
    assert.equal((await request(history + '/assign', writer.cookie, term, 'https://wrong.example.test')).status, 403);
    assert.equal((await assign({ ...term, businessId: randomUUID() })).status, 400);
    assert.equal((await assign({ ...term, startsAt: term.endsAt })).status, 400);
    assert.equal((await assign({ ...term, planVersion: 99 })).status, 404);
    assert.equal((await request('outlets/' + randomUUID() + '/service-plans', reader.cookie)).status, 404);
  });

  await t.test('serializes duplicate request keys across staff and audits just one write', async () => {
    const responses = await Promise.all([assign(), assign(term, other.cookie)]);
    assert.deepEqual(responses.map((res) => res.status), [201, 201]);
    assert.deepEqual(await responses[0].json(), await responses[1].json());
    assert.equal((await assign({ ...term, endsAt: at(2) })).status, 409);
    assert.equal((await request(history + '/cancel', writer.cookie, { requestKey: term.requestKey })).status, 409);
    const audits = await db.auditEvent.findMany({ where: { requestId: term.requestKey } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].businessId, parent.id);
    assert.equal(audits[0].subjectId, outlet.id);
  });

  await t.test('retains immutable history across renewal and cancellation, and rejects expiry and overlap', async () => {
    const renewal = { ...term, requestKey: randomUUID(), planCode: 'pro', startsAt: term.endsAt, endsAt: at(5) };
    assert.equal((await assign({ ...term, requestKey: randomUUID() })).status, 409);
    const renew = (body: object) => request(history + '/renew', writer.cookie, body);
    assert.equal((await renew({ ...renewal, startsAt: term.startsAt })).status, 409);
    assert.equal((await renew({ ...renewal, startsAt: at(-3), endsAt: at(-2) })).status, 409);
    await db.$executeRaw`ALTER TABLE control.audit_event ADD CONSTRAINT test_service_plan_failure CHECK (action <> 'servicePlan.renew') NOT VALID`;
    try {
      assert.equal((await renew(renewal)).status, 500);
    } finally { await db.$executeRaw`ALTER TABLE control.audit_event DROP CONSTRAINT test_service_plan_failure`; }
    assert.equal(await db.outletServiceTerm.count({ where: { requestKey: renewal.requestKey } }), 0);
    const renewed = await renew(renewal);
    const replayed = await renew(renewal);
    assert.deepEqual([renewed.status, replayed.status], [201, 201]);
    assert.deepEqual(await renewed.json(), await replayed.json());
    assert.equal(await db.auditEvent.count({ where: { requestId: renewal.requestKey } }), 1);
    const cancel = { requestKey: randomUUID() };
    assert.equal((await request(history + '/cancel', writer.cookie, cancel)).status, 201);
    type Page = { items: { operation: string; endsAt: string | null }[]; nextCursor: number | null };
    const read = async (query: string) => (await (await request(history + query, reader.cookie)).json()) as Page;
    const page = await read('?limit=1');
    assert.deepEqual(page.items.map((row) => row.operation), ['cancel']);
    const previous = await read('?cursor=' + page.nextCursor);
    assert.deepEqual(previous.items.map((row) => [row.operation, row.endsAt]), [['renew', renewal.endsAt], ['assign', term.endsAt]]);
    assert.equal(previous.nextCursor, null);

    await db.business.update({ where: { id: parent.id }, data: { archived: true } });
    assert.equal((await assign({ ...term, requestKey: randomUUID(), startsAt: term.endsAt })).status, 400);
    assert.equal((await assign({ ...term, requestKey: randomUUID(), startsAt: at(1), endsAt: at(2) })).status, 409);
    assert.equal((await assign()).status, 201);
  });

  await t.test('limits runtime inserts by composite outlet scope and prevents rewriting history', async () => {
    const runtime = (sql: 'update' | 'scope') => db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
      if (sql === 'update') return tx.$executeRaw`UPDATE control.outlet_service_term SET revision = 9`;
      return tx.$executeRaw`INSERT INTO control.outlet_service_term (id, business_id, outlet_id, revision, request_key, operation)
        VALUES (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${outlet.id}::uuid, 9, ${randomUUID()}::uuid, 'cancel')`;
    });
    const pgError = (code: string) => (error: unknown) => (error as { meta?: { code?: string } }).meta?.code === code;
    await assert.rejects(runtime('update'), pgError('42501'));
    await assert.rejects(runtime('scope'), pgError('23503'));
  });
}
