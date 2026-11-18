import { expect, test, type Page } from '@playwright/test';

const origin = 'https://localhost:4172';
const address = 'recipient@example.test';

async function openFixtureTicket(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('browser fixture passphrase');
  await page.getByRole('button', { name: 'Continue' }).click();
  const { base32Decode, hotp, stepAt } = require('../../packages/types/dist/node/totp');
  const fixtureSeed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  await page.getByLabel('Verification code').fill(hotp(base32Decode(fixtureSeed), stepAt(Date.now())));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('button', { name: /Printer support/ }).click();
  await expect(page.getByRole('heading', { name: 'Printer support' })).toBeVisible();
}

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

  await openFixtureTicket(page, 'reply-staff@example.test');

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

for (const action of ['pagination', 'refresh', 'reply', 'queue'] as const) {
  test(`clears revoked access after ticket ${action}`, async ({ page }) => {
    let revoked = false;
    await page.route('**/api/control/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = request.headers();
      if (headers.origin === origin.replace('https:', 'http:')) headers.origin = origin;
      if (action === 'queue' && request.method() === 'GET' && url.pathname.endsWith('/tickets')) {
        if (revoked) return route.fulfill({ status: 403 });
        const result = await route.fetch({ headers });
        const list = await result.json();
        return route.fulfill({ response: result, json: { ...list, nextCursor: list.items[0].id } });
      }
      if (revoked && action === 'reply' && request.method() === 'POST' && url.pathname.endsWith('/messages')) {
        return route.fulfill({ status: 403 });
      }
      if (request.method() === 'GET' && /\/tickets\/[^/]+$/.test(url.pathname)) {
        if (revoked && action === 'refresh') return route.fulfill({ status: 403 });
        const result = await route.fetch({ headers });
        if (revoked) return route.fulfill({ response: result });
        const detail = await result.json();
        return route.fulfill({ response: result, json: { ...detail,
          replyTarget: { address, verified: true }, messages: { ...detail.messages, nextCursor: 1 } } });
      }
      return route.continue({ headers });
    });

    await openFixtureTicket(page, 'reply-' + action + '@example.test');
    const threadText = page.getByText('<b>Receipt printer offline</b>', { exact: false });
    await expect(threadText).toBeVisible();
    await expect(page.getByText(address, { exact: true })).toBeVisible();
    await page.getByLabel('Email reply', { exact: true }).fill('A pending fixture draft.');
    revoked = true;

    if (action === 'pagination') {
      await page.getByRole('button', { name: 'More messages' }).click();
      await expect(page.getByRole('button', { name: 'More messages' })).toHaveCount(0);
      await expect(threadText).toBeVisible();
    } else if (action === 'queue') {
      await page.getByRole('button', { name: 'More tickets' }).click();
      await expect(page.getByRole('main').getByRole('alert')).toContainText('Your current permissions');
      await expect(page.getByRole('button', { name: /Printer support/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'More tickets' })).toHaveCount(0);
      await expect(threadText).toHaveCount(0);
    } else {
      await page.getByRole('button', { name: action === 'refresh' ? 'Refresh conversation' : 'Queue reply' }).click();
      await expect(page.getByRole('main').getByRole('alert')).toContainText('Your current permissions');
      await expect(threadText).toHaveCount(0);
    }
    await expect(page.getByText(address, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Email reply', { exact: true })).toHaveCount(0);
    if (action === 'queue') {
      revoked = false;
      await page.getByRole('button', { name: 'Retry ticket queue' }).click();
      await expect(page.getByRole('button', { name: /Printer support/ })).toBeVisible();
      await expect(threadText).toHaveCount(0);
      await expect(page.getByText(address, { exact: true })).toHaveCount(0);
    }
    if (action === 'reply') {
      await expect(page.getByRole('button', { name: /Printer support/ })).toBeVisible();
      await page.getByRole('button', { name: 'Retry ticket' }).click();
      await expect(threadText).toBeVisible();
      await expect(page.getByText(address, { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Email reply', { exact: true })).toHaveCount(0);
    }
  });
}