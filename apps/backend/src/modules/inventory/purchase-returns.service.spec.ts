import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  PurchaseReturnsService,
  costAfterReturn,
} from './purchase-returns.service';

// GRN-0001: 10 kg flour at 12.345/kg (batch b1, 10 left) and 5 l oil at 100/l
// (batch b2, only 2 left because 3 were already consumed).
const grn = () => ({
  id: 'g1',
  branchId: 'br1',
  supplierId: 's1',
  grnNumber: 'GRN-0001',
  items: [
    {
      id: 'gi1',
      ingredientId: 'flour',
      quantity: 10,
      unitCost: 12.345,
      stockBatch: { id: 'b1' },
    },
    {
      id: 'gi2',
      ingredientId: 'oil',
      quantity: 5,
      unitCost: 100,
      stockBatch: { id: 'b2' },
    },
  ],
});

const setup = () => {
  const batches: Record<string, { id: string; quantityRemaining: number }> = {
    b1: { id: 'b1', quantityRemaining: 10 },
    b2: { id: 'b2', quantityRemaining: 2 },
  };
  const ingredients: Record<string, object> = {
    flour: { id: 'flour', name: 'Flour', currentStock: 10, costPerUnit: 12 },
    oil: { id: 'oil', name: 'Oil', currentStock: 2, costPerUnit: 100 },
  };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
    goodsReceipt: { findFirst: jest.fn().mockResolvedValue(grn()) },
    supplier: { findFirst: jest.fn().mockResolvedValue({ id: 's1' }) },
    supplierInvoice: { aggregate: jest.fn() },
    purchaseReturn: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'pr1' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'pr1' }),
      aggregate: jest.fn(),
    },
    purchaseReturnItem: { groupBy: jest.fn().mockResolvedValue([]) },
    stockBatch: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(batches[where.id] ?? null),
      ),
      update: jest.fn(),
    },
    ingredient: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(ingredients[where.id]),
      ),
      update: jest.fn(),
    },
    stockMovement: { create: jest.fn() },
  };
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
    cb(prisma),
  );
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new PurchaseReturnsService(prisma as never, audit as never);
  return { prisma, audit, svc };
};

const dto = (items: { goodsReceiptItemId: string; quantity: number }[]) => ({
  goodsReceiptId: 'g1',
  reason: 'DAMAGED' as const,
  items,
});

