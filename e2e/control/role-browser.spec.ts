import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { MatrixContext, MatrixRequest, RouteDeclaration } from '../../apps/control-api/src/staff/role-route-matrix';
import { captureStaffScreen } from './staff-screenshots';

const resetFixturePeerWindow = require('./staff-peer-fixture.cjs') as () => Promise<void>;
// The launcher gives every browser file one TCP peer. Give this group its own
// fixture login window without changing the API's peer or account limits.
test.beforeAll(resetFixturePeerWindow);
test.afterAll(resetFixturePeerWindow);

const { ROUTE_ACCESS } = require('../../apps/control-api/dist/staff/role-route-matrix.js') as {
  ROUTE_ACCESS: Record<string, RouteDeclaration>;
};
const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
const prefix = '/api/control/v1/';
const staffNav = 'Staff workspace';
const allSections = ['Client operations', 'Helpdesk', 'Audit log', 'Team', 'Roles'];
const billingRoutes = ['GET /billing/overdue', 'GET /businesses/:id/invoices', 'POST /businesses/:id/invoices',
  'GET /businesses/:id/invoices/:invoiceId/payments', 'POST /businesses/:id/invoices/:invoiceId/payments'];

const cases = [
  { role: 'admin', sections: allSections, allowed: ['GET /businesses/:businessId', 'GET /billing/overdue', 'GET /staff/roles', 'GET /audit-events'],
    denied: [] },
  { role: 'manager', sections: allSections, allowed: ['GET /staff/roles', 'GET /audit-events', 'GET /plans'],
    denied: billingRoutes },
  { role: 'support', sections: ['Client operations', 'Helpdesk'],
    allowed: ['GET /businesses/:businessId', 'GET /outlets/:id/service-plans', 'GET /tickets/eligible-owners'],
    denied: ['PATCH /businesses/:businessId', 'POST /outlets/:id/service-plans/:operation', 'GET /staff/users',
      'GET /audit-events', 'GET /billing/overdue'] },
  { role: 'marketing', sections: ['Client operations'],
    allowed: ['GET /plans'], denied: ['GET /tickets', 'GET /billing/overdue', 'GET /staff/users', 'GET /audit-events',
      'GET /businesses/:id/hosted-access', 'POST /businesses/:id/portal-accounts/:accountId/reissue',
      'POST /businesses/:id/portal-accounts/:accountId/revoke'] },
  { role: 'custom', sections: ['Helpdesk'], allowed: ['GET /tickets'], denied: ['GET /businesses',
    'GET /plans', 'GET /tickets/eligible-owners', 'GET /staff/roles', 'GET /audit-events', 'GET /billing/overdue'] },
];

async function sameOriginRequest(page: Page, method: string, request: MatrixRequest) {
  return page.evaluate(async ({ path, method, headers, body }) => {
    const response = await fetch(path, {
      method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', redirect: 'error',
    });
    return response.status;
  }, { ...request, path: prefix + request.path, method });
}

