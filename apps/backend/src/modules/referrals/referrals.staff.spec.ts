import { ReferralsService } from './referrals.service';

const prismaMock = () => ({
  customer: { findFirst: jest.fn() },
  branch: { findMany: jest.fn() },
  referral: { findMany: jest.fn(), groupBy: jest.fn(), count: jest.fn() },
  pointsLedger: { aggregate: jest.fn() },
});

describe('ReferralsService staff operations', () => {
  it('listForCustomer 404s when the customer is outside the restaurant', async () => {
    const prisma = prismaMock();
    prisma.customer.findFirst.mockResolvedValue(null);
    const svc = new ReferralsService(prisma as never);
    await expect(svc.listForCustomer('r1', 'c1')).rejects.toThrow(
      'Customer not found',
    );
    expect(prisma.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c1', branch: { restaurantId: 'r1' } },
      }),
    );
  });

  it('listForCustomer returns referrals the customer made and the one they used', async () => {
    const prisma = prismaMock();
    prisma.customer.findFirst.mockResolvedValue({ id: 'c1' });
    const made = [{ id: 'a', status: 'PENDING' }];
    prisma.referral.findMany
      .mockResolvedValueOnce(made)
      .mockResolvedValueOnce([{ id: 'b', status: 'REWARDED' }]);
    const svc = new ReferralsService(prisma as never);
    const r = await svc.listForCustomer('r1', 'c1');
    expect(r.made).toEqual(made);
    expect(r.usedCode).toEqual({ id: 'b', status: 'REWARDED' });
    expect(prisma.referral.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { referrerId: 'c1' } }),
    );
  });

  it('stats scopes every query to the restaurant', async () => {
    const prisma = prismaMock();
    prisma.branch.findMany.mockResolvedValue([{ id: 'b1' }]);
    prisma.referral.count.mockResolvedValueOnce(5).mockResolvedValueOnce(2);
    prisma.pointsLedger.aggregate.mockResolvedValue({ _sum: { delta: 300 } });
    const svc = new ReferralsService(prisma as never);
    const s = await svc.stats('r1');
    expect(s).toEqual({
      total: 5,
      rewarded: 2,
      pending: 3,
      pointsAwarded: 300,
    });
    expect(prisma.referral.count).toHaveBeenCalledWith({
      where: { branchId: { in: ['b1'] } },
    });
  });

  it('applyCode throws 400 with the reason when attach refuses', async () => {
    const prisma = prismaMock();
    const svc = new ReferralsService(prisma as never);
    jest.spyOn(svc, 'attach').mockResolvedValue({
      applied: false,
      reason: 'This customer was already referred',
    });
    await expect(svc.applyCode('r1', 'c1', 'ABCDEF')).rejects.toThrow(
      'This customer was already referred',
    );
  });

  it('applyCode returns the referrer name on success', async () => {
    const svc = new ReferralsService(prismaMock() as never);
    jest
      .spyOn(svc, 'attach')
      .mockResolvedValue({ applied: true, referrerName: 'Asha' });
    await expect(svc.applyCode('r1', 'c1', 'ABCDEF')).resolves.toEqual({
      applied: true,
      referrerName: 'Asha',
    });
  });
});
