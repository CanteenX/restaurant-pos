import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  MembershipBenefit,
  MembershipTierDto,
  MembershipTierUpdateDto,
} from '@nventra/types';
import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 86_400_000;

const NO_BENEFIT: MembershipBenefit = {
  tierId: null,
  tierName: null,
  discountPercent: 0,
  pointsMultiplier: 1,
  expiresAt: null,
};

type Tx = Prisma.TransactionClient;

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Membership tiers (per restaurant) and customer enrolments.
 * A customer has at most one open row (endedAt null, enforced by a partial
 * unique index); it is "current" while expiresAt is null or in the future.
 * Benefits are only ever computed here, from the DB.
 */
@Injectable()
export class MembershipService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Tiers ---------------------------------------------------------------

  listTiers(restaurantId: string) {
    return this.prisma.membershipTier.findMany({
      where: { restaurantId },
      orderBy: [{ rank: 'asc' }, { name: 'asc' }],
    });
  }

  async createTier(restaurantId: string, dto: MembershipTierDto) {
    try {
      return await this.prisma.membershipTier.create({
        data: { ...dto, restaurantId },
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw new ConflictException('A tier with this name already exists');
      throw e;
    }
  }

  async updateTier(
    restaurantId: string,
    id: string,
    dto: MembershipTierUpdateDto,
  ) {
    await this.findTier(this.prisma, restaurantId, id, false);
    try {
      return await this.prisma.membershipTier.update({
        where: { id },
        data: dto,
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw new ConflictException('A tier with this name already exists');
      throw e;
    }
  }

  // ---- Enrolments ----------------------------------------------------------

  async summary(
    restaurantId: string,
    branchId: string,
    customerId: string,
    now = new Date(),
  ) {
    await this.assertCustomer(restaurantId, branchId, customerId);
    const [benefit, history] = await Promise.all([
      this.benefitFor(customerId, now),
      this.prisma.customerMembership.findMany({
        where: { customerId },
        include: { tier: { select: { id: true, name: true, rank: true } } },
        orderBy: { startsAt: 'desc' },
        take: 20,
      }),
    ]);
    return { benefit, history };
  }

  async enrol(
    restaurantId: string,
    branchId: string,
    customerId: string,
    tierId: string,
    userId: string,
    now = new Date(),
  ) {
    await this.assertCustomer(restaurantId, branchId, customerId);
    return this.run(async (tx) => {
      const tier = await this.findTier(tx, restaurantId, tierId, true);
      const open = await this.openRow(tx, customerId);
      if (open && this.isCurrent(open, now)) {
        throw new ConflictException(
          'Customer already has a membership; upgrade or expire it first',
        );
      }
      if (open) {
        // Lapsed by date: close it at the moment it lapsed, keep as history.
        await tx.customerMembership.update({
          where: { id: open.id },
          data: { endedAt: open.expiresAt, endReason: 'EXPIRED' },
        });
      }
      return this.start(tx, customerId, tier, userId, now);
    });
  }

  async upgrade(
    restaurantId: string,
    branchId: string,
    customerId: string,
    tierId: string,
    userId: string,
    now = new Date(),
  ) {
    await this.assertCustomer(restaurantId, branchId, customerId);
    return this.run(async (tx) => {
      const tier = await this.findTier(tx, restaurantId, tierId, true);
      const open = await this.openRow(tx, customerId);
      if (!open || !this.isCurrent(open, now)) {
        throw new BadRequestException('Customer has no current membership');
      }
      if (tier.rank <= open.tier.rank) {
        throw new BadRequestException('Upgrade must move to a higher tier');
      }
      await tx.customerMembership.update({
        where: { id: open.id },
        data: { endedAt: now, endReason: 'UPGRADED' },
      });
      return this.start(tx, customerId, tier, userId, now);
    });
  }

  async expire(
    restaurantId: string,
    branchId: string,
    customerId: string,
    now = new Date(),
  ) {
    await this.assertCustomer(restaurantId, branchId, customerId);
    const open = await this.openRow(this.prisma, customerId);
    if (!open || !this.isCurrent(open, now)) {
      throw new BadRequestException('Customer has no current membership');
    }
    return this.prisma.customerMembership.update({
      where: { id: open.id },
      data: { endedAt: now, endReason: 'EXPIRED' },
    });
  }

  /**
   * What the customer's current membership entitles them to. A tier that was
   * later deactivated still honours members enrolled before that (it only
   * stops new enrolments); expiry ends the benefit.
   */
  async benefitFor(
    customerId: string,
    now = new Date(),
  ): Promise<MembershipBenefit> {
    const open = await this.openRow(this.prisma, customerId);
    if (!open || !this.isCurrent(open, now)) return { ...NO_BENEFIT };
    return {
      tierId: open.tier.id,
      tierName: open.tier.name,
      discountPercent: Number(open.tier.discountPercent),
      pointsMultiplier: Number(open.tier.pointsMultiplier),
      expiresAt: open.expiresAt ? open.expiresAt.toISOString() : null,
    };
  }

  // ---- Helpers ---------------------------------------------------------------

  private async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (e) {
      // Two enrolments racing: the partial unique index lets only one win.
      if (isUniqueViolation(e))
        throw new ConflictException('Membership was changed concurrently');
      throw e;
    }
  }

  private start(
    tx: Tx,
    customerId: string,
    tier: { id: string; durationDays: number | null },
    userId: string,
    now: Date,
  ) {
    return tx.customerMembership.create({
      data: {
        customerId,
        tierId: tier.id,
        startsAt: now,
        expiresAt: tier.durationDays
          ? new Date(now.getTime() + tier.durationDays * DAY_MS)
          : null,
        createdById: userId,
      },
    });
  }

  private isCurrent(row: { expiresAt: Date | null }, now: Date) {
    return row.expiresAt === null || row.expiresAt > now;
  }

  private openRow(db: Tx | PrismaService, customerId: string) {
    return db.customerMembership.findFirst({
      where: { customerId, endedAt: null },
      include: { tier: true },
    });
  }

  private async findTier(
    db: Tx | PrismaService,
    restaurantId: string,
    id: string,
    activeOnly: boolean,
  ) {
    const tier = await db.membershipTier.findFirst({
      where: { id, restaurantId },
    });
    if (!tier || (activeOnly && !tier.active))
      throw new NotFoundException('Membership tier not found');
    return tier;
  }

  /**
   * The customer must sit in this branch of this restaurant. A missing id is
   * refused outright: Prisma drops `undefined` filters, which would otherwise
   * match a customer in any tenant. Because the tier is also looked up by
   * restaurantId, a tier and customer can never come from different tenants.
   */
  private async assertCustomer(
    restaurantId: string,
    branchId: string,
    customerId: string,
  ) {
    if (!restaurantId || !branchId || !customerId)
      throw new BadRequestException('branchId is required');
    const c = await this.prisma.customer.findFirst({
      where: { id: customerId, branchId, branch: { restaurantId } },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Customer not found');
  }
}
