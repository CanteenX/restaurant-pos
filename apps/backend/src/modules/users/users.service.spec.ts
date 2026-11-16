import { ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '@nventra/types';
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
  staffmgr: 'STAFF_MGR',
  fullmgr: 'FULL_MGR',
  waiter: 'WAITER',
  high: 'HIGH',
};

function setup() {
  const findUser = ({ where }: { where: { id: string } }) => {
    const r = USERS[where.id];
    if (!r) return Promise.resolve(null);
    return Promise.resolve({
      id: where.id,
      name: where.id,
      email: null,
      roleId: ROLES[r].id,
      role: ROLES[r],
      permissionOverrides: [],
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
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const sessions = { revokeAll: jest.fn() };
  const svc = new UsersService(
    prisma as never,
    { record: jest.fn() } as never,
    sessions as never,
  );
  return { svc, prisma, sessions };
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
