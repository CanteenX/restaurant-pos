// Unit conversion engine. Pure (no DB) so every rule is unit-testable.
//
// The stock model is unchanged: each Ingredient keeps ONE base unit, and every
// stored quantity (stock, batches, movements, recipe lines, GRN lines) is in
// that base unit. Conversion happens once, at the API boundary, from the unit
// the user entered into the base unit — so the ledger can never mix units.
//
// Two sources of factors:
//  1. A fixed global table for units that are always convertible
//     (KG/G, L/ML, DOZEN/PIECE). These cannot be overridden per ingredient.
//  2. Per-ingredient pack sizes (IngredientUnitConversion rows): "1 <unit> =
//     <factor> <base unit>", e.g. 1 PACK = 25 KG, or 1 G = 0.02 PIECE (eggs).
//
// Rounding rules:
//  - Maths is done in decimal (Prisma.Decimal), never binary floats.
//  - Quantities round half-up (away from zero) to 3dp, the stock column scale.
//    A non-zero quantity that rounds to 0 is rejected rather than lost.
//  - Unit costs round half-up to 6dp, the cost column scale.
import { Prisma } from '@prisma/client';

export type Unit = 'KG' | 'G' | 'L' | 'ML' | 'PIECE' | 'DOZEN' | 'PACK' | 'BOX';

/** unit -> how many base units one `unit` holds. */
export type PackSizes = ReadonlyMap<Unit, Prisma.Decimal.Value>;

export class UnitConversionError extends Error {}

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

// Dimension + size in that dimension's reference unit (G, ML, PIECE).
const GLOBAL: Partial<Record<Unit, { dim: string; size: number }>> = {
  G: { dim: 'mass', size: 1 },
  KG: { dim: 'mass', size: 1000 },
  ML: { dim: 'volume', size: 1 },
  L: { dim: 'volume', size: 1000 },
  PIECE: { dim: 'count', size: 1 },
  DOZEN: { dim: 'count', size: 12 },
};

const globallyCompatible = (a: Unit, b: Unit) => {
  const ga = GLOBAL[a];
  const gb = GLOBAL[b];
  return !!ga && !!gb && ga.dim === gb.dim;
};

/** Base units in one `from`. Exact decimal; may be non-terminating (1/12). */
export function conversionFactor(
  from: Unit,
  base: Unit,
  packs: PackSizes,
): Dec {
  if (from === base) return new D(1);
  if (globallyCompatible(from, base)) {
    return new D(GLOBAL[from]!.size).div(GLOBAL[base]!.size);
  }
  const pack = packs.get(from);
  if (pack !== undefined && new D(pack).gt(0)) return new D(pack);
  throw new UnitConversionError(
    `${from} cannot be converted to ${base} — add a pack size for ${from} on this item`,
  );
}

/** Quantity entered in `from` (default: base), as base units rounded to 3dp. */
export function toBaseQuantity(
  quantity: number,
  from: Unit | undefined,
  base: Unit,
  packs: PackSizes,
): number {
  // Base-unit entries go through the same rounding as converted ones.
  const factor =
    !from || from === base ? new D(1) : conversionFactor(from, base, packs);
  const exact = new D(quantity).mul(factor);
  const rounded = exact.toDecimalPlaces(3, D.ROUND_HALF_UP);
  if (rounded.isZero() && !exact.isZero()) {
    throw new UnitConversionError(
      `${quantity} ${from ?? base} is too small to record in ${base} (3 decimal places)`,
    );
  }
  return rounded.toNumber();
}

/** Cost per `from` unit, as cost per base unit rounded to 6dp. */
export function toBaseUnitCost(
  cost: number,
  from: Unit | undefined,
  base: Unit,
  packs: PackSizes,
): number {
  if (!from || from === base) return cost;
  return new D(cost)
    .div(conversionFactor(from, base, packs))
    .toDecimalPlaces(6, D.ROUND_HALF_UP)
    .toNumber();
}

/** Pack sizes an ingredient may store. Throws on the first invalid entry. */
export function validatePackSizes(
  base: Unit,
  sizes: readonly { unit: Unit; factor: number }[],
): void {
  const seen = new Set<Unit>();
  for (const { unit, factor } of sizes) {
    if (unit === base) {
      throw new UnitConversionError(
        `${unit} is this item's base unit and needs no pack size`,
      );
    }
    if (globallyCompatible(unit, base)) {
      throw new UnitConversionError(
        `${unit} to ${base} is fixed and cannot be overridden`,
      );
    }
    if (seen.has(unit)) {
      throw new UnitConversionError(`${unit} can only be sized once`);
    }
    if (!(factor > 0)) {
      throw new UnitConversionError(`${unit} size must be positive`);
    }
    seen.add(unit);
  }
}
