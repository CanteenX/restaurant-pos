const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const ts = require('../apps/control/node_modules/typescript');
require.extensions['.tsx'] = (module, path) => module._compile(ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, path);
const React = require('../apps/control/node_modules/react');
const { renderToStaticMarkup } = require('../apps/control/node_modules/react-dom/server');

test('the role picker requires system identity as well as held grants for the system role', () => {
  const { canSelectRole } = require('../apps/control/app/team-permissions.tsx');
  const system = { name: 'Anything', isSystem: true, grants: ['cc.staff.manage'] };
  assert.equal(canSelectRole(system, system.grants, false), false);
  assert.equal(canSelectRole(system, system.grants, true), true);
  assert.equal(canSelectRole(system, [], true), false);
  assert.equal(canSelectRole({ ...system, name: 'Admin', isSystem: false }, system.grants, false), true);
});

test('role preview uses the same permission mapping as navigation, without role names', () => {
  const { visibleSections } = require('../apps/control/app/team-permissions.tsx');
  assert.deepEqual(visibleSections(['cc.ticket.read']).map(([name]) => name), ['Helpdesk']);
  assert.deepEqual(visibleSections(['cc.staff.read']).map(([name]) => name), ['Team']);
  assert.deepEqual(visibleSections(['cc.role.manage']).map(([name]) => name), ['Roles']);
  assert.deepEqual(visibleSections([]), []);
  assert.deepEqual(visibleSections(['cc.billing.manage']), []);
});
test('grouped human checkboxes disable permissions the editor does not hold, retaining checked values', () => {
  const { PermissionEditor } = require('../apps/control/app/team-permissions.tsx');
  const html = renderToStaticMarkup(React.createElement(PermissionEditor, {
    grants: ['cc.billing.read'], ceiling: ['cc.ticket.read'], onChange() {},
  }));
  assert.match(html, /<legend>Billing<\/legend>/);
  assert.match(html, /disabled=""[^>]*checked=""[^>]*\/>Read invoices/);
  const ticket = html.match(/<input[^>]*\/>Read tickets/)[0];
  assert.equal(ticket.includes('disabled=""'), false);
  assert.doesNotMatch(html, />cc\./);
});
