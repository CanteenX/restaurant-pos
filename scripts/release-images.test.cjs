const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('CasaOS metadata preserves install identity and avoids misleading upstream release history', () => {
  const manifest = fs.readFileSync('casaos/docker-compose.yml', 'utf8');
  assert.match(manifest, /^name: nodedr-restaurant-pos$/m);
  assert.match(manifest, /^  id: com\.nodedr\.orderrestro$/m);
  assert.match(manifest, /\/DATA\/AppData\/nodedr-restaurant-pos\//);
  const notes = manifest.split('  release_notes:')[1].split('  website:')[0];
  const version = manifest.match(/^  version: "(\d+\.\d+\.\d+)"/m)?.[1];
  assert.ok(version, 'CasaOS manifest version must be a semantic version');
  const versionHeading = new RegExp(`^\\s+${version.replaceAll('.', '\\.')}:(?=\\s)`, 'gm');
  assert.doesNotMatch(notes, /1\.19\.0:|1\.17\.0:|1\.15\.1:|OrderRestro/);
  assert.equal((notes.match(versionHeading) || []).length, 1);
});

test('release image references and CasaOS version agree', () => {
  const publish = fs.readFileSync('.github/workflows/docker-publish.yml', 'utf8');
  const compose = fs.readFileSync('casaos/docker-compose.yml', 'utf8');
  const env = fs.readFileSync('.env.example', 'utf8');
  const updater = fs.readFileSync('apps/backend/src/system/update.service.ts', 'utf8');
  const version = compose.match(/^  version: "(\d+\.\d+\.\d+)"/m)?.[1];
  assert.ok(version, 'CasaOS manifest version must be a semantic version');
  for (const name of ['nventra-pos-backend', 'nventra-pos-web']) {
    assert.match(publish, new RegExp(`image: ${name}`));
    assert.ok(compose.includes(`image: ghcr.io/canteenx/${name}:${version}`));
  }
  assert.doesNotMatch(publish, /nodedr-restaurant-pos-(backend|web)/);
  assert.equal((publish.match(/image: \[nventra-pos-backend, nventra-pos-web\]/g) || []).length, 2);
  const images = [...compose.matchAll(/image: ghcr\.io\/canteenx\/nventra-pos-(?:backend|web):([^\s]+)/g)];
  assert.equal(images.length, 4);
  assert.ok(images.every((image) => image[1] === version));
  assert.match(env, /UPDATE_IMAGE_REPO=ghcr\.io\/canteenx\/nventra-pos-backend/);
  assert.match(updater, /DEFAULT_IMAGE_REPO = 'canteenx\/nventra-pos-backend'/);
});

test('version bump updates the four tags, manifest and release-note heading', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nventra-release-'));
  try {
    fs.mkdirSync(path.join(directory, 'casaos'));
    fs.copyFileSync('casaos/docker-compose.yml', path.join(directory, 'casaos/docker-compose.yml'));
    execFileSync(process.execPath, [path.resolve('scripts/bump-casaos-version.cjs'), '2.3.4'], { cwd: directory });
    const result = fs.readFileSync(path.join(directory, 'casaos/docker-compose.yml'), 'utf8');
    assert.equal((result.match(/image: ghcr\.io\/canteenx\/nventra-pos-(?:backend|web):2\.3\.4/g) || []).length, 4);
    assert.match(result, /version: "2\.3\.4"/);
    assert.match(result, /^\s+2\.3\.4:/m);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('version bump rejects invalid versions without writing', () => {
  assert.throws(() => execFileSync(process.execPath, ['scripts/bump-casaos-version.cjs', 'latest'], { stdio: 'pipe' }));
});

test('CasaOS metadata and all four release images target v1.1.1', () => {
  const compose = fs.readFileSync('casaos/docker-compose.yml', 'utf8');
  assert.equal(compose.match(/^  version: "([^"\r\n]+)"/m)?.[1], '1.1.1');
  assert.match(compose, /^\s+1\.1\.1:/m);
  const images = [...compose.matchAll(/image: ghcr\.io\/canteenx\/nventra-pos-(?:backend|web):([^\s]+)/g)];
  assert.equal(images.length, 4);
  assert.deepEqual(images.map((image) => image[1]), Array(4).fill('1.1.1'));
});
