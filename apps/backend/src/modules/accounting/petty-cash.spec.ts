/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { expectedCash } from './accounting.calc';
import {
  applyEntry,
  pettyDaySummary,
  signedAmount,
  tillTopUps,
} from './petty-cash.calc';
import { PettyCashService } from './petty-cash.service';

describe('petty cash maths', () => {
  it('signs entries: top-ups in, payouts out, adjustments as given', () => {
    expect(signedAmount('TOP_UP', 500)).toBe(500);
    expect(signedAmount('PAYOUT', 120.5)).toBe(-120.5);
    expect(signedAmount('ADJUST', -3.2)).toBe(-3.2);
    expect(signedAmount('ADJUST', 4)).toBe(4);
  });

  it('keeps the balance exact to the paisa (no float drift)', () => {
    let bal = 0;
    for (let i = 0; i < 10; i++) bal = applyEntry(bal, 'TOP_UP', 0.1);
    expect(bal).toBe(1);
    expect(applyEntry(1000, 'PAYOUT', 333.33)).toBe(666.67);
  });

  it('refuses a payout or adjustment that would take the float negative', () => {
    expect(() => applyEntry(100, 'PAYOUT', 100.01)).toThrow(
      BadRequestException,
    );
    expect(() => applyEntry(5, 'ADJUST', -6)).toThrow(BadRequestException);
    expect(applyEntry(100, 'PAYOUT', 100)).toBe(0);
  });

  it('summarises a day from its opening balance', () => {
    const s = pettyDaySummary(200, [
      { kind: 'TOP_UP', amount: 1000, fromTill: true },
      { kind: 'PAYOUT', amount: -250.5, fromTill: false },
      { kind: 'PAYOUT', amount: -49.5, fromTill: false },
      { kind: 'ADJUST', amount: -10, fromTill: false },
    ]);
    expect(s).toEqual({
      openingBalance: 200,
      topUps: 1000,
      payouts: 300,
      adjustments: -10,
      closingBalance: 890,
    });
  });

  it('only counts top-ups drawn from the till against the till', () => {
    const entries = [
      { kind: 'TOP_UP' as const, amount: 1000, fromTill: true },
      { kind: 'TOP_UP' as const, amount: 500, fromTill: false },
      { kind: 'PAYOUT' as const, amount: -300, fromTill: false },
    ];
    expect(tillTopUps(entries)).toBe(1000);
    // Opening 500 + 2000 sales - 0 refunds - 100 till expenses - 1000 moved
    // to petty cash. The 300 petty payout is NOT taken off the till again.
    expect(expectedCash(500, 2000, 0, 100, tillTopUps(entries))).toBe(1400);
    // Old four-argument callers are unchanged.
    expect(expectedCash(500, 2000, 0, 100)).toBe(2400);
  });
});

