import {
  backoffMs,
  columnsToWrite,
  derivedTargets,
  isContended,
  keyForServer,
  orderProblems,
  ownership,
  pullScope,
  schemaSkew,
  yieldDelayMs,
  type OwnershipInput,
} from './apply-rules';
import { DERIVED } from './derived';
import { SyncChange } from './outbox';
import { SYNC_TABLES, syncTable } from './tables';

const base = (over: Partial<OwnershipInput>): OwnershipInput => ({
  receiver: 'hq',
  tbl: 'orders',
  table: syncTable('orders'),
  op: 'U',
  exists: false,
  newBranch: 'b1',
  currentBranch: undefined,
  routedBranch: null,
  branches: ['b1'],
  ...over,
});
const verdict = (over: Partial<OwnershipInput>) => ownership(base(over));

describe('ownership (rule 1)', () => {
  describe('HQ receiving a branch push', () => {
    it('accepts a row of a branch the peer owns', () => {
      expect(verdict({})).toEqual({ ok: true });
    });

    it('rejects HQ-owned tables: a branch cannot change the menu', () => {
      const v = verdict({ tbl: 'menu_items', table: syncTable('menu_items') });
      expect(v).toMatchObject({ ok: false, retry: false });
      expect(!v.ok && v.error).toMatch(/^not-owner: menu_items is HQ-owned/);
    });

    it("rejects another branch's rows", () => {
      expect(verdict({ newBranch: 'b2' })).toMatchObject({
        ok: false,
        retry: false,
        error: 'not-owner: row belongs to branch b2',
      });
    });

    it("rejects moving a row out of another branch into the peer's own", () => {
      expect(
        verdict({ exists: true, currentBranch: 'b2', newBranch: 'b1' }),
      ).toMatchObject({
        ok: false,
        error: 'not-owner: row belongs to branch b2',
      });
    });

    it("rejects a delete of another branch's row", () => {
      expect(
        verdict({
          op: 'D',
          exists: true,
          currentBranch: 'b2',
          newBranch: null,
        }),
      ).toMatchObject({ ok: false, retry: false });
      expect(
        verdict({
          op: 'D',
          exists: true,
          currentBranch: 'b1',
          newBranch: null,
        }),
      ).toEqual({ ok: true });
    });

    it('retries a child whose parent row has not arrived yet', () => {
      expect(
        verdict({
          tbl: 'order_items',
          table: syncTable('order_items'),
          newBranch: undefined,
        }),
      ).toMatchObject({ ok: false, retry: true });
    });

    it('takes restaurant-wide append rows (audit log) as inserts only', () => {
      const audit = { tbl: 'audit_logs', table: syncTable('audit_logs') };
      expect(verdict({ ...audit, newBranch: null })).toEqual({ ok: true });
      expect(
        verdict({ ...audit, newBranch: null, exists: true }),
      ).toMatchObject({
        ok: false,
        error: 'not-owner: audit_logs is append-only',
      });
    });

    it('rejects tables that are not synced', () => {
      expect(
        verdict({ tbl: 'staff_api_keys', table: undefined }),
      ).toMatchObject({
        ok: false,
        retry: false,
        error: 'not-synced: staff_api_keys',
      });
    });
  });

  describe('a branch receiving a pull from HQ', () => {
    const pull = (over: Partial<OwnershipInput>) =>
      verdict({ receiver: 'branch', ...over });

    it('accepts HQ-owned rows', () => {
      expect(
        pull({
          tbl: 'menu_items',
          table: syncTable('menu_items'),
          newBranch: 'b2',
        }),
      ).toEqual({ ok: true });
    });

    it('accepts its own branch rows back (restore)', () => {
      expect(pull({})).toEqual({ ok: true });
    });

    it("never accepts another branch's orders", () => {
      expect(pull({ newBranch: 'b2' })).toMatchObject({ ok: false });
    });

    it('accepts a stock transfer sent to it from another branch', () => {
      const t = { tbl: 'stock_transfers', table: syncTable('stock_transfers') };
      expect(pull({ ...t, newBranch: 'b2', routedBranch: 'b1' })).toEqual({
        ok: true,
      });
      expect(pull({ ...t, newBranch: 'b2', routedBranch: 'b3' })).toMatchObject(
        {
          ok: false,
        },
      );
    });
  });
});

