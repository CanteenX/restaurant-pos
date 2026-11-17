import { ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '@nventra/types';
import { RolesService } from './roles.service';

// Privilege ceiling (#229), path (d): custom role create/edit/delete.

const role = (id: string, name: string, keys: string[], isSystem = false) => ({
  id,
  name,
  label: name,
  isSystem,
  createdAt: new Date(),
  permissions: keys.map((key) => ({
    permission: { key, label: key, category: 'x' },
  })),
});

const ROLES = [
  role('r-owner', 'OWNER', ['roles.manage', 'reports.access'], true),
  role('r-rolemgr', 'ROLE_MGR', ['roles.manage']),
  role('r-high', 'HIGH', ['roles.manage', 'reports.access']),
  role('r-low', 'LOW', []),
];

const roleMgr: SessionUser = {
  id: 'rm',
  restaurantId: 'rest',
  name: 'rm',
  roleId: 'r-rolemgr',
  roleName: 'ROLE_MGR',
  permissions: ['roles.manage', 'orders.create'],
};
const owner: SessionUser = {
  ...roleMgr,
  id: 'o',
  roleId: 'r-owner',
  roleName: 'OWNER',
  permissions: ['roles.manage'],
};

function setup() {
  const prisma = {
    role: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(ROLES.find((r) => r.id === where.id) ?? null),
      ),
      create: jest.fn().mockResolvedValue({ id: 'new', name: 'n', label: 'n' }),
      delete: jest.fn().mockResolvedValue({}),
    },
    permission: {
      findMany: jest.fn(({ where }: { where: { key: { in: string[] } } }) =>
        Promise.resolve(where.key.in.map((key) => ({ id: `p-${key}`, key }))),
      ),
    },
    user: {
      count: jest.fn().mockResolvedValue(0),
      // The actor is re-read from the DB (#236).
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(ACTOR_ROWS[where.id] ?? null),
      ),
    },
    $transaction: jest.fn().mockResolvedValue({ id: 'x' }),
  };
  const svc = new RolesService(prisma as never, { record: jest.fn() } as never);
  return { svc, prisma };
}

const grant = (key: string, expiresAt: Date | null = null) => ({
  effect: 'GRANT',
  expiresAt,
  permission: { key },
});
const ACTOR_ROWS: Record<string, unknown> = {
  rm: {
    id: 'rm',
    isActive: true,
    role: ROLES[1],
    permissionOverrides: [grant('orders.create')],
  },
  // Holds reports.access only until tomorrow.
  tm: {
    id: 'tm',
    isActive: true,
    role: ROLES[1],
    permissionOverrides: [
      grant('reports.access', new Date(Date.now() + 86_400_000)),
    ],
  },
  o: { id: 'o', isActive: true, role: ROLES[0], permissionOverrides: [] },
};
const tempMgr: SessionUser = {
  ...roleMgr,
  id: 'tm',
  permissions: ['roles.manage', 'reports.access'],
};

describe('RolesService temporary grants (#236)', () => {
  it('cannot create a permanent role from a temporary grant', async () => {
    const { svc, prisma } = setup();
    await expect(
      svc.create('rest', tempMgr, {
        name: 'X',
        label: 'X',
        permissionKeys: ['reports.access'],
      }),
    ).rejects.toThrow(/missing: reports\.access/);
    expect(prisma.role.create).not.toHaveBeenCalled();
  });

  it('cannot add a temporary grant to an existing role', async () => {
    const { svc, prisma } = setup();
    await expect(
      svc.update('rest', tempMgr, 'r-low', {
        permissionKeys: ['reports.access'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('RolesService privilege ceiling', () => {
  it('cannot create a role with a permission the actor lacks', async () => {
    const { svc, prisma } = setup();
    await expect(
      svc.create('rest', roleMgr, {
        name: 'ESC',
        label: 'Esc',
        permissionKeys: ['roles.manage', 'reports.access'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.role.create).not.toHaveBeenCalled();
  });

  it('cannot add a permission the actor lacks to their own role', async () => {
    const { svc, prisma } = setup();
    await expect(
      svc.update('rest', roleMgr, 'r-rolemgr', {
        permissionKeys: ['roles.manage', 'reports.access'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('cannot edit the OWNER role or a higher role, even just the label', async () => {
    const { svc } = setup();
    await expect(
      svc.update('rest', roleMgr, 'r-owner', { permissionKeys: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.update('rest', roleMgr, 'r-high', { label: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cannot delete a higher role', async () => {
    const { svc, prisma } = setup();
    await expect(svc.remove('rest', roleMgr, 'r-high')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it('allows create/edit/delete within the ceiling', async () => {
    const { svc, prisma } = setup();
    await svc.create('rest', roleMgr, {
      name: 'OK',
      label: 'Ok',
      permissionKeys: ['orders.create'],
    });
    await svc.update('rest', roleMgr, 'r-low', {
      permissionKeys: ['orders.create'],
    });
    await svc.remove('rest', roleMgr, 'r-low');
    expect(prisma.role.create).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.role.delete).toHaveBeenCalled();
  });

  it('the owner can edit any role, including OWNER, and grant anything', async () => {
    const { svc, prisma } = setup();
    await svc.update('rest', owner, 'r-owner', { label: 'Owner' });
    await svc.update('rest', owner, 'r-high', {
      permissionKeys: ['reports.access', 'system.update'],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
