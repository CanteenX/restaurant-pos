const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('published image instructions preserve version across both Compose commands', () => {
  for (const file of ['README.md', 'docs/UPGRADING.md']) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /export APP_VERSION=1\.1\.0/);
    assert.match(text, /docker compose pull postgres db-setup backend web\s*\n\s*docker compose build updater\s*\n\s*docker compose up -d --no-build/);
    assert.match(text, /:dev/);
    assert.match(text, /container_name/);
  }
});
