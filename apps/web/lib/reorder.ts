// Pure helpers for the reorder-suggestions table (no React, unit-testable).

export interface ReorderLine {
  ingredientId: string;
  name: string;
  unit: string;
  suggestedQuantity: number;
}

export interface ReorderGroup {
  supplierId: string | null;
  supplierName: string | null;
  suggestions: ReorderLine[];
}

/** A positive finite number, or null when the text is not a usable quantity. */
export function parseEditedQuantity(input: string): number | null {
  const text = input.trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Body for POST /inventory/purchase-requests; lines with no valid quantity are dropped. */
export function buildPurchaseRequest(
  group: ReorderGroup,
  edits: Record<string, string>,
): { items: { ingredientId: string; quantityRequested: number }[] } {
  const items: { ingredientId: string; quantityRequested: number }[] = [];
  for (const s of group.suggestions) {
    const qty =
      s.ingredientId in edits ? parseEditedQuantity(edits[s.ingredientId]) : s.suggestedQuantity;
    if (qty !== null && qty > 0) items.push({ ingredientId: s.ingredientId, quantityRequested: qty });
  }
  return { items };
}
