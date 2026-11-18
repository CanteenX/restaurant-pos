import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';

export async function portalIdentityCases(t: TestContext, db: PrismaClient, root: string, origin: string) {
  async function staff(grants: string[], age = 0) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.staff.create({ data: { id, email: id + '@example.test', grants, passwordHash: 'inert' } });
    const digest = createHmac('sha256', 'a5'.repeat(32)).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { staffId: id, digest, verifiedAt: new Date(Date.now() - age),
      expiresAt: new Date(Date.now() + 900_000) } });
    return '__Host-control_staff=' + token;
  }
  const manager = await staff(['cc.portal.manage']), reader = await staff(['cc.portal.read']);
  const stale = await staff(['cc.portal.manage'], 660_000);
  const business = () => db.business.create({ data: { id: randomUUID(), legalName: 'Synthetic', displayName: 'Fixture' } });
  const [a,b] = await Promise.all([business(),business()]);
  const directory = (id: string) => 'businesses/' + id + '/portal-accounts';
  const request = (path: string, body?: object, cookie = '', from = origin) =>
    fetch(new URL(path, root), { method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, origin: from, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const email = 'client@example.test', password = 'synthetic valid portal password';
  type Invitation = { account: { id: string; email: string; status: string }; activationCode: string; expiresAt: string };
  const create = async (address: string) => {
    const issued = await request(directory(a.id), { email: address }, manager);
    assert.equal(issued.status, 201);
    assert.equal(issued.headers.get('cache-control'), 'no-store');
    return await issued.json() as Invitation;
  };
  const cookieOf = (response: Response) => {
    const header = response.headers.get('set-cookie');
    assert.match(header ?? '', /^__Host-control_portal=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/);
    return header!.split(';')[0];
  };
  let account: Invitation['account'], activeCookie: string;

  await t.test('requires separate staff permissions and recent 2FA, with no activation secrets in lists', async () => {
    assert.equal((await request(directory(a.id), undefined, manager)).status, 403);
    assert.equal((await request(directory(a.id), { email }, reader)).status, 403);
    assert.equal((await request(directory(a.id), { email }, stale)).status, 403);
    assert.equal((await request(directory(a.id), { email }, manager, 'https://wrong.example.test')).status, 403);
    assert.equal((await request(directory(a.id), { email, businessId: b.id }, manager)).status, 400);
    const issued = await create(email.toUpperCase());
    account = issued.account;
    assert.deepEqual({ email: account.email, status: account.status }, { email, status: 'pending' });
    assert.ok(Date.parse(issued.expiresAt) > Date.now());
    const list = await (await request(directory(a.id), undefined, reader)).json() as { items: Invitation['account'][] };
    assert.deepEqual(list.items, [account]);
    assert.equal(JSON.stringify(list).includes(issued.activationCode), false);
    assert.equal((await request(directory(b.id), { email }, manager)).status, 409);
    assert.equal((await request(directory(b.id) + '/' + account.id + '/reissue', {}, manager)).status, 404);
    assert.equal((await request('portal/activate', { code: issued.activationCode, password }, '',
      'https://wrong.example.test')).status, 403);

    const redeem = () => request('portal/activate', { code: issued.activationCode, password });
    const responses = await Promise.all([redeem(), redeem()]);
    assert.deepEqual(responses.map((v) => v.status).sort(), [200,401]);
    const accepted = responses.find((v) => v.ok)!;
    activeCookie = cookieOf(accepted);
    assert.deepEqual(await accepted.json(), { accountId: account.id, businessId: a.id, email });
  });

  await t.test('sessions remain tenant-bound, cookie audiences differ and daily operations use live revocation', async () => {
    const path = directory(a.id) + '/' + account.id;
    assert.equal((await request('portal/session', undefined, reader)).status, 401);
    assert.equal((await request('businesses', undefined, activeCookie)).status, 401);
    const session = await request('portal/session', undefined, activeCookie);
    assert.equal(session.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await session.json(), { accountId: account.id, businessId: a.id, email });
    assert.equal((await request('portal/session', { email, password, businessId: b.id })).status, 400);
    const loggedIn = await request('portal/session', { email: email.toUpperCase(), password });
    const second = cookieOf(loggedIn);
    assert.equal((await request('portal/logout', {}, second, 'https://wrong.example.test')).status, 403);
    const logout = await request('portal/logout', {}, second);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0$/);
    assert.equal((await request('portal/session', undefined, second)).status, 401);
    const reissued = await request(path + '/reissue', {}, manager);
    assert.equal(reissued.status, 200);
    const invitation = await reissued.json() as Invitation;
    assert.equal((await request('portal/session', undefined, activeCookie)).status, 401);
    assert.equal((await request('portal/session', { email, password })).status, 401);
    const next = await request('portal/activate', { code: invitation.activationCode, password });
    const nextCookie = cookieOf(next);
    assert.equal((await request(path + '/revoke', {}, manager)).status, 200);
    assert.equal((await request('portal/session', undefined, nextCookie)).status, 401);
    assert.equal((await request('portal/session', { email, password })).status, 401);
  });

  await t.test('denies expired activation and rate limits normalized login identities with a redacted response', async () => {
    const pending = await create('expired-client@example.test');
    await db.$executeRaw`UPDATE control.portal_account SET activation_expires_at = now() - interval '1 second'
      WHERE id = ${pending.account.id}::uuid`;
    assert.equal((await request('portal/activate', { code: pending.activationCode, password })).status, 401);
    for (let i = 0; i < 8; ++i) {
      assert.equal((await request('portal/session', { email: 'UNKNOWN@example.test', password })).status, 401);
    }
    const limited = await request('portal/session', { email: 'unknown@example.test', password });
    assert.equal(limited.status, 429);
    assert.equal(await limited.text(), '');
  });
}
