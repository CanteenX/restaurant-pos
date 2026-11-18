import { expect, test } from '@playwright/test';

const origin = 'https://localhost:4172';

test.setTimeout(90_000);

test('staff record a partial payment in the business workspace', async ({ page }) => {
  await page.route('**/api/control/v1/**', async (route) => {
    const headers = route.request().headers();
    if (headers.origin === 'http://localhost:4172') headers.origin = origin;
    await route.continue({ headers });
  });
  await page.goto('/');
  await page.getByLabel('Email').fill('operations@example.test');
  await page.getByLabel('Password', { exact: true }).fill('browser fixture passphrase');
  await page.getByRole('button', { name: 'Continue' }).click();
  const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
  await page.getByLabel('Verification code').fill(hotp(base32Decode('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'), stepAt(Date.now())));
  const factor = page.waitForResponse((response) => response.url().endsWith('/staff/session/verify'));
  await page.getByRole('button', { name: 'Verify' }).click();
  expect((await factor).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Client operations' })).toBeVisible();
  await page.getByRole('button', { name: 'Fixture Bistro' }).click();

  const billing = page.getByRole('region', { name: 'Invoices and payments' });
  await expect(billing).toBeVisible();
  await billing.getByRole('button', { name: 'Record invoice' }).click();
  await billing.getByLabel('Invoice reference').fill('PILOT-101');
  await billing.getByLabel('Description').fill('Annual support');
  await billing.getByLabel('Invoice amount (INR)').fill('1000.50');
  await billing.getByLabel('Due date').fill('2025-03-01');
  await billing.getByRole('button', { name: 'Save invoice' }).click();
  await billing.getByRole('button', { name: 'PILOT-101', exact: true }).click();

  await billing.getByRole('button', { name: 'Record payment' }).click();
  await billing.getByLabel('Payment reference').fill('UPI-PILOT-101');
  await billing.getByLabel('Payment method').selectOption('upi');
  await billing.getByLabel('Payment amount (INR)').fill('200.25');
  const retries: string[] = [];
  await page.route('**/businesses/*/invoices/*/payments', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    retries.push(route.request().postDataJSON().requestKey);
    if (retries.length > 1) return route.fallback();
    const response = await route.fetch({ headers: { ...route.request().headers(), origin } });
    expect(response.status()).toBe(201);
    await route.abort('connectionreset');
  });
  const save = billing.getByRole('button', { name: 'Save payment' });
  await save.click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('could not be completed');
  await save.click();
  await expect(billing.getByText('UPI-PILOT-101', { exact: true })).toHaveCount(1);
  expect(retries).toEqual([retries[0], retries[0]]);
  await expect(billing.getByText('UPI-PILOT-101', { exact: true })).toBeVisible();
  await expect(billing.getByText('₹800.25', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Overdue invoices' }).click();
  await expect(page.getByRole('region', { name: 'Overdue invoices' }).getByText('PILOT-101')).toBeVisible();
  await page.getByRole('button', { name: 'Upcoming renewals' }).click();
  await expect(page.getByRole('region', { name: 'Upcoming renewals' })).toBeVisible();
});
