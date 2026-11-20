import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { CONTROL_PERMISSIONS, CONTROL_ROLE_PRESETS, controlPermissionSatisfied } from '@nventra/types';
import type { PrismaClient } from '../../node_modules/.prisma/control-client/index.js';
import { ROUTE_ACCESS, type MatrixContext } from './role-route-matrix.js';

const BILLING_ROUTES = [
  'GET /businesses/:id/invoices', 'POST /businesses/:id/invoices',
  'GET /businesses/:id/invoices/:invoiceId/payments', 'POST /businesses/:id/invoices/:invoiceId/payments',
  'GET /billing/overdue',
];
const TICKET_ROUTES = ['GET /tickets', 'GET /tickets/eligible-owners', 'GET /tickets/:id', 'PATCH /tickets/:id',
  'POST /tickets/:id/messages', 'POST /tickets/:id/notes', 'POST /tickets/:id/portal-replies'];
// Explicit route-level expectations. Routes a preset may reach (anything but 401/403) are listed in full.
const SUPPORT_REACHES = [...TICKET_ROUTES, 'GET /businesses', 'GET /businesses/:businessId', 'GET /businesses/:businessId/outlets',
  'GET /businesses/:businessId/outlets/:id', 'GET /plans', 'GET /plans/renewals', 'GET /outlets/:id/service-plans'];
const MARKETING_REACHES = ['GET /businesses', 'GET /businesses/:businessId', 'POST /businesses', 'PATCH /businesses/:businessId',
  'GET /businesses/:businessId/outlets', 'GET /businesses/:businessId/outlets/:id', 'POST /businesses/:businessId/outlets',
  'PATCH /businesses/:businessId/outlets/:id', 'GET /plans', 'GET /plans/renewals', 'GET /outlets/:id/service-plans',
  'GET /businesses/:id/portal-accounts', 'POST /businesses/:id/portal-accounts',
  'POST /businesses/:id/portal-accounts/:accountId/reissue', 'POST /businesses/:id/portal-accounts/:accountId/revoke'];
const gatedRoutes = Object.entries(ROUTE_ACCESS).filter(([, d]) => d.send);
const everyGatedRoute = gatedRoutes.map(([route]) => route).sort();

