import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createControlApi } from './bootstrap.js';

void test('requires its own listen port before creating a server', async () => {
  await assert.rejects(
    createControlApi({ PORT: '4001' }),
    /^Error: Invalid Control API configuration: CONTROL_API_PORT$/,
  );
});

void test('rejects malformed ports without echoing their values', async () => {
  for (const value of ['do-not-echo-this-config-value', '', '0', '65536', '1e3', ' 4002 ']) {
    await assert.rejects(
      createControlApi({ CONTROL_API_PORT: value }),
      /^Error: Invalid Control API configuration: CONTROL_API_PORT$/,
    );
  }
});

void test('boots independently and reports health under the Control API prefix', async (t) => {
  const { app, port } = await createControlApi({ CONTROL_API_PORT: '4002' });
  t.after(() => app.close());

  assert.equal(port, 4002);
  await app.listen(0, '127.0.0.1');

  const address = await app.getUrl();
  const health = await fetch(new URL('/api/control/v1/health', address));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const posHealth = await fetch(new URL('/api/health', address));
  assert.equal(posHealth.status, 404);
});

void test('the production entry point exits with a redacted diagnostic', () => {
  const value = 'do-not-echo-this-config-value';
  const result = spawnSync(process.execPath, [require.resolve('./main.js')], {
    env: { CONTROL_API_PORT: value },
    encoding: 'utf8',
    timeout: 20_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CONTROL_API_PORT/);
  assert.ok(!result.stderr.includes(value));
  assert.equal(result.stdout, '');
});
