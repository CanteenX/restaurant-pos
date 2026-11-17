import {
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import type { SessionUser } from '@nventra/types';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';

// Privilege ceiling (#229) at the service layer, with Prisma mocked out.

const role = (id: string, name: string, keys: string[]) => ({
  id,
  name,
  permissions: keys.map((key) => ({ permission: { key } })),
});

const ROLES = {
  OWNER: role('r-owner', 'OWNER', ['users.manage', 'reports.access']),
  STAFF_MGR: role('r-staff', 'STAFF_MGR', ['users.manage']),
  FULL_MGR: role('r-full', 'FULL_MGR', ['users.manage', 'orders.create']),
  WAITER: role('r-waiter', 'WAITER', ['orders.create']),
  HIGH: role('r-high', 'HIGH', ['users.manage', 'reports.access']),
};
type RoleKey = keyof typeof ROLES;

const actor = (id: string, r: RoleKey): SessionUser => ({
  id,
  restaurantId: 'rest',
  name: id,
  roleId: ROLES[r].id,
  roleName: ROLES[r].name,
  permissions: ROLES[r].permissions.map((p) => p.permission.key),
});

const USERS: Record<string, RoleKey> = {
  owner: 'OWNER',
  owner2: 'OWNER',
  staffmgr: 'STAFF_MGR',
  peer: 'STAFF_MGR',
  fullmgr: 'FULL_MGR',
  tempmgr: 'FULL_MGR',
  deniedmgr: 'FULL_MGR',
  waiter: 'WAITER',
  high: 'HIGH',
};

// tempmgr holds reports.access only through a GRANT that expires tomorrow.
const TEMP_GRANT = {
  effect: 'GRANT',
  expiresAt: new Date(Date.now() + 86_400_000),
  permission: { key: 'reports.access' },
};
const OVERRIDES: Record<
  string,
  { effect: string; expiresAt: Date | null; permission: { key: string } }[]
> = {
  tempmgr: [TEMP_GRANT],
  // A manager with one of their role's permissions denied.
  deniedmgr: [
    { effect: 'DENY', expiresAt: null, permission: { key: 'orders.create' } },
  ],
};
const tempMgr = (): SessionUser => ({
  ...actor('tempmgr', 'FULL_MGR'),
  permissions: [...actor('tempmgr', 'FULL_MGR').permissions, 'reports.access'],
});

let passwordHash = '';
beforeAll(async () => {
  passwordHash = await bcrypt.hash('Current123!', 4);
});

function setup() {
  const findUser = ({ where }: { where: { id: string } }) => {
    const r = USERS[where.id];
    if (!r) return Promise.resolve(null);
    return Promise.resolve({
      id: where.id,
      name: where.id,
      email: null,
      isActive: true,
      passwordHash,
      roleId: ROLES[r].id,
      role: ROLES[r],
      permissionOverrides: OVERRIDES[where.id] ?? [],
      branches: [{ branchId: 'b' }],
    });
  };
  const findRole = ({ where }: { where: { id: string } }) =>
    Promise.resolve(
      Object.values(ROLES).find((x) => x.id === where.id) ?? null,
    );
  const prisma = {
    user: {
      findFirst: jest.fn(findUser),
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue({ id: 'new' }),
      update: jest.fn().mockResolvedValue({ id: 'x' }),
      delete: jest.fn().mockResolvedValue({}),
      findFirstOrThrow: jest.fn().mockResolvedValue({}),
    },
    role: {
      findFirst: jest.fn(findRole),
      findMany: jest.fn().mockResolvedValue(Object.values(ROLES)),
    },
    branch: { count: jest.fn().mockResolvedValue(1) },
    department: { findFirst: jest.fn().mockResolvedValue({ id: 'd' }) },
    permission: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'p', key: 'reports.access' }]),
    },
    userPermissionOverride: { deleteMany: jest.fn(), createMany: jest.fn() },
    // Active owners still standing, as the row-locking query sees them.
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'owner' }, { id: 'owner2' }]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
      : Promise.resolve([]),
  );
  const sessions = { revokeAll: jest.fn() };
  // Same answer as the real check, minus the rate limit (tested on its own).
  const passwordCheck = {
    verify: jest.fn((u: { passwordHash: string }, pw: string) =>
      bcrypt.compare(pw, u.passwordHash),
    ),
  };
  const invites = {
    assertAvailable: jest.fn(),
    send: jest.fn().mockResolvedValue({ sent: true }),
    dropPending: jest.fn().mockResolvedValue(0),
  };
  const svc = new UsersService(
    prisma as never,
    { record: jest.fn() } as never,
    sessions as never,
    passwordCheck as never,
    invites as never,
  );
  return { svc, prisma, sessions, passwordCheck, invites };
}

