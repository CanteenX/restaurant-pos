import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PurchaseReturnDto } from '@nventra/types';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { round2, round3, round6 } from '../../common/money';

type Tx = Prisma.TransactionClient;

type GrnWithItems = Prisma.GoodsReceiptGetPayload<{
  include: { items: { include: { stockBatch: true } } };
}>;
type GrnItem = GrnWithItems['items'][number];

interface ReturnLine {
  grnItem: GrnItem;
  batchId: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
}

/**
 * Weighted-average cost after a lot leaves stock at its own unit cost — the
 * exact inverse of the goods-receipt formula. Falls back to the old cost when
 * nothing is left or the arithmetic would go negative (stock that drifted
 * below what the batches say), so a return can never zero out or invert the
 * cost basis of what remains.
 */
export function costAfterReturn(
  oldStock: number,
  oldCost: number,
  quantity: number,
  unitCost: number,
): number {
  const newStock = round3(Math.max(0, oldStock) - quantity);
  if (newStock <= 0) return oldCost;
  const value = Math.max(0, oldStock) * oldCost - quantity * unitCost;
  if (value < 0) return oldCost;
  return round6(value / newStock);
}

@Injectable()
export class PurchaseReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listReturns(branchId: string, supplierId?: string) {
    return this.prisma.purchaseReturn.findMany({
      where: { branchId, ...(supplierId ? { supplierId } : {}) },
      include: {
        supplier: { select: { id: true, name: true } },
        goodsReceipt: { select: { id: true, grnNumber: true } },
        createdBy: { select: { id: true, name: true } },
        items: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getReturn(branchId: string, id: string) {
    const ret = await this.prisma.purchaseReturn.findFirst({
      where: { id, branchId },
      include: {
        supplier: true,
        goodsReceipt: { select: { id: true, grnNumber: true } },
        createdBy: { select: { id: true, name: true } },
        items: { include: { ingredient: true } },
      },
    });
    if (!ret) throw new NotFoundException('Purchase return not found');
    return ret;
  }

  // Sends goods back against one GRN. Inside a single transaction it locks
  // every touched ingredient row (in a fixed order, so two returns can't
  // deadlock), re-reads earlier returns and batch balances, and only then
  // deducts — so two concurrent returns of the same lot cannot both pass
  // the "not more than received / still in stock" checks. Balances are
  // rounded read-then-set, never a DB `increment`.
  async createReturn(branchId: string, userId: string, dto: PurchaseReturnDto) {
    const grn = await this.prisma.goodsReceipt.findFirst({
      where: { id: dto.goodsReceiptId, branchId },
      include: { items: { include: { stockBatch: true } } },
    });
    if (!grn) throw new NotFoundException('Goods receipt not found');
    const requested = this.requestedByItem(grn, dto);

    const result = await this.prisma.$transaction(async (tx) => {
      const ingredientIds = [
        ...new Set([...requested.keys()].map((i) => i.ingredientId)),
      ].sort();
      for (const id of ingredientIds) {
        await tx.$queryRaw`SELECT id FROM ingredients WHERE id = ${id} FOR UPDATE`;
      }
      const lines = await this.validateLines(tx, requested);
      const totalAmount = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
      const count = await tx.purchaseReturn.count({ where: { branchId } });
      const returnNumber = `DN-${String(count + 1).padStart(4, '0')}`;

      const ret = await tx.purchaseReturn.create({
        data: {
          branchId,
          supplierId: grn.supplierId,
          goodsReceiptId: grn.id,
          returnNumber,
          reason: dto.reason,
          notes: dto.notes,
          totalAmount,
          createdById: userId,
          items: {
            create: lines.map((l) => ({
              goodsReceiptItemId: l.grnItem.id,
              ingredientId: l.grnItem.ingredientId,
              stockBatchId: l.batchId,
              quantity: l.quantity,
              unitCost: l.unitCost,
              lineTotal: l.lineTotal,
            })),
          },
        },
      });
      const note = `Return ${returnNumber} (${grn.grnNumber})`;
      for (const line of lines) {
        await this.deductStock(tx, branchId, userId, line, note);
      }
      return { ret, returnNumber, totalAmount, lines };
    });

    await this.audit.record({
      userId,
      action: 'purchase_return.created',
      entity: 'PurchaseReturn',
      entityId: result.ret.id,
      metadata: {
        returnNumber: result.returnNumber,
        goodsReceiptId: grn.id,
        supplierId: grn.supplierId,
        reason: dto.reason,
        totalAmount: result.totalAmount,
        lines: result.lines.length,
      },
    });

    return this.prisma.purchaseReturn.findUniqueOrThrow({
      where: { id: result.ret.id },
      include: { items: { include: { ingredient: true } } },
    });
  }

  // Payable to the supplier, derived from the records rather than a stored
  // running total so it can never drift: non-cancelled invoices, minus what
  // was paid against them, minus debit notes. Negative = supplier owes us.
  async getSupplierBalance(branchId: string, supplierId: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, branchId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const [invoices, returns] = await Promise.all([
      this.prisma.supplierInvoice.aggregate({
        where: { branchId, supplierId, status: { not: 'CANCELLED' } },
        _sum: { totalAmount: true, amountPaid: true },
      }),
      this.prisma.purchaseReturn.aggregate({
        where: { branchId, supplierId },
        _sum: { totalAmount: true },
      }),
    ]);
    const invoiced = round2(Number(invoices._sum.totalAmount ?? 0));
    const paid = round2(Number(invoices._sum.amountPaid ?? 0));
    const returned = round2(Number(returns._sum.totalAmount ?? 0));
    return {
      supplierId,
      invoiced,
      paid,
      returned,
      balance: round2(invoiced - paid - returned),
    };
  }

  // Merges duplicate lines per GRN item and rejects lines from another GRN.
  private requestedByItem(grn: GrnWithItems, dto: PurchaseReturnDto) {
    const requested = new Map<GrnItem, number>();
    for (const line of dto.items) {
      const item = grn.items.find((i) => i.id === line.goodsReceiptItemId);
      if (!item) {
        throw new BadRequestException(
          `Item ${line.goodsReceiptItemId} is not on goods receipt ${grn.grnNumber}`,
        );
      }
      requested.set(item, round3((requested.get(item) ?? 0) + line.quantity));
    }
    for (const [item, quantity] of requested) {
      if (quantity <= 0) {
        throw new BadRequestException(
          `Return quantity for item ${item.id} rounds to 0 — use at least 0.001`,
        );
      }
    }
    return requested;
  }

  private async validateLines(
    tx: Tx,
    requested: Map<GrnItem, number>,
  ): Promise<ReturnLine[]> {
    const items = [...requested.keys()];
    const prior = await tx.purchaseReturnItem.groupBy({
      by: ['goodsReceiptItemId'],
      where: { goodsReceiptItemId: { in: items.map((i) => i.id) } },
      _sum: { quantity: true },
    });
    const lines: ReturnLine[] = [];
    for (const [grnItem, quantity] of requested) {
      const already = Number(
        prior.find((p) => p.goodsReceiptItemId === grnItem.id)?._sum.quantity ??
          0,
      );
      const returnable = round3(Number(grnItem.quantity) - already);
      if (quantity > returnable) {
        throw new BadRequestException(
          `Cannot return ${quantity} — received ${Number(grnItem.quantity)}, only ${returnable} left to return on this line`,
        );
      }
      const batch = grnItem.stockBatch
        ? await tx.stockBatch.findUnique({
            where: { id: grnItem.stockBatch.id },
          })
        : null;
      const inStock = batch ? Number(batch.quantityRemaining) : 0;
      if (!batch || quantity > inStock) {
        throw new BadRequestException(
          `Cannot return ${quantity} — only ${inStock} of this batch is still in stock`,
        );
      }
      // Same 6dp scale as the GRN line and costPerUnit (#193), so per-gram
      // costs survive the round trip into the debit note unchanged.
      const unitCost = round6(Number(grnItem.unitCost));
      lines.push({
        grnItem,
        batchId: batch.id,
        quantity,
        unitCost,
        lineTotal: round2(quantity * unitCost),
      });
    }
    return lines;
  }

  private async deductStock(
    tx: Tx,
    branchId: string,
    userId: string,
    line: ReturnLine,
    note: string,
  ) {
    const batch = await tx.stockBatch.findUnique({
      where: { id: line.batchId },
    });
    await tx.stockBatch.update({
      where: { id: line.batchId },
      data: {
        quantityRemaining: round3(
          Number(batch!.quantityRemaining) - line.quantity,
        ),
      },
    });
    await tx.stockMovement.create({
      data: {
        branchId,
        ingredientId: line.grnItem.ingredientId,
        batchId: line.batchId,
        type: 'PURCHASE_RETURN',
        quantity: -line.quantity,
        note,
        createdById: userId,
      },
    });
    const ingredient = await tx.ingredient.findUnique({
      where: { id: line.grnItem.ingredientId },
    });
    const oldStock = Number(ingredient!.currentStock);
    const oldCost = Number(ingredient!.costPerUnit);
    await tx.ingredient.update({
      where: { id: line.grnItem.ingredientId },
      data: {
        currentStock: round3(oldStock - line.quantity),
        costPerUnit: costAfterReturn(
          oldStock,
          oldCost,
          line.quantity,
          line.unitCost,
        ),
      },
    });
  }
}
