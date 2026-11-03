import { RiderService } from './rider.service';

const setup = (count: number) => {
  const prisma = {
    user: { updateMany: jest.fn().mockResolvedValue({ count }) },
    userBranch: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ branchId: 'b1' }, { branchId: 'b2' }]),
    },
  };
  const realtime = { emitToBranch: jest.fn() };
  const svc = new RiderService(prisma as never, {} as never, realtime as never);
  return { prisma, realtime, svc };
};

describe('RiderService.setLocation', () => {
  it('broadcasts rider.location to each of the rider branches when saved', async () => {
    const { svc, realtime } = setup(1);
    const r = await svc.setLocation('u1', 12.5, 77.5);
    expect(r).toEqual({ saved: true });
    expect(realtime.emitToBranch).toHaveBeenCalledTimes(2);
    expect(realtime.emitToBranch).toHaveBeenCalledWith(
      'b1',
      'rider.location',
      expect.objectContaining({
        id: 'u1',
        lat: 12.5,
        lng: 77.5,
        at: expect.any(String),
      }),
    );
  });

  it('stays silent for a rider who is off duty', async () => {
    const { svc, realtime } = setup(0);
    expect(await svc.setLocation('u1', 1, 2)).toEqual({ saved: false });
    expect(realtime.emitToBranch).not.toHaveBeenCalled();
  });
});
