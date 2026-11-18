import { expect, test, type Page } from '@playwright/test';

const origin = 'https://localhost:4172';
const prefix = '/api/control/v1';
const subject = 'Printer support';

async function openTicket(page: Page, email: string) {
  await page.route('**/api/control/v1/**', async (route) => {
    const headers = route.request().headers();
    if (headers.origin === origin.replace('https:', 'http:')) headers.origin = origin;
    await route.continue({ headers });
  });
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('browser fixture passphrase');
  await page.getByRole('button', { name: 'Continue' }).click();
  const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
  const fixtureSeed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await page.getByLabel('Verification code').fill(hotp(base32Decode(fixtureSeed), stepAt(Date.now())));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('button', { name: 'Helpdesk', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(subject) }).click();
  await expect(page.getByRole('heading', { name: subject })).toBeVisible();
}

test('support staff read plain text, update ticket status and add a private note', async ({ page }) => {
  await openTicket(page, 'support@example.test');
  await expect(page.getByText('Customer message', { exact: true })).toBeVisible();
  const original = page.getByText('<b>Receipt printer offline</b>', { exact: false });
  await expect(original).toBeVisible();
  await expect(original.locator('b')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Printer support.*Open/ })).toBeVisible();
  const priority = page.getByRole('combobox', { name: 'Priority', exact: true });
  await expect(priority).toHaveValue('high');
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('pending');
  await priority.selectOption('urgent');
  const savedTriage = page.waitForResponse((response) => response.request().method() === 'PATCH' &&
    response.url().includes('/tickets/'));
  await page.getByRole('button', { name: 'Save status and priority' }).click();
  const triage = await savedTriage;
  expect(triage.status()).toBe(200);
  expect(triage.request().postDataJSON()).toEqual({ status: 'pending', priority: 'urgent' });
  await expect(page.getByRole('button', { name: /Printer support.*Pending/ })).toBeVisible();
  await expect(page.getByText('Pending · Urgent priority', { exact: true })).toBeVisible();
  await expect(priority).toHaveValue('urgent');

  await page.getByLabel('Internal note', { exact: true }).fill('Ask technician to check toner.');
  const saved = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/notes'));
  await page.getByRole('button', { name: 'Add internal note' }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  expect(await response.json()).toMatchObject({ direction: 'internal', visibility: 'staff' });
  await expect(page.getByText('Ask technician to check toner.', { exact: true })).toBeVisible();
  await expect(page.getByText('Internal note', { exact: true }).first()).toBeVisible();
  await page.getByRole('combobox', { name: 'Filter by status' }).selectOption('closed');
  await expect(page.getByText('No tickets found.')).toBeVisible();
});

test('read-only staff see ticket details while management actions stay unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTicket(page, 'ticket-reader@example.test');
  await expect(page.getByText('Customer message', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Priority', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add internal note' })).toHaveCount(0);
  const { items: [ticket] } = await (await page.request.get(prefix + '/tickets')).json();
  const endpoint = prefix + '/tickets/' + ticket.id;
  expect((await page.request.patch(endpoint, { headers: { origin }, data: { status: 'closed', priority: 'normal' } })).status()).toBe(403);
  expect((await page.request.post(endpoint + '/notes', { headers: { origin },
    data: { requestKey: crypto.randomUUID(), text: 'Read-only note attempt' } })).status()).toBe(403);
});