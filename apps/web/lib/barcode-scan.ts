export interface ScannableItem {
  id: string;
  sku: string | null;
  barcode: string | null;
  isActive: boolean;
}

export function findBarcodeMatch<T extends ScannableItem>(code: string, items: readonly T[]):
  | { kind: "invalid" | "missing" | "duplicate" }
  | { kind: "match"; item: T } {
  if (!code || code.length > 128 || /[\x00-\x1f\x7f]/.test(code)) return { kind: "invalid" };
  const matches = new Map<string, T>();
  for (const item of items) {
    if (item.barcode === code || item.sku === code) matches.set(item.id, item);
  }
  if (matches.size > 1) return { kind: "duplicate" };
  const item = matches.values().next().value;
  return item?.isActive ? { kind: "match", item } : { kind: "missing" };
}
