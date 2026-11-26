const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('password visibility control provides a keyboard-visible focus ring', () => {
  const source = readFileSync('apps/web/components/ui/password-input.tsx', 'utf8');
  assert.match(source, /focus-visible:ring-2/);
  assert.match(source, /focus-visible:ring-ring/);
  assert.match(source, /focus-visible:ring-inset/);
});
