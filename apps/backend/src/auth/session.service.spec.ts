import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SessionService } from './session.service';

const target = (name: string, keys: string[]) => ({
  id: 'u2',
  role: { name, permissions: keys.map((key) => ({ permission: { key } })) },
  permissionOverrides: [],
});
const ACTOR = {
  id: 'actor',
  roleName: 'STAFF_MGR',
  permissions: ['users.manage'],
};

function setup(found: unknown = target('WAITER', [])) {
  const prisma = {
    user: {
      update: jest.fn().mockResolvedValue({ tokenVersion: 1 }),
      findFirst: jest.fn().mockResolvedValue(found),
    },
  };
  const realtime = { disconnectUser: jest.fn() };
  const audit = { record: jest.fn() };
  const svc = new SessionService(
    prisma as never,
    realtime as never,
    audit as never,
  );
  return { svc, prisma, realtime, audit };
}

describe('SessionService', () => {
  it('revokeAll bumps tokenVersion and drops live sockets', async () => {
    const { svc, prisma, realtime } = setup();
    await svc.revokeAll('u1');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    expect(realtime.disconnectUser).toHaveBeenCalledWith('u1');
  });

  it('revokeForStaff only touches a user in the same restaurant', async () => {
    const { svc, prisma, realtime, audit } = setup(null);
    await expect(svc.revokeForStaff(ACTOR, 'r1', 'other')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'other', restaurantId: 'r1' } }),
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(realtime.disconnectUser).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('revokeForStaff revokes and audits', async () => {
    const { svc, prisma, audit } = setup();
    await svc.revokeForStaff(ACTOR, 'r1', 'u2');
    expect(prisma.user.update).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'actor',
        action: 'sessions.revoked',
        entityId: 'u2',
      }),
    );
  });

  it('revokeForStaff refuses an owner or higher target (#229)', async () => {
    for (const t of [
      target('OWNER', ['users.manage']),
      target('HIGH', ['users.manage', 'reports.access']),
    ]) {
      const { svc, prisma, audit } = setup(t);
      await expect(
        svc.revokeForStaff(ACTOR, 'r1', 'u2'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    }
  });
});
