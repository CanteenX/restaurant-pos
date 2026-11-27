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
// ---- update + automatic rollback (fake Docker engine, no daemon needed) ----
const { createUpdater } = require('./server.js');
const { fakeDocker } = require('./fake-docker.js');

const B = 'reg.local/canteenx/nventra-pos-backend';
const W = 'reg.local/canteenx/nventra-pos-web';
const fast = { healthTimeoutMs: 200, graceMs: 20, pollMs: 2 };

function install(health) {
  const fd = fakeDocker({ health, images: [`${B}:1.0.1`, `${W}:1.0.1`] });
  fd.add('app-backend', `${B}:1.0.0`);
  fd.add('app-web', `${W}:1.0.0`);
  const up = createUpdater({ docker: fd.docker, targets: ['app-backend', 'app-web'], ...fast });
  return { fd, up };
}

function installWithSetup(result) {
  const { fd } = install((image, name) => {
    if (name === 'app-db-setup-update') {
      if (image === `${B}:1.0.0`) return 'completed';
      assert.equal(image, `${B}:1.0.1`);
      return result;
    }
    return 'healthy';
  });
  fd.add('app-db-setup', `${B}:1.0.0`, false);
  fd.containers.get('app-db-setup').Config.Cmd = ['setup'];
  const up = createUpdater({ docker: fd.docker, targets: ['app-backend', 'app-web'], dbSetup: 'app-db-setup', ...fast });
  return { fd, up };
}

test('rejects a downgrade of any target before pulling or stopping containers', async () => {
  const fd = fakeDocker({ images: [`${B}:1.1.0`, `${W}:1.1.0`] });
  fd.add('app-backend', `${B}:1.0.0`);
  fd.add('app-web', `${W}:1.2.0`);
  const up = createUpdater({ docker: fd.docker, targets: ['app-backend', 'app-web'], ...fast });
  await up.run('1.1.0');
  assert.equal(up.status.state, 'error');
  assert.match(up.status.error, /downgrade/i);
  assert.ok(!fd.log.some(entry => entry.startsWith('POST /images/create') || entry.includes('/stop')));
  assert.ok(fd.running('app-backend') && fd.running('app-web'));
});

test('rejects a downgrade from an immutable pinned image source', async () => {
  const fd = fakeDocker({ images: [`${B}:1.2.0`, `${B}:1.1.0`] });
  fd.add('app-backend', `${B}:1.2.0`);
  const container = fd.containers.get('app-backend');
  container.Config.Image = container.Image;
  container.Config.Labels = { 'com.nventra.updater.source': `${B}:1.2.0` };
  const up = createUpdater({ docker: fd.docker, targets: ['app-backend'], ...fast });
  await up.run('1.1.0');
  assert.equal(up.status.state, 'error');
  assert.match(up.status.error, /downgrade/i);
  assert.ok(!fd.log.some(entry => entry.startsWith('POST /images/create') || entry.includes('/stop')));
});

test('compares release components numerically and accepts development tags', async () => {
  const fd = fakeDocker({ images: [`${B}:1.10.0`, `${W}:1.10.0`] });
  fd.add('app-backend', `${B}:1.9.0`);
  fd.add('app-web', `${W}:dev`);
  const up = createUpdater({ docker: fd.docker, targets: ['app-backend', 'app-web'], ...fast });
  await up.run('1.10.0');
  assert.equal(up.status.state, 'done', up.status.error);
});

test('compares large numeric components without rounding and handles equal releases', async () => {
  const fd = fakeDocker();
  fd.add('app-backend', `${B}:1.9007199254740993.0`);
  const up = createUpdater({ docker: fd.docker, targets: ['app-backend'], ...fast });
  await up.run('1.9007199254740992.0');
  assert.equal(up.status.state, 'error');
  assert.match(up.status.error, /downgrade/i);
  assert.ok(!fd.log.some(entry => entry.startsWith('POST /images/create') || entry.includes('/stop')));
  await up.run('1.9007199254740993.0');
  assert.equal(up.status.state, 'done', up.status.error);
});

test('managed update runs the target image setup between stopping and replacing the backend', async () => {
  const { fd, up } = installWithSetup('completed');
  await up.run('1.0.1');
  assert.equal(up.status.state, 'done', up.status.error);
  const stop = fd.log.indexOf('POST /containers/app-backend/stop');
  const setup = fd.log.indexOf('POST /containers/create?name=app-db-setup-update');
  const start = fd.log.indexOf('POST /containers/create?name=app-backend');
  assert.ok(stop < setup && setup < start, fd.log.join('\n'));
  assert.ok(!fd.containers.has('app-db-setup-update'));
  assert.equal(fd.imageOf('app-db-setup'), `${B}:1.0.0`);
});

