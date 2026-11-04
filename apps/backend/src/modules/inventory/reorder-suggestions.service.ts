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
        include: { preferredSupplier: { select: { id: true, name: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['ingredientId'],
        where: {
          branchId,
          type: 'CONSUMPTION',
          createdAt: { gte: since, lte: now },
        },
        _sum: { quantity: true },
      }),
    ]);
    const consumed = new Map(
      consumption.map((c) => [
        c.ingredientId,
        Math.abs(Number(c._sum.quantity ?? 0)),
      ]),
    );

    const suggestions = ingredients
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
          supplierId: i.preferredSupplier?.id ?? null,
          supplierName: i.preferredSupplier?.name ?? null,
        }),
      )
      .filter((s): s is ReorderSuggestion => s !== null);

    return { days, groups: groupBySupplier(suggestions) };
  }
}