describe('schema version skew (G9)', () => {
  const local = '20261105100000_sync_apply';

  it('orders migration names by their timestamp prefix', () => {
    expect(schemaSkew(local, local)).toBe('same');
    expect(schemaSkew('20261104130000_sync_outbox', local)).toBe('older');
    expect(schemaSkew('20261201000000_later', local)).toBe('newer');
    expect(schemaSkew(null, local)).toBe('older');
  });

  const cols = ['id', 'branchId', 'name', 'addedLater', 'twoFactorSecret'];

  it('writes only the columns a change carries, so an older sender never nulls a newer column', () => {
    expect(
      columnsToWrite({
        rowKeys: ['id', 'branchId', 'name'],
        cols,
        pk: ['id'],
        strip: ['twoFactorSecret'],
        skew: 'older',
      }),
    ).toEqual(['id', 'branchId', 'name']);
  });

  it('never writes stripped columns and ignores keys the table lacks', () => {
    expect(
      columnsToWrite({
        rowKeys: [...cols, 'unknown'],
        cols,
        pk: ['id'],
        strip: ['twoFactorSecret'],
        skew: 'same',
      }),
    ).toEqual(['id', 'branchId', 'name', 'addedLater']);
  });

  it('refuses a change from a newer schema than this install', () => {
    expect(() =>
      columnsToWrite({
        rowKeys: cols,
        cols,
        pk: ['id'],
        strip: [],
        skew: 'newer',
      }),
    ).toThrow(/newer app version/);
  });

  it('refuses a row missing a key column', () => {
    expect(() =>
      columnsToWrite({
        rowKeys: ['name'],
        cols,
        pk: ['id'],
        strip: [],
        skew: 'same',
      }),
    ).toThrow(/missing key column id/);
  });
});

describe('derived balances (rule 5)', () => {
  it('covers exactly the columns tables.ts marks as derived', () => {
    const declared = Object.entries(SYNC_TABLES).flatMap(([t, s]) =>
      (s.derived ?? []).map((c) => `${t}.${c}`),
    );
    expect(DERIVED.map((d) => `${d.table}.${d.column}`).sort()).toEqual(
      declared.sort(),
    );
  });

  it('every derived ledger is a synced append-only table of the same owner', () => {
    for (const d of DERIVED) {
      const ledger = syncTable(d.ledger);
      expect(ledger?.rule).toBe('append');
      expect(ledger?.owner).toBe(syncTable(d.table)?.owner);
    }
  });

  const ch = (
    tbl: string,
    row: Record<string, unknown> | null,
    op: 'U' | 'D' = 'U',
  ): SyncChange => ({
    tbl,
    pk: { id: typeof row?.id === 'string' ? row.id : 'x' },
    pkKey: '',
    op,
    row,
    ts: '',
    hlc: '1',
    peer: 'p',
  });

  it('recomputes the parents of applied ledger rows and the rows themselves', () => {
    const t = derivedTargets([
      ch('customer_wallet_entries', { id: 'w1', customerId: 'c1' }),
      ch('customers', { id: 'c2' }),
      ch('gift_card_redemptions', { id: 'r1', giftCardId: 'g1' }),
      ch('gift_cards', { id: 'g2' }),
      ch('orders', { id: 'o1' }),
      ch('customers', null, 'D'),
    ]);
    expect([...t.get('customers.walletBalance')!].sort()).toEqual(['c1', 'c2']);
    expect([...t.get('gift_cards.balance')!].sort()).toEqual(['g1', 'g2']);
  });

  it('keys petty-cash floats by branchId, their primary key', () => {
    const t = derivedTargets([
      ch('petty_cash_entries', { id: 'e1', branchId: 'b1' }),
      ch('petty_cash_floats', { branchId: 'b2', balance: '9.00' }),
    ]);
    expect([...t.get('petty_cash_floats.balance')!].sort()).toEqual([
      'b1',
      'b2',
    ]);
  });
});

