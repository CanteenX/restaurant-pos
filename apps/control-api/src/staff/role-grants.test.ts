import assert from 'node:assert/strict';
import test from 'node:test';
import * as types from '@nventra/types';
import { CONTROL_PERMISSIONS, controlRoleCreate, controlRoleUpdate, controlStaffRoleAssignment,
  effectiveControlGrants } from '@nventra/types';

void test('role management is a fixed-vocabulary permission and no role list is exported from code', () => {
  assert.ok((CONTROL_PERMISSIONS as readonly string[]).includes('cc.role.manage'));
  assert.equal(new Set(CONTROL_PERMISSIONS).size, CONTROL_PERMISSIONS.length);
  assert.equal('CONTROL_ROLE_PRESETS' in types, false);
});

void test('effective grants are role plus extras minus removals, deduplicated, in vocabulary order', () => {
  assert.deepEqual(effectiveControlGrants(['cc.ticket.read', 'cc.business.read'], ['cc.plan.read', 'cc.ticket.read'], ['cc.business.read']),
    ['cc.plan.read', 'cc.ticket.read']);
  assert.deepEqual(effectiveControlGrants([], [], []), []);
  assert.deepEqual(effectiveControlGrants(['cc.ticket.read'], [], ['cc.ticket.read']), []);
  assert.deepEqual(effectiveControlGrants(['cc.ticket.read', 'not.a.permission'], [], []), ['cc.ticket.read']);
});

void test('role request bodies reject unknown, duplicate and oversized input', () => {
  const ok = { key: 'billing-ops', name: ' Billing ', grants: ['cc.billing.read'] };
  assert.deepEqual(controlRoleCreate.parse(ok), { ...ok, name: 'Billing', description: '' });
  for (const bad of [{ ...ok, key: 'Bad Key' }, { ...ok, key: 'x' }, { ...ok, name: ' ' }, { ...ok, grants: ['cc.nope'] },
    { ...ok, grants: ['cc.billing.read', 'cc.billing.read'] }, { ...ok, extra: 1 }, { ...ok, description: 'x'.repeat(301) }, null]) {
    assert.equal(controlRoleCreate.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(controlRoleUpdate.safeParse({}).success, false);
  assert.equal(controlRoleUpdate.safeParse({ key: 'renamed' }).success, false);
  assert.equal(controlRoleUpdate.safeParse({ grants: [] }).success, true);
  const id = '00000000-0000-4000-8000-0000000000a1';
  assert.deepEqual(controlStaffRoleAssignment.parse({ roleId: id }), { roleId: id, extraGrants: [], removedGrants: [] });
  assert.equal(controlStaffRoleAssignment.safeParse({ roleId: 'nope' }).success, false);
});
