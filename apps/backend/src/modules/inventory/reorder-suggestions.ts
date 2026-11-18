// Pure reorder maths: no database access, so every rule is unit-testable.

export interface ReorderInput {
  ingredientId: string;
  name: string;
  unit: string;
  currentStock: number;
  reorderLevel: number;
  /** Units consumed over the look-back window (positive number). */
  consumedInWindow: number;
  windowDays: number;
  leadTimeDays: number | null;
  packSize: number | null;
  supplierId: string | null;
  supplierName: string | null;
}

export interface ReorderSuggestion {
  ingredientId: string;
  name: string;
  unit: string;
  currentStock: number;
  reorderLevel: number;
  avgDailyConsumption: number;
  leadTimeDays: number;
  targetStock: number;
  suggestedQuantity: number;
  packSize: number | null;
  packs: number | null;
  supplierId: string | null;
  supplierName: string | null;
}

export interface SupplierGroup {
  supplierId: string | null;
  supplierName: string | null;
  suggestions: ReorderSuggestion[];
  /** Body for POST /inventory/purchase-requests. */
  purchaseRequest: {
    items: { ingredientId: string; quantityRequested: number }[];
  };
}

const r3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** Target = reorder level + demand during lead time; null when no order is needed. */
export function suggestReorder(i: ReorderInput): ReorderSuggestion | null {
  const avg = i.windowDays > 0 ? r3(i.consumedInWindow / i.windowDays) : 0;
  if (i.reorderLevel <= 0 && avg <= 0) return null;
  const lead = i.leadTimeDays ?? 0;
  const target = r3(i.reorderLevel + avg * lead);
  const shortfall = r3(target - i.currentStock);
  if (shortfall <= 0) return null;

  let quantity = shortfall;
  let packs: number | null = null;
  if (i.packSize && i.packSize > 0) {
    packs = Math.ceil(shortfall / i.packSize - 1e-9);
    quantity = r3(packs * i.packSize);
  }
  return {
    ingredientId: i.ingredientId,
    name: i.name,
    unit: i.unit,
    currentStock: i.currentStock,
    reorderLevel: i.reorderLevel,
    avgDailyConsumption: avg,
    leadTimeDays: lead,
    targetStock: target,
    suggestedQuantity: quantity,
    packSize: i.packSize,
    packs,
    supplierId: i.supplierId,
    supplierName: i.supplierName,
  };
}

export function groupBySupplier(list: ReorderSuggestion[]): SupplierGroup[] {
  const groups = new Map<string, SupplierGroup>();
  for (const s of list) {
    const key = s.supplierId ?? '';
    let g = groups.get(key);
    if (!g) {
      g = {
        supplierId: s.supplierId,
        supplierName: s.supplierName,
        suggestions: [],
        purchaseRequest: { items: [] },
      };
      groups.set(key, g);
    }
    g.suggestions.push(s);
    g.purchaseRequest.items.push({
      ingredientId: s.ingredientId,
      quantityRequested: s.suggestedQuantity,
    });
  }
  return [...groups.values()];
}
