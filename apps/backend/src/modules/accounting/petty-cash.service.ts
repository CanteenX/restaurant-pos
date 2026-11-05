import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PettyCashEntryDto, PettyCashReconcileDto } from '@nventra/types';
import { PrismaService } from '../../prisma/prisma.service';
import { round2 } from './accounting.calc';
import { assertPayoutAllowed, readApprovalThreshold } from './expense-approval';
import {
  applyEntry,
  pettyDaySummary,
  signedAmount,
  type PettyKind,
} from './petty-cash.calc';

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

/** Who records a movement; canApprove = holds expenses.approve. */
export interface PettyActor {
  id: string;
  canApprove: boolean;
}

const PRE_APPROVED_NOTE = 'Pre-approved petty-cash payout';

/**
 * Petty-cash float per branch (#72). The float is a separate box from the
 * till: a PAYOUT books exactly one Expense with paidFromCash=false (so the
 * day-close count never subtracts it), and a TOP_UP marked fromTill is
 * subtracted from that day's expected till cash instead. A PAYOUT above the
 * expense approval threshold (#192) needs an approver and is booked as
 * pre-approved by them, with an explicit audit entry.
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

  async record(branchId: string, actor: PettyActor, dto: PettyCashEntryDto) {
    return this.prisma.$transaction(async (tx) => {
      const fromTill = dto.kind === 'TOP_UP' && dto.fromTill;
      if (fromTill) await this.assertDayOpen(tx, branchId, dto.businessDate);
      // Checked before the float moves; the expense is booked after it.
      const check =
        dto.kind === 'PAYOUT'
          ? await this.payoutApproval(tx, branchId, actor, dto.amount)
          : null;
      const balanceAfter = await this.move(tx, branchId, dto.kind, dto.amount);
      const expense =
        dto.kind === 'PAYOUT' && check
          ? await this.bookPayout(tx, branchId, actor, dto, check.preApproved)
          : null;
      const entry = await tx.pettyCashEntry.create({
        data: {
          branchId,
          createdById: actor.id,
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
      // Same transaction: the payout and its pre-approval audit row commit
      // together or not at all (a failed audit write moves no cash).
      if (expense && check?.preApproved) {
        await tx.auditLog.create({
          data: {
            userId: actor.id,
            action: 'expense.preapproved',
            entity: 'Expense',
            entityId: expense.id,
            metadata: {
              via: 'petty_cash.payout',
              branchId,
              pettyCashEntryId: entry.id,
              amount: round2(dto.amount),
              threshold: check.threshold,
            },
          },
        });
      }
      return entry;
    });
  }

  /**
   * Above the expense approval threshold (#192) a payout needs an approver:
   * the cash has already left the float, so it cannot wait in the queue.
   */
  private async payoutApproval(
    tx: Prisma.TransactionClient,
    branchId: string,
    actor: PettyActor,
    amount: number,
  ) {
    const threshold = await readApprovalThreshold(tx, branchId);
    const preApproved = assertPayoutAllowed(
      amount,
      threshold,
      actor.canApprove,
    );
    return { threshold, preApproved };
  }

  /** The one Expense a PAYOUT books, stamped if an approver pre-approved it. */
  private bookPayout(
    tx: Prisma.TransactionClient,
    branchId: string,
    actor: PettyActor,
    dto: Extract<PettyCashEntryDto, { kind: 'PAYOUT' }>,
    preApproved: boolean,
  ) {
    return tx.expense.create({
      data: {
        branchId,
        createdById: actor.id,
        spentOn: day(dto.businessDate),
        category: dto.category,
        amount: round2(dto.amount),
        note: dto.reason,
        paidFromCash: false,
        status: 'APPROVED',
        ...(preApproved && {
          decidedById: actor.id,
          decidedAt: new Date(),
          decisionNote: PRE_APPROVED_NOTE,
        }),
      },
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
    // Exact 2-dp strings: a JS number filter on a Decimal column is bound
    // imprecisely and can miss (e.g. 8227.30), failing every movement.
    const res = await tx.pettyCashFloat.updateMany({
      where: { branchId, balance: before.toFixed(2) },
      data: { balance: after.toFixed(2) },
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
