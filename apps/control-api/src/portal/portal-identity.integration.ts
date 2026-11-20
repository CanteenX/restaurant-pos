import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { portalReadCases } from './portal-read.integration.js';
import { portalTicketCases } from '../helpdesk/portal/portal-tickets.integration.js';
import { roleRouteMatrixCases } from '../staff/role-route-matrix.integration.js';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';
import { Prisma } from '../../node_modules/.prisma/control-client/index.js';
import { createControlApi } from '../bootstrap.js';
import { openPortalDatabase } from './portal-database.js';

export async function portalIdentityCases(t: TestContext, db: PrismaClient, fixtureUrl: string,
  disabledRoot: string, origin: string) {
  assert.equal((await fetch(new URL('portal/session', disabledRoot))).status, 404);
  await db.$executeRaw`CREATE ROLE control_portal_runtime NOLOGIN`;
  await db.$executeRaw`CREATE ROLE cc325_portal_fixture LOGIN PASSWORD 'public_loopback_fixture' IN ROLE control_portal_runtime`;
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'execute',
    '--file', 'operator/portal-runtime-grants.sql', '--schema', 'prisma/schema.prisma'],
  { env: { ...process.env, CONTROL_DATABASE_URL: fixtureUrl }, stdio: 'ignore', timeout: 30_000 });
  const portalUrl = new URL(fixtureUrl), staffUrl = new URL(fixtureUrl);
  portalUrl.username = 'cc325_portal_fixture';
  portalUrl.password = 'public_loopback_fixture';
  staffUrl.searchParams.set('options', '-c role=control_runtime');

  await t.test('requires the actual dedicated portal login and keeps auth storage isolated', async () => {
    await assert.rejects(openPortalDatabase(fixtureUrl), /^Error: Invalid Control portal database identity$/);
    await assert.rejects(openPortalDatabase(staffUrl.toString()), /^Error: Invalid Control portal database identity$/);
    await db.$executeRaw`GRANT SELECT (description) ON control.billing_invoice TO cc325_portal_fixture`;
    try {
      await assert.rejects(openPortalDatabase(portalUrl.toString()), /^Error: Invalid Control portal database identity$/);
    } finally {
      await db.$executeRaw`REVOKE SELECT (description) ON control.billing_invoice FROM cc325_portal_fixture`;
    }
    await db.$executeRaw`GRANT SELECT (subject) ON control.ticket TO cc325_portal_fixture`;
    try {
      await assert.rejects(openPortalDatabase(portalUrl.toString()), /^Error: Invalid Control portal database identity$/);
    } finally {
      await db.$executeRaw`REVOKE SELECT (subject) ON control.ticket FROM cc325_portal_fixture`;
    }
    const [grants] = await db.$queryRaw<{ portalBusiness: boolean; portalStaff: boolean; staffVerifier: boolean }[]>`
      SELECT has_any_column_privilege('cc325_portal_fixture','control.business','SELECT,UPDATE') AS "portalBusiness",
        has_any_column_privilege('cc325_portal_fixture','control.staff','SELECT,UPDATE') AS "portalStaff",
        has_column_privilege('control_runtime','control.portal_account','password_hash','SELECT') AS "staffVerifier"`;
    assert.deepEqual(grants, { portalBusiness: false, portalStaff: false, staffVerifier: false });
  });

  await t.test('denies direct reads and writes of stored portal credentials and sessions', async () => {
    const restricted = [
      Prisma.sql`SELECT activation_digest FROM control.portal_account WHERE false`,
      Prisma.sql`SELECT password_hash FROM control.portal_account WHERE false`,
      Prisma.sql`UPDATE control.portal_account SET status = 'revoked', password_hash = NULL, activation_digest = NULL,
        activation_expires_at = NULL WHERE false`,
      Prisma.sql`SELECT digest FROM control.portal_session WHERE false`,
      Prisma.sql`INSERT INTO control.portal_session(digest,account_id,expires_at)
        SELECT repeat('a',64), gen_random_uuid(), clock_timestamp() WHERE false`,
      Prisma.sql`DELETE FROM control.portal_session WHERE false`,
    ];
    const states = [];
    for (const operation of restricted) {
      try {
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL ROLE control_portal_runtime`;
          await tx.$executeRaw(operation);
        });
        states.push('allowed');
      } catch (error) {
        states.push(error instanceof Prisma.PrismaClientKnownRequestError ? error.meta?.code : 'unexpected');
      }
    }
    assert.deepEqual(states, restricted.map(() => '42501'));
  });

  await t.test('grants only the dedicated role five pinned auth functions', async () => {
    const [functions] = await db.$queryRaw<{ count: number; secured: boolean }[]>`
      SELECT count(*)::int, bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
        AND pg_catalog.has_function_privilege('control_portal_runtime',p.oid,'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('control_runtime',p.oid,'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('control_audit_ungranted',p.oid,'EXECUTE')) AS secured
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='control' AND p.proname IN ('portal_activate','portal_login_verifier',
        'portal_open_session','portal_lock_session','portal_logout')`;
    assert.deepEqual(functions, { count: 5, secured: true });
  });

  const releaseDirectory = await mkdtemp(path.join(await realpath(tmpdir()), 'control-portal-fixture-'));
  t.after(() => rm(releaseDirectory, { recursive: true, force: true }));
  await writeFile(path.join(releaseDirectory, 'OrderRestro.msix'), 'fixture installer');
  const { app } = await createControlApi({ CONTROL_API_PORT: '4002', CONTROL_DATABASE_URL: staffUrl.toString(),
    CONTROL_AUTH_KEY: 'a5'.repeat(32), CONTROL_ORIGIN: origin,
    CONTROL_PORTAL_DOWNLOAD_DIR: releaseDirectory, CONTROL_PORTAL_DATABASE_URL: portalUrl.toString(), CONTROL_PORTAL_AUTH_KEY: 'a6'.repeat(32) });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const root = (await app.getUrl()) + '/api/control/v1/';

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
  const request = (path: string, body?: object | null, cookie = '', from = origin) =>
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
    assert.equal((await request('portal/logout', null, second)).status, 400);
    const logout = await request('portal/logout', {}, second);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0$/);
    assert.equal((await request('portal/session', undefined, second)).status, 401);

    await db.$executeRaw`ALTER TABLE control.audit_event ADD CONSTRAINT test_portal_audit
      CHECK (action <> 'portalAccount.reissue') NOT VALID`;
    try {
      assert.equal((await request(path + '/reissue', {}, manager)).status, 500);
      assert.equal((await request('portal/session', undefined, activeCookie)).status, 200);
    } finally { await db.$executeRaw`ALTER TABLE control.audit_event DROP CONSTRAINT test_portal_audit`; }

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
  await portalReadCases(t, db, root, 'a6'.repeat(32));
  await portalTicketCases(t, db, root, origin, 'a6'.repeat(32));
  await roleRouteMatrixCases(t, db, root, origin);
}
