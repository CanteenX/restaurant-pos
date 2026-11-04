// Run with: node --test updater/server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitImage, registryAuthHeader, redact, tokenProblem } = require('./server.js');

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

test('tokenProblem refuses missing, short and published tokens', () => {
  assert.match(tokenProblem(''), /not set/);
  assert.match(tokenProblem('short-token'), /at least 24/);
  // The values the compose files used to default to (upstream, then the
  // rebrand), and the CasaOS placeholder.
  assert.match(tokenProblem('nodedr-restaurant-updater'), /published/);
  assert.match(tokenProblem('nventra-pos-updater'), /published/);
  assert.match(tokenProblem('change-me-to-a-long-random-updater-token'), /published/);
  assert.equal(tokenProblem('3f9a1c0e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f'), null);
});

// The real server over HTTP: a placeholder token disables it outright, a good
// one still demands the exact bearer token.
async function withServer(token, fn) {
  const { spawn } = require('node:child_process');
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [require.resolve('./server.js')], {
    env: { ...process.env, PORT: String(port), UPDATER_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => String(d).includes('listening') && resolve());
      child.on('exit', (code) => reject(new Error(`updater exited ${code}`)));
    });
    await fn((path, bearer) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${bearer}` } }));
  } finally {
    child.kill();
  }
}

test('updater with the published token answers 503 even to that token', async () => {
  await withServer('nodedr-restaurant-updater', async (get) => {
    const res = await get('/v1/status', 'nodedr-restaurant-updater');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /updater disabled/);
  });
});

test('updater with the rebrand default token answers 503 even to that token', async () => {
  await withServer('nventra-pos-updater', async (get) => {
    const res = await get('/v1/status', 'nventra-pos-updater');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /published/);
  });
});

test('updater with a random token rejects other bearers and accepts its own', async () => {
  const token = require('node:crypto').randomBytes(32).toString('hex');
  await withServer(token, async (get) => {
    assert.equal((await get('/v1/status', 'nodedr-restaurant-updater')).status, 401);
    assert.equal((await get('/v1/status', 'nventra-pos-updater')).status, 401);
    assert.equal((await get('/v1/status', '')).status, 401);
    assert.equal((await get('/v1/status', token)).status, 200);
  });
});
