import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CashClosingDto, ExpenseDto, ExpenseStatus } from '@nventra/types';
import { localDate, zonedRange } from '../../common/time';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { expectedCash, gstSummary, round2 } from './accounting.calc';
import {
  assertDecision,
  EXPENSE_APPROVE_PERMISSION,
  statusForNewExpense,
} from './expense-approval';
import type { TallyOrderInput, TallyRefundInput } from './tally-xml';

const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
const dayAfter = (d: string) => new Date(dayStart(d).getTime() + 86_400_000);

@Injectable()
export class AccountingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: BranchTimeService,
    private readonly notifications: NotificationsService,
  ) {}

  // --- Expenses ------------------------------------------------------------

  listExpenses(
    branchId: string,
    from: string,
    to: string,
    status?: ExpenseStatus,
  ) {
    return this.prisma.expense.findMany({
      where: {
        branchId,
        spentOn: { gte: dayStart(from), lte: dayStart(to) },
        ...(status ? { status } : {}),
      },
      orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
  }

  /** Pending expenses for the approver queue, oldest first. */
  listPendingExpenses(branchId: string) {
    return this.prisma.expense.findMany({
      where: { branchId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { createdBy: { select: { id: true, name: true } } },
      take: 500,
    });
  }

  private async approvalThreshold(branchId: string) {
    const r = await this.prisma.restaurant.findFirst({
      where: { branches: { some: { id: branchId } } },
      select: { expenseApprovalThreshold: true },
    });
    const t = r?.expenseApprovalThreshold;
    return t === null || t === undefined ? null : Number(t);
  }

  async createExpense(branchId: string, userId: string, dto: ExpenseDto) {
    const status = statusForNewExpense(
      dto.amount,
      await this.approvalThreshold(branchId),
    );
    const expense = await this.prisma.expense.create({
      data: {
        branchId,
        createdById: userId,
        spentOn: dayStart(dto.spentOn),
        category: dto.category,
        amount: dto.amount,
        note: dto.note,
        paidFromCash: dto.paidFromCash,
        status,
      },
    });
    if (status === 'PENDING')
      await this.notifications.notifyByPermission(
        branchId,
        EXPENSE_APPROVE_PERMISSION,
        {
          type: 'expense.pending',
          title: 'Expense needs approval',
          body: `${dto.category}: ${round2(dto.amount).toFixed(2)} on ${dto.spentOn}`,
          entity: 'Expense',
          entityId: expense.id,
        },
        userId,
      );
    return expense;
  }

  /** Approve or reject a PENDING expense. The recorder cannot decide it. */
  async decideExpense(
    branchId: string,
    id: string,
    userId: string,
    decision: 'APPROVED' | 'REJECTED',
    note?: string,
  ) {
    const expense = await this.prisma.expense.findFirst({
      where: { id, branchId },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    assertDecision(expense, userId);
    if (decision === 'APPROVED' && expense.paidFromCash) {
      const closed = await this.prisma.cashClosing.findUnique({
        where: {
          branchId_businessDate: { branchId, businessDate: expense.spentOn },
        },
      });
      if (closed)
        throw new BadRequestException(
          'That day is already closed — approving would change its cash count',
        );
    }
    const updated = await this.prisma.expense.update({
      where: { id, status: 'PENDING' },
      data: {
        status: decision,
        decidedById: userId,
        decidedAt: new Date(),
        decisionNote: note,
      },
    });
    await this.notifications.notifyUser(expense.createdById, branchId, {
      type: decision === 'APPROVED' ? 'expense.approved' : 'expense.rejected',
      title: decision === 'APPROVED' ? 'Expense approved' : 'Expense rejected',
      body: `${expense.category}: ${round2(Number(expense.amount)).toFixed(2)}${note ? ` — ${note}` : ''}`,
      entity: 'Expense',
      entityId: id,
    });
    return updated;
  }

  async deleteExpense(branchId: string, id: string) {
    const expense = await this.prisma.expense.findFirst({
      where: { id, branchId },
      include: { pettyCashEntry: { select: { id: true } } },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    if (expense.pettyCashEntry)
      throw new BadRequestException(
        'Paid from petty cash — correct it with a petty-cash adjustment',
      );
    const closed = await this.prisma.cashClosing.findUnique({
      where: {
        branchId_businessDate: { branchId, businessDate: expense.spentOn },
      },
    });
    if (closed && expense.paidFromCash && expense.status === 'APPROVED')
      throw new BadRequestException(
        'That day is already closed — the cash count includes this expense',
      );
    await this.prisma.expense.delete({ where: { id } });
    return { ok: true };
  }

  // --- Daily cash closing --------------------------------------------------

  /** What the till should hold for a day, before anyone counts it. */
  async closingPreview(branchId: string, date: string, openingFloat = 0) {
    const from = dayStart(date); // @db.Date column: a plain calendar date
    const range = zonedRange(date, date, await this.time.tzForBranch(branchId));
    const [sales, refunds, expenses, petty] = await Promise.all([
      this.prisma.payment.aggregate({
        where: {
          method: 'CASH',
          createdAt: range,
          order: { branchId },
        },
        _sum: { amount: true },
      }),
      this.prisma.refund.aggregate({
        where: {
          method: 'CASH',
          createdAt: range,
          order: { branchId },
        },
        _sum: { amount: true },
      }),
      this.prisma.expense.aggregate({
        where: {
          branchId,
          spentOn: from,
          paidFromCash: true,
          status: 'APPROVED',
        },
        _sum: { amount: true },
      }),
      // Cash moved from the drawer into the petty-cash float (#72).
      this.prisma.pettyCashEntry.aggregate({
        where: {
          branchId,
          businessDate: from,
          kind: 'TOP_UP',
          fromTill: true,
        },
        _sum: { amount: true },
      }),
    ]);
    const cashSales = Number(sales._sum.amount ?? 0);
    const cashRefunds = Number(refunds._sum.amount ?? 0);
    const cashExpenses = Number(expenses._sum.amount ?? 0);
    const pettyCashTopUps = round2(Number(petty._sum.amount ?? 0));
    return {
      businessDate: date,
      openingFloat,
      cashSales: round2(cashSales - cashRefunds),
      cashExpenses: round2(cashExpenses),
      pettyCashTopUps,
      expectedCash: expectedCash(
        openingFloat,
        cashSales,
        cashRefunds,
        cashExpenses,
        pettyCashTopUps,
      ),
    };
  }

  async closeDay(branchId: string, userId: string, dto: CashClosingDto) {
    const existing = await this.prisma.cashClosing.findUnique({
      where: {
        branchId_businessDate: {
          branchId,
          businessDate: dayStart(dto.businessDate),
        },
      },
    });
    if (existing) throw new BadRequestException('This day is already closed');
    const p = await this.closingPreview(
      branchId,
      dto.businessDate,
      dto.openingFloat,
    );
    return this.prisma.cashClosing.create({
      data: {
        branchId,
        businessDate: dayStart(dto.businessDate),
        openingFloat: dto.openingFloat,
        cashSales: p.cashSales,
        cashExpenses: p.cashExpenses,
        pettyCashTopUps: p.pettyCashTopUps,
        expectedCash: p.expectedCash,
        countedCash: dto.countedCash,
        variance: round2(dto.countedCash - p.expectedCash),
        note: dto.note,
        closedById: userId,
      },
    });
  }

  listClosings(branchId: string) {
    return this.prisma.cashClosing.findMany({
      where: { branchId },
      orderBy: { businessDate: 'desc' },
      take: 60,
    });
  }

  // --- Reports -------------------------------------------------------------

  /** Profit & loss for a period (cash-basis on bills paid in the period). */
  async profitAndLoss(branchId: string, from: string, to: string) {
    const f = dayStart(from); // date columns (expenses, payroll periods)
    const t = dayAfter(to);
    const range = zonedRange(from, to, await this.time.tzForBranch(branchId));
    const [orders, refunds, expenses, runs] = await Promise.all([
      this.prisma.order.aggregate({
        where: { branchId, status: 'PAID', billedAt: range },
        _sum: { totalAmount: true, tipAmount: true, taxAmount: true },
        _count: { _all: true },
      }),
      this.prisma.refund.aggregate({
        where: { createdAt: range, order: { branchId } },
        _sum: { amount: true },
      }),
      this.prisma.expense.groupBy({
        by: ['category'],
        where: { branchId, spentOn: { gte: f, lt: t }, status: 'APPROVED' },
        _sum: { amount: true },
        orderBy: { category: 'asc' },
      }),
      this.prisma.payrollRun.findMany({
        where: {
          branchId,
          status: 'FINALIZED',
          periodEnd: { gte: f, lt: t },
        },
        include: { lines: true },
      }),
    ]);

    // Tips belong to staff, not the restaurant, so they are excluded from
    // revenue (and from payroll cost below).
    const collected =
      Number(orders._sum.totalAmount ?? 0) - Number(orders._sum.tipAmount ?? 0);
    const tax = Number(orders._sum.taxAmount ?? 0);
    const refunded = Number(refunds._sum.amount ?? 0);
    const netSales = round2(collected - tax - refunded);
    const expenseRows = expenses.map((e) => ({
      category: e.category,
      amount: round2(Number(e._sum.amount ?? 0)),
    }));
    const totalExpenses = round2(expenseRows.reduce((s, e) => s + e.amount, 0));
    const payrollCost = round2(
      runs
        .flatMap((r) => r.lines)
        .reduce(
          (s, l) => s + Number(l.basePay) - Number(l.unpaidLeaveDeduction),
          0,
        ),
    );
    return {
      from,
      to,
      orders: orders._count._all,
      grossCollected: round2(collected),
      taxCollected: round2(tax),
      refunds: round2(refunded),
      netSales,
      expenses: expenseRows,
      totalExpenses,
      payrollCost,
      netProfit: round2(netSales - totalExpenses - payrollCost),
    };
  }

  async gstReport(branchId: string, from: string, to: string) {
    const orders = await this.prisma.order.findMany({
      where: {
        branchId,
        status: 'PAID',
        billedAt: zonedRange(from, to, await this.time.tzForBranch(branchId)),
      },
      select: {
        subtotal: true,
        discountAmount: true,
        loyaltyDiscountAmount: true,
        items: { select: { lineTotal: true, taxRateSnapshot: true } },
      },
    });
    const lines = orders.flatMap((o) => {
      const subtotal = Number(o.subtotal);
      const charged =
        subtotal - Number(o.discountAmount) - Number(o.loyaltyDiscountAmount);
      const factor = subtotal > 0 ? Math.max(0, charged) / subtotal : 1;
      return o.items.map((i) => ({
        lineTotal: Number(i.lineTotal),
        taxRatePercent: Number(i.taxRateSnapshot),
        factor,
      }));
    });
    return { from, to, orders: orders.length, ...gstSummary(lines) };
  }

  /** Paid orders and refunds in a range, shaped for the Tally generator. */
  async tallyExportData(branchId: string, from: string, to: string) {
    const tz = await this.time.tzForBranch(branchId);
    const range = zonedRange(from, to, tz);
    const [orders, refunds] = await Promise.all([
      this.prisma.order.findMany({
        where: { branchId, status: 'PAID', billedAt: range },
        select: {
          id: true,
          orderNumber: true,
          billedAt: true,
          subtotal: true,
          discountAmount: true,
          loyaltyDiscountAmount: true,
          totalAmount: true,
          items: { select: { lineTotal: true, taxRateSnapshot: true } },
          payments: { select: { id: true, method: true, amount: true } },
        },
      }),
      this.prisma.refund.findMany({
        where: { createdAt: range, order: { branchId } },
        select: {
          id: true,
          amount: true,
          method: true,
          createdAt: true,
          order: {
            select: {
              orderNumber: true,
              subtotal: true,
              discountAmount: true,
              loyaltyDiscountAmount: true,
              totalAmount: true,
              items: { select: { lineTotal: true, taxRateSnapshot: true } },
            },
          },
        },
      }),
    ]);
    const taxOf = (o: (typeof refunds)[number]['order']) => {
      const subtotal = Number(o.subtotal);
      const charged =
        subtotal - Number(o.discountAmount) - Number(o.loyaltyDiscountAmount);
      const factor = subtotal > 0 ? Math.max(0, charged) / subtotal : 1;
      return gstSummary(
        o.items.map((i) => ({
          lineTotal: Number(i.lineTotal),
          taxRatePercent: Number(i.taxRateSnapshot),
          factor,
        })),
      ).totalTax;
    };
    const orderInputs: TallyOrderInput[] = orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      date: localDate(o.billedAt ?? new Date(), tz),
      subtotal: Number(o.subtotal),
      discountAmount: Number(o.discountAmount),
      loyaltyDiscountAmount: Number(o.loyaltyDiscountAmount),
      totalAmount: Number(o.totalAmount),
      items: o.items.map((i) => ({
        lineTotal: Number(i.lineTotal),
        taxRatePercent: Number(i.taxRateSnapshot),
      })),
      payments: o.payments.map((p) => ({
        id: p.id,
        method: p.method,
        amount: Number(p.amount),
      })),
    }));
    const refundInputs: TallyRefundInput[] = refunds.map((r) => ({
      id: r.id,
      orderNumber: r.order.orderNumber,
      date: localDate(r.createdAt, tz),
      amount: Number(r.amount),
      method: r.method,
      orderTax: taxOf(r.order),
      orderTotal: Number(r.order.totalAmount),
    }));
    return { orders: orderInputs, refunds: refundInputs };
  }

  /** Cross-branch snapshot for the whole restaurant. */
  async branchOverview(restaurantId: string, from: string, to: string) {
    const range = zonedRange(
      from,
      to,
      await this.time.tzForRestaurant(restaurantId),
    );
    const branches = await this.prisma.branch.findMany({
      where: { restaurantId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return Promise.all(
      branches.map(async (b) => {
        const [sales, open, ingredients] = await Promise.all([
          this.prisma.order.aggregate({
            where: {
              branchId: b.id,
              status: 'PAID',
              billedAt: range,
            },
            _sum: { totalAmount: true },
            _count: { _all: true },
          }),
          this.prisma.order.count({
            where: { branchId: b.id, status: 'OPEN' },
          }),
          this.prisma.ingredient.findMany({
            where: { branchId: b.id },
            select: {
              currentStock: true,
              reorderLevel: true,
              costPerUnit: true,
            },
          }),
        ]);
        return {
          branchId: b.id,
          name: b.name,
          orders: sales._count._all,
          sales: round2(Number(sales._sum.totalAmount ?? 0)),
          openOrders: open,
          lowStockItems: ingredients.filter(
            (i) =>
              Number(i.reorderLevel) > 0 &&
              Number(i.currentStock) <= Number(i.reorderLevel),
          ).length,
          inventoryValue: round2(
            ingredients.reduce(
              (s, i) => s + Number(i.currentStock) * Number(i.costPerUnit),
              0,
            ),
          ),
        };
      }),
    );
  }
}
