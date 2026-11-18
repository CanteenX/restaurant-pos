import type { LabelSpec } from "@nventra/types";
import { formatCurrency } from "./format.ts";

const clip = (s: string) => s.trim().slice(0, 40);

/** Menu labels: name + the server's tax-inclusive price (never typed by hand). */
export function labelsFromMenuItems(
  items: { id: string; name: string; price: string; isActive: boolean }[],
): LabelSpec[] {
  return items
    .filter((i) => i.isActive)
    .map((i) => ({ title: clip(i.name), price: formatCurrency(i.price) }));
}

/** Inventory labels: name + SKU as a Code 128 barcode when it is printable ASCII. */
export function labelsFromIngredients(
  items: { id: string; name: string; sku: string | null; isActive: boolean }[],
): LabelSpec[] {
  return items
    .filter((i) => i.isActive)
    .map((i) => {
      const spec: LabelSpec = { title: clip(i.name) };
      if (i.sku && /^[\x20-\x7e]{1,32}$/.test(i.sku.trim())) spec.barcode = i.sku.trim();
      return spec;
    });
}