export async function roleRouteMatrixCases(t: TestContext, db: PrismaClient, root: string, origin: string) {
  const key = 'a5'.repeat(32);
  async function actor(label: string, grants: readonly string[]) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.staff.create({ data: { id, email: label + '-' + id + '@example.test', passwordHash: 'inert', grants: [...grants] } });
    const digest = createHmac('sha256', key).update('session\0' + token).digest('hex');
    await db.staffSession.create({ data: { staffId: id, digest, verifiedAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 600_000) } });
    return { id, cookie: '__Host-control_staff=' + token };
  }
  const call = (cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(new URL(path, root), { method, headers: { cookie, origin, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = (): MatrixContext => ({ business: randomUUID(), outlet: randomUUID(), invoice: randomUUID(),
    ticket: randomUUID(), staff: randomUUID(), account: randomUUID() });
  const drive = (cookie: string, route: string, c: MatrixContext) => {
    const declared = ROUTE_ACCESS[route]; assert.ok(declared.send, route);
    const req = declared.send(c);
    return call(cookie, route.split(' ')[0], req.path, req.body, req.headers);
  };

  const groups = {
    OWNER: CONTROL_ROLE_PRESETS.OWNER, MANAGER: CONTROL_ROLE_PRESETS.MANAGER, SUPPORT: CONTROL_ROLE_PRESETS.SUPPORT,
    MARKETING: CONTROL_ROLE_PRESETS.MARKETING,
    // Stored before the rename: authorization must follow these grants, not any preset name.
    LEGACY_SALES_GRANTS: ['cc.business.read', 'cc.business.manage', 'cc.plan.read'],
    NO_GRANTS: [],
  } as const;

  for (const [name, grants] of Object.entries(groups)) {
    await t.test('role x route matrix over every gated route: ' + name, async () => {
      const staff = await actor(name.toLowerCase(), grants);
      const reached: string[] = [];
      for (const [route, declared] of gatedRoutes) {
        const status = (await drive(staff.cookie, route, ctx())).status;
        const permitted = controlPermissionSatisfied(grants, declared.access as (typeof CONTROL_PERMISSIONS)[number]);
        if (permitted) assert.ok(status !== 401 && status !== 403 && status < 500, route + ' ' + status + ' for ' + name);
        else assert.equal(status, 403, route + ' must be 403 for ' + name);
        if (status !== 403) reached.push(route);
      }
      const expected: Record<string, readonly string[]> = {
        OWNER: everyGatedRoute,
        MANAGER: everyGatedRoute.filter((r) => !BILLING_ROUTES.includes(r)),
        SUPPORT: SUPPORT_REACHES,
        MARKETING: MARKETING_REACHES,
        LEGACY_SALES_GRANTS: ['GET /businesses', 'GET /businesses/:businessId', 'POST /businesses', 'PATCH /businesses/:businessId',
          'GET /businesses/:businessId/outlets', 'GET /businesses/:businessId/outlets/:id', 'POST /businesses/:businessId/outlets',
          'PATCH /businesses/:businessId/outlets/:id', 'GET /plans', 'GET /plans/renewals', 'GET /outlets/:id/service-plans'],
        NO_GRANTS: [],
      };
      assert.deepEqual(reached.sort(), [...expected[name]].sort());
    });
  }

  await t.test('Manager gets 403 on every billing route and every billing-gated write leaves no invoice', async () => {
    const manager = await actor('manager-billing', CONTROL_ROLE_PRESETS.MANAGER);
    const business = await call((await actor('owner-seed', CONTROL_ROLE_PRESETS.OWNER)).cookie, 'POST', 'businesses',
      { legalName: 'Billing Ltd', displayName: 'Billing' });
    assert.equal(business.status, 201);
    const c = { ...ctx(), business: ((await business.json()) as { id: string }).id };
    for (const route of BILLING_ROUTES) assert.equal((await drive(manager.cookie, route, c)).status, 403, route);
    assert.equal(await db.billingInvoice.count({ where: { businessId: c.business } }), 0);
  });

  await t.test('grant ceiling: a Manager cannot grant billing and cannot edit, reset, revoke or deactivate an Admin', async () => {
    const manager = await actor('ceiling-manager', CONTROL_ROLE_PRESETS.MANAGER);
    const admin = await actor('ceiling-admin', CONTROL_ROLE_PRESETS.OWNER);
    const support = await actor('ceiling-support', CONTROL_ROLE_PRESETS.SUPPORT);
    const peer = await actor('ceiling-peer', CONTROL_ROLE_PRESETS.MANAGER);
    const adminBefore = await db.staff.findUniqueOrThrow({ where: { id: admin.id } });
    const patch = (target: string, grants: string[], cookie = manager.cookie) =>
      call(cookie, 'PATCH', 'staff/users/' + target + '/grants', { grants });
    // Admin: edit, escalate-by-edit, reset 2FA, revoke sessions are all refused.
    assert.equal((await patch(admin.id, [...CONTROL_ROLE_PRESETS.SUPPORT])).status, 403);
    assert.equal((await patch(admin.id, [...CONTROL_ROLE_PRESETS.OWNER])).status, 403);
    assert.equal((await call(manager.cookie, 'POST', 'staff/users/' + admin.id + '/reset-factor', {})).status, 403);
    assert.equal((await call(manager.cookie, 'POST', 'staff/users/' + admin.id + '/revoke-sessions', {})).status, 403);
    // Neither can it touch a peer Manager, itself, or hand out billing to anyone.
    assert.equal((await patch(peer.id, [])).status, 403);
    assert.equal((await patch(manager.id, [...CONTROL_ROLE_PRESETS.OWNER])).status, 403);
    assert.equal((await patch(support.id, [...CONTROL_ROLE_PRESETS.SUPPORT, 'cc.billing.read'])).status, 403);
    assert.equal((await patch(support.id, ['cc.billing.manage'])).status, 403);
    // The admin row, its sessions and the support grants are untouched.
    const adminAfter = await db.staff.findUniqueOrThrow({ where: { id: admin.id } });
    assert.deepEqual(adminAfter.grants, adminBefore.grants);
    assert.equal(adminAfter.enabled, true);
    assert.equal(adminAfter.credentialVersion, adminBefore.credentialVersion);
    assert.deepEqual((await db.staff.findUniqueOrThrow({ where: { id: support.id } })).grants, [...CONTROL_ROLE_PRESETS.SUPPORT]);
    assert.equal((await call(admin.cookie, 'GET', 'staff/session')).status, 200);
    // Within the ceiling a Manager can still manage a lesser role.
    assert.equal((await patch(support.id, [...CONTROL_ROLE_PRESETS.MARKETING])).status, 200);
    // No route can disable a staff account, so deactivation is not reachable by any role.
    assert.deepEqual(Object.keys(ROUTE_ACCESS).filter((r) => /deactivat|disable/i.test(r)), []);
  });

  await t.test('Marketing can create a business, an outlet and a portal login', async () => {
    const marketing = await actor('marketing-flow', CONTROL_ROLE_PRESETS.MARKETING);
    const business = await call(marketing.cookie, 'POST', 'businesses', { legalName: 'Flow Pvt Ltd', displayName: 'Flow' });
    assert.equal(business.status, 201);
    const businessId = ((await business.json()) as { id: string }).id;
    const outlet = await call(marketing.cookie, 'POST', 'businesses/' + businessId + '/outlets',
      { displayName: 'Flow outlet', timeZone: 'Asia/Kolkata' });
    assert.equal(outlet.status, 201);
    const login = await call(marketing.cookie, 'POST', 'businesses/' + businessId + '/portal-accounts', { email: 'flow-portal@example.test' });
    assert.ok(login.status === 200 || login.status === 201, 'portal login status ' + login.status);
    for (const route of [...TICKET_ROUTES, ...BILLING_ROUTES, 'GET /businesses/:id/hosted-access', 'PATCH /businesses/:id/hosted-access',
      'GET /audit-events', 'GET /staff/users', 'PATCH /staff/users/:id/grants']) {
      assert.equal((await drive(marketing.cookie, route, { ...ctx(), business: businessId })).status, 403, route);
    }
  });

  await t.test('Support can read, manage and reply to tickets but cannot mutate business, plan, billing or staff', async () => {
    const support = await actor('support-flow', CONTROL_ROLE_PRESETS.SUPPORT);
    for (const route of ['GET /tickets', 'GET /tickets/eligible-owners', 'GET /tickets/:id', 'PATCH /tickets/:id',
      'POST /tickets/:id/messages', 'POST /tickets/:id/notes', 'POST /tickets/:id/portal-replies']) {
      const status = (await drive(support.cookie, route, ctx())).status;
      assert.ok(status !== 401 && status !== 403, route + ' ' + status);
    }
    for (const route of everyGatedRoute.filter((r) => ['POST', 'PATCH'].includes(r.split(' ')[0]) && !TICKET_ROUTES.includes(r))) {
      assert.equal((await drive(support.cookie, route, ctx())).status, 403, route);
    }
    for (const route of [...BILLING_ROUTES, 'GET /staff/users', 'GET /audit-events']) {
      assert.equal((await drive(support.cookie, route, ctx())).status, 403, route);
    }
  });

  await t.test('stored grants, not preset names, decide access for rows that predate the new presets', async () => {
    const legacy = await actor('legacy-sales', groups.LEGACY_SALES_GRANTS);
    const created = await call(legacy.cookie, 'POST', 'businesses', { legalName: 'Legacy Ltd', displayName: 'Legacy' });
    assert.equal(created.status, 201);
    assert.equal((await call(legacy.cookie, 'POST', 'businesses/' + randomUUID() + '/portal-accounts',
      { email: 'legacy@example.test' })).status, 403);
    assert.equal((await call(legacy.cookie, 'GET', 'billing/overdue?limit=1')).status, 403);
  });
}
