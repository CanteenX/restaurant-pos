import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../node_modules/.prisma/control-client/index.js';
import { invoiceRows, pageOf, projectPayment, type PaymentProjection } from '../billing/billing.js';

type Page = { cursor?: string; limit: number };

export function portalInvoices(tx: Prisma.TransactionClient, businessId: string, page: Page) {
  return invoiceRows(tx, page, {businessId}, 'portal');
}

export async function portalPayments(tx: Prisma.TransactionClient, businessId: string, invoiceId: string, page: Page) {
  const [invoice] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM control.portal_invoice
    WHERE business_id=${businessId}::uuid AND id=${invoiceId}::uuid`;
  if (!invoice) throw new NotFoundException();
  const cursor = page.cursor ?? null;
  const rows = await tx.$queryRaw<PaymentProjection[]>`SELECT id, business_id AS "businessId", invoice_id AS "invoiceId",
    reference, method, amount_paise AS "amountPaise", created_at AS "createdAt" FROM control.portal_payment
    WHERE business_id=${businessId}::uuid AND invoice_id=${invoiceId}::uuid AND (${cursor}::uuid IS NULL OR id>${cursor}::uuid)
    ORDER BY id LIMIT ${page.limit + 1}`;
  return pageOf(rows.map(projectPayment), page.limit);
}
