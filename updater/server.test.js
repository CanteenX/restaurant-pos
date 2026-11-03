// Run with: node --test updater/server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitImage, registryAuthHeader, redact } = require('./server.js');

test('splitImage parses the rebranded GHCR names', () => {
  assert.deepEqual(splitImage('ghcr.io/canteenx/nventra-pos-backend:1.4.0'), {
    repo: 'ghcr.io/canteenx/nventra-pos-backend',
    tag: '1.4.0',
  });
  assert.deepEqual(splitImage('ghcr.io/canteenx/nventra-pos-web'), {
    repo: 'ghcr.io/canteenx/nventra-pos-web',
    tag: 'latest',
  });
  assert.deepEqual(splitImage('localhost:5000/canteenx/nventra-pos-web:2.0.0'), {
    repo: 'localhost:5000/canteenx/nventra-pos-web',
    tag: '2.0.0',
  });
});

test('registryAuthHeader is empty without a token or for non-GHCR images', () => {
  assert.equal(registryAuthHeader('ghcr.io/canteenx/nventra-pos-web', ''), null);
  assert.equal(registryAuthHeader('docker.io/library/node', 'tok'), null);
  assert.equal(registryAuthHeader('ghcr.io.evil.com/x/y', 'tok'), null);
});

test('registryAuthHeader encodes GHCR credentials for the Docker API', () => {
  const h = registryAuthHeader('ghcr.io/canteenx/nventra-pos-web', 'tok123');
  const decoded = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.deepEqual(decoded, { username: 'token', password: 'tok123', serveraddress: 'ghcr.io' });
});

test('redact removes the token from error text', () => {
  assert.equal(redact('pull failed: bad tok123 here', 'tok123'), 'pull failed: bad *** here');
  assert.equal(redact('nothing', ''), 'nothing');
});
