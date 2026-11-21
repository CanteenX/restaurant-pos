import { expect, test, type Page } from '@playwright/test';

const origin = 'https://localhost:4172';
const prefix = '/api/control/v1/staff/';
const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
async function transport(page: Page) {
  await page.route('**/api/control/v1/**', async (route) => {
    const headers = route.request().headers();
    if (headers.origin === 'http://localhost:4172') headers.origin = origin;
    await route.continue({ headers });
  });
}
async function enroll(page: Page) {
  const seed = await page.getByTestId('authenticator-key').innerText();
  await page.getByLabel('Verification code').fill(hotp(base32Decode(seed), stepAt(Date.now())));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recovery codes' })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
}
test('Admin creates a role, invites and enrolls a member, then edits their live sections', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await transport(page);
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('team-admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill(process.env.CONTROL_FIXTURE_PASSPHRASE!);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await page.getByLabel('Verification code').fill(hotp(base32Decode(process.env.CONTROL_FIXTURE_TOTP_SEED!), stepAt(Date.now())));
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await page.getByRole('button', { name: 'Roles', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Admin · Locked', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create role', exact: true }).click();
  await page.getByLabel('Role key').fill('browser-custom');
  await page.getByLabel('Role name').fill('Browser colleague');
  await page.getByLabel('Description', { exact: true }).fill('Synthetic acceptance fixture');
  await page.getByLabel('Read tickets', { exact: true }).check();
  await expect(page.getByRole('region', { name: 'Visible sections' })).toContainText('Helpdesk');
  await page.getByRole('button', { name: 'Save role', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Browser colleague', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Team', exact: true }).click();
  await page.getByRole('button', { name: 'Invite staff', exact: true }).click();
  await page.getByLabel('Staff email').fill('browser-colleague@example.test');
  await page.getByLabel('Role', { exact: true }).selectOption({ label: 'Browser colleague' });
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
  const result = page.getByRole('status').filter({ hasText: '/#token=' });
  await expect(result).toBeVisible();
  const link = (await result.locator('p').innerText()).replace(origin, 'http://localhost:4172');
  const context = await browser.newContext();
  const colleague = await context.newPage();
  await transport(colleague);
  try {
    await colleague.goto(link);
    await expect(colleague.getByRole('heading', { name: 'Accept invitation' })).toBeVisible();
    expect(new URL(colleague.url()).hash).toBe('');
    await colleague.getByLabel('Your name').fill('Morgan Lee');
    await colleague.getByLabel('Password', { exact: true }).fill('Synthetic browser acceptance passphrase');
    await colleague.getByRole('button', { name: 'Continue' }).click();
    await expect(colleague.getByRole('heading', { name: 'Two-factor verification' })).toBeVisible();
    await expect(colleague.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
    await enroll(colleague);
    await expect(colleague.getByRole('heading', { name: 'Helpdesk', exact: true })).toBeVisible();
    await expect(colleague.getByRole('button', { name: 'Team', exact: true })).toHaveCount(0);
    const current = await colleague.request.get(prefix + 'session');
    expect((await current.json()).grants).toEqual(['cc.ticket.read']);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: 'browser-colleague@example.test' });
    await expect(row).toContainText('Morgan Lee');
    await expect(row).toContainText('Enrolled');
    await expect(row).not.toContainText('Not recorded');
    await page.getByRole('button', { name: 'Roles', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Browser colleague', exact: true }).click();
    await page.getByLabel('Read tickets', { exact: true }).uncheck();
    await page.getByLabel('View businesses', { exact: true }).check();
    await page.getByRole('button', { name: 'Save role', exact: true }).click();
    await expect(page.getByRole('form', { name: 'Role editor' })).toHaveCount(0);
    await colleague.reload();
    await expect(colleague.getByRole('heading', { name: 'Client operations', exact: true })).toBeVisible();
    await expect(colleague.getByRole('button', { name: 'Helpdesk', exact: true })).toHaveCount(0);
    expect((await (await colleague.request.get(prefix + 'session')).json()).grants).toEqual(['cc.business.read']);
    await page.getByRole('button', { name: 'Team', exact: true }).click();
    await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(row).toContainText('Active');
    await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm Deactivate for browser-colleague@example.test', exact: true }).click();
    await expect(row).toContainText('Deactivated');
    expect((await colleague.request.get(prefix + 'session')).status()).toBe(401);
    await row.getByRole('button', { name: 'Reactivate', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm Reactivate for browser-colleague@example.test', exact: true }).click();
    await expect(row).toContainText('Active');
  } finally { await context.close(); }
});
