import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Prisma, type PrismaClient } from '../../node_modules/.prisma/control-client/index.js';

export async function businessCases(t: TestContext, db: PrismaClient, url: string, origin: string) {
  const actor = async (grants: string[]) => {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.staff.create({ data: { id, email: id + '@example.test', grants, passwordHash: 'inert' } });
    const digest = createHmac('sha256', 'a5'.repeat(32)).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { staffId: id, digest, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 600_000) } });
    return { id, cookie: '__Host-control_staff=' + token };
  };
  const writer = await actor(['cc.business.manage']), reader = await actor(['cc.business.read']);
  const request = (path = '', cookie = reader.cookie, method = 'GET', body?: unknown, from = origin) =>
    fetch(url + path, { method, headers: { cookie, origin: from, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const business = { legalName: 'Synthetic Co', displayName: 'Synthetic' };
  const outlet = { displayName: 'Sample outlet', timeZone: 'Asia/Kolkata' };
  const create = async (path: string, body: unknown) => {
    const res = await request(path, writer.cookie, 'POST', body);
    assert.equal(res.status, 201);
    return (await res.json() as { id: string }).id;
  };
  await t.test('requires a Control staff cookie, the exact action permission and matching origin', async () => {
    assert.equal((await request('', '')).status, 401);
    assert.equal((await request('', reader.cookie.replace('__Host-control_staff', 'portal'))).status, 401);
    assert.equal((await request('', writer.cookie)).status, 403);
    assert.equal((await request('', reader.cookie, 'POST', business)).status, 403);
    assert.equal((await request('', writer.cookie, 'POST', business, 'https://other.example.test')).status, 403);
    assert.equal((await request('?limit=0')).status, 400);
    assert.equal((await request('/invalid')).status, 400);
  });
  const a = await create('', business), b = await create('', { ...business, legalName: 'Another Co' });
  const nested = '/' + a + '/outlets', id = await create(nested, outlet), detail = nested + '/' + id;
  await t.test('pages registry rows and enforces business scope for outlet reads and writes', async () => {
    const first = await (await request('?limit=1')).json() as { items: { id: string }[]; nextCursor: string };
    assert.equal(first.items.length, 1);
    const next = await (await request('?limit=1&cursor=' + first.nextCursor)).json() as typeof first;
    assert.notEqual(first.items[0].id, next.items[0].id);
    assert.equal((await request('/' + a)).status, 200);
    assert.equal((await request(detail)).status, 200);
    assert.equal((await request('/' + b + '/outlets/' + id)).status, 404);
    assert.equal((await request('/' + b + '/outlets/' + id, writer.cookie, 'PATCH', { archived: true })).status, 404);
    const empty = await (await request('/' + b + '/outlets')).json() as typeof first;
    assert.equal(empty.items.length, 0);
    assert.equal((await request(nested, writer.cookie, 'POST', { ...outlet, businessId: b })).status, 400);
    assert.equal((await request(nested, writer.cookie, 'POST', { ...outlet, timeZone: 'Invalid/Nowhere' })).status, 400);
    assert.equal((await request(detail, writer.cookie, 'PATCH', {})).status, 400);
    assert.equal((await request(detail, writer.cookie, 'PATCH', { archived: true })).status, 200);
    assert.equal((await request(detail, writer.cookie, 'PATCH', { archived: false })).status, 200);
    assert.equal((await request(detail, writer.cookie, 'PATCH', { displayName: outlet.displayName })).status, 200);
  });
  await t.test('PostgreSQL rejects an outlet paired with the wrong business in a scoped reference', async () => {
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRaw`CREATE TABLE control.test_scoped_reference (business_id uuid, outlet_id uuid,
        FOREIGN KEY (business_id, outlet_id) REFERENCES control.outlet(business_id, id))`;
      await tx.$executeRaw`INSERT INTO control.test_scoped_reference VALUES (${a}::uuid, ${id}::uuid)`;
      await tx.$executeRaw`INSERT INTO control.test_scoped_reference VALUES (${b}::uuid, ${id}::uuid)`;
    }), (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.meta?.code === '23503');
  });
  await t.test('commits business/outlet changes with redacted audit metadata and rolls back on audit failure', async () => {
    const rows = await db.auditEvent.findMany({ where: { actorId: writer.id }, orderBy: { sequence: 'asc' } });
    assert.deepEqual(rows.map((v) => v.action),
      ['business.create', 'business.create', 'outlet.create', 'outlet.update', 'outlet.update', 'outlet.update']);
    assert.deepEqual(rows[5].changedFields, []);
    assert.deepEqual(rows[2].changedFields.sort(), ['displayName', 'timeZone']);
    assert.equal(rows[2].businessId, a);
    assert.equal(rows[2].subjectId, id);
    await db.$executeRaw`ALTER TABLE control.audit_event ADD CONSTRAINT test_business_failure CHECK (action <> 'business.update') NOT VALID`;
    try {
      assert.equal((await request('/' + a, writer.cookie, 'PATCH', { legalName: 'Discarded name' })).status, 500);
      assert.equal((await (await request('/' + a)).json() as typeof business).legalName, business.legalName);
    } finally { await db.$executeRaw`ALTER TABLE control.audit_event DROP CONSTRAINT test_business_failure`; }
  });
  await t.test('blocks outlet creation racing with archive and preserves historical records', async () => {
    let pending: Promise<Response> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE control.business SET archived = true WHERE id = ${a}::uuid`;
      pending = request(nested, writer.cookie, 'POST', outlet);
      let blocked = false;
      const deadline = Date.now() + 5_000;
      while (!blocked && Date.now() < deadline) {
        const [row] = await tx.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
          SELECT FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS blocked`;
        blocked = row.blocked;
        if (!blocked) await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(blocked, true);
    }, { timeout: 10_000 });
    assert.equal((await pending)?.status, 409);
    assert.equal((await request(detail)).status, 200);
    assert.equal((await request(detail, writer.cookie, 'PATCH', { archived: false })).status, 409);
    assert.equal((await request('/' + b, writer.cookie, 'PATCH', { archived: true })).status, 200);
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
      await tx.$executeRaw`INSERT INTO control.outlet (id, business_id, display_name, time_zone)
        VALUES (${randomUUID()}::uuid, ${a}::uuid, 'direct fixture', 'UTC')`;
    }), (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.meta?.code === '23514');
    const history = await (await request(nested)).json() as { items: unknown[] };
    assert.equal(history.items.length, 1);
  });
}
