import { expect, test, type Page } from '@playwright/test';

const baseURL = 'http://localhost:4172';
const origin = 'https://localhost:4172';
const api = '/api/control/v1';
const password = 'browser fixture passphrase';

async function browserOrigin(page: Page) {
  await page.route('**/api/control/v1/**', async (route) => {
    const headers = route.request().headers();
    if (headers.origin === baseURL) headers.origin = origin;
    await route.continue({ headers });
  });
}

test('real customer access can be suspended and restored while invoice recovery remains available', async ({ browser, page: staff }) => {
  test.setTimeout(90_000);
  await browserOrigin(staff);
  await staff.goto('/');
  await staff.getByLabel('Email').fill('portal-recovery-staff@example.test');
  await staff.getByLabel('Password', { exact: true }).fill(password);
  await staff.getByRole('button', { name: 'Continue' }).click();
  const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
  await staff.getByLabel('Verification code').fill(hotp(base32Decode('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'), stepAt(Date.now())));
  const verified = staff.waitForResponse((response) => response.url().endsWith('/staff/session/verify'));
  await staff.getByRole('button', { name: 'Verify' }).click();
  expect((await verified).status()).toBe(200);

  async function create(path: string, data: object) {
    const response = await staff.request.post(api + path, { data, headers: { origin } });
    expect(response.status()).toBe(201);
    return response.json();
  }
  const name = 'Recovery fixture restaurant';
  const business = await create('/businesses', { displayName: name, legalName: name });
  const foreignName = 'Unrelated recovery fixture';
  const foreign = await create('/businesses', { displayName: foreignName, legalName: foreignName });
  const businessPath = '/businesses/' + business.id;
  function invoice(path: string, reference: string) {
    return create(path + '/invoices', { reference, description: 'Pilot support', amountPaise: 100050,
      dueOn: '2025-03-01', requestKey: crypto.randomUUID() });
  }
  const ownInvoice = await invoice(businessPath, 'RECOVERY-01');
  const foreignInvoice = await invoice('/businesses/' + foreign.id, 'UNRELATED-01');
  await create(businessPath + '/invoices/' + ownInvoice.id + '/payments', {
    reference: 'SYNTHETIC-UPI', amountPaise: 25025, method: 'upi', requestKey: crypto.randomUUID(),
  });
  await create(businessPath + '/outlets', { displayName: 'Recovery fixture outlet', timeZone: 'Asia/Kolkata' });
  const access = api + businessPath + '/hosted-access';
  async function setStatus(status: 'active' | 'suspended') {
    const current = await staff.request.get(access);
    expect(current.status()).toBe(200);
    const response = await staff.request.patch(access, { headers: { origin, 'if-match': current.headers().etag },
      data: { status, reason: 'Synthetic payment or restoration', requestKey: crypto.randomUUID() } });
    expect(response.status()).toBe(200);
  }

  const contact = await create(businessPath + '/portal-accounts', { email: 'portal-recovery-customer@example.test' });
  const customer = await browser.newPage({ baseURL });
  await browserOrigin(customer);
  try {
    await customer.goto('/portal');
    await customer.getByRole('button', { name: 'Activate account' }).click();
    await customer.getByLabel('Activation code').fill(contact.activationCode);
    await customer.getByLabel('Password', { exact: true }).fill(password);
    await customer.getByRole('button', { name: 'Set password' }).click();
    await expect(customer.getByRole('heading', { name })).toBeVisible();
    await expect(customer.getByText('RECOVERY-01')).toBeVisible();
    await expect(customer.getByText('UNRELATED-01')).toHaveCount(0);
    const foreignPaymentPath = api + '/portal/invoices/' + foreignInvoice.id + '/payments';
    expect((await customer.request.get(foreignPaymentPath)).status()).toBe(404);

    await customer.getByRole('button', { name: 'Outlets', exact: true }).click();
    await expect(customer.getByText('Recovery fixture outlet')).toBeVisible();
    await customer.getByRole('button', { name: 'Downloads', exact: true }).click();
    const installer = customer.getByRole('link', { name: 'Windows installer' });
    const completed = customer.waitForEvent('download');
    await installer.click();
    const download = await completed;
    expect(download.suggestedFilename()).toBe('OrderRestro.msix');
    expect(await download.failure()).toBeNull();
    await customer.getByRole('button', { name: 'Outlets', exact: true }).click();
    await expect(customer.getByText('Recovery fixture outlet')).toBeVisible();
    await setStatus('suspended');
    await customer.getByRole('button', { name: 'Downloads', exact: true }).click();
    await expect(customer.getByRole('heading', { name: 'Hosted access suspended' })).toBeVisible();
    await expect(customer.getByText('Recovery fixture outlet')).toHaveCount(0);
    await expect(customer.getByRole('button', { name: 'Outlets', exact: true })).toHaveCount(0);
    await expect(customer.getByRole('link', { name: 'nventra01@gmail.com' })).toBeVisible();
    await customer.getByRole('button', { name: 'View payments' }).click();
    await expect(customer.getByText('SYNTHETIC-UPI', { exact: false })).toBeVisible();
    expect((await customer.request.get(foreignPaymentPath)).status()).toBe(404);
    expect((await customer.request.get(api + '/portal/outlets')).status()).toBe(403);
    expect((await customer.request.get(api + '/portal/downloads/windows-installer')).status()).toBe(403);

    await setStatus('active');
    await customer.getByRole('button', { name: 'Refresh access' }).click();
    await customer.getByRole('button', { name: 'Outlets', exact: true }).click();
    await expect(customer.getByText('Recovery fixture outlet')).toBeVisible();
    expect((await customer.request.get(api + '/portal/downloads/not-a-real-install')).status()).toBe(404);
    expect((await customer.goto('/portal/not-a-resource'))?.status()).toBe(404);
  } finally {
    await customer.close();
  }
});
