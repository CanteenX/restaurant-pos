import { expect, test } from '@playwright/test';

const passphrase = process.env.CONTROL_FIXTURE_PASSPHRASE ?? '';
const totpSeed = process.env.CONTROL_FIXTURE_TOTP_SEED ?? '';

test('owner suspends and restores hosted access and provisions a contact in the selected business', async ({ page }) => {
  test.setTimeout(90_000);
  expect(passphrase).not.toBe('');
  expect(totpSeed).toMatch(/^[A-Z2-7]{32}$/);
  await page.route('**/api/control/v1/**', async (route) => {
    const headers = route.request().headers();
    if (headers.origin === 'http://localhost:4172') headers.origin = 'https://localhost:4172';
    await route.continue({ headers });
  });
  await page.goto('/');
  await page.getByLabel('Email').fill('client-controls@example.test');
  await page.getByLabel('Password', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Continue' }).click();
  const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
  await page.getByLabel('Verification code').fill(hotp(base32Decode(totpSeed), stepAt(Date.now())));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('button', { name: 'Fixture Bistro' }).click();

  const hosted = page.getByRole('region', { name: 'Hosted access' });
  await expect(hosted.getByText('Active', { exact: true })).toBeVisible();

  // Stale path: another session suspends first, so this If-Match revision is rejected with 412.
  let raced = false;
  await page.route('**/hosted-access', async (route) => {
    if (route.request().method() !== 'PATCH' || raced) return route.fallback();
    raced = true;
    const response = await route.fetch({ method: 'PATCH', headers: { ...route.request().headers(), origin: 'https://localhost:4172' }, postData: JSON.stringify({
      status: 'suspended', reason: 'Concurrent change', requestKey: crypto.randomUUID(),
    }) });
    expect(response.status()).toBe(200);
    await route.fallback();
  });
  await hosted.getByRole('button', { name: 'Suspend hosted access' }).click();
  await hosted.getByLabel('Reason').fill('Overdue invoice PIT-201');
  await hosted.getByLabel('Confirm business name').fill('Fixture Bistro');
  await hosted.getByRole('button', { name: 'Confirm suspension' }).click();
  const stale = hosted.getByRole('alert');
  await expect(stale).toContainText('Access changed in another session');
  await expect(hosted.getByText('Suspended', { exact: true })).toBeVisible();
  await hosted.getByRole('button', { name: 'Restore hosted access' }).click();
  await expect(stale).toHaveCount(0);
  await hosted.getByLabel('Reason').fill('Concurrent change reviewed');
  await hosted.getByLabel('Confirm business name').fill('Fixture Bistro');
  await hosted.getByRole('button', { name: 'Confirm restoration' }).click();
  await expect(hosted.getByText('Active', { exact: true })).toBeVisible();
  await hosted.getByRole('button', { name: 'Suspend hosted access' }).click();
  const confirm = hosted.getByRole('button', { name: 'Confirm suspension' });
  await expect(confirm).toBeDisabled();
  await hosted.getByLabel('Reason').fill('Overdue invoice PIT-202');
  await hosted.getByLabel('Confirm business name').fill('Fixture Bistro');
  await confirm.click();
  await expect(hosted.getByText('Suspended', { exact: true })).toBeVisible();
  await hosted.getByRole('button', { name: 'Restore hosted access' }).click();
  await hosted.getByLabel('Reason').fill('Payment received');
  await hosted.getByLabel('Confirm business name').fill('Fixture Bistro');
  await hosted.getByRole('button', { name: 'Confirm restoration' }).click();
  await expect(hosted.getByText('Active', { exact: true })).toBeVisible();

  const contacts = page.getByRole('region', { name: 'Customer contacts' });
  await contacts.getByRole('button', { name: 'Add contact' }).click();
  await contacts.getByLabel('Contact email').fill('pilot-contact@example.test');
  await contacts.getByRole('button', { name: 'Create portal account' }).click();
  await expect(contacts.getByText('pilot-contact@example.test', { exact: true })).toBeVisible();
  await expect(contacts.getByText('Activation code', { exact: true })).toBeVisible();
  await contacts.getByRole('button', { name: 'Close activation code' }).click();
  await expect(contacts.getByText('Activation code', { exact: true })).toHaveCount(0);
  const contact = contacts.getByRole('listitem').filter({ hasText: 'pilot-contact@example.test' });
  await contact.getByRole('button', { name: 'Reissue activation' }).click();
  await contacts.getByRole('button', { name: 'Confirm reissue' }).click();
  await expect(contacts.getByText('Activation code', { exact: true })).toBeVisible();
  await contacts.getByRole('button', { name: 'Close activation code' }).click();
  await contact.getByRole('button', { name: 'Revoke access' }).click();
  await contacts.getByRole('button', { name: 'Confirm revoke' }).click();
  await expect(contact).toContainText('revoked');
  await expect(contact.getByRole('button', { name: 'Revoke access' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Business support tickets' })).toBeVisible();
});
