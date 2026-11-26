const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (name) => readFileSync(join(__dirname, '..', 'docs', name), 'utf8');

test('upgrade guide documents pre-upgrade backup and rollback consequences', () => {
  const guide = read('UPGRADING.md');
  assert.match(guide, /## Back up and roll back a v1\.0\.1 Docker install/);
  assert.match(guide, /S3-compatible/);
  assert.match(guide, /writes after the backup/i);
  assert.match(guide, /nventra_owner.*nventra_runtime.*nventra_restore/s);
  assert.match(guide, /superuser/i);
  assert.match(guide, /do not use.*in-app updater/i);
  assert.match(guide, /createdb -U nventra -O nventra nventra_pos/);
  assert.match(guide, /pg_restore --exit-on-error --no-owner/);
  assert.match(guide, /docker compose cp .*uploads/);
  assert.match(guide, /isolated.*project name/i);
  assert.match(guide, /separate recovery host/i);
  assert.match(guide, /stopped containers.*reserve/i);
  assert.match(guide, /pull_policy: never/);
  assert.match(guide, /RECOVERY_BACKEND_IMAGE_ID/);
  assert.match(guide, /docker inspect.*Mounts/s);
  assert.match(guide, /docker image save/);
  assert.match(guide, /docker image load/);
  assert.match(guide, /sha256sum -c/);
  assert.match(guide, /export COMPOSE_FILE=docker-compose\.yml:recovery-images\.yml/);
  assert.match(guide, /before applying any migration/);
  assert.match(guide, /published.*nodedr-restaurant-pos/is);
});

test('release documentation explains old updater and future image publication', () => {
  const notes = read('RELEASE-NOTES-v1.1.0.md');
  const checklist = read('RELEASE-CHECKLIST.md');
  assert.match(notes, /before applying any migration/);
  assert.match(checklist, /before applying any migration/);
  assert.match(notes, /images.*(?:tag|publish)/is);
  assert.match(checklist, /git fetch --tags --force/);
  assert.match(checklist, /v1\.0\.1 in-app updater/is);
});

test('release documents accurately describe the verified stock updater rollback', () => {
  for (const name of ['UPGRADING.md', 'RELEASE-NOTES-v1.1.0.md', 'RELEASE-CHECKLIST.md']) {
    const doc = read(name);
    assert.match(doc, /no database or upload data changed/);
    assert.match(doc, /non-stock DATABASE_URL was not tested/);
    assert.doesNotMatch(doc, /at least one (?:newer? )?(?:database )?migration/i);
  }
  assert.match(read('UPGRADING.md'), /Windows.*(?:not tested|untested)/i);
});

test('release checklist verifies tag identity and documents refresh', () => {
  const checklist = read('RELEASE-CHECKLIST.md');
  assert.match(checklist, /git ls-remote --tags origin/);
  assert.match(checklist, /git rev-parse/);
  assert.match(checklist, /git fetch --tags --force/);
});

test('backup and release notes reflect observed limits and untested upgrade paths', () => {
  const backups = read('BACKUPS.md');
  const notes = read('RELEASE-NOTES-v1.1.0.md');
  assert.doesNotMatch(backups, /Extraction rejects lines over 8 MiB/);
  assert.match(backups, /64 MiB/);
  assert.match(notes, /CasaOS.*Debian.*not tested/i);
  assert.match(notes, /do not use.*in-app updater/i);
});

test('recovery guidance prevents partial restores and preserves transferable images', () => {
  const guide = read('UPGRADING.md');
  const checklist = read('RELEASE-CHECKLIST.md');
  const notes = read('RELEASE-NOTES-v1.1.0.md');
  assert.match(guide, /set -e/);
  assert.match(guide, /--wait.*postgres/);
  assert.match(guide, /do not start (?:the )?backend.*restore/sim);
  assert.match(guide, /same.host/is);
  assert.match(guide, /RepoTags/);
  assert.match(guide, /store types?/i);
  assert.match(guide, /\.env/);
  assert.doesNotMatch(guide, /migrations increased from 69 to 70/);
  assert.doesNotMatch(notes, /69 to 70/);
  assert.doesNotMatch(checklist, /refs\/tags\/v1\.0\.1\*/);
  assert.match(guide, /local registry.*not GHCR/is);
});
