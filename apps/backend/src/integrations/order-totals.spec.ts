import { Prisma } from '@prisma/client';
import { computeBill } from '../modules/orders/settlement';
import { orderTotals } from './integrations.service';

const d = (v: number) => new Prisma.Decimal(v);

describe('orderTotals', () => {
  it('includes the tip, so total matches the settled bill', () => {
    const bill = computeBill({
      lines: [{ lineTotal: 200, taxAmount: 9.52 }],
      discountPercent: 10,
      loyaltyDiscountRequested: 5,
      tip: 20,
      deliveryFee: 30,
    });
    const totals = orderTotals({
      subtotal: d(bill.subtotal),
      taxAmount: d(bill.taxAmount),
      discountAmount: d(bill.discountAmount),
      loyaltyDiscountAmount: d(bill.loyaltyDiscountAmount),
      tipAmount: d(bill.tipAmount),
      deliveryFee: d(bill.deliveryFee),
    });
    expect(totals).toMatchObject({ tip: 20, discount: 25, deliveryFee: 30 });
    expect(totals.total).toBe(bill.totalDue); // 200 - 20 - 5 + 20 + 30 = 225
    expect(totals.total).toBe(225);
  });

  it('a ₹200 order with a ₹20 tip totals 220', () => {
    const totals = orderTotals({
      subtotal: d(200),
      taxAmount: d(9.52),
      discountAmount: d(0),
      loyaltyDiscountAmount: d(0),
      tipAmount: d(20),
      deliveryFee: d(0),
    });
    expect(totals).toMatchObject({ subtotal: 200, tip: 20, total: 220 });
  });
});
