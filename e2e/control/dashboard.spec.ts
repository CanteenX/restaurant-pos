import { expect, test, type Page } from '@playwright/test';

const prefix = '/api/control/v1';
const origin = 'https://localhost:4172';
const password = 'browser fixture passphrase';
const proof = Buffer.alloc(32, 42).toString('base64url');
const date = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test.beforeEach(async ({ page }) => {
  // Browser loopback accepts Secure cookies. Translate only the fixture's exact HTTP
  // origin to the configured HTTPS origin; Nest still rejects every other origin.
  await page.route('**/api/control/v1/**', async (route) => {
    const headers = route.request().headers();
    if (headers.origin === origin.replace('https:', 'http:')) headers.origin = origin;
    await route.continue({ headers });
  });
});

async function passwordStep(page: Page, email: string, enrollment = false) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  if (enrollment) await page.getByLabel('Enrollment proof').fill(proof);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Verification code')).toBeVisible();
  expect((await page.request.get(prefix + '/staff/session')).status()).toBe(401);
}

async function openOutlet(page: Page) {
  await page.getByRole('button', { name: 'Fixture Bistro' }).click();
  await page.getByRole('button', { name: 'Market Outlet' }).click();
  await expect(page.getByRole('heading', { name: 'Market Outlet' })).toBeVisible();
}

test('enrolls with proof and 2FA, then assigns and renews an outlet plan', async ({ page }) => {
  await passwordStep(page, 'owner@example.test', true);
  const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
  const seed = await page.getByTestId('authenticator-key').innerText();
  await page.getByLabel('Verification code').fill(hotp(base32Decode(seed), stepAt(Date.now())));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Recovery codes' })).toBeVisible();
  const cookie = (await page.context().cookies()).find(({ name }) => name === '__Host-control_staff');
  expect(cookie && { secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite })
    .toEqual({ secure: true, httpOnly: true, sameSite: 'Strict' });
  await page.getByRole('button', { name: 'Done' }).click();
  await openOutlet(page);

  await page.getByRole('combobox', { name: 'Plan', exact: true }).selectOption('starter:1');
  await page.getByLabel('Starts on').fill(date(-1));
  await page.getByLabel('Ends on').fill(date(7));
  const keys: string[] = [];
  await page.route('**/outlets/*/service-plans/assign', async (route) => {
    keys.push(route.request().postDataJSON().requestKey);
    if (keys.length > 1) return route.fallback();
    const response = await route.fetch({ headers: { ...route.request().headers(), origin } });
    expect(response.status()).toBe(201);
    // The write committed, but the browser did not receive the result.
    await route.abort('connectionreset');
  });
  const assign = page.getByRole('button', { name: 'Assign plan' });
  await assign.click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('could not be completed');
  await assign.click();
  await expect(page.getByRole('heading', { name: 'Upcoming renewal' })).toBeVisible();
  expect(keys).toEqual([keys[0], keys[0]]);
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Assigned' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Plan', exact: true }).selectOption('pro:1');
  await page.getByLabel('Ends on').fill(date(30));
  await page.getByRole('button', { name: 'Renew plan' }).click();
  await expect(page.getByRole('cell', { name: 'Renewed' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Assigned' })).toBeVisible();

  await page.getByRole('button', { name: 'Add business' }).click();
  await page.getByLabel('Display name').fill('Harbor Café');
  await page.getByLabel('Legal name').fill('Harbor Café Pvt Ltd');
  await page.getByRole('button', { name: 'Save business' }).click();
  await expect(page.getByRole('button', { name: 'Harbor Café' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Add outlet' }).click();
  await page.getByLabel('Display name').fill('Pier Outlet');
  await page.getByLabel('Time zone').fill('Asia/Kolkata');
  await page.getByRole('button', { name: 'Save outlet' }).click();
  await expect(page.getByRole('heading', { name: 'Pier Outlet' })).toBeVisible();

  const committed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route('**/businesses/*/outlets', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const response = await route.fetch({ headers: { ...route.request().headers(), origin } });
    expect(response.status()).toBe(201);
    if (route.request().postDataJSON().displayName === 'Unconfirmed Outlet') return route.abort('connectionreset');
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Add outlet' }).click();
  await page.getByLabel('Display name').fill('Lagged Outlet');
  await page.getByLabel('Time zone').fill('Asia/Kolkata');
  await page.getByRole('button', { name: 'Save outlet' }).click();
  await committed.promise;
  await page.getByRole('button', { name: 'Fixture Bistro' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture Bistro' })).toBeVisible();
  const response = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/outlets'));
  release.resolve();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await expect(page.getByRole('heading', { name: 'Lagged Outlet' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Fixture Bistro' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Assign plan' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Add outlet' }).click();
  await page.getByLabel('Display name').fill('Unconfirmed Outlet');
  await page.getByLabel('Time zone').fill('Asia/Kolkata');
  await page.getByRole('button', { name: 'Save outlet' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Reload the directory and check whether it was created');
  await expect(page.getByRole('button', { name: 'Add outlet' })).toBeDisabled();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Staff sign-in' })).toBeVisible();
});

test('read-only staff complete their second factor and cannot mutate plans', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await passwordStep(page, 'reader@example.test');
  await page.getByLabel('Verification code').fill('TEST-CODE-ONLY');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Verification failed.');
  const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await page.getByLabel('Verification code').fill(hotp(base32Decode(secret), stepAt(Date.now())));
  await page.getByRole('button', { name: 'Verify' }).click();
  await openOutlet(page);

  await expect(page.getByRole('heading', { name: 'Plan history' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Assign plan|Renew plan|Add business|Add outlet/ })).toHaveCount(0);
  const businesses = await page.request.get(prefix + '/businesses');
  expect(businesses.status()).toBe(200);
  const directory = await businesses.json() as { items: { id: string; displayName: string }[] };
  const business = directory.items.find(({ displayName }) => displayName === 'Fixture Bistro');
  expect(business, 'Fixture Bistro must match the business selected in the UI').toBeDefined();
  if (!business) throw new Error('Fixture Bistro is missing from the directory');
  const response = await page.request.get(prefix + '/businesses/' + business.id + '/outlets');
  expect(response.status()).toBe(200);
  const details = await response.json() as { items: { id: string; displayName: string }[] };
  const outlet = details.items.find(({ displayName }) => displayName === 'Market Outlet');
  expect(outlet, 'Market Outlet must match the outlet selected in the UI').toBeDefined();
  if (!outlet) throw new Error('Market Outlet is missing from Fixture Bistro');
  const endpoint = prefix + '/outlets/' + outlet.id + '/service-plans/assign';
  const data = { planCode: 'starter', planVersion: 1, requestKey: crypto.randomUUID(),
    startsAt: new Date(date(31)).toISOString(), endsAt: new Date(date(61)).toISOString() };
  expect((await page.request.post(endpoint, { headers: { origin }, data })).status()).toBe(403);
});
