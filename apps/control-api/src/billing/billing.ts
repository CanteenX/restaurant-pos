import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import type { billingInvoiceInput, billingPaymentInput } from '@nventra/types/dist/control-billing';
import { Prisma, type BillingPayment } from '../../node_modules/.prisma/control-client/index.js';

type Tx = Prisma.TransactionClient;
type Page = { cursor?: string; limit: number };
type Invoice = {
  id: string; businessId: string; reference: string; description: string; dueOn: string;
  amountPaise: bigint; paidPaise: bigint; balancePaise: bigint; createdAt: Date; overdue: boolean
};

function pageOf<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
}

async function invoiceRows(tx: Tx, page: Page, scope: { businessId?: string; id?: string; overdue?: boolean }) {
  const filters = [Prisma.sql`TRUE`];
  if (scope.businessId) filters.push(Prisma.sql`i.business_id=${scope.businessId}::uuid`);
  if (scope.id) filters.push(Prisma.sql`i.id=${scope.id}::uuid`);
  if (page.cursor) filters.push(Prisma.sql`i.id>${page.cursor}::uuid`);
  const rows = await tx.$queryRaw<Invoice[]>`WITH balances AS (
    SELECT i.id,i.business_id AS "businessId",i.reference,i.description,i.created_at AS "createdAt",to_char(i.due_on,'YYYY-MM-DD') AS "dueOn",
      i.amount_paise AS "amountPaise",p.paid AS "paidPaise",(i.amount_paise-p.paid) AS "balancePaise",
      (i.due_on < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date AND i.amount_paise>p.paid) AS overdue
    FROM control.billing_invoice i CROSS JOIN LATERAL (
      SELECT coalesce(sum(amount_paise),0)::bigint AS paid FROM control.billing_payment WHERE invoice_id=i.id
    ) p WHERE ${Prisma.join(filters, ' AND ')}
  ) SELECT * FROM balances WHERE ${scope.overdue ? Prisma.sql`overdue` : Prisma.sql`TRUE`} ORDER BY id LIMIT ${page.limit + 1}`;
  return pageOf(rows.map(row => ({
    ...row, amountPaise: Number(row.amountPaise), paidPaise: Number(row.paidPaise),
    balancePaise: Number(row.balancePaise)
  })), page.limit);
}

async function businessExists(tx: Tx, businessId: string) {
  if (!await tx.business.findUnique({ where: { id: businessId }, select: { id: true } })) throw new NotFoundException();
}

export async function listBusinessInvoices(tx: Tx, businessId: string, page: Page) {
  await businessExists(tx, businessId);
  return invoiceRows(tx, page, { businessId });
}

export function listOverdueInvoices(tx: Tx, page: Page, businessId?: string) {
  return invoiceRows(tx, page, { businessId, overdue: true });
}

function projectPayment(row: BillingPayment) {
  return {
    id: row.id, businessId: row.businessId, invoiceId: row.invoiceId, reference: row.reference,
    method: row.method, amountPaise: Number(row.amountPaise), createdAt: row.createdAt
  };
}

export async function listInvoicePayments(tx: Tx, businessId: string, invoiceId: string, page: Page) {
  if (!await tx.billingInvoice.findUnique({ where: { businessId_id: { businessId, id: invoiceId } }, select: { id: true } })) throw new NotFoundException();
  const rows = await tx.billingPayment.findMany({
    where: { businessId, invoiceId, id: { gt: page.cursor } },
    orderBy: { id: 'asc' }, take: page.limit + 1
  });
  return pageOf(rows.map(projectPayment), page.limit);
}

export async function issueInvoice(tx: Tx, businessId: string, createdBy: string, input: z.infer<typeof billingInvoiceInput>) {
  const [parent] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM control.business WHERE id=${businessId}::uuid FOR UPDATE`;
  if (!parent) throw new NotFoundException();
  const { requestKey, reference, description, dueOn, amountPaise } = input;
  const existing = await tx.billingInvoice.findUnique({ where: { businessId_requestKey: { businessId, requestKey } } });
  const id = existing?.id ?? randomUUID();
  if (existing) {
    if (existing.createdBy !== createdBy || existing.reference !== reference || existing.description !== description ||
      existing.dueOn.toISOString().slice(0, 10) !== dueOn || existing.amountPaise !== BigInt(amountPaise)) throw new ConflictException();
  } else {
    await tx.billingInvoice.create({
      data: {
        id, businessId, createdBy, requestKey, reference, description,
        amountPaise: BigInt(amountPaise), dueOn: new Date(dueOn + 'T00:00:00Z')
      }, select: { id: true }
    });
  }
  return (await invoiceRows(tx, { limit: 1 }, { businessId, id })).items[0];
}

export async function recordPayment(tx: Tx, businessId: string, invoiceId: string, createdBy: string, input: z.infer<typeof billingPaymentInput>) {
  await tx.$executeRaw`SELECT control.lock_billing_payments(${invoiceId}::uuid)`;
  const [invoice] = (await invoiceRows(tx, { limit: 1 }, { businessId, id: invoiceId })).items;
  if (!invoice) throw new NotFoundException();
  const { requestKey, reference, method, amountPaise } = input;
  const existing = await tx.billingPayment.findUnique({ where: { invoiceId_requestKey: { invoiceId, requestKey } } });
  if (existing) {
    if (existing.createdBy !== createdBy || existing.reference !== reference || existing.method !== method ||
      existing.amountPaise !== BigInt(amountPaise)) throw new ConflictException();
    return projectPayment(existing);
  }
  if (amountPaise > invoice.balancePaise || await tx.billingPayment.findUnique({
    where: { invoiceId_method_reference: { invoiceId, method, reference } }, select: { id: true }
  })) throw new ConflictException();
  const row = await tx.billingPayment.create({ data: { id: randomUUID(), businessId, invoiceId, createdBy, requestKey, reference, method, amountPaise: BigInt(amountPaise) } });
  return projectPayment(row);
}
