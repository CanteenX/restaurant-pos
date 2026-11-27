import { ForbiddenException } from '@nestjs/common';
import {
  assertCanAssignRole,
  assertCanGrant,
  assertCanManage,
  assertCanManageRole,
  assertCanResetCredentials,
  canGrant,
  canManage,
  canManageRole,
  ceilingKeys,
  grantableKeys,
  loadCeilingActor,
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

// --- #236 follow-ups -------------------------------------------------------

const ov = (
  effect: 'GRANT' | 'DENY',
  key: string,
  expiresAt: Date | null = null,
) => ({ effect, expiresAt, permission: { key } });
const soon = () => new Date(Date.now() + 60_000);

describe('grantableKeys (#236)', () => {
  it('does not delegate a denied view permission through manage', () => {
    const permissions = grantableKeys(
      user('m', role('M', ['menu.manage']), [ov('DENY', 'menu.view')]),
    );
    expect(
      canGrant({ id: 'm', roleName: 'M', permissions }, ['menu.view']),
    ).toBe(false);
    expect(
      canGrant({ id: 'm', roleName: 'M', permissions }, ['menu.manage']),
    ).toBe(false);
  });
  it('drops permissions held only through a time-limited GRANT', () => {
    const keys = grantableKeys(
      user('m', STAFF_MGR, [
        ov('GRANT', 'reports.access', soon()),
        ov('GRANT', 'orders.create'),
      ]),
    );
    expect(keys.sort()).toEqual(['orders.create', 'users.manage']);
  });

  it('keeps a role permission even when a temporary GRANT repeats it', () => {
    const keys = grantableKeys(
      user('m', STAFF_MGR, [ov('GRANT', 'users.manage', soon())]),
    );
    expect(keys).toEqual(['users.manage']);
  });

  it('subtracts a live DENY and ignores an expired one', () => {
    const past = new Date(Date.now() - 60_000);
    const keys = grantableKeys(
      user('m', FULL_MGR, [
        ov('DENY', 'orders.create'),
        ov('DENY', 'users.manage', past),
      ]),
    );
    expect(keys).toEqual(['users.manage']);
  });
});

describe('loadCeilingActor (#236)', () => {
  const record = {
    id: 'm',
    isActive: true,
    role: STAFF_MGR,
    permissionOverrides: [ov('GRANT', 'reports.access', soon())],
  };

  it('reloads the actor and leaves out temporary grants', async () => {
    const findFirst = jest.fn().mockResolvedValue(record);
    const actor = await loadCeilingActor(
      { user: { findFirst } } as never,
      { id: 'm' },
      'rest',
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm', restaurantId: 'rest' } }),
    );
    expect(actor).toEqual({
      id: 'm',
      roleName: 'STAFF_MGR',
      permissions: ['users.manage'],
    });
  });

  it('refuses a missing or disabled actor', async () => {
    for (const found of [null, { ...record, isActive: false }]) {
      const findFirst = jest.fn().mockResolvedValue(found);
      await expect(
        loadCeilingActor({ user: { findFirst } } as never, { id: 'm' }, 'r'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
});

describe('assertCanResetCredentials (#236)', () => {
  it('never treats a denial marker itself as a permission above the target', () => {
    const actor: CeilingActor = {
      id: 'a',
      roleName: 'MANAGER',
      permissions: ['users.manage', '!menu.view'],
    };
    expect(() =>
      assertCanResetCredentials(actor, user('peer', STAFF_MGR)),
    ).toThrow(ForbiddenException);
  });
  it('still allows a truly higher actor with a DENY to reset a lower target', () => {
    const higher = user(
      'higher',
      role('HIGHER', ['users.manage', 'menu.manage']),
      [ov('DENY', 'menu.view')],
    );
    const actor: CeilingActor = {
      id: higher.id,
      roleName: higher.role.name,
      permissions: grantableKeys(higher),
    };
    expect(() =>
      assertCanResetCredentials(actor, user('lower', STAFF_MGR)),
    ).not.toThrow();
  });
  it('does not count a DENY marker as superior access over a peer', () => {
    const peerRole = role('MENU_PEER', [
      'users.manage',
      'roles.manage',
      'menu.manage',
    ]);
    const denied = user('denied', peerRole, [ov('DENY', 'menu.view')]);
    const actor: CeilingActor = {
      id: denied.id,
      roleName: peerRole.name,
      permissions: grantableKeys(denied),
    };
    expect(() =>
      assertCanResetCredentials(actor, user('peer', peerRole)),
    ).toThrow(ForbiddenException);
  });

  it('does not permit management or delegation of an implied permission denied to actor', () => {
    const peerRole = role('MENU_PEER', ['users.manage', 'menu.manage']);
    const denied = user('denied', peerRole, [ov('DENY', 'menu.view')]);
    const actor: CeilingActor = {
      id: denied.id,
      roleName: peerRole.name,
      permissions: grantableKeys(denied),
    };
    expect(() => assertCanManage(actor, user('peer', peerRole))).toThrow(
      ForbiddenException,
    );
    expect(() => assertCanManageRole(actor, peerRole)).toThrow(
      ForbiddenException,
    );
    expect(canGrant(actor, ['menu.manage'])).toBe(false);
  });
  it('refuses a same-level peer', () => {
    expect(() =>
      assertCanResetCredentials(staffMgr, user('p', STAFF_MGR)),
    ).toThrow(ForbiddenException);
    expect(() => assertCanResetCredentials(admin, user('p', ADMIN))).toThrow(
      /less access/,
    );
  });

  it('refuses a target whose temporary grant makes them equal', () => {
    const boosted = user('w', role('LOW', []), [
      ov('GRANT', 'users.manage', soon()),
    ]);
    expect(() => assertCanResetCredentials(staffMgr, boosted)).toThrow(
      /less access/,
    );
  });

  it('allows a strictly lower target', () => {
    expect(() =>
      assertCanResetCredentials(fullMgr, user('w', WAITER)),
    ).not.toThrow();
    expect(() =>
      assertCanResetCredentials(admin, user('h', HIGH)),
    ).not.toThrow();
  });

  it('still refuses a higher target or an OWNER', () => {
    expect(() => assertCanResetCredentials(staffMgr, user('h', HIGH))).toThrow(
      ForbiddenException,
    );
    expect(() => assertCanResetCredentials(admin, user('o', OWNER))).toThrow(
      ForbiddenException,
    );
  });

  it('the owner may reset anyone, including another owner', () => {
    expect(() =>
      assertCanResetCredentials(owner, user('o2', OWNER)),
    ).not.toThrow();
  });
});

describe('403 messages list the missing permission keys (#236)', () => {
  it('assertCanManage names what the actor lacks', () => {
    expect(() => assertCanManage(staffMgr, user('h', HIGH))).toThrow(
      /missing: reports\.access/,
    );
  });

  it('assertCanManageRole names what the actor lacks', () => {
    expect(() => assertCanManageRole(staffMgr, FULL_MGR)).toThrow(
      /missing: orders\.create/,
    );
  });

  it('does not leak ids or role names', () => {
    let message = '';
    try {
      assertCanManage(staffMgr, user('secret-id', HIGH));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toMatch(/secret-id|HIGH/);
  });
});
