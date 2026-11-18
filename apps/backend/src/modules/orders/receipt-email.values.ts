import {
  resolveTaxIdLabel,
  resolveTaxLabel,
  type TaxMode,
  type TaxRegime,
} from '@nventra/types';
import type { TemplateValues } from '../email/templates/markdown';
import {
  CURRENCY_SYMBOLS,
  receiptTotalRows,
  type ReceiptOrder,
} from './receipt.html';

export interface ReceiptEmailBranch {
  gstNumber: string | null;
  taxRegime: TaxRegime;
  taxMode: TaxMode;
  taxLabel: string | null;
  taxId: string | null;
}

/**
 * Placeholder values for the RECEIPT email. Every figure comes from the same
 * order data and the same total rows as the printed receipt, so the email
 * and the paper copy can never disagree. The template only decides the
 * wording around these values.
 *
 * Lines never start with a Markdown list marker, so the summary renders as
 * plain lines in the email.
 */
export function buildReceiptEmailValues({
  currency,
  timeZone,
  branch,
  order,
}: {
  currency: string;
  timeZone: string;
  branch: ReceiptEmailBranch;
  order: ReceiptOrder;
}): TemplateValues {
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const money = (n: number) => `${sym}${Number(n).toFixed(2)}`;
  const taxLabel = resolveTaxLabel(branch.taxRegime, branch.taxLabel);

  const itemLines = order.items.flatMap((item) => [
    `${item.quantity} × ${item.nameSnapshot}: ${money(item.lineTotal)}`,
    ...item.modifiers.map((m) => `   with ${m.nameSnapshot}`),
  ]);
  const totalLines = receiptTotalRows({ branch, taxLabel, order, money }).map(
    ([label, value]) => `${label}: ${value}`,
  );
  const summary = [
    ...itemLines,
    '',
    ...totalLines,
    `Total: ${money(order.totalAmount)}`,
  ].join('\n');

  const taxIdValue =
    branch.taxId ||
    (branch.taxRegime === 'INDIA_GST' ? branch.gstNumber : null);

  return {
    'customer.name': order.customer?.name || 'Guest',
    'order.number': `#${order.orderNumber}`,
    'order.date': new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(order.createdAt)),
    'order.total': money(order.totalAmount),
    'order.summary': summary,
    'order.payment': order.payments
      .map((p) => `Paid by ${p.method}: ${money(p.amount)}`)
      .join('\n'),
    'order.taxId': taxIdValue
      ? `${resolveTaxIdLabel(branch.taxRegime)}: ${taxIdValue}`
      : '',
    // There is no public receipt page; an empty link drops the button.
    'receipt.url': '',
  };
}
