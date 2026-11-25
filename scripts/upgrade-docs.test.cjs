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
});

test('release checklist verifies tag identity without replacing local tags', () => {
  const checklist = read('RELEASE-CHECKLIST.md');
  assert.match(checklist, /git ls-remote --tags origin/);
  assert.match(checklist, /git rev-parse/);
  assert.doesNotMatch(checklist, /git fetch --tags --force/);
});

test('backup and release notes reflect observed limits and untested upgrade paths', () => {
  const backups = read('BACKUPS.md');
  const notes = read('RELEASE-NOTES-v1.1.0.md');
  assert.doesNotMatch(backups, /Extraction rejects lines over 8 MiB/);
  assert.match(backups, /64 MiB/);
  assert.match(notes, /CasaOS.*Debian.*not tested/i);
  assert.match(notes, /do not use.*in-app updater/i);
});
