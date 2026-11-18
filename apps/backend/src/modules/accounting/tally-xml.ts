// TallyPrime voucher import XML (ENVELOPE/TALLYMESSAGE). Pure: no database.
// Prices are tax-inclusive, so tax is backed out of what was actually
// charged (after discounts) using the same maths as the GST report.
import type { TallyLedgerKey } from '@nventra/types';
import { gstSummary, round2 } from './accounting.calc';

export interface TallyOrderInput {
  id: string;
  orderNumber: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  subtotal: number;
  discountAmount: number;
  loyaltyDiscountAmount: number;
  totalAmount: number;
  items: { lineTotal: number; taxRatePercent: number }[];
  payments: { id: string; method: string; amount: number }[];
}

export interface TallyRefundInput {
  id: string;
  orderNumber: string;
  date: string;
  amount: number;
  method: string;
  /** Tax and total of the refunded order, to split the refund pro rata. */
  orderTax: number;
  orderTotal: number;
}

export interface TallyTotals {
  orders: number;
  salesTotal: number;
  taxable: number;
  tax: number;
  receipts: number;
  refunds: number;
}

type Mapping = Record<TallyLedgerKey, string>;

export function escapeXml(v: string): string {
  return (
    v
      // eslint-disable-next-line no-control-regex -- strips XML-illegal characters
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}

const LEDGER_FOR_METHOD: Record<string, TallyLedgerKey> = {
  CASH: 'cash',
  CARD: 'card',
  UPI: 'upi',
  BANK_TRANSFER: 'upi',
  WALLET: 'wallet',
  GIFT_CARD: 'wallet',
  STORE_CREDIT: 'wallet',
  OTHER: 'cash',
};

const tallyDate = (d: string) => d.replace(/-/g, '');
const money = (n: number) => round2(n).toFixed(2);
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Line {
  ledger: string;
  /** Positive = credit, negative = debit. */
  amount: number;
}

function ledgerEntry(l: Line): string {
  // Tally: debit entries are "deemed positive" and carry a negative amount.
  const debit = l.amount < 0;
  return (
    '<ALLLEDGERENTRIES.LIST>' +
    `<LEDGERNAME>${escapeXml(l.ledger)}</LEDGERNAME>` +
    `<ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
    `<AMOUNT>${money(l.amount)}</AMOUNT>` +
    '</ALLLEDGERENTRIES.LIST>'
  );
}

function voucher(v: {
  type: string;
  date: string;
  number: string;
  guid: string;
  party: string;
  narration: string;
  lines: Line[];
}): string {
  return (
    `<TALLYMESSAGE xmlns:UDF="TallyUDF">` +
    `<VOUCHER VCHTYPE="${v.type}" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
    `<DATE>${tallyDate(v.date)}</DATE>` +
    `<GUID>${escapeXml(v.guid)}</GUID>` +
    `<VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME>` +
    `<VOUCHERNUMBER>${escapeXml(v.number)}</VOUCHERNUMBER>` +
    `<PARTYLEDGERNAME>${escapeXml(v.party)}</PARTYLEDGERNAME>` +
    `<NARRATION>${escapeXml(v.narration)}</NARRATION>` +
    v.lines
      .filter((l) => Math.round(l.amount * 100) !== 0)
      .map(ledgerEntry)
      .join('') +
    '</VOUCHER></TALLYMESSAGE>'
  );
}

/** Splits tax between CGST and SGST so the two always add back to `tax`. */
function splitTax(tax: number, m: Mapping): Line[] {
  const half = round2(tax / 2);
  return [
    { ledger: m.cgstOutput, amount: half },
    { ledger: m.sgstOutput, amount: round2(tax - half) },
  ];
}

function orderVouchers(o: TallyOrderInput, m: Mapping, t: TallyTotals) {
  const subtotal = o.subtotal;
  const charged = subtotal - o.discountAmount - o.loyaltyDiscountAmount;
  const factor = subtotal > 0 ? Math.max(0, charged) / subtotal : 1;
  const g = gstSummary(o.items.map((i) => ({ ...i, factor })));
  const total = round2(o.totalAmount);
  const roundOff = round2(total - (g.totalTaxable + g.totalTax));
  t.orders += 1;
  t.salesTotal = round2(t.salesTotal + total);
  t.taxable = round2(t.taxable + g.totalTaxable);
  t.tax = round2(t.tax + g.totalTax);

  const out = [
    voucher({
      type: 'Sales',
      date: o.date,
      number: o.orderNumber,
      guid: `nventra-sale-${o.id}`,
      party: m.partyDefault,
      narration: `POS order ${o.orderNumber}`,
      lines: [
        { ledger: m.partyDefault, amount: -total },
        { ledger: m.sales, amount: g.totalTaxable },
        ...splitTax(g.totalTax, m),
        { ledger: m.roundOff, amount: roundOff },
      ],
    }),
  ];
  const pays = [...o.payments].sort((a, b) => byKey(a.id, b.id));
  pays.forEach((p, i) => {
    t.receipts = round2(t.receipts + p.amount);
    out.push(
      voucher({
        type: 'Receipt',
        date: o.date,
        number: `${o.orderNumber}-R${i + 1}`,
        guid: `nventra-receipt-${p.id}`,
        party: m.partyDefault,
        narration: `Receipt (${p.method}) for order ${o.orderNumber}`,
        lines: [
          {
            ledger: m[LEDGER_FOR_METHOD[p.method] ?? 'cash'],
            amount: -p.amount,
          },
          { ledger: m.partyDefault, amount: p.amount },
        ],
      }),
    );
  });
  return out;
}

function refundVouchers(r: TallyRefundInput, m: Mapping, t: TallyTotals) {
  const tax =
    r.orderTotal > 0 ? round2((r.amount * r.orderTax) / r.orderTotal) : 0;
  t.refunds = round2(t.refunds + r.amount);
  return [
    voucher({
      type: 'Credit Note',
      date: r.date,
      number: `${r.orderNumber}-CN-${r.id.slice(-6)}`,
      guid: `nventra-refund-${r.id}`,
      party: m.partyDefault,
      narration: `Refund for order ${r.orderNumber}`,
      lines: [
        { ledger: m.partyDefault, amount: r.amount },
        { ledger: m.sales, amount: -round2(r.amount - tax) },
        ...splitTax(tax, m).map((l) => ({ ...l, amount: -l.amount })),
      ],
    }),
    voucher({
      type: 'Payment',
      date: r.date,
      number: `${r.orderNumber}-PAY-${r.id.slice(-6)}`,
      guid: `nventra-refund-pay-${r.id}`,
      party: m.partyDefault,
      narration: `Refund paid (${r.method}) for order ${r.orderNumber}`,
      lines: [
        { ledger: m.partyDefault, amount: -r.amount },
        { ledger: m[LEDGER_FOR_METHOD[r.method] ?? 'cash'], amount: r.amount },
      ],
    }),
  ];
}

export function buildTallyXml(input: {
  orders: TallyOrderInput[];
  refunds: TallyRefundInput[];
  mapping: Mapping;
}): { xml: string; totals: TallyTotals } {
  const totals: TallyTotals = {
    orders: 0,
    salesTotal: 0,
    taxable: 0,
    tax: 0,
    receipts: 0,
    refunds: 0,
  };
  const key = (x: { date: string; orderNumber: string; id: string }) =>
    `${x.date}|${x.orderNumber}|${x.id}`;
  const messages = [
    ...[...input.orders]
      .sort((a, b) => byKey(key(a), key(b)))
      .flatMap((o) => orderVouchers(o, input.mapping, totals)),
    ...[...input.refunds]
      .sort((a, b) => byKey(key(a), key(b)))
      .flatMap((r) => refundVouchers(r, input.mapping, totals)),
  ];
  const xml = (
    '<ENVELOPE>' +
    '<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>' +
    '<BODY><IMPORTDATA>' +
    '<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>' +
    `<REQUESTDATA>${messages.join('')}</REQUESTDATA>` +
    '</IMPORTDATA></BODY></ENVELOPE>'
  ).replace(/></g, '>\n<'); // one tag per line; text never contains ><
  return { xml, totals };
}
