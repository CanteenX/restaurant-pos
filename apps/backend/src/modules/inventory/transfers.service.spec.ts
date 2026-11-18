import { TransfersService } from './transfers.service';
import type { StockService } from './stock.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Transfers must keep the 6dp cost scale (#69): a per-gram cost converted from
// a per-kg price (₹33.33/kg -> 0.03333/g) must not be re-truncated to 4dp at
// the destination branch.
const dataOf = (fn: jest.Mock) =>
  (fn.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

describe('TransfersService cost precision', () => {
  const setup = (
    dest: { currentStock: number; costPerUnit: number } | null,
  ) => {
    const source = {
      id: 'ing-src',
      name: 'Flour',
      sku: null,
      unit: 'G',
      reorderLevel: 0,
    };
    const destRow = {
      id: 'ing-dst',
      unit: 'G',
      currentStock: dest?.currentStock ?? 0,
      costPerUnit: dest?.costPerUnit ?? 0,
    };
    const tx = {
      ingredient: {
        findFirst: jest.fn().mockResolvedValue(dest ? destRow : null),
        create: jest.fn().mockResolvedValue(destRow),
        findUniqueOrThrow: jest.fn().mockResolvedValue(destRow),
        update: jest.fn().mockResolvedValue(destRow),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      stockBatch: { create: jest.fn().mockResolvedValue({ id: 'batch-1' }) },
      stockMovement: { create: jest.fn().mockResolvedValue({}) },
      stockTransfer: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      branch: {
        findFirst: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) => ({
            id: where.id,
            name: where.id,
          })),
      },
      ingredient: { findFirst: jest.fn().mockResolvedValue(source) },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    } as unknown as PrismaService;
    const stock = {
      consumeStock: jest
        .fn()
        .mockResolvedValue([
          { batchId: 'b0', quantity: 2500, unitCost: 0.03333 },
        ]),
    } as unknown as StockService;
    return { service: new TransfersService(prisma, stock), tx };
  };

  const send = (service: TransfersService) =>
    service.transfer('rest', 'user', 'branch-a', {
      toBranchId: 'branch-b',
      ingredientId: 'ing-src',
      quantity: 2500,
    });

  it('keeps 6dp on the destination batch, ingredient and transfer record', async () => {
    const { service, tx } = setup(null);
    await send(service);
    expect(dataOf(tx.stockBatch.create).unitCost).toBe(0.03333);
    expect(dataOf(tx.ingredient.update).costPerUnit).toBe(0.03333);
    expect(dataOf(tx.stockTransfer.create).unitCost).toBe(0.03333);
  });

  it('rounds the destination weighted average to 6dp', async () => {
    // 1000 g at 0.041234 + 2500 g at 0.03333 -> 0.035588285.. -> 0.035588
    const { service, tx } = setup({
      currentStock: 1000,
      costPerUnit: 0.041234,
    });
    await send(service);
    expect(dataOf(tx.ingredient.update).costPerUnit).toBe(0.035588);
  });
});
