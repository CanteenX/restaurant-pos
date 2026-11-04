import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  groupBySupplier,
  suggestReorder,
  type ReorderSuggestion,
} from './reorder-suggestions';

@Injectable()
export class ReorderSuggestionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSuggestions(branchId: string, days: number, now = new Date()) {
    const since = new Date(now.getTime() - days * 86_400_000);
    const [ingredients, consumption] = await Promise.all([
      this.prisma.ingredient.findMany({
        where: { branchId, isActive: true },
        include: {
          preferredSupplier: {
            select: { id: true, name: true, isActive: true },
          },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['ingredientId'],
        where: {
          branchId,
          // REVERSAL (+qty) only ever compensates CONSUMPTION (-qty) for
          // returned items, so the net sum is the true usage in the window.
          type: { in: ['CONSUMPTION', 'REVERSAL'] },
          createdAt: { gte: since, lte: now },
        },
        _sum: { quantity: true },
      }),
    ]);
    const consumed = new Map(
      consumption.map((c) => [
        c.ingredientId,
        Math.max(0, -Number(c._sum.quantity ?? 0)),
      ]),
    );

    const suggestions = ingredients
      .map((i) => ({
        ...i,
        // a deactivated supplier is not ordered from: fall back to "none"
        supplier: i.preferredSupplier?.isActive ? i.preferredSupplier : null,
      }))
      .map((i) =>
        suggestReorder({
          ingredientId: i.id,
          name: i.name,
          unit: i.unit,
          currentStock: Number(i.currentStock),
          reorderLevel: Number(i.reorderLevel),
          consumedInWindow: consumed.get(i.id) ?? 0,
          windowDays: days,
          leadTimeDays: i.leadTimeDays,
          packSize: i.packSize === null ? null : Number(i.packSize),
          supplierId: i.supplier?.id ?? null,
          supplierName: i.supplier?.name ?? null,
        }),
      )
      .filter((s): s is ReorderSuggestion => s !== null);

    return { days, groups: groupBySupplier(suggestions) };
  }
}