for (const problem of ['missing', 'running', 'occupied job name']) {
  test(`managed setup preflight leaves the healthy backend serving with ${problem}`, async () => {
    const { fd, up } = installWithSetup('completed');
    if (problem === 'missing') fd.containers.delete('app-db-setup');
    if (problem === 'running') fd.containers.get('app-db-setup')._running = true;
    if (problem === 'occupied job name') fd.add('app-db-setup-update', `${B}:1.0.0`, false);
    await up.run('1.0.1');
    assert.ok(!fd.log.includes('POST /containers/app-backend/stop'));
    assert.ok(fd.running('app-backend'));
    assert.equal(up.status.state, 'error');
    assert.match(up.status.error, /database setup failed/);
    assert.ok(!fd.log.includes('POST /containers/create?name=app-db-setup-update'));
  });
}

test('a setup create failure restores service without running the previous setup', async () => {
  const { fd } = installWithSetup('completed');
  let attempts = 0;
  const docker = (...args) => {
    if (args[0] === 'POST' && args[1] === '/containers/create?name=app-db-setup-update') {
      attempts++;
      throw new Error('create rejected');
    }
    return fd.docker(...args);
  };
  const up = createUpdater({ docker, targets: ['app-backend'], dbSetup: 'app-db-setup', ...fast });
  await up.run('1.0.1');
  assert.equal(attempts, 1);
  assert.ok(fd.running('app-backend'));
  assert.equal(up.status.state, 'rolled_back');
});

test('managed update restores the previous backend if the setup job fails', async () => {
  const { fd, up } = installWithSetup('exits');
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rolled_back', up.status.error ?? 'update did not roll back');
  assert.match(up.status.error, /database setup failed/);
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.0`);
  assert.ok(fd.running('app-backend'));
  assert.equal(fd.log.filter(entry => entry === 'POST /containers/create?name=app-db-setup-update').length, 2);
  assert.ok(!fd.log.includes('POST /containers/create?name=app-backend'));
  assert.ok(!fd.containers.has('app-db-setup-update'));
});

test('managed rollback restores the previous capture definitions before starting the previous backend', async () => {
  const setupImages = [];
  const { fd } = install((image, name) => {
    if (name === 'app-db-setup-update') return 'completed';
    return image === `${W}:1.0.1` ? 'unhealthy' : 'healthy';
  });
  fd.add('app-db-setup', `${B}:1.0.0`, false);
  fd.containers.get('app-db-setup').Config.Cmd = ['setup'];
  const docker = (method, path, body, headers) => {
    if (path === '/containers/create?name=app-db-setup-update') setupImages.push(body.Image);
    return fd.docker(method, path, body, headers);
  };
  const up = createUpdater({ docker, targets: ['app-backend', 'app-web'], dbSetup: 'app-db-setup', ...fast });
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rolled_back', up.status.error);
  assert.deepEqual(setupImages, [fd.imageId(`${B}:1.0.1`), fd.imageId(`${B}:1.0.0`)]);
  assert.ok(fd.log.lastIndexOf('POST /containers/create?name=app-db-setup-update') <
    fd.log.indexOf('POST /containers/app-backend/start'));
});

test('failed previous setup leaves the previous backend stopped for recovery', async () => {
  const { fd } = install((_, name) => name === 'app-db-setup-update' ? 'exits' : 'healthy');
  fd.add('app-db-setup', `${B}:1.0.0`, false);
  fd.containers.get('app-db-setup').Config.Cmd = ['setup'];
  const up = createUpdater({ docker: fd.docker, targets: ['app-backend'], dbSetup: 'app-db-setup', ...fast });
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rollback_failed');
  assert.equal(fd.running('app-backend'), false);
  assert.equal(up.status.rolledBackTo, null);
});

test('consecutive managed updates use matching immutable setup and backend images and restore the actual prior image', async () => {
  const { fd } = install((image, name) => {
    if (name === 'app-db-setup-update') return 'completed';
    return image === `${W}:1.0.2` ? 'unhealthy' : 'healthy';
  });
  fd.add('app-db-setup', `${B}:1.0.0`, false);
  fd.containers.get('app-db-setup').Config.Cmd = ['setup'];
  const setup = [], backend = [];
  const docker = (m, path, body, headers) => {
    if (path === '/containers/create?name=app-db-setup-update') setup.push(body.Image);
    if (path === '/containers/create?name=app-backend') backend.push(body.Image);
    return fd.docker(m, path, body, headers);
  };
  const up = createUpdater({docker, targets: ['app-backend','app-web'], dbSetup: 'app-db-setup', ...fast});
  await up.run('1.0.1');
  assert.equal(up.status.state, 'done', up.status.error);
  for (const repo of [B, W]) fd.imageSet.add(`${repo}:1.0.2`);
  await up.run('1.0.2');
  assert.equal(up.status.state, 'rolled_back', up.status.error);
  assert.equal(up.status.rolledBackTo, '1.0.1');
  const n = fd.imageId(`${B}:1.0.1`), next = fd.imageId(`${B}:1.0.2`);
  assert.deepEqual(setup, [n, next, n]);
  assert.deepEqual(backend, [n, next]);
  assert.equal(fd.containers.get('app-backend').Image, n);
});

test('healthy N+1 replaces both containers and cleans up the old ones', async () => {
  const { fd, up } = install(() => 'healthy');
  await up.run('1.0.1');
  assert.equal(up.status.state, 'done', up.status.error);
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.1`);
  assert.equal(fd.imageOf('app-web'), `${W}:1.0.1`);
  assert.ok(fd.running('app-backend') && fd.running('app-web'));
  assert.ok(!fd.containers.has('app-backend-old') && !fd.containers.has('app-web-old'));
  assert.ok(!fd.imageSet.has(`${B}:1.0.0`), 'superseded image removed');
});

