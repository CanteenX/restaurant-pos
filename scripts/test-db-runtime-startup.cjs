// Run from the repository root after building the backend.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const test = require('node:test');

for (const host of ['postgres', 'nventra-pos-postgres', 'nodedr-restaurant-pos-postgres']) {
  for (const [user, db] of [['nventra','nventra_pos'], ['nodedr','nodedr_restaurant']]) {
    test(`legacy startup and entrypoint refuse the ${user} identity on ${host}`, () => {
      const url = new URL(`postgresql://${host}:5432/${db}`);
      url.username = user;
      const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'sh';
      for (const [cmd, args] of [
        [process.execPath, ['dist/src/system/db-identity-upgrade.cli.js']],
        [shell, ['./container-entrypoint.sh', 'true']],
      ]) {
        const result = spawnSync(cmd, args, {
          cwd: 'apps/backend',
          env: { ...process.env, DATABASE_URL: url.href, NVENTRA_DATABASE_URL_FILE: '' },
          encoding: 'utf8', timeout: 12000,
        });
        assert.equal(result.status, 1);
        assert.match(result.stdout + result.stderr, /Apply the current Compose or CasaOS definition/);
        assert.ok(!(result.stdout + result.stderr).includes(url.href));
      }
    });
  }
}

test('CasaOS runs the updater copied into the backend image at its absolute path', () => {
  const compose = readFileSync('casaos/docker-compose.yml', 'utf8');
  const dockerfile = readFileSync('apps/backend/Dockerfile', 'utf8');
  const runtime = dockerfile.slice(dockerfile.indexOf('FROM node:22-alpine AS runtime'));
  const dest = runtime.match(/WORKDIR (\S+)[\s\S]*?COPY updater\/server.js (\.\/\S+)/);
  assert.ok(dest);
  const expected = require('node:path').posix.resolve(dest[1], dest[2]);
  const updater = compose.split(/^  updater:/m)[1];
  assert.ok(updater, 'CasaOS updater service');
  const command = JSON.parse(updater.match(/^    command: (\[.*\])/m)[1]);
  assert.deepEqual(command, ['node', expected]);
});

test('ci-gate runs the PostgreSQL role and updater regressions when deployment inputs change', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /db_runtime:[\s\S]*?casaos\/docker-compose.yml/);
  assert.ok(!ci.split('workflow_dispatch:')[0].includes('"casaos/**"'));
  assert.match(ci, /if: steps.changes.outputs.db_runtime == 'true'[\s\S]*?bash scripts\/test-db-runtime-role.sh/);
  assert.ok(ci.includes('node --test updater/server.test.js scripts/test-db-runtime-startup.cjs'));
});