const staffDto = (r: RoleKey) => ({
  name: 'n',
  password: 'Password123!',
  roleId: ROLES[r].id,
  branchIds: ['b'],
});

describe('UsersService privilege ceiling', () => {
  describe('(a) promotion and assignment', () => {
    it('a staff manager cannot promote themselves to OWNER', async () => {
      const { svc, prisma } = setup();
      await expect(
        svc.update('rest', actor('staffmgr', 'STAFF_MGR'), 'staffmgr', {
          roleId: ROLES.OWNER.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('a non-owner cannot change their own role, even to a lower one', async () => {
      const { svc } = setup();
      await expect(
        svc.update('rest', actor('fullmgr', 'FULL_MGR'), 'fullmgr', {
          roleId: ROLES.WAITER.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a manager cannot assign a higher role to someone else', async () => {
      const { svc } = setup();
      await expect(
        svc.update('rest', actor('fullmgr', 'FULL_MGR'), 'waiter', {
          roleId: ROLES.HIGH.id,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a staff manager cannot create an OWNER or higher account', async () => {
      const { svc, prisma } = setup();
      const me = actor('staffmgr', 'STAFF_MGR');
      await expect(
        svc.create('rest', me, staffDto('OWNER')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.create('rest', me, staffDto('HIGH')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('(b) editing and deleting higher accounts', () => {
    it('a staff manager cannot edit or delete the owner', async () => {
      const { svc, prisma } = setup();
      const me = actor('staffmgr', 'STAFF_MGR');
      await expect(
        svc.update('rest', me, 'owner', { name: 'x' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.remove('rest', me, 'owner')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('a manager cannot disable or delete a higher user', async () => {
      const { svc } = setup();
      const me = actor('fullmgr', 'FULL_MGR');
      await expect(
        svc.update('rest', me, 'high', { isActive: false }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.remove('rest', me, 'high')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('per-user overrides cannot be set on a higher user', async () => {
      const { svc, prisma } = setup();
      await expect(
        svc.setPermissionOverrides(
          'rest',
          actor('staffmgr', 'STAFF_MGR'),
          'high',
          {
            overrides: [{ permissionKey: 'reports.access', effect: 'DENY' }],
          },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('(c) password resets', () => {
    it("a staff manager cannot reset the owner's or a higher user's password", async () => {
      const { svc, prisma, sessions } = setup();
      const me = actor('staffmgr', 'STAFF_MGR');
      for (const target of ['owner', 'high']) {
        await expect(
          svc.update('rest', me, target, { password: 'Hijacked123!' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
    });
  });

  describe('role picker', () => {
    it('lists only roles the actor may assign, without permission data', async () => {
      const { svc } = setup();
      const mine = await svc.listRoles('rest', actor('fullmgr', 'FULL_MGR'));
      expect(mine.map((r) => r.name).sort()).toEqual([
        'FULL_MGR',
        'STAFF_MGR',
        'WAITER',
      ]);
      expect(mine[0]).not.toHaveProperty('permissions');
      const all = await svc.listRoles('rest', actor('owner', 'OWNER'));
      expect(all).toHaveLength(Object.keys(ROLES).length);
    });
  });

  describe('allowed flows', () => {
    it('a full manager creates, edits, re-roles and deletes a waiter', async () => {
      const { svc, prisma } = setup();
      const me = actor('fullmgr', 'FULL_MGR');
      await svc.create('rest', me, staffDto('WAITER'));
      await svc.update('rest', me, 'waiter', {
        password: 'Another123!',
        roleId: ROLES.WAITER.id,
      });
      await svc.remove('rest', me, 'waiter');
      expect(prisma.user.create).toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalled();
      expect(prisma.user.delete).toHaveBeenCalled();
    });

    it('a staff manager can edit their own name and password', async () => {
      const { svc, prisma } = setup();
      await svc.update('rest', actor('staffmgr', 'STAFF_MGR'), 'staffmgr', {
        name: 'Me',
        password: 'Another123!',
        currentPassword: 'Current123!',
      });
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('the owner manages everyone and assigns any role', async () => {
      const { svc, prisma } = setup();
      const me = actor('owner', 'OWNER');
      await svc.update('rest', me, 'high', { roleId: ROLES.OWNER.id });
      await svc.create('rest', me, staffDto('OWNER'));
      await svc.remove('rest', me, 'high');
      expect(prisma.user.update).toHaveBeenCalled();
      expect(prisma.user.create).toHaveBeenCalled();
      expect(prisma.user.delete).toHaveBeenCalled();
    });
  });
});

describe('UsersService #236 follow-ups', () => {
  describe('temporary grants are not grantable onward', () => {
    it('an override with no expiry cannot pass on a temporary grant', async () => {
      const { svc, prisma } = setup();
      await expect(
        svc.setPermissionOverrides('rest', tempMgr(), 'waiter', {
          overrides: [{ permissionKey: 'reports.access', effect: 'GRANT' }],
        }),
      ).rejects.toThrow(/reports\.access/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('nor can an override with an expiry', async () => {
      const { svc } = setup();
      await expect(
        svc.setPermissionOverrides('rest', tempMgr(), 'waiter', {
          overrides: [
            {
              permissionKey: 'reports.access',
              effect: 'GRANT',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
          ],
        }),
      ).rejects.toThrow(/reports\.access/);
    });

    it('a temporary grant does not let the actor create or assign a role holding it', async () => {
      const { svc, prisma } = setup();
      await expect(
        svc.create('rest', tempMgr(), staffDto('HIGH')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.update('rest', tempMgr(), 'waiter', { roleId: ROLES.HIGH.id }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('the actor is re-read from the database for the check', async () => {
      const { svc, prisma } = setup();
      await svc.update('rest', actor('fullmgr', 'FULL_MGR'), 'waiter', {
        name: 'W',
      });
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'fullmgr', restaurantId: 'rest' },
        }),
      );
    });
  });

  describe('credential resets need strictly more access', () => {
    it("a staff manager cannot reset a same-level peer's password", async () => {
      const { svc, prisma, sessions } = setup();
      await expect(
        svc.update('rest', actor('staffmgr', 'STAFF_MGR'), 'peer', {
          password: 'Hijacked123!',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
    });

    it('but can still edit a same-level peer', async () => {
      const { svc, prisma } = setup();
      await svc.update('rest', actor('staffmgr', 'STAFF_MGR'), 'peer', {
        name: 'Peer',
      });
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it("an owner can reset another owner's password", async () => {
      const { svc, prisma } = setup();
      await svc.update('rest', actor('owner', 'OWNER'), 'owner2', {
        password: 'Another123!',
      });
      expect(prisma.user.update).toHaveBeenCalled();
    });
  });

  describe('self-edit', () => {
    const me = () => actor('staffmgr', 'STAFF_MGR');

    it('changing your own password needs the current password', async () => {
      const { svc, prisma } = setup();
      await expect(
        svc.update('rest', me(), 'staffmgr', { password: 'Another123!' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.update('rest', me(), 'staffmgr', {
          password: 'Another123!',
          currentPassword: 'Wrong123!',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('the owner also needs the current password for their own', async () => {
      const { svc } = setup();
      await expect(
        svc.update('rest', actor('owner', 'OWNER'), 'owner', {
          password: 'Another123!',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cannot change your own branches or active status', async () => {
      const { svc, prisma } = setup();
      await expect(
        svc.update('rest', me(), 'staffmgr', { branchIds: ['b', 'b2'] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.update('rest', me(), 'staffmgr', { isActive: false }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('sending your unchanged branches and status is fine', async () => {
      const { svc, prisma } = setup();
      await svc.update('rest', me(), 'staffmgr', {
        name: 'Me',
        branchIds: ['b'],
        isActive: true,
      });
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('the current-password check goes through the rate-limited checker, with the client address', async () => {
      const { svc, prisma, passwordCheck } = setup();
      await svc.update(
        'rest',
        me(),
        'staffmgr',
        { password: 'Another123!', currentPassword: 'Current123!' },
        '7.7.7.7',
      );
      expect(passwordCheck.verify).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'staffmgr' }),
        'Current123!',
        '7.7.7.7',
      );
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('a locked-out checker (429) stops the change', async () => {
      const { svc, prisma, passwordCheck } = setup();
      const tooMany = new HttpException('Too many', 429);
      passwordCheck.verify.mockRejectedValue(tooMany);
      await expect(
        svc.update('rest', me(), 'staffmgr', {
          password: 'Another123!',
          currentPassword: 'Current123!',
        }),
      ).rejects.toBe(tooMany);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('a user with a temporary GRANT can still edit their own name and password', async () => {
      const { svc, prisma } = setup();
      await svc.update('rest', tempMgr(), 'tempmgr', {
        name: 'Temp',
        password: 'Another123!',
        currentPassword: 'Current123!',
      });
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('a user with a DENY override can still edit their own name', async () => {
      const { svc, prisma } = setup();
      const denied: SessionUser = {
        ...actor('deniedmgr', 'FULL_MGR'),
        permissions: ['users.manage'],
      };
      await svc.update('rest', denied, 'deniedmgr', { name: 'D' });
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('…but still cannot change their own role', async () => {
      const { svc } = setup();
      await expect(
        svc.update('rest', tempMgr(), 'tempmgr', { roleId: ROLES.HIGH.id }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('the owner may change their own branches', async () => {
      const { svc, prisma } = setup();
      prisma.branch.count.mockResolvedValue(2);
      await svc.update('rest', actor('owner', 'OWNER'), 'owner', {
        branchIds: ['b', 'b2'],
      });
      expect(prisma.user.update).toHaveBeenCalled();
    });
  });

  describe('last-owner check runs inside one locked transaction', () => {
    it('disabling an owner locks the owner rows and writes in the same transaction', async () => {
      const { svc, prisma } = setup();
      await svc.update('rest', actor('owner', 'OWNER'), 'owner2', {
        isActive: false,
      });
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(prisma.user.count).not.toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
    });

    it('refuses when the locked rows show no other active owner', async () => {
      const { svc, prisma } = setup();
      prisma.$queryRaw.mockResolvedValue([{ id: 'owner2' }]);
      await expect(
        svc.update('rest', actor('owner', 'OWNER'), 'owner2', {
          isActive: false,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.remove('rest', actor('owner', 'OWNER'), 'owner2'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });
  });
});

describe('UsersService staff invites (#223)', () => {
  const inviteDto = (r: RoleKey) => ({
    name: 'Ravi',
    email: 'ravi@example.com',
    invite: true,
    roleId: ROLES[r].id,
    branchIds: ['b'],
  });

  it('creates an inactive account with no usable password and emails the invite', async () => {
    const { svc, prisma, invites } = setup();
    const me = actor('fullmgr', 'FULL_MGR');
    const res = await svc.create('rest', me, inviteDto('WAITER'));
    expect(invites.assertAvailable).toHaveBeenCalled();
    const { data } = prisma.user.create.mock.calls[0][0] as {
      data: { isActive: boolean; passwordHash: string };
    };
    expect(data.isActive).toBe(false);
    expect(data.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(invites.send).toHaveBeenCalledWith('rest', me, 'new');
    expect(res).toEqual(expect.objectContaining({ inviteSent: true }));
  });

  it('checks email setup before creating anything', async () => {
    const { svc, prisma, invites } = setup();
    invites.assertAvailable.mockImplementation(() => {
      throw new Error('no smtp');
    });
    await expect(
      svc.create('rest', actor('owner', 'OWNER'), inviteDto('WAITER')),
    ).rejects.toThrow('no smtp');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('keeps the account when the email fails, reporting inviteSent: false', async () => {
    const { svc, invites } = setup();
    invites.send.mockRejectedValue(new Error('smtp down'));
    const res = await svc.create(
      'rest',
      actor('owner', 'OWNER'),
      inviteDto('WAITER'),
    );
    expect(res).toEqual(expect.objectContaining({ inviteSent: false }));
  });

  it('cannot invite into a role above the actor (#229)', async () => {
    const { svc, prisma, invites } = setup();
    await expect(
      svc.create('rest', actor('staffmgr', 'STAFF_MGR'), inviteDto('HIGH')),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(invites.send).not.toHaveBeenCalled();
  });

  it('disabling an account drops its pending invite', async () => {
    const { svc, invites } = setup();
    await svc.update('rest', actor('owner', 'OWNER'), 'waiter', {
      isActive: false,
    });
    expect(invites.dropPending).toHaveBeenCalledWith('waiter');
  });

  it('the password-create path is unchanged (no invite sent)', async () => {
    const { svc, invites, prisma } = setup();
    await svc.create('rest', actor('owner', 'OWNER'), staffDto('WAITER'));
    expect(invites.send).not.toHaveBeenCalled();
    const { data } = prisma.user.create.mock.calls[0][0] as {
      data: { isActive?: boolean };
    };
    expect(data.isActive).toBeUndefined();
  });
});
