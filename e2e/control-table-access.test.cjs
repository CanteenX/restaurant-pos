const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const team = readFileSync('apps/control/app/team.tsx', 'utf8');
const css = readFileSync('apps/control/app/styles.css', 'utf8');

test('team and role tables expose a focusable labelled scroll region and a visible cue', () => {
  assert.match(team, /className="table-scroll"[^>]*role="region"[^>]*tabIndex=\{0\}/);
  assert.match(team, /aria-label=\{rolesOnly \? 'Roles table' : 'Team table'\}/);
  assert.match(team, /Scroll horizontally to see all columns/);
  assert.match(css, /\.table-scroll:focus-visible/);
});

test('role key HTML pattern supports hyphens under the Unicode sets flag', () => {
  const pattern = team.match(/pattern="([^"]+)"/)[1];
  const regex = new RegExp(`^(?:${pattern})$`, 'v');
  assert.equal(regex.test('sales-team'), true);
  assert.equal(regex.test('Sales!'), false);
});

test('other scrollable tables expose keyboard-focusable labelled regions', () => {
  for (const file of ['audit-log.tsx', 'business-billing.tsx', 'outlet-plans.tsx', 'portal/sections.tsx']) {
    const source = readFileSync(`apps/control/app/${file}`, 'utf8');
    assert.match(source, /className="table-scroll"[^>]*role="region"[^>]*tabIndex=\{0\}[^>]*aria-label="[^"]+"/, file);
  }
});
