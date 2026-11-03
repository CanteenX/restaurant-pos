/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MembershipService } from './membership.service';

const NOW = new Date('2026-11-03T10:00:00.000Z');
const DAY = 86_400_000;

const tier = (over: Record<string, unknown> = {}) => ({
  id: 't-silver',
  restaurantId: 'r1',
  name: 'Silver',
  rank: 1,
  discountPercent: new Prisma.Decimal(5),
  pointsMultiplier: new Prisma.Decimal('1.5'),
  durationDays: 30,
  active: true,
  ...over,
});
const gold = tier({
  id: 't-gold',
  name: 'Gold',
  rank: 2,
  discountPercent: new Prisma.Decimal('12.5'),
  pointsMultiplier: new Prisma.Decimal(2),
  durationDays: null,
});

function setup(
  opts: {
    open?: any;
    tiers?: any[];
    customer?: any;
    closedConcurrently?: boolean;
  } = {},
) {
  const tiers = opts.tiers ?? [tier(), gold];
  const prisma: any = {
    customer: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.customer === undefined ? { id: 'c1' } : opts.customer,
        ),
    },
    membershipTier: {
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          tiers.find(
            (t) => t.id === where.id && t.restaurantId === where.restaurantId,
          ) ?? null,
        ),
      ),
    },
    customerMembership: {
      findFirst: jest.fn().mockResolvedValue(opts.open ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(({ data }: any) =>
        Promise.resolve({ id: 'm-new', ...data }),
      ),
      update: jest.fn(({ data }: any) => Promise.resolve({ ...data })),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.closedConcurrently ? 0 : 1 }),
      findUniqueOrThrow: jest.fn(({ where }: any) =>
        Promise.resolve({ id: where.id, endReason: 'EXPIRED' }),
      ),
    },
  };
  prisma.$transaction = jest.fn((fn: any) => fn(prisma));
  return { svc: new MembershipService(prisma), prisma };
}