describe('order reconciliation at HQ (rule 7 audit)', () => {
  const order = {
    id: 'o1',
    status: 'PAID',
    subtotal: '500.00',
    discountAmount: '50.00',
    loyaltyDiscountAmount: '10.00',
    tipAmount: '20.00',
    deliveryFee: '15.00',
    totalAmount: '475.00',
  };
  const items = [{ lineTotal: '300.00' }, { lineTotal: '200.00' }];
  const payments = [{ amount: '400.00' }, { amount: '75.00' }];

  it('accepts a settled order whose lines, total and payments agree', () => {
    expect(orderProblems(order, items, payments, [])).toEqual([]);
  });

  it('flags lines that do not add up to the subtotal', () => {
    expect(
      orderProblems(order, [{ lineTotal: '300.00' }], payments, []),
    ).toEqual(['line items add up to 300.00, order subtotal is 500.00']);
  });

  it('flags a total that does not follow from subtotal, discounts, tip and delivery', () => {
    expect(
      orderProblems({ ...order, totalAmount: '400.00' }, items, payments, []),
    ).toEqual([
      'total 400.00 should be 475.00 (subtotal - discounts - loyalty + tip + delivery)',
      'payments add up to 475.00, order total is 400.00',
    ]);
  });

  it('flags payments that do not settle a paid order, and refunds above them', () => {
    expect(orderProblems(order, items, [{ amount: '400.00' }], [])).toEqual([
      'payments add up to 400.00, order total is 475.00',
    ]);
    expect(
      orderProblems(order, items, payments, [{ amount: '500.00' }]),
    ).toEqual(['refunds add up to 500.00, more than the 475.00 paid']);
  });

  it('does not judge orders that are still open or were cancelled', () => {
    expect(orderProblems({ ...order, status: 'OPEN' }, [], [], [])).toEqual([]);
    expect(
      orderProblems({ ...order, status: 'CANCELLED' }, [], [], []),
    ).toEqual([]);
  });

  it('compares in whole paise, so float noise is not a mismatch', () => {
    expect(
      orderProblems(
        {
          ...order,
          subtotal: '0.30',
          discountAmount: '0',
          loyaltyDiscountAmount: '0',
          tipAmount: '0',
          deliveryFee: '0',
          totalAmount: '0.30',
        },
        [{ lineTotal: '0.10' }, { lineTotal: '0.20' }],
        [{ amount: '0.30' }],
        [],
      ),
    ).toEqual([]);
  });
});

describe('retry backoff', () => {
  it('starts at the 30 s cycle, doubles per failure and caps at 10 min', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(5)).toBe(480_000);
    expect(backoffMs(6)).toBe(600_000);
    expect(backoffMs(50)).toBe(600_000);
  });
});

describe('pull scope (G2)', () => {
  it('splits tables into HQ-owned and transfer routing for the SQL filter', () => {
    const s = pullScope();
    expect(s.hqTables).toContain('menu_items');
    expect(s.hqTables).not.toContain('orders');
    expect(s.routed).toEqual([{ tbl: 'stock_transfers', col: 'toBranchId' }]);
  });
});

describe('lock contention (#82 review)', () => {
  it('yields on deadlocks, its own lock timeout and serialization failures', () => {
    for (const m of [
      'Raw query failed. Code: `40P01`. Message: `deadlock detected`',
      'Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`',
      'could not serialize access due to concurrent update',
    ])
      expect(isContended(m)).toBe(true);
  });

  it('does not treat ordinary apply errors as contention', () => {
    for (const m of [
      'violates foreign key constraint "order_items_orderId_fkey"',
      'waiting for parent row',
      'not-owner: menu_items is HQ-owned',
    ])
      expect(isContended(m)).toBe(false);
  });

  it('backs off from 100 ms, doubling, capped and jittered', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 9].map((a) => yieldDelayMs(a, mid))).toEqual([
      100, 200, 400, 800, 1600, 1600,
    ]);
    expect(yieldDelayMs(0, () => 0)).toBe(75);
    expect(yieldDelayMs(0, () => 1)).toBe(125);
  });
});

describe('keyForServer (#209 audit)', () => {
  const s = { serverUrl: 'https://hq.example.com', peerKey: 'pk_old' };
  it('re-sends the stored peer key only to the HQ that issued it', () => {
    expect(keyForServer(s, 'https://hq.example.com')).toBe('pk_old');
    expect(keyForServer(s, 'https://hq.example.com//')).toBe('pk_old');
    expect(keyForServer(s, 'https://other.example.com')).toBeNull();
    expect(keyForServer(s, 'http://hq.example.com')).toBeNull();
    expect(keyForServer(s, 'https://hq.example.com.evil.test')).toBeNull();
  });
  it('sends nothing without a stored key or URL', () => {
    expect(
      keyForServer({ serverUrl: null, peerKey: 'pk' }, 'https://a'),
    ).toBeNull();
    expect(
      keyForServer({ serverUrl: 'https://a', peerKey: null }, 'https://a'),
    ).toBeNull();
  });
});