describe('PurchaseReturnsService.createReturn', () => {
  it('only looks up the goods receipt inside the caller branch', async () => {
    const { prisma, svc } = setup();
    prisma.goodsReceipt.findFirst.mockResolvedValue(null);
    await expect(
      svc.createReturn(
        'br1',
        'u1',
        dto([{ goodsReceiptItemId: 'gi1', quantity: 1 }]),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.goodsReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'g1', branchId: 'br1' } }),
    );
  });

  it('rejects a line that is not on that goods receipt', async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.createReturn(
        'br1',
        'u1',
        dto([{ goodsReceiptItemId: 'other', quantity: 1 }]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.purchaseReturn.create).not.toHaveBeenCalled();
  });

  it('rejects a line whose quantity rounds to zero', async () => {
    const { svc, prisma } = setup();
    await expect(
      svc.createReturn(
        'br1',
        'u1',
        dto([{ goodsReceiptItemId: 'gi1', quantity: 0.0004 }]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.purchaseReturn.create).not.toHaveBeenCalled();
  });

  it('cannot return more than was received', async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.createReturn(
        'br1',
        'u1',
        dto([{ goodsReceiptItemId: 'gi1', quantity: 10.001 }]),
      ),
    ).rejects.toThrow(/received/);
    expect(prisma.stockBatch.update).not.toHaveBeenCalled();
    expect(prisma.ingredient.update).not.toHaveBeenCalled();
  });

  it('counts earlier returns against the received quantity', async () => {
    const { prisma, svc } = setup();
    prisma.purchaseReturnItem.groupBy.mockResolvedValue([
      { goodsReceiptItemId: 'gi1', _sum: { quantity: 8 } },
    ]);
    await expect(
      svc.createReturn(
        'br1',
        'u1',
        dto([{ goodsReceiptItemId: 'gi1', quantity: 3 }]),
      ),
    ).rejects.toThrow(/only 2 /);
    expect(prisma.purchaseReturn.create).not.toHaveBeenCalled();
  });

  it('adds up duplicate lines for the same receipt item before checking', async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.createReturn(
        'br1',
        'u1',
        dto([
          { goodsReceiptItemId: 'gi1', quantity: 6 },
          { goodsReceiptItemId: 'gi1', quantity: 5 },
        ]),
      ),
    ).rejects.toThrow(/received/);
    expect(prisma.purchaseReturn.create).not.toHaveBeenCalled();
  });

  it('cannot return stock from the batch that was already used', async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.createReturn(
        'br1',
        'u1',
        dto([{ goodsReceiptItemId: 'gi2', quantity: 3 }]),
      ),
    ).rejects.toThrow(/in stock/);
    expect(prisma.purchaseReturn.create).not.toHaveBeenCalled();
  });

  it('locks the ingredient rows before reading earlier returns', async () => {
    const { prisma, svc } = setup();
    await svc.createReturn(
      'br1',
      'u1',
      dto([{ goodsReceiptItemId: 'gi1', quantity: 1 }]),
    );
    const lockOrder = prisma.$queryRaw.mock.invocationCallOrder[0];
    const readOrder =
      prisma.purchaseReturnItem.groupBy.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(readOrder);
  });

  it('deducts the batch and ingredient stock and writes a debit note', async () => {
    const { prisma, audit, svc } = setup();
    await svc.createReturn(
      'br1',
      'u1',
      dto([
        { goodsReceiptItemId: 'gi1', quantity: 4 },
        { goodsReceiptItemId: 'gi2', quantity: 2 },
      ]),
    );

    const created = prisma.purchaseReturn.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      branchId: 'br1',
      supplierId: 's1',
      goodsReceiptId: 'g1',
      returnNumber: 'DN-0001',
      reason: 'DAMAGED',
      createdById: 'u1',
      // 4 x 12.345 = 49.38, 2 x 100 = 200 -> server-side value, never client.
      totalAmount: 249.38,
    });
    expect(created.items.create).toEqual([
      expect.objectContaining({
        goodsReceiptItemId: 'gi1',
        ingredientId: 'flour',
        stockBatchId: 'b1',
        quantity: 4,
        unitCost: 12.345,
        lineTotal: 49.38,
      }),
      expect.objectContaining({ goodsReceiptItemId: 'gi2', lineTotal: 200 }),
    ]);

    expect(prisma.stockBatch.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { quantityRemaining: 6 },
    });
    expect(prisma.stockBatch.update).toHaveBeenCalledWith({
      where: { id: 'b2' },
      data: { quantityRemaining: 0 },
    });
    expect(prisma.ingredient.update).toHaveBeenCalledWith({
      where: { id: 'flour' },
      data: {
        currentStock: 6,
        costPerUnit: costAfterReturn(10, 12, 4, 12.345),
      },
    });
    expect(prisma.ingredient.update).toHaveBeenCalledWith({
      where: { id: 'oil' },
      data: { currentStock: 0, costPerUnit: 100 },
    });
    expect(prisma.stockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        branchId: 'br1',
        ingredientId: 'flour',
        batchId: 'b1',
        type: 'PURCHASE_RETURN',
        quantity: -4,
        note: 'Return DN-0001 (GRN-0001)',
        createdById: 'u1',
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'purchase_return.created',
        entity: 'PurchaseReturn',
        entityId: 'pr1',
        metadata: expect.objectContaining({ totalAmount: 249.38 }),
      }),
    );
  });

  it('numbers debit notes per branch', async () => {
    const { prisma, svc } = setup();
    prisma.purchaseReturn.count.mockResolvedValue(41);
    await svc.createReturn(
      'br1',
      'u1',
      dto([{ goodsReceiptItemId: 'gi1', quantity: 1 }]),
    );
    expect(prisma.purchaseReturn.count).toHaveBeenCalledWith({
      where: { branchId: 'br1' },
    });
    expect(
      prisma.purchaseReturn.create.mock.calls[0][0].data.returnNumber,
    ).toBe('DN-0042');
  });

  it('does not audit a rejected return', async () => {
    const { audit, svc } = setup();
    await expect(
      svc.createReturn(
        'br1',
        'u1',
        dto([{ goodsReceiptItemId: 'gi1', quantity: 99 }]),
      ),
    ).rejects.toThrow();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('costAfterReturn', () => {
  it('removes the returned lot at its own cost from the weighted average', () => {
    // 10 @ 12 = 120; minus 4 @ 15 = 60 -> 60 / 6 = 10
    expect(costAfterReturn(10, 12, 4, 15)).toBe(10);
  });
  it('keeps the old cost when nothing is left', () => {
    expect(costAfterReturn(4, 12, 4, 15)).toBe(12);
  });
  it('never produces a negative cost', () => {
    expect(costAfterReturn(5, 1, 4, 100)).toBe(1);
  });
});

describe('PurchaseReturnsService.getSupplierBalance', () => {
  it('is invoiced minus paid minus debit notes', async () => {
    const { prisma, svc } = setup();
    prisma.supplierInvoice.aggregate.mockResolvedValue({
      _sum: { totalAmount: 1000, amountPaid: 300.1 },
    });
    prisma.purchaseReturn.aggregate.mockResolvedValue({
      _sum: { totalAmount: 49.38 },
    });
    await expect(svc.getSupplierBalance('br1', 's1')).resolves.toEqual({
      supplierId: 's1',
      invoiced: 1000,
      paid: 300.1,
      returned: 49.38,
      balance: 650.52,
    });
    expect(prisma.supplierInvoice.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          branchId: 'br1',
          supplierId: 's1',
          status: { not: 'CANCELLED' },
        },
      }),
    );
  });

  it('is zero for a supplier with no history', async () => {
    const { prisma, svc } = setup();
    prisma.supplierInvoice.aggregate.mockResolvedValue({
      _sum: { totalAmount: null, amountPaid: null },
    });
    prisma.purchaseReturn.aggregate.mockResolvedValue({
      _sum: { totalAmount: null },
    });
    const res = await svc.getSupplierBalance('br1', 's1');
    expect(res.balance).toBe(0);
  });

  it('404s for a supplier outside the branch', async () => {
    const { prisma, svc } = setup();
    prisma.supplier.findFirst.mockResolvedValue(null);
    await expect(svc.getSupplierBalance('br1', 's9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.supplier.findFirst).toHaveBeenCalledWith({
      where: { id: 's9', branchId: 'br1' },
    });
  });
});
