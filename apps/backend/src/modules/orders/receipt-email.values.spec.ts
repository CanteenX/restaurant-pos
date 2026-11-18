import { buildReceiptHtml, type ReceiptOrder } from './receipt.html';
import { buildReceiptEmailValues } from './receipt-email.values';

const branch = {
  name: 'Main',
  address: '12 MG Road',
  phone: null,
  gstNumber: '29ABCDE1234F1Z5',
  taxRegime: 'INDIA_GST' as const,
  taxMode: 'INCLUSIVE' as const,
  taxLabel: null,
  taxId: null,
};

const order: ReceiptOrder = {
  orderNumber: '1042',
  type: 'DINE_IN',
  createdAt: new Date('2026-11-15T15:12:00Z'),
  table: null,
  customer: { name: 'Asha **Rao**', phone: null },
  subtotal: 1100,
  discountAmount: 110,
  discountPercent: 10,
  taxAmount: 47.14,
  tipAmount: 20,
  loyaltyPointsRedeemed: 0,
  loyaltyDiscountAmount: 0,
  totalAmount: 1010,
  items: [
    {
      nameSnapshot: 'Paneer Tikka',
      quantity: 2,
      unitPriceSnapshot: 300,
      lineTotal: 600,
      taxRateSnapshot: 5,
      modifiers: [{ nameSnapshot: 'Extra mint', priceAdjSnapshot: 0 }],
    },
    {
      nameSnapshot: 'Biryani',
      quantity: 1,
      unitPriceSnapshot: 500,
      lineTotal: 500,
      taxRateSnapshot: 5,
      modifiers: [],
    },
  ],
  payments: [
    { method: 'CASH', amount: 1010, tendered: 1100, changeGiven: 90 },
  ],
};

const values = () =>
  buildReceiptEmailValues({
    currency: 'INR',
    timeZone: 'Asia/Kolkata',
    branch,
    order,
  });

describe('buildReceiptEmailValues', () => {
  it('uses the stored totals untouched', () => {
    const v = values();
    expect(v['order.total']).toBe('₹1010.00');
    expect(v['order.number']).toBe('#1042');
    expect(v['order.summary']).toContain('2 × Paneer Tikka');
    expect(v['order.summary']).toContain('₹600.00');
    expect(v['order.summary']).toContain('Biryani');
    expect(v['order.summary']).toContain('₹500.00');
    expect(v['order.summary']).toContain('Subtotal: ₹1100.00');
    expect(v['order.summary']).toContain('Discount (10%): - ₹110.00');
    expect(v['order.summary']).toContain('Tip: ₹20.00');
    expect(v['order.summary']).toContain('Total: ₹1010.00');
  });

  it('shows the same tax rows as the printed receipt', () => {
    const v = values();
    const html = buildReceiptHtml({
      restaurantName: 'Spice',
      currency: 'INR',
      branch,
      order,
    });
    // The printed receipt splits GST into CGST/SGST; so must the email.
    for (const row of ['CGST (incl.)', 'SGST (incl.)']) {
      expect(html).toContain(row);
      expect(v['order.summary']).toContain(row);
    }
    expect(v['order.summary']).toContain('CGST (incl.): ₹23.57');
    expect(v['order.summary']).toContain('SGST (incl.): ₹23.57');
  });

  it('lists payments and the tax id, and names the customer', () => {
    const v = values();
    expect(v['order.payment']).toBe('Paid by CASH: ₹1010.00');
    expect(v['order.taxId']).toBe('GSTIN: 29ABCDE1234F1Z5');
    expect(v['customer.name']).toBe('Asha **Rao**');
    expect(v['order.date']).toContain('2026');
  });

  it('never starts a line with a Markdown list marker', () => {
    const lines = values()['order.summary'].split('\n');
    expect(lines.some((l) => /^\s*[-*+]\s/.test(l))).toBe(false);
    expect(lines.some((l) => /^\s*\d+[.)]\s/.test(l))).toBe(false);
  });

  it('leaves the receipt link empty (there is no public receipt page)', () => {
    expect(values()['receipt.url']).toBe('');
  });

  it('falls back to Guest and an empty tax id', () => {
    const v = buildReceiptEmailValues({
      currency: 'INR',
      timeZone: 'Asia/Kolkata',
      branch: { ...branch, gstNumber: null },
      order: { ...order, customer: null },
    });
    expect(v['customer.name']).toBe('Guest');
    expect(v['order.taxId']).toBe('');
  });
});
