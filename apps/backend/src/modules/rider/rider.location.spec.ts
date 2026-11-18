import { RiderService } from './rider.service';

const setup = (count: number) => {
  const prisma = {
    user: {
      updateMany: jest.fn().mockResolvedValue({ count }),
      findMany: jest.fn().mockResolvedValue([{ id: 'd1' }]),
    },
    userBranch: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ branchId: 'b1' }, { branchId: 'b2' }]),
    },
  };
  const realtime = { emitToBranch: jest.fn(), emitToUsers: jest.fn() };
  const svc = new RiderService(prisma as never, {} as never, realtime as never);
  return { prisma, realtime, svc };
};

describe('RiderService.setLocation', () => {
  it('pushes rider.location only to delivery.manage holders per branch', async () => {
    const { svc, realtime, prisma } = setup(1);
    const r = await svc.setLocation('u1', 12.5, 77.5);
    expect(r).toEqual({ saved: true });
    expect(realtime.emitToBranch).not.toHaveBeenCalled();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          branches: { some: { branchId: 'b1' } },
          role: {
            permissions: { some: { permission: { key: 'delivery.manage' } } },
          },
        }),
      }),
    );
    expect(realtime.emitToUsers).toHaveBeenCalledWith(
      ['d1'],
      'rider.location',
      expect.objectContaining({ id: 'u1', lat: 12.5, lng: 77.5 }),
    );
  });

  it('stays silent for a rider who is off duty', async () => {
    const { svc, realtime } = setup(0);
    expect(await svc.setLocation('u1', 1, 2)).toEqual({ saved: false });
    expect(realtime.emitToUsers).not.toHaveBeenCalled();
  });
});
