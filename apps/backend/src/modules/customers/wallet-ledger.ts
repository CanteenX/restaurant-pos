import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { round2 } from '../orders/pricing';

export interface WalletEntryInput {
  customerId: string;
  /** Signed: + credit, - spend. */
  delta: number;
  reason: 'REFUND_CREDIT' | 'OPENING';
  refundId?: string;
  orderId?: string;
  /** Unique per business event, so a retried request books it once. */
  idempotencyKey: string;
}

/**
 * Books a store-credit change (#82). The customer row is locked, the entry
 * is appended, and walletBalance is set to the rounded sum of the ledger: a
 * read-modify-write `set` under the row lock, never `increment`, so the
 * cached balance always equals its ledger (and sync can recompute it the
 * same way on another install, see sync/derived.ts). Returns the balance.
 */
export async function addWalletEntry(
  tx: Prisma.TransactionClient,
  e: WalletEntryInput,
): Promise<number> {
  // The entry belongs to the customer's branch, which owns it for sync.
  const locked = await tx.$queryRaw<{ id: string; branchId: string }[]>`
    SELECT id, "branchId" FROM customers WHERE id = ${e.customerId} FOR UPDATE`;
  if (!locked.length) throw new NotFoundException('Customer not found');
  const delta = round2(e.delta);
  if (delta !== 0) {
    await tx.customerWalletEntry.createMany({
      data: [
        {
          customerId: e.customerId,
          branchId: locked[0].branchId,
          delta,
          reason: e.reason,
          refundId: e.refundId,
          orderId: e.orderId,
          idempotencyKey: e.idempotencyKey,
        },
      ],
      skipDuplicates: true,
    });
  }
  const sum = await tx.customerWalletEntry.aggregate({
    where: { customerId: e.customerId },
    _sum: { delta: true },
  });
  const balance = round2(Number(sum._sum.delta ?? 0));
  await tx.customer.update({
    where: { id: e.customerId },
    data: { walletBalance: balance },
  });
  return balance;
}
