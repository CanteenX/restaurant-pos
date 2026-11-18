import { expect, test, type Page } from '@playwright/test';

const path = '/api/control/v1/audit-events';
async function signIn(page: Page, name: string) {
  await page.route('**/api/control/v1/**', async route => {
    const headers = route.request().headers();
    if (headers.origin === 'http://localhost:4172') headers.origin = 'https://localhost:4172';
    await route.continue({ headers });
  });
  await page.goto('/');
  await page.getByLabel('Email').fill(name + '@example.test');
  await page.getByLabel('Password', { exact: true }).fill('browser fixture passphrase');
  await page.getByRole('button', { name:'Continue' }).click();
  const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
  await page.getByLabel('Verification code').fill(hotp(base32Decode('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'),stepAt(Date.now())));
  await page.getByRole('button', { name:'Verify' }).click();
  await expect(page.getByRole('button',{ name:'Sign out' })).toBeVisible();
}

test('owner can read and page the audit history; a denied request clears prior data', async ({ page }) => {
  await signIn(page,'audit-owner');
  await page.getByRole('button',{ name:'Audit log' }).click();
  await expect(page.getByRole('heading',{ name:'Audit log' })).toBeVisible();
  await expect(page.getByRole('cell',{ name:'fixture.audit.24', exact:true })).toBeVisible();
  await page.getByRole('button',{ name:'Next',exact:true }).click();
  await expect(page.getByRole('cell',{ name:'fixture.audit.1',exact:true })).toBeVisible();
  await page.getByRole('button',{ name:'Client operations' }).click();
  await page.getByRole('button',{ name:'Audit log' }).click();
  await expect(page.getByRole('cell',{ name:'fixture.audit.24',exact:true })).toBeVisible();
  await page.route('**/audit-events?*cursor=*',route => route.fulfill({ status:403,body:'' }));
  await page.getByRole('button',{ name:'Next',exact:true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('permission');
  await expect(page.getByRole('table',{ name:'Audit events' })).toHaveCount(0);
  await page.unroute('**/audit-events?*cursor=*');
  await page.getByRole('button',{ name:'Client operations' }).click();
  await page.getByRole('button',{ name:'Audit log' }).click();
  await expect(page.getByRole('table',{ name:'Audit events' })).toBeVisible();
  await page.context().clearCookies();
  await page.getByRole('button',{ name:'Next',exact:true }).click();
  await expect(page.getByRole('heading',{ name:'Staff sign-in' })).toBeVisible();
  await expect(page.getByRole('table',{ name:'Audit events' })).toHaveCount(0);
});

test('sales staff cannot open the audit workspace or its API', async ({ page }) => {
  await signIn(page,'audit-sales');
  await expect(page.getByRole('button',{ name:'Audit log' })).toHaveCount(0);
  expect((await page.request.get(path)).status()).toBe(403);
});

test('an audit-only reader lands directly on the log without other workspaces', async ({ page }) => {
  await signIn(page,'audit-reader');
  await expect(page.getByRole('heading',{ name:'Audit log' })).toBeVisible();
  await expect(page.getByRole('cell',{ name:'fixture.audit.24',exact:true })).toBeVisible();
  await expect(page.getByRole('button',{ name:'Client operations' })).toHaveCount(0);
  await expect(page.getByRole('button',{ name:'Helpdesk' })).toHaveCount(0);
});