test('containers without a healthcheck count as healthy once they stay up', async () => {
  const { up } = install(() => 'running');
  await up.run('1.0.1');
  assert.equal(up.status.state, 'done', up.status.error);
});

test('an unhealthy N+1 is rolled back automatically and the reason reported', async () => {
  const { fd, up } = install((img) => (img === `${W}:1.0.1` ? 'unhealthy' : 'healthy'));
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rolled_back');
  assert.equal(up.status.rolledBackTo, '1.0.0');
  assert.match(up.status.error, /app-web.*unhealthy/);
  // Both containers are back on N (backend had already been swapped), running.
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.0`);
  assert.equal(fd.imageOf('app-web'), `${W}:1.0.0`);
  assert.ok(fd.running('app-backend') && fd.running('app-web'));
  assert.ok(!fd.containers.has('app-backend-old') && !fd.containers.has('app-web-old'));
  assert.ok(fd.imageSet.has(`${B}:1.0.0`), 'old image kept for the restored container');
  // The pulled N+1 images are dropped so repeated failed attempts don't fill the disk.
  assert.ok(!fd.imageSet.has(`${B}:1.0.1`) && !fd.imageSet.has(`${W}:1.0.1`), 'failed N+1 images removed');
  // Volumes/bind mounts were carried over untouched.
  assert.deepEqual(fd.containers.get('app-backend').HostConfig.Binds, ['data:/data']);
});

test('a container that exits after start is rolled back', async () => {
  const { fd, up } = install((img) => (img === `${B}:1.0.1` ? 'exits' : 'running'));
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rolled_back');
  assert.match(up.status.error, /app-backend.*exited/);
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.0`);
  assert.equal(fd.imageOf('app-web'), `${W}:1.0.0`, 'web never touched');
});

test('a container that never turns healthy times out and is rolled back', async () => {
  const { fd, up } = install((img) => (img === `${B}:1.0.1` ? 'starting' : 'healthy'));
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rolled_back');
  assert.match(up.status.error, /not healthy within/);
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.0`);
});

test('a start failure on the second container also restores the first', async () => {
  const { fd, up } = install((img) => (img === `${W}:1.0.1` ? 'fail-start' : 'healthy'));
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rolled_back');
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.0`);
  assert.equal(fd.imageOf('app-web'), `${W}:1.0.0`);
  assert.ok(fd.running('app-backend') && fd.running('app-web'));
});

