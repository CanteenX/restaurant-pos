import { expect, test, type Page } from '@playwright/test';

const { subject, recipient, incomingId, incomingText, receiveFixtureMail, deliverFixtureReply } = require('./mail-roundtrip-fixture.cjs');

const origin = 'https://localhost:4172';
const api = '/api/control/v1';

async function openConversation(page: Page, email: string) {
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
  const seed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await page.getByLabel('Verification code').fill(hotp(base32Decode(seed), stepAt(Date.now())));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('button', { name: new RegExp(subject) }).click();
  await expect(page.getByRole('heading', { name: subject })).toBeVisible();
}

test('receives a fake IMAP message and sends one staff reply through the real queue', async ({ page, browser }) => {
  test.setTimeout(45_000);
  expect(await receiveFixtureMail()).toBe('batch');
  await openConversation(page, 'roundtrip-staff@example.test');
  await expect(page.getByText(incomingText, { exact: true })).toBeVisible();
  await expect(page.getByText(recipient, { exact: true })).toBeVisible();

  const { items } = await (await page.request.get(api + '/tickets')).json() as { items: { id: string; subject: string }[] };
  const ticket = items.find((item) => item.subject === subject);
  expect(ticket).toBeDefined();
  const messages = api + '/tickets/' + ticket!.id + '/messages';
  const note = 'Internal note to the technician only.';
  const text = 'Please power cycle the printer. <b>Thank you</b>';
  const draft = { text, requestKey: crypto.randomUUID() };
  expect((await page.request.post(messages, { headers: { origin }, data: draft })).status()).toBe(403);

  const reader = await browser.newPage({ baseURL: origin.replace('https:', 'http:') });
  try {
    await openConversation(reader, 'roundtrip-reader@example.test');
    await expect(reader.getByText(recipient, { exact: true })).toHaveCount(0);
    await expect(reader.getByRole('button', { name: 'Queue reply' })).toHaveCount(0);
    expect((await reader.request.post(messages, { headers: { origin },
      data: { ...draft, acknowledgeUnverified: true } })).status()).toBe(403);
  } finally {
    await reader.close();
  }

  await page.getByLabel('Internal note', { exact: true }).fill(note);
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  await page.getByLabel('Email reply', { exact: true }).fill(text);
  const queue = page.getByRole('button', { name: 'Queue reply' });
  await expect(queue).toBeDisabled();
  await page.getByRole('checkbox', { name: /unverified recipient/i }).check();
  const pending = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(messages));
  await queue.click();
  const response = await pending;
  expect(response.status()).toBe(201);
  const queued = await response.json();
  expect(queued).toMatchObject({ direction: 'outbound', visibility: 'public', deliveryState: 'queued' });
  const outgoing = page.getByRole('article').filter({ hasText: text });
  await expect(outgoing.getByText('Queued', { exact: true })).toBeVisible();

  const { state, next, deliveries } = await deliverFixtureReply();
  expect({ state, next }).toEqual({ state: 'sent', next: 'idle' });
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]).toMatchObject({ envelope: { to: [recipient] }, messageId: '<' + queued.id + '@nventra.invalid>',
    subject: 'Re: ' + subject, inReplyTo: incomingId, references: incomingId });
  expect(deliveries[0].text).toContain(text);
  expect(deliveries[0].html).toContain('&lt;b&gt;Thank you&lt;/b&gt;');
  expect(deliveries[0].text).not.toContain(note);
  expect(deliveries[0].html).not.toContain(note);
  await page.getByRole('button', { name: 'Refresh conversation' }).click();
  await expect(outgoing.getByText('Sent', { exact: true })).toBeVisible();
});