const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('rejects non-fixture input before initializing the database client', () => {
  const intercept = `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function (id, ...args) {
      if (id.includes('control-client')) throw new Error('Started loading the database client');
      return load.call(this, id, ...args);
    };
    process.argv.splice(1, 0, 'e2e/control/seed.cjs');
    require('./e2e/control/seed.cjs');
  `;
  const loopback = 'postgresql://fixture:fixture@127.0.0.1:49199/fixture';
  const cases = [
    [loopback, []],
    ['postgresql://fixture:fixture@postgres.example.test:49199/fixture', ['49199']],
    [loopback, ['49200']],
    [loopback.replace('49199', '54321'), ['54321', 'extra']],
    [loopback.replace('49199', '5432'), ['5432']],
    [loopback.replace('fixture:fixture', 'fixture:fake'), ['49199']],
    [loopback.replace('/fixture', '/owner'), ['49199']],
    [loopback + '?options=-c%20role%3Dcontrol_runtime', ['49199']],
    [loopback + '#extra', ['49199']],
  ];
  for (const [url, args] of cases) {
    const result = spawnSync(process.execPath, ['-e', intercept, '--', ...args], {
      encoding: 'utf8', timeout: 5_000, env: { ...process.env, CONTROL_DATABASE_URL: url },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Control browser fixture seed failed.\n');
  }
});