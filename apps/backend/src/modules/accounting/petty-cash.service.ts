import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PettyCashEntryDto, PettyCashReconcileDto } from '@nventra/types';
import { PrismaService } from '../../prisma/prisma.service';
import { round2 } from './accounting.calc';
import {
  applyEntry,
  pettyDaySummary,
  signedAmount,
  type PettyKind,
} from './petty-cash.calc';

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

/**
 * Petty-cash float per branch (#72). The float is a separate box from the
 * till: a PAYOUT books exactly one Expense with paidFromCash=false (so the
 * day-close count never subtracts it), and a TOP_UP marked fromTill is
 * subtracted from that day's expected till cash instead.
 */
@Injectable()
export class PettyCashService {
  constructor(private readonly prisma: PrismaService) {}

  async balance(branchId: string) {
    const f = await this.prisma.pettyCashFloat.findUnique({
      where: { branchId },
    });
    return { branchId, balance: round2(Number(f?.balance ?? 0)) };
  }

  listEntries(branchId: string, from: string, to: string) {
    return this.prisma.pettyCashEntry.findMany({
      where: { branchId, businessDate: { gte: day(from), lte: day(to) } },
      orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
      include: { expense: { select: { id: true, category: true } } },
      take: 500,
    });
  }

  /** Opening, movements and closing for one business date. */
  async daySummary(branchId: string, date: string) {
    const [before, entries] = await Promise.all([
      this.prisma.pettyCashEntry.aggregate({
        where: { branchId, businessDate: { lt: day(date) } },
        _sum: { amount: true },
      }),
      this.prisma.pettyCashEntry.findMany({
        where: { branchId, businessDate: day(date) },
        select: { kind: true, amount: true, fromTill: true },
      }),
    ]);
    return {
      businessDate: date,
      ...pettyDaySummary(
        Number(before._sum.amount ?? 0),
        entries.map((e) => ({ ...e, amount: Number(e.amount) })),
      ),
    };
  }

  record(branchId: string, userId: string, dto: PettyCashEntryDto) {
    return this.prisma.$transaction(async (tx) => {
      const fromTill = dto.kind === 'TOP_UP' && dto.fromTill;
      if (fromTill) await this.assertDayOpen(tx, branchId, dto.businessDate);
      const balanceAfter = await this.move(tx, branchId, dto.kind, dto.amount);
      const expense =
        dto.kind === 'PAYOUT'
          ? await tx.expense.create({
              data: {
                branchId,
                createdById: userId,
                spentOn: day(dto.businessDate),
                category: dto.category,
                amount: round2(dto.amount),
                note: dto.reason,
                paidFromCash: false,
              },
            })
          : null;
      return tx.pettyCashEntry.create({
        data: {
          branchId,
          createdById: userId,
          businessDate: day(dto.businessDate),
          kind: dto.kind,
          amount: signedAmount(dto.kind, dto.amount),
          balanceAfter,
          reason: dto.reason,
          receiptRef: dto.receiptRef,
          fromTill,
          expenseId: expense?.id,
        },
      });
    });
  }

  /** Physical count of the float; any difference is booked as an ADJUST. */
  reconcile(branchId: string, userId: string, dto: PettyCashReconcileDto) {
    return this.prisma.$transaction(async (tx) => {
      const expected = await this.current(tx, branchId);
      const counted = round2(dto.countedCash);
      const variance = round2(counted - expected);
      if (variance === 0) return { expected, counted, variance, entry: null };
      const balanceAfter = await this.move(tx, branchId, 'ADJUST', variance);
      const entry = await tx.pettyCashEntry.create({
        data: {
          branchId,
          createdById: userId,
          businessDate: day(dto.businessDate),
          kind: 'ADJUST',
          amount: variance,
          balanceAfter,
          reason: dto.note ? `Count variance: ${dto.note}` : 'Count variance',
        },
      });
      return { expected, counted, variance, entry };
    });
  }

  private async current(tx: Prisma.TransactionClient, branchId: string) {
    const f = await tx.pettyCashFloat.upsert({
      where: { branchId },
      create: { branchId },
      update: {},
    });
    return round2(Number(f.balance));
  }

  // Rounded read-modify-write `set`, guarded on the value read so a
  // concurrent movement cannot be silently lost (never a DB increment).
  private async move(
    tx: Prisma.TransactionClient,
    branchId: string,
    kind: PettyKind,
    amount: number,
  ) {
    const before = await this.current(tx, branchId);
    const after = applyEntry(before, kind, amount);
    const res = await tx.pettyCashFloat.updateMany({
      where: { branchId, balance: before },
      data: { balance: after },
    });
    if (res.count === 0) {
      throw new ConflictException('Petty cash changed meanwhile — retry');
    }
    return after;
  }

  private async assertDayOpen(
    tx: Prisma.TransactionClient,
    branchId: string,
    date: string,
  ) {
    const closed = await tx.cashClosing.findUnique({
      where: { branchId_businessDate: { branchId, businessDate: day(date) } },
    });
    if (closed) {
      throw new BadRequestException(
        'That day is already closed — the till count cannot change',
      );
    }
  }
}
