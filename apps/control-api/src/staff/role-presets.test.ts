import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canManageControlStaff, CONTROL_PERMISSIONS, CONTROL_ROLE_PRESETS, controlPermissionSatisfied,
  type ControlPermissionKey,
} from '@nventra/types';

const ids = {
  admin: '00000000-0000-4000-8000-0000000000a1',
  manager: '00000000-0000-4000-8000-0000000000a2',
  peerManager: '00000000-0000-4000-8000-0000000000a3',
  support: '00000000-0000-4000-8000-0000000000a4',
  marketing: '00000000-0000-4000-8000-0000000000a5',
};
const BILLING: readonly ControlPermissionKey[] = ['cc.billing.read', 'cc.billing.manage'];

const expected: Record<string, { allowed: readonly ControlPermissionKey[] }> = {
  OWNER: { allowed: CONTROL_PERMISSIONS },
  MANAGER: {
    allowed: ['cc.staff.read', 'cc.staff.manage', 'cc.business.read', 'cc.business.manage', 'cc.plan.read',
      'cc.plan.manage', 'cc.audit.read', 'cc.hosted.read', 'cc.hosted.manage', 'cc.portal.read', 'cc.portal.manage',
      'cc.ticket.read', 'cc.ticket.manage', 'cc.ticket.reply'],
  },
  SUPPORT: {
    allowed: ['cc.business.read', 'cc.plan.read', 'cc.ticket.read', 'cc.ticket.manage', 'cc.ticket.reply'],
  },
  MARKETING: {
    allowed: ['cc.business.read', 'cc.business.manage', 'cc.plan.read', 'cc.portal.read', 'cc.portal.manage'],
  },
};

void test('the preset catalog is exactly Owner, Manager, Support and Marketing', () => {
  assert.deepEqual(Object.keys(CONTROL_ROLE_PRESETS).sort(), Object.keys(expected).sort());
  assert.equal('SALES' in CONTROL_ROLE_PRESETS, false);
  assert.equal(Object.isFrozen(CONTROL_ROLE_PRESETS), true);
});

for (const [name, { allowed }] of Object.entries(expected)) {
  void test(name + ' preset holds exactly its explicit allowed list and none of the denied list', () => {
    const preset = (CONTROL_ROLE_PRESETS as Record<string, readonly ControlPermissionKey[]>)[name];
    assert.ok(preset, name + ' preset exists');
    assert.equal(Object.isFrozen(preset), true);
    assert.deepEqual([...preset].sort(), [...allowed].sort());
    assert.equal(new Set(preset).size, preset.length, 'no duplicate grants');
    for (const key of preset) assert.ok(CONTROL_PERMISSIONS.includes(key), key + ' is a catalog key');
    for (const key of CONTROL_PERMISSIONS.filter((k) => !allowed.includes(k))) {
      assert.equal(controlPermissionSatisfied(preset, key), false, name + ' must not hold ' + key);
    }
  });
}

void test('Manager is everything except billing', () => {
  const manager: readonly ControlPermissionKey[] = CONTROL_ROLE_PRESETS.MANAGER;
  assert.deepEqual([...CONTROL_PERMISSIONS].filter((k) => !manager.includes(k)).sort(), [...BILLING].sort());
  for (const key of ['cc.plan.manage', 'cc.audit.read', 'cc.staff.manage'] as const) {
    assert.equal(controlPermissionSatisfied(manager, key), true);
  }
});

void test('Support and Marketing never hold billing, hosted access, audit or staff grants', () => {
  for (const preset of [CONTROL_ROLE_PRESETS.SUPPORT, CONTROL_ROLE_PRESETS.MARKETING]) {
    for (const key of [...BILLING, 'cc.hosted.read', 'cc.hosted.manage', 'cc.audit.read', 'cc.staff.read', 'cc.staff.manage'] as const) {
      assert.equal(controlPermissionSatisfied(preset, key), false, key);
    }
  }
  for (const key of ['cc.ticket.read', 'cc.ticket.manage', 'cc.ticket.reply'] as const) {
    assert.equal(controlPermissionSatisfied(CONTROL_ROLE_PRESETS.MARKETING, key), false, key);
  }
  for (const key of ['cc.business.manage', 'cc.plan.manage', 'cc.portal.read', 'cc.portal.manage'] as const) {
    assert.equal(controlPermissionSatisfied(CONTROL_ROLE_PRESETS.SUPPORT, key), false, key);
  }
});

void test('grant ceiling: a Manager can never grant billing and never touches an Admin', () => {
  const manager = { staffId: ids.manager, grants: [...CONTROL_ROLE_PRESETS.MANAGER] };
  const admin = { staffId: ids.admin, grants: [...CONTROL_ROLE_PRESETS.OWNER] };
  const support = { staffId: ids.support, grants: [...CONTROL_ROLE_PRESETS.SUPPORT] };
  // Edit, reset 2FA, revoke and deactivate all go through this single decision.
  assert.equal(canManageControlStaff(manager, admin, admin.grants), false);
  assert.equal(canManageControlStaff(manager, admin, []), false);
  assert.equal(canManageControlStaff(manager, admin, [...CONTROL_ROLE_PRESETS.MANAGER]), false);
  for (const key of BILLING) {
    assert.equal(canManageControlStaff(manager, support, [...support.grants, key]), false, key);
    assert.equal(canManageControlStaff(manager, support, [key]), false, key);
  }
  assert.equal(canManageControlStaff(manager, support, [...CONTROL_ROLE_PRESETS.MARKETING]), true);
  assert.equal(canManageControlStaff(manager, { staffId: ids.marketing, grants: [...CONTROL_ROLE_PRESETS.MARKETING] },
    [...CONTROL_ROLE_PRESETS.SUPPORT]), true);
  assert.equal(canManageControlStaff(manager, { staffId: ids.peerManager, grants: [...CONTROL_ROLE_PRESETS.MANAGER] }, []), false);
  assert.equal(canManageControlStaff(manager, { ...manager }, []), false);
  assert.equal(canManageControlStaff(admin, manager, [...CONTROL_ROLE_PRESETS.MANAGER]), true);
});

void test('authorization uses stored grants, so rows created under the old Sales preset keep working', () => {
  const legacySales = ['cc.business.read', 'cc.business.manage', 'cc.plan.read'];
  assert.equal(controlPermissionSatisfied(legacySales, 'cc.business.manage'), true);
  assert.equal(controlPermissionSatisfied(legacySales, 'cc.portal.manage'), false);
  assert.equal(controlPermissionSatisfied(legacySales, 'cc.billing.read'), false);
  const manager = { staffId: ids.manager, grants: [...CONTROL_ROLE_PRESETS.MANAGER] };
  assert.equal(canManageControlStaff(manager, { staffId: ids.support, grants: legacySales }, legacySales), true);
});