describe('PettyCashService', () => {
  function setup(balance = 0) {
    const state = { balance, entries: [] as any[], expenses: [] as any[] };
    const tx = {
      pettyCashFloat: {
        upsert: jest.fn(() => Promise.resolve({ balance: state.balance })),
        updateMany: jest.fn(({ where, data }: any) => {
          if (Number(where.balance) !== state.balance)
            return Promise.resolve({ count: 0 });
          state.balance = Number(data.balance);
          return Promise.resolve({ count: 1 });
        }),
      },
      expense: {
        create: jest.fn(({ data }: any) => {
          const e = { id: `exp${state.expenses.length + 1}`, ...data };
          state.expenses.push(e);
          return Promise.resolve(e);
        }),
      },
      pettyCashEntry: {
        create: jest.fn(({ data }: any) => {
          const e = { id: `pc${state.entries.length + 1}`, ...data };
          state.entries.push(e);
          return Promise.resolve(e);
        }),
      },
      cashClosing: { findUnique: jest.fn(() => Promise.resolve(null)) },
    };
    const prisma = {
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
      ...tx,
    };
    return {
      svc: new PettyCashService(prisma as never),
      state,
      tx,
    };
  }

  it('records a payout as one expense that is NOT paid from the till', async () => {
    const { svc, state } = setup(1000);
    await svc.record('b1', 'u1', {
      kind: 'PAYOUT',
      businessDate: '2026-11-04',
      amount: 250,
      category: 'Vegetables',
      reason: 'Market run',
      receiptRef: 'RCPT-9',
    });
    expect(state.balance).toBe(750);
    expect(state.expenses).toHaveLength(1);
    expect(state.expenses[0]).toMatchObject({
      category: 'Vegetables',
      amount: 250,
      paidFromCash: false,
    });
    expect(state.entries[0]).toMatchObject({
      kind: 'PAYOUT',
      amount: -250,
      balanceAfter: 750,
      expenseId: 'exp1',
      receiptRef: 'RCPT-9',
    });
  });

  it('a top-up creates no expense', async () => {
    const { svc, state } = setup(0);
    await svc.record('b1', 'u1', {
      kind: 'TOP_UP',
      businessDate: '2026-11-04',
      amount: 2000,
      reason: 'Float',
      fromTill: true,
    });
    expect(state.balance).toBe(2000);
    expect(state.expenses).toHaveLength(0);
    expect(state.entries[0]).toMatchObject({ fromTill: true, amount: 2000 });
  });

  it('refuses a till top-up on a day that is already closed', async () => {
    const { svc, tx, state } = setup(0);
    tx.cashClosing.findUnique.mockResolvedValueOnce({ id: 'c1' } as never);
    await expect(
      svc.record('b1', 'u1', {
        kind: 'TOP_UP',
        businessDate: '2026-11-03',
        amount: 100,
        reason: 'Float',
        fromTill: true,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(state.entries).toHaveLength(0);
  });

  it('refuses a payout larger than the float', async () => {
    const { svc, state } = setup(100);
    await expect(
      svc.record('b1', 'u1', {
        kind: 'PAYOUT',
        businessDate: '2026-11-04',
        amount: 150,
        category: 'Gas',
        reason: 'Cylinder',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(state.expenses).toHaveLength(0);
  });

  it('fails cleanly when the balance moved under it (lost-update guard)', async () => {
    const { svc, tx } = setup(500);
    tx.pettyCashFloat.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.record('b1', 'u1', {
        kind: 'TOP_UP',
        businessDate: '2026-11-04',
        amount: 10,
        reason: 'x',
        fromTill: false,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('reconciles a count: books the variance as an adjustment', async () => {
    const { svc, state } = setup(890);
    const r = await svc.reconcile('b1', 'u1', {
      businessDate: '2026-11-04',
      countedCash: 880.5,
      note: 'Short',
    });
    expect(r).toMatchObject({
      expected: 890,
      counted: 880.5,
      variance: -9.5,
    });
    expect(state.balance).toBe(880.5);
    expect(state.entries[0]).toMatchObject({ kind: 'ADJUST', amount: -9.5 });
  });

  it('reconciles an exact count without writing an entry', async () => {
    const { svc, state } = setup(890);
    const r = await svc.reconcile('b1', 'u1', {
      businessDate: '2026-11-04',
      countedCash: 890,
    });
    expect(r).toMatchObject({ variance: 0, entry: null });
    expect(state.entries).toHaveLength(0);
  });
});

describe('petty cash schemas', () => {
  const base = { businessDate: '2026-11-04', reason: 'x' };
  it('rejects amounts that round to zero paisa', () => {
    const { pettyCashEntrySchema: s } =
      jest.requireActual<typeof import('@nventra/types')>('@nventra/types');
    expect(
      s.safeParse({ ...base, kind: 'TOP_UP', amount: 0.001 }).success,
    ).toBe(false);
    expect(
      s.safeParse({ ...base, kind: 'PAYOUT', amount: 0.004, category: 'Gas' })
        .success,
    ).toBe(false);
    expect(
      s.safeParse({ ...base, kind: 'ADJUST', amount: -0.004 }).success,
    ).toBe(false);
    expect(s.safeParse({ ...base, kind: 'TOP_UP', amount: 0.01 }).success).toBe(
      true,
    );
    expect(
      s.safeParse({ ...base, kind: 'ADJUST', amount: -0.01 }).success,
    ).toBe(true);
  });
  it('trims the reconcile note', () => {
    const { pettyCashReconcileSchema: s } =
      jest.requireActual<typeof import('@nventra/types')>('@nventra/types');
    const r = s.parse({
      businessDate: '2026-11-04',
      countedCash: 5,
      note: '  short  ',
    });
    expect(r.note).toBe('short');
  });
});