test('a pull failure touches nothing and is a plain error', async () => {
  const { fd, up } = install(() => 'healthy');
  await up.run('9.9.9');
  assert.equal(up.status.state, 'error');
  assert.match(up.status.error, /pull .* failed/);
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.0`);
  assert.ok(!fd.log.some((l) => l.includes('/stop')));
});

test('a restored N that is not healthy is reported as rollback_failed, naming it', async () => {
  // N+1 web fails; N backend was migrated past and stays unhealthy once restored.
  const { fd, up } = install((img) => (img === `${W}:1.0.1` || img === `${B}:1.0.0` ? 'unhealthy' : 'healthy'));
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rollback_failed');
  assert.match(up.status.error, /app-web.*unhealthy/);
  assert.match(up.status.error, /rollback failed: restored app-backend failed its health check/);
  assert.equal(up.status.rolledBackTo, null);
  // Both are still put back on N so a human can recover from there.
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.0`);
  assert.equal(fd.imageOf('app-web'), `${W}:1.0.0`);
});

test('a failed restore does not stop the other containers being restored', async () => {
  const { fd, up } = install((img) => (img === `${W}:1.0.1` ? 'unhealthy' : 'healthy'));
  // The rollback runs newest first, so app-web is restored first: make it fail.
  fd.failRename = (from) => from === 'app-web-old';
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rollback_failed');
  assert.match(up.status.error, /could not restore app-web/);
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.0`, 'backend still restored');
  assert.ok(fd.running('app-backend'));
  assert.ok(fd.containers.has('app-web-old'), 'the old web container is kept, not deleted');
});

test('a crash-looping container without a healthcheck is not passed by the grace window', async () => {
  const { fd, up } = install((img) => (img === `${B}:1.0.1` ? 'crashloop' : 'running'));
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rolled_back', up.status.error);
  assert.match(up.status.error, /app-backend restarted during its health check/);
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.0`);
});

test('rollback_failed is not "running", so a new update can be started', async () => {
  const { fd, up } = install((img) => (img === `${W}:1.0.1` ? 'unhealthy' : 'healthy'));
  fd.failRename = (from) => from === 'app-web-old';
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rollback_failed');
  assert.ok(!['pulling', 'restarting'].includes(up.status.state));
});

// ---- a container whose OWN swap fails goes through the same safe rollback ----

test('A: own start fails and its restore fails -> rollback_failed, original reason kept', async () => {
  const { fd, up } = install((img) => (img === `${W}:1.0.1` ? 'fail-start' : 'healthy'));
  fd.failRename = (from) => from === 'app-web-old';
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rollback_failed', up.status.error);
  assert.match(up.status.error, /^docker -> 500: start failed/);
  assert.match(up.status.error, /rollback failed: could not restore app-web: .*rename app-web-old failed/);
  assert.equal(up.status.rolledBackTo, null);
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.0`, 'backend still restored');
  assert.ok(fd.running('app-backend'));
  assert.ok(fd.containers.has('app-web-old'), 'the old web container is kept, not deleted');
});

test('B: own start fails and the restored N is unhealthy -> rollback_failed', async () => {
  const { fd, up } = install((img) => {
    if (img === `${W}:1.0.1`) return 'fail-start';
    if (img === `${W}:1.0.0`) return 'unhealthy';
    return 'healthy';
  });
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rollback_failed', up.status.error);
  assert.match(up.status.error, /start failed/);
  assert.match(up.status.error, /restored app-web failed its health check/);
  assert.equal(fd.imageOf('app-web'), `${W}:1.0.0`);
});

test('C: single target, N+1 and N both fail to start -> rollback_failed, not "running"', async () => {
  const fd = fakeDocker({ health: () => 'fail-start', images: [`${B}:1.0.1`] });
  fd.add('app-backend', `${B}:1.0.0`);
  const up = createUpdater({ docker: fd.docker, targets: ['app-backend'], ...fast });
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rollback_failed', up.status.error);
  assert.match(up.status.error, /could not restore app-backend/);
  assert.equal(fd.running('app-backend'), false);
});

test('D: rename to -old fails after stop -> the stopped N is started again', async () => {
  const { fd, up } = install(() => 'healthy');
  fd.failRename = (from, to) => to === 'app-backend-old';
  await up.run('1.0.1');
  assert.equal(up.status.state, 'rolled_back', up.status.error);
  assert.match(up.status.error, /rename app-backend failed/);
  assert.equal(fd.imageOf('app-backend'), `${B}:1.0.0`);
  assert.ok(fd.running('app-backend'), 'backend is not left stopped');
  assert.equal(fd.imageOf('app-web'), `${W}:1.0.0`, 'web never touched');
});
