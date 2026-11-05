/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AccountingService } from './accounting.service';
import { assertDecision, statusForNewExpense } from './expense-approval';

describe('statusForNewExpense', () => {
  it('approves everything when no threshold is set', () => {
    expect(statusForNewExpense(1_000_000, null)).toBe('APPROVED');
  });

  it('needs approval only strictly above the threshold', () => {
    expect(statusForNewExpense(4999.99, 5000)).toBe('APPROVED');
    expect(statusForNewExpense(5000, 5000)).toBe('APPROVED');
    expect(statusForNewExpense(5000.01, 5000)).toBe('PENDING');
  });

  it('treats a zero threshold as "every expense needs approval"', () => {
    expect(statusForNewExpense(1, 0)).toBe('PENDING');
  });
});

describe('assertDecision', () => {
  const pending = { status: 'PENDING' as const, createdById: 'u1' };

  it('blocks the creator from deciding their own expense', () => {
    expect(() => assertDecision(pending, 'u1')).toThrow(ForbiddenException);
  });

  it('lets another user decide a pending expense', () => {
    expect(() => assertDecision(pending, 'u2')).not.toThrow();
  });

  it.each(['APPROVED', 'REJECTED'] as const)(
    'refuses to re-decide an %s expense',
    (status) => {
      expect(() => assertDecision({ status, createdById: 'u1' }, 'u2')).toThrow(
        BadRequestException,
      );
    },
  );
});

describe('AccountingService expense approvals', () => {
  function setup(threshold: number | null, existing?: Record<string, unknown>) {
    const prisma = {
      restaurant: {
        findFirst: jest.fn().mockResolvedValue({
          expenseApprovalThreshold: threshold,
        }),
      },
      expense: {
        create: jest.fn((a: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'e1', ...a.data }),
        ),
        findFirst: jest.fn().mockResolvedValue(existing ?? null),
        update: jest.fn((a: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...existing, ...a.data }),
        ),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      cashClosing: { findUnique: jest.fn().mockResolvedValue(null) },
      pettyCashEntry: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
      payment: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
      refund: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
      order: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: {},
          _count: { _all: 0 },
        }),
      },
      payrollRun: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const time = { tzForBranch: jest.fn().mockResolvedValue('Asia/Kolkata') };
    const notifications = {
      notifyByPermission: jest.fn().mockResolvedValue(undefined),
      notifyUser: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new AccountingService(
      prisma as never,
      time as never,
      notifications as never,
    );
    return { svc, prisma, notifications };
  }
  const dto = {
    spentOn: '2026-11-01',
    category: 'Repairs',
    amount: 8000,
    paidFromCash: true,
  };

  it('records a large expense as PENDING and notifies approvers', async () => {
    const { svc, prisma, notifications } = setup(5000);
    const e = await svc.createExpense('b1', 'u1', dto);
    expect(e.status).toBe('PENDING');
    expect(prisma.expense.create.mock.calls[0][0].data.status).toBe('PENDING');
    expect(notifications.notifyByPermission).toHaveBeenCalledWith(
      'b1',
      'expenses.approve',
      expect.objectContaining({ type: 'expense.pending', entityId: 'e1' }),
      'u1',
    );
  });

  it('auto-approves an expense under the threshold without notifying', async () => {
    const { svc, notifications } = setup(5000);
    const e = await svc.createExpense('b1', 'u1', { ...dto, amount: 200 });
    expect(e.status).toBe('APPROVED');
    expect(notifications.notifyByPermission).not.toHaveBeenCalled();
  });

  it('approves a pending expense, stamping the approver', async () => {
    const { svc, prisma, notifications } = setup(5000, {
      id: 'e1',
      status: 'PENDING',
      createdById: 'u1',
      spentOn: new Date('2026-11-01'),
      paidFromCash: false,
      amount: 8000,
      category: 'Repairs',
    });
    const e = await svc.decideExpense('b1', 'e1', 'u2', 'APPROVED', 'ok');
    const data = prisma.expense.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: 'APPROVED',
      decidedById: 'u2',
      decisionNote: 'ok',
    });
    expect(data.decidedAt).toBeInstanceOf(Date);
    expect(e.status).toBe('APPROVED');
    expect(notifications.notifyUser).toHaveBeenCalledWith(
      'u1',
      'b1',
      expect.objectContaining({ type: 'expense.approved' }),
    );
  });

  it('blocks self-approval', async () => {
    const { svc, prisma } = setup(5000, {
      id: 'e1',
      status: 'PENDING',
      createdById: 'u1',
    });
    await expect(
      svc.decideExpense('b1', 'e1', 'u1', 'APPROVED'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });

  it('will not approve a cash expense into an already-closed day', async () => {
    const { svc, prisma } = setup(5000, {
      id: 'e1',
      status: 'PENDING',
      createdById: 'u1',
      spentOn: new Date('2026-11-01'),
      paidFromCash: true,
    });
    prisma.cashClosing.findUnique.mockResolvedValue({ id: 'c1' });
    await expect(
      svc.decideExpense('b1', 'e1', 'u2', 'APPROVED'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('counts only approved expenses in cash close and P&L', async () => {
    const { svc, prisma } = setup(null);
    await svc.closingPreview('b1', '2026-11-01');
    expect(prisma.expense.aggregate.mock.calls[0][0].where.status).toBe(
      'APPROVED',
    );
    await svc.profitAndLoss('b1', '2026-11-01', '2026-11-30');
    expect(prisma.expense.groupBy.mock.calls[0][0].where.status).toBe(
      'APPROVED',
    );
  });
});