describe('MembershipService.enrol', () => {
  it('enrols with an expiry of startsAt + tier duration', async () => {
    const { svc, prisma } = setup();
    const m = await svc.enrol('r1', 'b1', 'c1', 't-silver', 'u1', NOW);
    expect(m.tierId).toBe('t-silver');
    expect(m.startsAt).toEqual(NOW);
    expect(m.expiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
    expect(prisma.customerMembership.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ customerId: 'c1', createdById: 'u1' }),
    );
  });

  it('has no expiry when the tier has no duration', async () => {
    const { svc } = setup();
    const m = await svc.enrol('r1', 'b1', 'c1', 't-gold', 'u1', NOW);
    expect(m.expiresAt).toBeNull();
  });

  it('refuses a second enrolment while one is current', async () => {
    const { svc, prisma } = setup({
      open: { id: 'm1', tierId: 't-silver', expiresAt: null, tier: tier() },
    });
    await expect(
      svc.enrol('r1', 'b1', 'c1', 't-gold', 'u1', NOW),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.customerMembership.create).not.toHaveBeenCalled();
  });

  it('closes a lapsed enrolment and starts a new one', async () => {
    const lapsedAt = new Date(NOW.getTime() - DAY);
    const { svc, prisma } = setup({
      open: { id: 'm1', tierId: 't-silver', expiresAt: lapsedAt, tier: tier() },
    });
    await svc.enrol('r1', 'b1', 'c1', 't-silver', 'u1', NOW);
    expect(prisma.customerMembership.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { endedAt: lapsedAt, endReason: 'EXPIRED' },
    });
    expect(prisma.customerMembership.create).toHaveBeenCalled();
  });

  it("rejects another restaurant's tier and inactive tiers", async () => {
    const { svc } = setup({
      tiers: [
        tier({ restaurantId: 'r2' }),
        gold,
        tier({ id: 't-old', active: false }),
      ],
    });
    await expect(
      svc.enrol('r1', 'b1', 'c1', 't-silver', 'u1', NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.enrol('r1', 'b1', 'c1', 't-old', 'u1', NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s for a customer outside the branch', async () => {
    const { svc } = setup({ customer: null });
    await expect(
      svc.enrol('r1', 'b1', 'c1', 't-silver', 'u1', NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes the customer lookup to the branch and the restaurant', async () => {
    const { svc, prisma } = setup();
    await svc.enrol('r1', 'b1', 'c1', 't-silver', 'u1', NOW);
    expect(prisma.customer.findFirst.mock.calls[0][0].where).toEqual({
      id: 'c1',
      branchId: 'b1',
      branch: { restaurantId: 'r1' },
    });
  });

  it.each([
    [
      'enrol',
      (s: MembershipService) => s.enrol('r1', '', 'c1', 't-silver', 'u1', NOW),
    ],
    [
      'upgrade',
      (s: MembershipService) =>
        s.upgrade('r1', undefined as any, 'c1', 't-gold', 'u1', NOW),
    ],
    ['expire', (s: MembershipService) => s.expire('r1', '', 'c1', NOW)],
    [
      'summary',
      (s: MembershipService) => s.summary('r1', undefined as any, 'c1', NOW),
    ],
    ['no restaurant', (s: MembershipService) => s.summary('', 'b1', 'c1', NOW)],
  ])(
    'refuses a missing branch or restaurant (%s) before any query',
    async (_n, call) => {
      const { svc, prisma } = setup();
      await expect(call(svc)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
      expect(prisma.customerMembership.create).not.toHaveBeenCalled();
    },
  );

  it('turns a concurrent duplicate (unique index) into a 409', async () => {
    const { svc, prisma } = setup();
    prisma.customerMembership.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    await expect(
      svc.enrol('r1', 'b1', 'c1', 't-silver', 'u1', NOW),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('MembershipService.upgrade / expire', () => {
  const current = {
    id: 'm1',
    tierId: 't-silver',
    expiresAt: new Date(NOW.getTime() + 10 * DAY),
    tier: tier(),
  };

  it('upgrades to a higher tier, closing the old row', async () => {
    const { svc, prisma } = setup({ open: current });
    const m = await svc.upgrade('r1', 'b1', 'c1', 't-gold', 'u1', NOW);
    expect(prisma.customerMembership.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { endedAt: NOW, endReason: 'UPGRADED' },
    });
    expect(m.tierId).toBe('t-gold');
  });

  it('refuses a sideways or downward move', async () => {
    const { svc } = setup({
      open: { ...current, tierId: 't-gold', tier: gold },
    });
    await expect(
      svc.upgrade('r1', 'b1', 'c1', 't-silver', 'u1', NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('needs a current membership to upgrade or expire', async () => {
    const { svc } = setup();
    await expect(
      svc.upgrade('r1', 'b1', 'c1', 't-gold', 'u1', NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.expire('r1', 'b1', 'c1', NOW)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('expires the current membership now', async () => {
    const { svc, prisma } = setup({ open: current });
    const row = await svc.expire('r1', 'b1', 'c1', NOW);
    expect(prisma.customerMembership.updateMany).toHaveBeenCalledWith({
      where: { id: 'm1', endedAt: null },
      data: { endedAt: NOW, endReason: 'EXPIRED' },
    });
    expect(row).toMatchObject({ id: 'm1', endReason: 'EXPIRED' });
  });

  it('does not overwrite a row an upgrade closed at the same time', async () => {
    const { svc, prisma } = setup({ open: current, closedConcurrently: true });
    await expect(svc.expire('r1', 'b1', 'c1', NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.customerMembership.update).not.toHaveBeenCalled();
  });
});

describe('MembershipService.benefitFor', () => {
  it('returns the tier benefits as numbers', async () => {
    const { svc } = setup({
      open: { id: 'm1', tierId: 't-gold', expiresAt: null, tier: gold },
    });
    expect(await svc.benefitFor('c1', NOW)).toEqual({
      tierId: 't-gold',
      tierName: 'Gold',
      discountPercent: 12.5,
      pointsMultiplier: 2,
      expiresAt: null,
    });
  });

  it('gives nothing once the expiry date has passed', async () => {
    const { svc } = setup({
      open: {
        id: 'm1',
        tierId: 't-silver',
        expiresAt: new Date(NOW.getTime() - 1),
        tier: tier(),
      },
    });
    expect(await svc.benefitFor('c1', NOW)).toEqual({
      tierId: null,
      tierName: null,
      discountPercent: 0,
      pointsMultiplier: 1,
      expiresAt: null,
    });
  });

  it('gives nothing to a non-member', async () => {
    const { svc } = setup();
    expect((await svc.benefitFor('c1', NOW)).discountPercent).toBe(0);
  });
});
