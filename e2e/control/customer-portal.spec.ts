import { expect, test, type Page } from '@playwright/test';

const business = { id: '92c0b7c1-6db4-4f24-ab3f-fe8d08136756', displayName: 'Cedar Bistro' };
const account = { accountId: 'e426d9dd-e95a-4833-ac01-5aba5de1c489', businessId: business.id, email: 'manager@example.test' };
const invoice = { id: '91e65ba5-f22a-482a-9e65-cf8323f8bb82', reference: 'INV-2026-2',
  description: 'Hosted plan', dueOn: '2026-11-30', amountPaise: 12_500, paidPaise: 5000,
  balancePaise: 7500, state: 'partially-paid', createdAt: '2026-11-19T00:00:00.000Z' };
const list = (items: object[]) => ({ items, nextCursor: null });

async function portal(page: Page) {
  let suspended = false;
  let signedIn = false;
  let invitation: unknown;
  let ticketBody: unknown;
  let ticketCreated = false;
  await page.route('**/api/control/v1/portal/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/portal/')[1];
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (request.method() === 'POST' && path === 'activate') {
      invitation = request.postDataJSON(); signedIn = true; return json(account);
    }
    if (request.method() === 'POST' && path === 'session') { signedIn = true; return json(account); }
    if (request.method() === 'POST' && path === 'logout') { signedIn = false; return json({ loggedOut: true }); }
    if (!signedIn) return json({}, 401);
    if (path === 'session') return json(account);
    if (path === 'summary') return json({ business, hostedStatus: suspended ? 'suspended' : 'active',
      paymentInstructions: 'Pay the balance against the invoice reference.', supportEmail: 'support@example.test' });
    if (path === 'invoices') return json(list([invoice, {
      ...invoice, id: 'e7179820-10d5-49cd-9ee4-a70aea9856e3', reference: 'MAX-PAISE', amountPaise: Number.MAX_SAFE_INTEGER,
    }]));
    if (path === 'invoices/' + invoice.id + '/payments') return json(list([{ id: 'paid-fixture',
      reference: 'Payment fixture', method: 'upi', amountPaise: 5000, createdAt: '2026-11-19T00:00:00.000Z' }]));
    if (suspended) return json({}, 403);
    if (path === 'outlets') return json(list([{ id: '6e682dd5-084a-45a1-87fa-8d30d80d455d', displayName: 'Market Outlet',
      timeZone: 'Asia/Kolkata', plan: { label: 'Pro', startsAt: '2026-11-01', endsAt: '2027-11-01' } }]));
    if (path === 'downloads') return json({ items: [{ id: 'installer', label: 'POS installer' }] });
    if (path === 'tickets' && request.method() === 'POST') { ticketBody = request.postDataJSON(); ticketCreated = true; }
    if (path === 'tickets') return json(list(ticketCreated ? [{ id: invoice.id, subject: 'Printer support',
      status: 'open', createdAt: '2026-11-19T00:00:00.000Z' }] : []));
    if (path === 'tickets/' + invoice.id) return json({ id: invoice.id, subject: 'Printer support',
      status: 'open', messages: list([{ id: 'message-fixture', direction: 'inbound', text: '<b>Fixture note</b>' }]) });
    return json({}, 404);
  });
  return { suspend: () => { suspended = true; }, restore: () => { suspended = false; },
    invitation: () => invitation, ticket: () => ticketBody };
}

test('activation uses the portal form and preserves invoices and support after mid-session suspension', async ({ page }) => {
  const state = await portal(page);
  await page.goto('/portal');
  await page.getByRole('button', { name: 'Activate account' }).click();
  const code = 'A'.repeat(43), password = 'synthetic portal password';
  await page.getByLabel('Activation code').fill(code);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('heading', { name: business.displayName })).toBeVisible();
  expect(state.invitation()).toEqual({ code, password });
  expect(await page.evaluate(() => [location.pathname, location.search, localStorage.length, sessionStorage.length]))
    .toEqual(['/portal', '', 0, 0]);
  await page.getByRole('button', { name: 'Outlets' }).click();
  await expect(page.getByText('Market Outlet')).toBeVisible();
  await expect(page.getByText('Pro', { exact: true })).toBeVisible();
  state.suspend();
  await page.getByRole('button', { name: 'Downloads' }).click();
  await expect(page.getByRole('heading', { name: 'Hosted access suspended' })).toBeVisible();
  await expect(page.getByText('Market Outlet')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Downloads' })).toHaveCount(0);
  await expect(page.getByText('Pay the balance against the invoice reference.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'support@example.test' })).toBeVisible();
  await page.getByRole('button', { name: 'Invoices' }).click();
  await expect(page.getByText('INV-2026-2')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'MAX-PAISE' })).toContainText('₹9,00,71,99,25,47,409.91');
  await page.getByRole('row').filter({ hasText: 'INV-2026-2' }).getByRole('button', { name: 'View payments' }).click();
  await expect(page.getByText('Payment fixture')).toBeVisible();
  state.restore();
  await page.getByRole('button', { name: 'Refresh access' }).click();
  await page.getByRole('button', { name: 'Downloads' }).click();
  await expect(page.getByRole('link', { name: 'POS installer' }))
    .toHaveAttribute('href', '/api/control/v1/portal/downloads/installer');
});

test('sign-in and ticket creation use only same-origin public portal paths and render text literally', async ({ page }) => {
  const state = await portal(page);
  await page.goto('/portal');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic portal password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: business.displayName })).toBeVisible();
  await page.getByRole('button', { name: 'Tickets' }).click();
  await page.getByLabel('Subject').fill('Printer support');
  await page.getByLabel('Message', { exact: true }).fill('<b>Fixture note</b>');
  await page.getByRole('button', { name: 'Raise ticket' }).click();
  await expect.poll(state.ticket).toEqual({ subject: 'Printer support', text: '<b>Fixture note</b>',
    requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  await page.getByRole('button', { name: 'Printer support' }).click();
  const message = page.getByText('<b>Fixture note</b>', { exact: true });
  await expect(message).toBeVisible();
  await expect(message.locator('b')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Customer portal sign-in' })).toBeVisible();
});

test('unknown portal paths return a branded server 404', async ({ page }) => {
  const response = await page.goto('/portal/not-your-business');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Portal page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to customer portal' })).toHaveAttribute('href', '/portal');
});
