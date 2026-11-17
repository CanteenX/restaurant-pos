import type { EscposReceiptOrder } from './escpos-receipt';
import type { OrdersService } from './orders.service';

export type ReceiptData = Awaited<ReturnType<OrdersService['getReceiptData']>>;

// Figures that replace the stored ones on a printed bill (an open order's
// bill is priced from what the cashier entered, not from what is saved yet).
export type BillOverrides = {
  subtotal: number;
  discountAmount: number;
  discountPercent: number;
  taxAmount: number;
  tipAmount: number;
  loyaltyPointsRedeemed: number;
  loyaltyDiscountAmount: number;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  isProvisional: boolean;
};

/** The order as the printed receipt shows it (shared by print and email). */
export function toEscposOrder(
  order: ReceiptData,
  overrides?: BillOverrides,
): EscposReceiptOrder {
  return {
    orderNumber: order.orderNumber,
    type: order.type,
    createdAt: order.createdAt,
    table: order.table
      ? { label: order.table.name ?? `#${order.table.number}` }
      : null,
    customer: order.customer
      ? { name: order.customer.name ?? 'Guest', phone: order.customer.phone }
      : null,
    subtotal: Number(order.subtotal),
    discountAmount: Number(order.discountAmount),
    taxAmount: Number(order.taxAmount),
    tipAmount: Number(order.tipAmount),
    loyaltyPointsRedeemed: order.loyaltyPointsRedeemed,
    loyaltyDiscountAmount: Number(order.loyaltyDiscountAmount),
    totalAmount: Number(order.totalAmount),
    ...overrides,
    items: order.items.map((item) => ({
      nameSnapshot: item.nameSnapshot,
      quantity: item.quantity,
      unitPriceSnapshot: Number(item.unitPriceSnapshot),
      lineTotal: Number(item.lineTotal),
      taxRateSnapshot: Number(item.taxRateSnapshot),
      modifiers: item.modifiers.map((m) => ({
        nameSnapshot: m.nameSnapshot,
        priceAdjSnapshot: Number(m.priceAdjSnapshot),
      })),
    })),
    payments: order.payments.map((p) => ({
      method: p.method,
      amount: Number(p.amount),
      tendered: p.tendered ? Number(p.tendered) : null,
      changeGiven: p.changeGiven ? Number(p.changeGiven) : null,
    })),
  };
}
