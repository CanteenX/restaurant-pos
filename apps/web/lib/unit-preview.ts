// Client-side preview of the server's unit conversion (display only: the
// server converts and stores base units; never trust this for stored values).
// Mirrors apps/backend/src/modules/inventory/unit-conversion.ts.
import type { IngredientUnit } from "@nventra/types";

export interface PackSize {
  unit: IngredientUnit;
  factor: number;
}

// Dimension + size relative to that dimension's reference unit.
const GLOBAL: Partial<Record<IngredientUnit, { dim: string; size: number }>> = {
  G: { dim: "mass", size: 1 },
  KG: { dim: "mass", size: 1000 },
  ML: { dim: "volume", size: 1 },
  L: { dim: "volume", size: 1000 },
  PIECE: { dim: "count", size: 1 },
  DOZEN: { dim: "count", size: 12 },
};

const globallyCompatible = (a: IngredientUnit, b: IngredientUnit) => {
  const ga = GLOBAL[a];
  const gb = GLOBAL[b];
  return !!ga && !!gb && ga.dim === gb.dim;
};

/** Units a user may enter a quantity in for an ingredient with this base unit. */
export function enterableUnits(base: IngredientUnit, packs: readonly PackSize[]): IngredientUnit[] {
  const units = new Set<IngredientUnit>([base]);
  for (const u of Object.keys(GLOBAL) as IngredientUnit[]) {
    if (globallyCompatible(u, base)) units.add(u);
  }
  for (const p of packs) units.add(p.unit);
  return [...units];
}

function factor(from: IngredientUnit, base: IngredientUnit, packs: readonly PackSize[]): number | null {
  if (from === base) return 1;
  if (globallyCompatible(from, base)) return GLOBAL[from]!.size / GLOBAL[base]!.size;
  const pack = packs.find((p) => p.unit === from);
  return pack && pack.factor > 0 ? pack.factor : null;
}

/** Quantity in `base` units (3dp, half-up), or null if it cannot be converted. */
export function convertPreview(
  quantity: number,
  from: IngredientUnit,
  base: IngredientUnit,
  packs: readonly PackSize[],
): number | null {
  if (!Number.isFinite(quantity)) return null;
  const f = factor(from, base, packs);
  if (f === null) return null;
  const exact = quantity * f;
  const rounded = Math.sign(exact) * Math.round(Math.abs(exact) * 1000 + 1e-9) / 1000;
  if (rounded === 0 && exact !== 0) return null;
  return rounded;
}
