import { expect, request, test, type Browser } from '@playwright/test';

const origin = 'https://localhost:4172';
const baseURL = 'http://localhost:4172';
const prefix = '/api/control/v1';
const subject = 'Portal receipt printer case';
const privateNote = 'Private technician dispatch note.';
const publicReply = 'Please check the printer cable.';
const fixturePassword = 'browser fixture passphrase';

async function newPage(browser: Browser) {
  const page = await browser.newPage({ baseURL });
  await page.route('**/api/control/v1/**', async (route) => {
    const headers = route.request().headers();
    if (headers.origin === baseURL) headers.origin = origin;
    await route.continue({ headers });
  });
  return page;
}

async function portal(principal: { email: string } | { code: string }) {
  const context = await request.newContext({ baseURL, extraHTTPHeaders: { origin } });
  const action = 'code' in principal ? 'activate' : 'session';
  const signIn = await context.post(prefix + '/portal/' + action, { data: { ...principal, password: fixturePassword } });
  expect(signIn.status()).toBe(200);
  const cookie = signIn.headers()['set-cookie']?.split(';', 1)[0];
  if (!cookie?.startsWith('__Host-control_portal=')) throw new Error('Missing portal fixture cookie');
  const { businessId } = await signIn.json() as { businessId: string };
  return { businessId, get: (path: string) => context.get(path, { headers: { cookie } }),
    post: (path: string, data: object) => context.post(path, { headers: { cookie }, data }),
    close: () => context.dispose() };
}

async function staff(browser: Browser) {
  const page = await newPage(browser);
  await page.goto('/');
  await page.getByLabel('Email').fill('portal-support-staff@example.test');
  await page.getByLabel('Password', { exact: true }).fill(fixturePassword);
  await page.getByRole('button', { name: 'Continue' }).click();
  const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
  const fixtureSeed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await page.getByLabel('Verification code').fill(hotp(base32Decode(fixtureSeed), stepAt(Date.now())));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('button', { name: 'Helpdesk', exact: true })).toBeVisible();
  return page;
}

test('supports a portal ticket across staff and customer while enforcing account scope and hosted suspension', async ({ browser }) => {
  test.setTimeout(60_000);
  const agent = await staff(browser);
  const directory = await agent.request.get(prefix + '/businesses');
  expect(directory.status()).toBe(200);
  const { items: businesses } = await directory.json() as { items: { id: string; displayName: string }[] };
  const business = businesses.find(({ displayName }) => displayName === 'Portal Support Bistro');
  if (!business) throw new Error('Missing portal support fixture business');
  const account = await agent.request.post(prefix + '/businesses/' + business.id + '/portal-accounts', {
    headers: { origin }, data: { email: 'portal-ticket-opener@example.test' },
  });
  expect(account.status()).toBe(201);
  const { activationCode } = await account.json() as { activationCode?: string };
  if (!activationCode) throw new Error('Missing synthetic portal activation response');
  const customer = await portal({ code: activationCode });
  const start = prefix + '/portal/tickets';
  const opening = '<b>Printer offline</b>';
  const response = await customer.post(start, { subject, text: opening, requestKey: crypto.randomUUID() });
  expect(response.status()).toBe(201);
  const { id } = await response.json() as { id: string };
  const path = start + '/' + id;
  const messages = async () => {
    const open = await customer.get(path);
    expect(open.status()).toBe(200);
    const thread = await open.json() as { messages: { items: { text: string }[] } };
    return thread.messages.items.map(({ text }) => text);
  };
  expect(await messages()).toEqual([opening]);

  for (const email of ['portal-ticket-colleague@example.test', 'portal-ticket-other@example.test']) {
    const outsider = await portal({ email });
    expect((await outsider.get(path)).status()).toBe(404);
    const { items } = await (await outsider.get(start)).json() as { items: { id: string }[] };
    expect(items.some((ticket) => ticket.id === id)).toBe(false);
    await outsider.close();
  }

  await agent.getByRole('button', { name: 'Helpdesk', exact: true }).click();
  await agent.getByRole('button', { name: new RegExp(subject) }).click();
  await expect(agent.getByRole('heading', { name: subject })).toBeVisible();
  await expect(agent.getByText('Portal ticket', { exact: true })).toBeVisible();
  await expect(agent.getByRole('group', { name: 'Portal ticket scope' })
    .getByText('Portal Support Bistro', { exact: true })).toBeVisible();
  await expect(agent.getByLabel('Ticket business', { exact: true })).toHaveCount(0);
  const [ownerId] = await agent.getByLabel('Ticket owner', { exact: true }).selectOption({ label: 'portal-support-staff@example.test' });
  await agent.getByRole('button', { name: 'Save assignment' }).click();
  await expect(agent.getByText('Ticket assignment saved.', { exact: true })).toBeVisible();
  const staffTicket = prefix + '/tickets/' + id;
  expect(await (await agent.request.get(staffTicket)).json()).toMatchObject({ ownerId, businessId: customer.businessId });
  expect((await agent.request.post(staffTicket + '/messages', { headers: { origin },
    data: { text: 'Mail path remains unbound.', requestKey: crypto.randomUUID() } })).status()).toBe(409);
  await agent.getByLabel('Internal note', { exact: true }).fill(privateNote);
  await agent.getByRole('button', { name: 'Add internal note' }).click();
  await expect(agent.getByText(privateNote, { exact: true })).toBeVisible();
  await agent.getByLabel('Portal reply', { exact: true }).fill(publicReply);
  await agent.getByRole('button', { name: 'Post portal reply' }).click();
  await expect(agent.getByText('Portal reply posted.', { exact: true })).toBeVisible();
  await expect(agent.getByText(publicReply, { exact: true })).toBeVisible();
  await expect(agent.getByText('Queued', { exact: true })).toHaveCount(0);

  expect(await messages()).toEqual([opening, publicReply]);

  const access = prefix + '/businesses/' + customer.businessId + '/hosted-access';
  const setAccess = async (status: 'active' | 'suspended') => {
    const current = await agent.request.get(access);
    expect(current.status()).toBe(200);
    const updated = await agent.request.patch(access, { headers: { origin, 'if-match': current.headers().etag },
      data: { status, reason: 'Synthetic portal browser fixture', requestKey: crypto.randomUUID() } });
    expect(updated.status()).toBe(200);
  };
  await setAccess('suspended');
  try {
    expect((await customer.get(path)).status()).toBe(403);
    expect((await customer.get(start)).status()).toBe(403);
  } finally {
    await setAccess('active');
    await customer.close();
  }
});
