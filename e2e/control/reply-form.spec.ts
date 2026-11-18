import { expect, test } from '@playwright/test';

const origin = 'https://localhost:4172';
const address = 'recipient@example.test';

test('confirms an unverified target and reuses a queued reply key after a lost response', async ({ page }) => {
  const submissions: { text: string; requestKey: string; acknowledgeUnverified?: true }[] = [];
  let deliveryState = '';
  await page.route('**/api/control/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = request.headers();
    if (headers.origin === origin.replace('https:', 'http:')) headers.origin = origin;
    if (request.method() === 'POST' && url.pathname.endsWith('/messages')) {
      submissions.push(request.postDataJSON());
      if (submissions.length === 1) { await route.fulfill({ status: 502 }); return; }
      deliveryState = 'queued';
      await route.fulfill({ status: 201, json: { id: 'outgoing-browser-fixture' } });
      return;
    }
    if (request.method() === 'GET' && /\/tickets\/[^/]+$/.test(url.pathname)) {
      const result = await route.fetch({ headers });
      const ticket = await result.json();
      const outgoing = deliveryState ? [{ id: 'outgoing-browser-fixture',
        text: 'A technician will follow up.', direction: 'outbound', visibility: 'public', deliveryState }] : [];
      await route.fulfill({ response: result, json: { ...ticket, replyTarget: { address, verified: false },
        messages: { ...ticket.messages, items: [...ticket.messages.items, ...outgoing] } } });
      return;
    }
    await route.continue({ headers });
  });

  await page.goto('/');
  await page.getByLabel('Email').fill('reply-staff@example.test');
  await page.getByLabel('Password', { exact: true }).fill('browser fixture passphrase');
  await page.getByRole('button', { name: 'Continue' }).click();
  const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
  const fixtureSeed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await page.getByLabel('Verification code').fill(hotp(base32Decode(fixtureSeed), stepAt(Date.now())));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('button', { name: /Printer support/ }).click();
  await expect(page.getByRole('heading', { name: 'Printer support' })).toBeVisible();

  await expect(page.getByText(address, { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /recipient|^to$/i })).toHaveCount(0);
  const queue = page.getByRole('button', { name: 'Queue reply' });
  await page.getByLabel('Email reply', { exact: true }).fill('A technician will follow up.');
  await expect(queue).toBeDisabled();
  await page.getByRole('checkbox', { name: /unverified recipient/i }).check();
  await queue.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not complete the ticket request. Try again.' })).toBeVisible();
  await queue.click();
  await expect(page.getByText('Reply queued.', { exact: true })).toBeVisible();
  expect(submissions).toEqual(Array(2).fill({ text: 'A technician will follow up.',
    requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/), acknowledgeUnverified: true }));
  expect(submissions[0].requestKey).toBe(submissions[1].requestKey);
  const reply = page.getByRole('article').filter({ hasText: 'A technician will follow up.' });
  await expect(reply.getByText('Queued', { exact: true })).toBeVisible();
  deliveryState = 'held';
  await page.getByRole('button', { name: 'Refresh conversation' }).click();
  await expect(reply.getByText('Held for review', { exact: true })).toBeVisible();
  deliveryState = 'sent';
  await page.getByRole('button', { name: 'Refresh conversation' }).click();
  await expect(reply.getByText('Sent', { exact: true })).toBeVisible();
});
