// Pure helpers for the purchase-return form. The server stays authoritative
// (it re-checks received/in-stock limits and values every line itself); these
// only keep the form honest before submit.

export interface ReturnableItem {
  id: string;
  quantity: string | number;
}

export interface PriorReturn {
  goodsReceiptId?: string;
  items: { goodsReceiptItemId: string; quantity: string | number }[];
}

/** Quantity still returnable per goods-receipt item: received minus earlier returns. */
export function returnableQuantities(
  grnItems: ReturnableItem[],
  priorReturns: PriorReturn[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of grnItems) out[item.id] = Number(item.quantity);
  for (const ret of priorReturns) {
    for (const line of ret.items) {
      if (line.goodsReceiptItemId in out) out[line.goodsReceiptItemId] -= Number(line.quantity);
    }
  }
  for (const id of Object.keys(out)) out[id] = Math.max(0, Math.round(out[id] * 1000) / 1000);
  return out;
}

export type ReturnQtyError = "invalid" | "max";

export interface ReturnValidation {
  ok: boolean;
  lines: { goodsReceiptItemId: string; quantity: number }[];
  errors: Record<string, ReturnQtyError>;
}

/** Validates typed quantities against the limits. Blank and 0 mean "not returning this line". */
export function validateReturnQuantities(
  input: Record<string, string>,
  limits: Record<string, number>,
): ReturnValidation {
  const lines: ReturnValidation["lines"] = [];
  const errors: ReturnValidation["errors"] = {};
  for (const [id, raw] of Object.entries(input)) {
    if (raw.trim() === "") continue;
    const qty = Number(raw);
    if (!Number.isFinite(qty) || qty < 0) errors[id] = "invalid";
    else if (qty === 0) continue;
    else if (qty > (limits[id] ?? 0)) errors[id] = "max";
    else lines.push({ goodsReceiptItemId: id, quantity: qty });
  }
  return { ok: lines.length > 0 && Object.keys(errors).length === 0, lines, errors };
}
