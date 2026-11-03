import { readFileSync } from 'fs';
import { join } from 'path';
import { TALLY_LEDGER_DEFAULTS } from '@nventra/types';
import {
  buildTallyXml,
  escapeXml,
  type TallyOrderInput,
  type TallyRefundInput,
} from './tally-xml';

const M = TALLY_LEDGER_DEFAULTS;
const golden = (n: string) =>
  readFileSync(join(__dirname, '__golden__', n), 'utf8').trimEnd();

// Tax-inclusive 118.00 @18% -> taxable 100.00, tax 18.00 (9 + 9).
const plain: TallyOrderInput = {
  id: 'o1',
  orderNumber: 'A-001',
  date: '2026-11-03',
  subtotal: 118,
  discountAmount: 0,
  loyaltyDiscountAmount: 0,
  totalAmount: 118,
  items: [{ lineTotal: 118, taxRatePercent: 18 }],
  payments: [{ id: 'p1', method: 'CASH', amount: 118 }],
};
// 236 gross, 36 discount -> charged 200; factor .847457..; tax 30.51
const discounted: TallyOrderInput = {
  id: 'o2',
  orderNumber: 'A-002',
  date: '2026-11-03',
  subtotal: 236,
  discountAmount: 36,
  loyaltyDiscountAmount: 0,
  totalAmount: 200,
  items: [{ lineTotal: 236, taxRatePercent: 18 }],
  payments: [
    { id: 'p2', method: 'CASH', amount: 50 },
    { id: 'p3', method: 'UPI', amount: 150 },
  ],
};
const refund: TallyRefundInput = {
  id: 'r1',
  orderNumber: 'A-001',
  date: '2026-11-03',
  amount: 59,
  method: 'CASH',
  orderTax: 18,
  orderTotal: 118,
};

/** Minimal structural check of Tally's import envelope. */
function assertTallyStructure(xml: string) {
  expect(xml.startsWith('<ENVELOPE>')).toBe(true);
  expect(xml.endsWith('</ENVELOPE>')).toBe(true);
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Z][A-Z0-9.]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) expect(stack.pop()).toBe(name);
    else stack.push(name);
  }
  expect(stack).toEqual([]);
  expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
  expect(xml).toContain('<REPORTNAME>Vouchers</REPORTNAME>');
  // Every voucher balances: ledger amounts sum to zero.
  for (const v of xml.split('<VOUCHER ').slice(1)) {
    const sum = [...v.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].reduce(
      (s, a) => s + Number(a[1]),
      0,
    );
    expect(Math.abs(Math.round(sum * 100))).toBe(0);
  }
}

describe('escapeXml', () => {
  it('escapes markup characters and strips control characters', () => {
    expect(escapeXml(`a<b>&"c"'d'\u0001`)).toBe(
      'a&lt;b&gt;&amp;&quot;c&quot;&apos;d&apos;',
    );
  });
});

describe('buildTallyXml', () => {
  it('matches the golden file for a tax-inclusive order', () => {
    const { xml } = buildTallyXml({ orders: [plain], refunds: [], mapping: M });
    assertTallyStructure(xml);
    expect(xml).toBe(golden('plain.xml'));
  });

  it('matches the golden file for a discounted split-tender order', () => {
    const { xml } = buildTallyXml({
      orders: [discounted],
      refunds: [],
      mapping: M,
    });
    assertTallyStructure(xml);
    expect(xml).toBe(golden('discount-split.xml'));
  });

  it('matches the golden file for a refund (credit note + payment)', () => {
    const { xml } = buildTallyXml({
      orders: [],
      refunds: [refund],
      mapping: M,
    });
    assertTallyStructure(xml);
    expect(xml).toBe(golden('refund.xml'));
  });

  it('orders vouchers deterministically regardless of input order', () => {
    const a = buildTallyXml({
      orders: [discounted, plain],
      refunds: [refund],
      mapping: M,
    });
    const b = buildTallyXml({
      orders: [plain, discounted],
      refunds: [refund],
      mapping: M,
    });
    expect(a.xml).toBe(b.xml);
  });

  it('totals equal the GST report for the same orders', () => {
    const { totals } = buildTallyXml({
      orders: [plain, discounted],
      refunds: [],
      mapping: M,
    });
    expect(totals.salesTotal).toBe(318);
    expect(totals.tax).toBeCloseTo(48.51, 2);
    expect(totals.taxable).toBeCloseTo(269.49, 2);
    expect(totals.receipts).toBe(318);
  });

  it('uses mapped ledger names and escapes them', () => {
    const { xml } = buildTallyXml({
      orders: [plain],
      refunds: [],
      mapping: { ...M, sales: 'Food "Sales"', cash: "Till's Cash" },
    });
    expect(xml).toContain('Food &quot;Sales&quot;');
    expect(xml).toContain('Till&apos;s Cash');
  });

  it('books a round-off line when total differs from the lines', () => {
    const { xml } = buildTallyXml({
      orders: [{ ...plain, totalAmount: 118.4 }],
      refunds: [],
      mapping: M,
    });
    assertTallyStructure(xml);
    expect(xml).toContain(`<LEDGERNAME>${M.roundOff}</LEDGERNAME>`);
  });
});
