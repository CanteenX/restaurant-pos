// Inventory valuation rows. Cost per unit is a per-base-unit cost stored at
// 6dp (#69: ₹45/kg into a G item is 0.045/g), so it is exported at 6dp; only
// the money columns (Value, Total) round to 2dp.
import { round2, round6 } from '../../common/money';

export interface ValuationIngredient {
  name: string;
  unit: string;
  currentStock: number;
  costPerUnit: number;
}

export function inventoryValuationRows(
  ingredients: readonly ValuationIngredient[],
): (string | number)[][] {
  const rows = ingredients.map((i) => [
    i.name,
    i.unit,
    i.currentStock,
    round6(i.costPerUnit),
    round2(i.currentStock * i.costPerUnit),
  ]);
  const total = round2(rows.reduce((s, r) => s + Number(r[4]), 0));
  return [...rows, ['Total', '', '', '', total]];
}