async function signIn(page: Page, role: string) {
  const passphrase = process.env.CONTROL_FIXTURE_PASSPHRASE;
  const seed = process.env.CONTROL_FIXTURE_TOTP_SEED;
  if (!passphrase || !seed) throw new Error('Missing disposable Control sign-in fixture');
  // Translate the test loopback origin to the Nest fixture's configured HTTPS origin.
  await page.route('**/api/control/v1/**', async (route) => {
    const headers = route.request().headers();
    if (headers.origin === 'http://localhost:4172') headers.origin = 'https://localhost:4172';
    await route.continue({ headers });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Staff sign-in' })).toBeVisible();
  if (role === 'admin') await captureStaffScreen(page, '01-sign-in');
  await page.getByLabel('Email', { exact: true }).fill('role-' + role + '@example.test');
  await page.getByLabel('Password', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor verification' })).toBeVisible();
  expect(await sameOriginRequest(page, 'GET', { path: 'staff/session' })).toBe(401);
  if (role === 'admin') await captureStaffScreen(page, '02-two-factor');
  await page.getByLabel('Verification code').fill(hotp(base32Decode(seed), stepAt(Date.now())));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  expect(await sameOriginRequest(page, 'GET', { path: 'staff/session' })).toBe(200);
}

async function expectSections(page: Page, sections: string[]) {
  const nav = page.getByRole('navigation', { name: staffNav });
  if (sections.length > 1) await expect(nav.getByRole('button')).toHaveText(sections);
  else await expect(nav).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(sections[0]);
}

type Identified = { id: string };
async function findRecord<T extends Identified>(page: Page, path: string, field: keyof T, value: string) {
  const response = await page.request.get(prefix + path);
  expect(response.status()).toBe(200);
  const { items } = await response.json() as { items: T[] };
  const record = items.find((item) => item[field] === value);
  if (!record) throw new Error('Browser fixture record missing from ' + path + ' for ' + value);
  return record.id;
}

async function matrixContext(page: Page, hasBusinessRead: boolean): Promise<MatrixContext> {
  const context = { business: randomUUID(), outlet: randomUUID(), invoice: randomUUID(), ticket: randomUUID(),
    staff: randomUUID(), account: randomUUID() };
  if (!hasBusinessRead) return context;
  const business = await findRecord<Identified & { displayName: string }>(page, 'businesses', 'displayName', 'Fixture Bistro');
  const outlet = await findRecord<Identified & { displayName: string }>(page,
    'businesses/' + business + '/outlets', 'displayName', 'Market Outlet');
  return { ...context, business, outlet };
}

async function createMarketingContact(page: Page) {
  await page.getByRole('button', { name: 'Add business', exact: true }).click();
  await page.getByLabel('Display name').fill('Marketing QA Bistro');
  await page.getByLabel('Legal name').fill('Marketing QA Bistro Ltd');
  await page.getByRole('button', { name: 'Save business', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Marketing QA Bistro', exact: true })).toBeVisible();
  const business = await findRecord<Identified & { displayName: string }>(page,
    'businesses', 'displayName', 'Marketing QA Bistro');
  await page.getByRole('button', { name: 'Add outlet', exact: true }).click();
  await page.getByLabel('Display name').fill('Marketing QA Outlet');
  await page.getByLabel('Time zone').fill('Asia/Kolkata');
  await page.getByRole('button', { name: 'Save outlet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Marketing QA Outlet', exact: true })).toBeVisible();

  const email = 'marketing-qa-contact@example.test';
  const contacts = page.getByRole('region', { name: 'Customer contacts' });
  const addContact = contacts.getByRole('button', { name: 'Add contact', exact: true });
  await expect(addContact).toBeVisible();
  await addContact.click();
  await contacts.getByLabel('Contact email').fill(email);
  await contacts.getByRole('button', { name: 'Create portal account', exact: true }).click();
  await expect(contacts.getByText('Activation code', { exact: true })).toBeVisible();
  await contacts.getByRole('button', { name: 'Close activation code' }).click();
  const row = contacts.getByRole('listitem').filter({ hasText: email });
  await expect(row).toContainText('pending');
  await expect(row.getByRole('button', { name: /Reissue activation|Revoke access/ })).toHaveCount(0);
  const account = await findRecord<Identified & { email: string }>(page,
    'businesses/' + business + '/portal-accounts', 'email', email);
  return { business, account };
}

for (const { role, sections, allowed, denied } of cases) {
  test(role + ' sees exactly its sections and its session enforces direct route access', async ({ page }) => {
    test.setTimeout(60_000);
    if (role === 'support' || role === 'marketing') await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, role);
    await expectSections(page, sections);
    const hasBusinessRead = sections.includes('Client operations');
    const resources = await matrixContext(page, hasBusinessRead);

    if (hasBusinessRead) {
      await page.getByRole('button', { name: 'Fixture Bistro', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Fixture Bistro', exact: true })).toBeVisible();
      const billing = page.getByRole('button', { name: 'Overdue invoices', exact: true });
      if (role === 'admin') {
        await expect(billing).toBeVisible();
        await expect(page.getByRole('region', { name: 'Invoices and payments' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'PILOT-101', exact: true })).toBeVisible();
        await captureStaffScreen(page, '06-businesses');
      } else {
        await expect(billing).toHaveCount(0);
        await expect(page.getByRole('region', { name: 'Invoices and payments' })).toHaveCount(0);
      }
    }
    if (role === 'support') {
      await page.getByRole('button', { name: 'Market Outlet', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Plan history' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Add business|Add outlet|Assign plan|Renew plan/ })).toHaveCount(0);
      await page.getByRole('navigation', { name: staffNav }).getByRole('button', { name: 'Helpdesk' }).click();
      await expect(page.getByRole('heading', { name: 'Ticket queue' })).toBeVisible();
    }
    const context = role === 'marketing' ? { ...resources, ...await createMarketingContact(page) } : resources;

    async function probe(route: string, expected: number, target = context) {
      const send = ROUTE_ACCESS[route]?.send;
      if (!send) throw new Error('Missing request in the Nest route inventory for ' + route);
      const status = await sameOriginRequest(page, route.split(' ')[0], send(target));
      expect(status, role + ' ' + route).toBe(expected);
    }
    for (const route of allowed) await probe(route, 200);
    for (const route of denied) await probe(route, 403);
    if (role === 'admin') {
      await probe('GET /businesses/:businessId', 404, { ...context, business: randomUUID() });
      await page.getByRole('navigation', { name: staffNav }).getByRole('button', { name: 'Audit log' }).click();
      await expect(page.getByRole('heading', { name: 'Audit log', exact: true })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Audit events' })).toBeVisible();
      await captureStaffScreen(page, '08-audit-log');
    }
  });
}
