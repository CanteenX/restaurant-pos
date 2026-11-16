import { ForbiddenException } from '@nestjs/common';
import {
  assertCanAssignRole,
  assertCanGrant,
  assertCanManage,
  assertCanManageRole,
  canGrant,
  canManage,
  canManageRole,
  ceilingKeys,
  type CeilingActor,
  type CeilingRole,
  type CeilingUser,
} from './privilege-ceiling';

const role = (name: string, keys: string[]): CeilingRole => ({
  name,
  permissions: keys.map((key) => ({ permission: { key } })),
});

const user = (
  id: string,
  r: CeilingRole,
  overrides: CeilingUser['permissionOverrides'] = [],
): CeilingUser => ({ id, role: r, permissionOverrides: overrides });

const OWNER = role('OWNER', ['users.manage', 'roles.manage', 'reports.access']);
const ADMIN = role('ADMINISTRATOR', [
  'users.manage',
  'roles.manage',
  'reports.access',
  'orders.create',
]);
const STAFF_MGR = role('STAFF_MGR', ['users.manage']);
const FULL_MGR = role('FULL_MGR', ['users.manage', 'orders.create']);
const WAITER = role('WAITER', ['orders.create']);
const HIGH = role('HIGH', ['users.manage', 'reports.access']);

const owner: CeilingActor = {
  id: 'o',
  roleName: 'OWNER',
  permissions: ['users.manage'], // owner power does not depend on the list
};
const admin: CeilingActor = {
  id: 'a',
  roleName: 'ADMINISTRATOR',
  permissions: ADMIN.permissions.map((p) => p.permission.key),
};
const staffMgr: CeilingActor = {
  id: 's',
  roleName: 'STAFF_MGR',
  permissions: ['users.manage'],
};
const fullMgr: CeilingActor = {
  id: 'f',
  roleName: 'FULL_MGR',
  permissions: ['users.manage', 'orders.create', 'menu.manage'],
};

describe('ceilingKeys', () => {
  it('is the role permissions plus live GRANT overrides; DENY and expired grants are ignored', () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const keys = ceilingKeys(
      user('w', WAITER, [
        { effect: 'GRANT', expiresAt: null, permission: { key: 'a.live' } },
        { effect: 'GRANT', expiresAt: future, permission: { key: 'b.live' } },
        { effect: 'GRANT', expiresAt: past, permission: { key: 'c.dead' } },
        {
          effect: 'DENY',
          expiresAt: null,
          permission: { key: 'orders.create' },
        },
      ]),
    );
    expect([...keys].sort()).toEqual(['a.live', 'b.live', 'orders.create']);
  });
});

describe('canGrant / assertCanGrant', () => {
  it('allows only keys the actor holds (directly or by implication)', () => {
    expect(canGrant(fullMgr, ['orders.create'])).toBe(true);
    expect(canGrant(fullMgr, ['menu.view'])).toBe(true); // implied by menu.manage
    expect(canGrant(fullMgr, ['orders.create', 'reports.access'])).toBe(false);
    expect(canGrant(fullMgr, [])).toBe(true);
  });

  it('the owner may grant anything', () => {
    expect(canGrant(owner, ['system.update', 'reports.access'])).toBe(true);
  });

  it('throws 403 with a clear message', () => {
    expect(() => assertCanGrant(staffMgr, ['reports.access'])).toThrow(
      ForbiddenException,
    );
    expect(() => assertCanGrant(staffMgr, ['reports.access'])).toThrow(
      /reports.access/,
    );
  });
});

describe('canManageRole / assertCanManageRole', () => {
  it('only an owner may manage the OWNER role', () => {
    expect(canManageRole(owner, OWNER)).toBe(true);
    expect(canManageRole(admin, OWNER)).toBe(false); // admin holds every key
    expect(() => assertCanManageRole(admin, OWNER)).toThrow(ForbiddenException);
  });

  it('a role must be a subset of the actor permissions', () => {
    expect(canManageRole(staffMgr, STAFF_MGR)).toBe(true);
    expect(canManageRole(staffMgr, HIGH)).toBe(false);
    expect(canManageRole(fullMgr, WAITER)).toBe(true);
    expect(canManageRole(fullMgr, FULL_MGR)).toBe(true);
    expect(canManageRole(staffMgr, FULL_MGR)).toBe(false);
    expect(canManageRole(staffMgr, WAITER)).toBe(false);
  });
});

describe('canManage / assertCanManage', () => {
  it('owner manages everyone', () => {
    expect(canManage(owner, user('x', OWNER))).toBe(true);
    expect(canManage(owner, user('x', HIGH))).toBe(true);
  });

  it('non-owners never manage an OWNER account', () => {
    expect(canManage(admin, user('x', OWNER))).toBe(false);
    expect(canManage(staffMgr, user('x', OWNER))).toBe(false);
  });

  it('blocks higher users, allows lower and same-level users', () => {
    expect(canManage(staffMgr, user('x', HIGH))).toBe(false);
    expect(canManage(staffMgr, user('x', STAFF_MGR))).toBe(true);
    expect(canManage(fullMgr, user('x', WAITER))).toBe(true);
    expect(canManage(admin, user('x', HIGH))).toBe(true);
  });

  it('counts a live GRANT override on the target', () => {
    const boosted = user('x', WAITER, [
      {
        effect: 'GRANT',
        expiresAt: null,
        permission: { key: 'reports.access' },
      },
    ]);
    expect(canManage(fullMgr, boosted)).toBe(false);
    expect(() => assertCanManage(fullMgr, boosted)).toThrow(ForbiddenException);
  });

  it('a DENY override on the target does not lower its ceiling', () => {
    const denied = user('x', HIGH, [
      {
        effect: 'DENY',
        expiresAt: null,
        permission: { key: 'reports.access' },
      },
    ]);
    expect(canManage(staffMgr, denied)).toBe(false);
  });
});

describe('assertCanAssignRole', () => {
  it('a non-owner can never change their own role', () => {
    expect(() => assertCanAssignRole(staffMgr, staffMgr.id, STAFF_MGR)).toThrow(
      ForbiddenException,
    );
  });

  it('a non-owner cannot assign OWNER or a higher role to others', () => {
    expect(() => assertCanAssignRole(admin, 'x', OWNER)).toThrow(
      ForbiddenException,
    );
    expect(() => assertCanAssignRole(staffMgr, 'x', HIGH)).toThrow(
      ForbiddenException,
    );
  });

  it('allows assigning a role within the ceiling, and owners anything', () => {
    expect(() => assertCanAssignRole(fullMgr, 'x', WAITER)).not.toThrow();
    expect(() => assertCanAssignRole(owner, 'x', OWNER)).not.toThrow();
    expect(() => assertCanAssignRole(owner, owner.id, HIGH)).not.toThrow();
  });
});
