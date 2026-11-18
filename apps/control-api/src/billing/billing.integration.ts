import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';

export async function billingCases(t: TestContext, db: PrismaClient, url: string, origin: string) {
  const actor = async (grants: string[], age = 0) => {
    const id = randomUUID(), token = Buffer.from(id).subarray(0, 32).toString('base64url');
    await db.staff.create({ data: { id, email: id + '@example.test', passwordHash: 'inert', grants } });
    await db.staffSession.create({
      data: {
        staffId: id,
        digest: createHmac('sha256', 'a5'.repeat(32)).update('session\0' + token).digest('hex'),
        verifiedAt: new Date(Date.now() - age), expiresAt: new Date(Date.now() + 600_000)
      }
    });
    return '__Host-control_staff=' + token;
  };
  const [reader, writer, other, stale, sales] = await Promise.all([
    actor(['cc.billing.read']), actor(['cc.billing.manage']), actor(['cc.billing.manage']),
    actor(['cc.billing.manage'], 660_000), actor(['cc.business.manage']),
  ]);
  const business = () => db.business.create({ data: { id: randomUUID(), legalName: 'Fixture', displayName: 'Fixture' } });
  const [a, b] = await Promise.all([business(), business()]);
  const base = 'businesses/' + a.id + '/invoices', foreign = 'businesses/' + b.id + '/invoices';
  const issue = { reference: 'Manual 1', description: 'Support subscription', amountPaise: 1200, dueOn: '2020-02-29', requestKey: randomUUID() };
  const payment = { reference: 'Transfer 1', method: 'upi', amountPaise: 500, requestKey: randomUUID() };
  const call = (path: string, cookie: string, body?: object) => fetch(url + path, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, origin, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  await t.test('requires explicit billing grants and recent verification; validates money, dates and pagination', async () => {
    assert.equal((await call(base, '')).status, 401);
    assert.equal((await call(base, sales)).status, 403);
    assert.equal((await call(base, reader, issue)).status, 403);
    assert.equal((await call(base, stale, issue)).status, 403);
    for (const patch of [{ amountPaise: 0 }, { amountPaise: 1.01 }, { amountPaise: '1200' }, { amountPaise: Number.MAX_SAFE_INTEGER + 1 },
    { dueOn: '2021-02-29' }, { dueOn: '2026-03-04T00:00:00Z' }, { reference: ' ' }, { description: 'bad\0value' }, { tax: 10 }]) {
      assert.equal((await call(base, writer, { ...issue, ...patch })).status, 400);
    }
    assert.equal((await call(base + '?limit=999', reader)).status, 400);
    assert.equal((await call('billing/overdue?sales=1', reader)).status, 400);
  });
  await t.test('records immutable scoped invoices, partial payments, same-key retries and concurrent balances', async () => {
    const posted = await call(base, writer, issue);
    assert.equal(posted.status, 201);
    const invoice = await posted.json() as { id: string; dueOn: string; paidPaise: number; balancePaise: number; overdue: boolean };
    assert.deepEqual([invoice.dueOn, invoice.paidPaise, invoice.balancePaise, invoice.overdue], [issue.dueOn, 0, 1200, true]);
    assert.deepEqual(await (await call(base, writer, issue)).json(), invoice);
    assert.equal((await call(base, writer, { ...issue, amountPaise: 500 })).status, 409);
    assert.equal((await call(base, other, issue)).status, 409);
    const path = base + '/' + invoice.id + '/payments', wrong = foreign + '/' + invoice.id + '/payments';
    assert.equal((await call(wrong, reader)).status, 404);
    assert.equal((await call(wrong, writer, payment)).status, 404);
    assert.equal((await call(path, writer, { ...payment, method: 'cash' })).status, 400);
    const pair = await Promise.all([call(path, writer, payment), call(path, writer, payment)]);
    assert.deepEqual(pair.map(p => p.status), [201, 201]);
    assert.deepEqual(await pair[0].json(), await pair[1].json());
    assert.equal((await call(path, writer, { ...payment, reference: 'changed' })).status, 409);
    assert.equal((await call(path, writer, { ...payment, reference: ' Transfer 1 ', requestKey: randomUUID() })).status, 409);
    const overdue = await (await call('billing/overdue?businessId=' + a.id, reader)).json() as { items: { paidPaise: number; balancePaise: number }[] };
    assert.deepEqual(overdue.items.map(i => [i.paidPaise, i.balancePaise]), [[500, 700]]);
    assert.deepEqual(await (await call('billing/overdue?businessId=' + b.id, reader)).json(), { items: [], nextCursor: null });
    const race = await Promise.all([writer, other].map((cookie, index) => call(path, cookie, { ...payment, reference: 'Final ' + index, amountPaise: 700, requestKey: randomUUID() })));
    assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
    const history = await (await call(path + '?limit=1', reader)).json() as { items: { id: string }[]; nextCursor: string };
    assert.ok(history.nextCursor);
    const next = await (await call(path + '?limit=1&cursor=' + history.nextCursor, reader)).json() as typeof history;
    assert.notEqual(history.items[0].id, next.items[0].id);
    assert.equal(next.nextCursor, null);
    assert.deepEqual(await (await call('billing/overdue?businessId=' + a.id, reader)).json(), { items: [], nextCursor: null });
    const totals = await (await call(base, reader)).json() as typeof overdue;
    assert.deepEqual(totals.items.map(i => [i.paidPaise, i.balancePaise]), [[1200, 0]]);
    assert.equal(await db.auditEvent.count({ where: { businessId: a.id, action: 'billing.invoice.create' } }), 1);
    assert.equal(await db.auditEvent.count({ where: { businessId: a.id, action: 'billing.payment.record' } }), 2);
  });
  await t.test('uses the Kolkata calendar, preserves immutable grants and rolls back when audit fails', async () => {
    const [{ today }] = await db.$queryRaw<{ today: string }[]>`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`;
    const current = await call(foreign, writer, { ...issue, dueOn: today, requestKey: randomUUID() });
    assert.equal(current.status, 201);
    const { id, overdue } = await current.json() as { id: string; overdue: boolean };
    assert.equal(overdue, false);
    await db.$executeRaw`ALTER TABLE control.audit_event ADD CONSTRAINT fixture_billing_audit CHECK (action NOT LIKE 'billing.%') NOT VALID`;
    try {
      assert.equal((await call(foreign, writer, { ...issue, requestKey: randomUUID() })).status, 500);
      assert.equal((await call(foreign + '/' + id + '/payments', writer, payment)).status, 500);
      const list = await (await call(foreign, reader)).json() as { items: { balancePaise: number }[] };
      assert.deepEqual(list.items.map(i => i.balancePaise), [1200]);
    } finally { await db.$executeRaw`ALTER TABLE control.audit_event DROP CONSTRAINT fixture_billing_audit`; }
    const direct = (key: string, amount: number) => db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL ROLE control_runtime`;
      await tx.$executeRaw`INSERT INTO control.billing_payment(id,business_id,invoice_id,created_by,request_key,reference,method,amount_paise)
        SELECT ${randomUUID()}::uuid,business_id,id,created_by,${key}::uuid,${key},'bank_transfer',${amount}
        FROM control.billing_invoice WHERE id=${id}::uuid`;
    });
    const keys = [randomUUID(), randomUUID()];
    const competing = await Promise.allSettled(keys.map(key => direct(key, 800)));
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(await db.auditEvent.count({ where: { requestId: { in: keys }, action: 'billing.payment.record' } }), 1);
    const [grants] = await db.$queryRaw<{ safe: boolean }[]>`SELECT NOT EXISTS (
      SELECT FROM (VALUES ('control.billing_invoice'),('control.billing_payment')) t(name)
      WHERE has_table_privilege('control_runtime',name,'UPDATE,DELETE,TRUNCATE')
        OR has_table_privilege('control_mail_worker',name,'SELECT,INSERT')) AS safe`;
    assert.ok(grants.safe);
  });
  await t.test('retains each paise at the safe integer ceiling and scopes unknown businesses', async () => {
    const tenant = await business();
    const path = 'businesses/' + tenant.id + '/invoices';
    assert.equal((await call('businesses/' + randomUUID() + '/invoices', reader)).status, 404);
    const posted = await call(path, writer, { ...issue, amountPaise: Number.MAX_SAFE_INTEGER, requestKey: randomUUID() });
    const { id } = await posted.json() as { id: string };
    assert.equal(posted.status, 201);
    const paid = Number.MAX_SAFE_INTEGER - 1;
    assert.equal((await call(path + '/' + id + '/payments', writer, { ...payment, amountPaise: paid })).status, 201);
    const list = await (await call(path, reader)).json() as { items: { amountPaise: number; paidPaise: number; balancePaise: number }[] };
    assert.deepEqual(list.items.map(i => [i.amountPaise, i.paidPaise, i.balancePaise]), [[Number.MAX_SAFE_INTEGER, paid, 1]]);
  });
}
