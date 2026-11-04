import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { IngredientUnit, Prisma } from '@prisma/client';
import type { UnitConversionDto } from '@nventra/types';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  UnitConversionError,
  toBaseQuantity,
  toBaseUnitCost,
  validatePackSizes,
  type PackSizes,
} from './unit-conversion';

/** Minimal ingredient shape a converter needs (include `unitConversions`). */
export interface ConvertibleIngredient {
  unit: IngredientUnit;
  unitConversions?: { unit: IngredientUnit; factor: Prisma.Decimal }[];
}

/** Converts quantities/costs entered in `unit` into the ingredient's base. */
export interface Converter {
  quantity(q: number, unit?: IngredientUnit): number;
  unitCost(c: number, unit?: IngredientUnit): number;
}

const badRequest = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof UnitConversionError) {
      throw new BadRequestException(e.message);
    }
    throw e;
  }
};

export function converterFor(ingredient: ConvertibleIngredient): Converter {
  const packs: PackSizes = new Map(
    (ingredient.unitConversions ?? []).map((c) => [c.unit, c.factor]),
  );
  const base = ingredient.unit;
  return {
    quantity: (q, unit) =>
      badRequest(() => toBaseQuantity(q, unit, base, packs)),
    unitCost: (c, unit) =>
      badRequest(() => toBaseUnitCost(c, unit, base, packs)),
  };
}

/** Prisma `include` that loads what converterFor needs. */
export const withConversions = {
  unitConversions: { select: { unit: true, factor: true } },
} as const;

@Injectable()
export class UnitConversionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async ingredient(branchId: string, ingredientId: string) {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id: ingredientId, branchId },
    });
    if (!ingredient) throw new NotFoundException('Ingredient not found');
    return ingredient;
  }

  async list(branchId: string, ingredientId: string) {
    await this.ingredient(branchId, ingredientId);
    return this.prisma.ingredientUnitConversion.findMany({
      where: { ingredientId },
      orderBy: { unit: 'asc' },
    });
  }

  // Replaces the ingredient's pack sizes. Stored quantities are always in the
  // base unit, so changing a pack size never rewrites existing stock; it only
  // changes how future entries in that unit are converted.
  async replace(
    branchId: string,
    ingredientId: string,
    conversions: UnitConversionDto[],
    userId?: string,
  ) {
    const ingredient = await this.ingredient(branchId, ingredientId);
    badRequest(() => validatePackSizes(ingredient.unit, conversions));
    await this.prisma.$transaction(async (tx) => {
      await tx.ingredientUnitConversion.deleteMany({ where: { ingredientId } });
      if (conversions.length > 0) {
        await tx.ingredientUnitConversion.createMany({
          data: conversions.map((c) => ({
            ingredientId,
            unit: c.unit,
            factor: c.factor,
          })),
        });
      }
    });
    await this.audit.record({
      userId,
      action: 'ingredient.units_updated',
      entity: 'Ingredient',
      entityId: ingredientId,
      metadata: {
        branchId,
        name: ingredient.name,
        baseUnit: ingredient.unit,
        conversions,
      },
    });
    return this.list(branchId, ingredientId);
  }
}
