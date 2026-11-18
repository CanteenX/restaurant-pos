import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';
import { portalDigest } from './portal-identity-policy.js';

// The calling identity fixture supplies the same isolated portal key and synthetic local installer.
export async function portalReadCases(t: TestContext, db: PrismaClient, root: string, key: string) {
  const actor = await db.staff.create({ data: { id: randomUUID(), email: randomUUID() + '@example.test', passwordHash: 'fixture' } });
  async function tenant(displayName: string, byte: number) {
    const business = await db.business.create({ data: { id: randomUUID(), legalName: 'Private legal name', displayName } });
    const outlet = await db.outlet.create({ data: { id: randomUUID(), businessId: business.id, displayName, timeZone: 'Asia/Kolkata' } });
    const account = randomUUID(), email = account + '@example.test', token = Buffer.alloc(32, byte).toString('base64url');
    const digest = portalDigest(key, 'session', token);
    await db.$executeRaw`INSERT INTO control.portal_account(id, business_id, email, status, password_hash)
      VALUES (${account}::uuid, ${business.id}::uuid, ${email}, 'active', 'fixture')`;
    await db.$executeRaw`INSERT INTO control.portal_session(digest, account_id, expires_at)
      VALUES (${digest}, ${account}::uuid, now() + interval '1 hour')`;
    const invoice = await db.billingInvoice.create({ data: { id: randomUUID(), businessId: business.id, createdBy: actor.id,
      requestKey: randomUUID(), reference: 'INV', description: displayName, amountPaise: 5000n, dueOn: new Date('2025-01-01') } });
    const payment = await db.billingPayment.create({ data: { id: randomUUID(), businessId: business.id, invoiceId: invoice.id,
      createdBy: actor.id, requestKey: randomUUID(), method: 'upi', reference: 'SYNTHETIC', amountPaise: 1000n } });
    return { business, outlet, account, invoice, payment, digest, cookie: '__Host-control_portal=' + token };
  }
  const [a,b] = await Promise.all([tenant('Portal A', 17),tenant('Portal B', 18)]);
  const get = (path: string, cookie = a.cookie) => fetch(new URL('portal/' + path, root), { headers: { cookie } });
  type Page = { items: { id: string; amountPaise?: number; paidPaise?: number; balancePaise?: number;
    overdue?: boolean; plan?: { label: string } | null }[]; nextCursor: string | null };
  type Summary = { business: { id: string; displayName: string }; hostedStatus: string; supportEmail: string; paymentInstructions: string };
  const json = async <T = Page>(path: string, cookie?: string): Promise<T> => {
    const response = await get(path, cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return await response.json() as T;
  };
  await t.test('shows only the signed-in business, invoice balances, payments and current outlet plans', async () => {
    const summary = await json<Summary>('summary');
    assert.deepEqual(summary.business, { id: a.business.id, displayName: 'Portal A' });
    assert.equal(summary.hostedStatus, 'active');
    assert.equal(summary.supportEmail, 'nventra01@gmail.com');
    assert.ok(summary.paymentInstructions);
    const [invoice] = (await json('invoices')).items;
    assert.deepEqual([invoice.id, invoice.amountPaise, invoice.paidPaise, invoice.balancePaise, invoice.overdue],
      [a.invoice.id, 5000, 1000, 4000, true]);
    assert.deepEqual(Object.keys(invoice).sort(), ['id','businessId','reference','description','createdAt','dueOn',
      'amountPaise','paidPaise','balancePaise','overdue'].sort());
    assert.equal((await json('invoices/' + a.invoice.id + '/payments')).items[0].id, a.payment.id);
    assert.equal((await get('invoices/' + b.invoice.id + '/payments')).status, 404);
    assert.equal((await json('invoices', b.cookie)).items[0].id, b.invoice.id);
    for (const path of ['summary?businessId=' + b.business.id,'invoices?limit=999','outlets?cursor=wrong']) {
      assert.equal((await get(path)).status, 400);
    }
    assert.equal((await get('outlets', '')).status, 401);
    const startsAt = new Date(Date.now() - 3600000), endsAt = new Date(Date.now() + 3600000);
    await db.outletServiceTerm.create({ data: { id: randomUUID(), businessId: a.business.id, outletId: a.outlet.id,
      revision: 1, requestKey: randomUUID(), operation: 'assign', planCode: 'starter', planVersion: 1, startsAt, endsAt } });
    assert.deepEqual(await json('outlets'), { items: [{ id: a.outlet.id, displayName: 'Portal A', timeZone: 'Asia/Kolkata',
      plan: { label: 'Starter', startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } }], nextCursor: null });
    await db.outletServiceTerm.create({ data: { id: randomUUID(), businessId: a.business.id, outletId: a.outlet.id,
      revision: 2, requestKey: randomUUID(), operation: 'cancel' } });
    assert.equal((await json('outlets')).items[0].plan, null);
  });
  await t.test('portal role reads only scoped projections and cannot update history or underlying business rows', async () => {
    await db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL ROLE control_portal_runtime`;
      const [privileges] = await tx.$queryRaw<{ broad: boolean; mutable: boolean }[]>`SELECT
        EXISTS(SELECT FROM (VALUES ('control.business'),('control.outlet'),('control.billing_invoice'),
          ('control.billing_payment'),('control.hosted_access_event'),('control.outlet_service_term')) AS t(name)
          WHERE has_any_column_privilege(current_user, name, 'SELECT')) AS broad,
        EXISTS(SELECT FROM (VALUES ('control.portal_invoice'),('control.portal_payment'),('control.portal_outlet')) AS t(name)
          WHERE has_table_privilege(current_user, name, 'INSERT,UPDATE,DELETE')) AS mutable`;
      assert.deepEqual(privileges, {broad: false, mutable: false});
      assert.deepEqual(await tx.$queryRaw`SELECT id FROM control.portal_invoice`, []);
      await tx.$queryRaw`SELECT set_config('control.portal_business_id', ${a.business.id}, true),
        set_config('control.portal_account_id', ${b.account}, true)`;
      assert.deepEqual(await tx.$queryRaw`SELECT id FROM control.portal_invoice`, []);
      await tx.$queryRaw`SELECT set_config('control.portal_account_id', ${a.account}, true)`;
      assert.deepEqual(await tx.$queryRaw`SELECT id FROM control.portal_invoice`, [{id: a.invoice.id}]);
      assert.deepEqual(await tx.$queryRaw`SELECT id FROM control.portal_payment`, [{id: a.payment.id}]);
      assert.deepEqual(await tx.$queryRaw`SELECT id FROM control.portal_outlet`, [{id: a.outlet.id}]);
    });
  });
  const file = 'downloads/windows-installer';
  await t.test('rechecks suspension for an existing cookie and for every local file request', async () => {
    assert.deepEqual(await json('downloads'), { items: [{ id: 'windows-installer', label: 'Windows installer' }] });
    const downloaded = await get(file);
    assert.equal(downloaded.headers.get('content-disposition'), 'attachment; filename="OrderRestro.msix"');
    assert.equal(await downloaded.text(), 'fixture installer');
    assert.equal((await get('downloads/private.txt')).status, 404);
    let request: Promise<Response> | undefined;
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM control.business WHERE id=${a.business.id}::uuid FOR UPDATE`;
      await tx.$executeRaw`INSERT INTO control.hosted_access_event(business_id,request_key,actor_id,revision,status,reason)
        VALUES (${a.business.id}::uuid,${randomUUID()}::uuid,${actor.id}::uuid,1,'suspended','Synthetic hold')`;
      request = get(file);
      for (let i = 0; i < 80; ++i) {
        await tx.$queryRaw`SELECT pg_stat_clear_snapshot() IS NULL AS cleared`;
        const [lock] = await tx.$queryRaw<{waiting:boolean}[]>`SELECT EXISTS(SELECT FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS waiting`;
        if (lock.waiting) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('Portal request did not wait for the pending hosted transition');
    });
    assert.equal((await request!).status, 403);
    for (const path of ['outlets','downloads',file]) assert.equal((await get(path)).status, 403);
    assert.equal((await json<Summary>('summary')).hostedStatus, 'suspended');
    assert.equal((await json('invoices')).items.length, 1);
    assert.equal((await json('invoices/' + a.invoice.id + '/payments')).items.length, 1);
    assert.equal((await get(file, b.cookie)).status, 200);
    await db.$executeRaw`INSERT INTO control.hosted_access_event(business_id,request_key,actor_id,revision,status,reason)
      VALUES (${a.business.id}::uuid,${randomUUID()}::uuid,${actor.id}::uuid,2,'active','Synthetic restore')`;
    assert.equal((await get(file)).status, 200);
    await db.business.update({ where: {id: b.business.id}, data: {archived: true} });
    assert.equal((await get('summary', b.cookie)).status, 404);
    await db.business.update({ where: {id: b.business.id}, data: {archived: false} });
    await db.$executeRaw`UPDATE control.portal_account SET status='revoked', password_hash=NULL WHERE id=${b.account}::uuid`;
    for (const path of ['summary','invoices','outlets',file]) assert.equal((await get(path, b.cookie)).status, 401);
    await db.$executeRaw`UPDATE control.portal_session SET expires_at=now()-interval '1 second' WHERE digest=${a.digest}`;
    for (const path of ['summary','invoices','outlets',file]) assert.equal((await get(path)).status, 401);
  });
}
