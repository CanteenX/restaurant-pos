import { expect, test } from '@playwright/test';

test('serves the isolated Control API at the browser origin', async ({ page }) => {
  const prefix = '/api/control/v1';
  const response = await page.goto(prefix + '/health');
  expect(response?.status()).toBe(200);
  expect(await response?.json()).toEqual({ status: 'ok' });

  const unauthenticated = await page.request.get(prefix + '/staff/session');
  expect(unauthenticated.status()).toBe(401);
  expect(unauthenticated.headers()['cache-control']).toBe('no-store');

  const crossOrigin = await page.request.post(prefix + '/staff/session/logout', {
    headers: { origin: 'https://untrusted.example.test' }, data: {},
  });
  expect(crossOrigin.status()).toBe(403);
});