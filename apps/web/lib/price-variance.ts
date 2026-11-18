// Helpers for the purchase price-variance report table.
// Column order matches the backend `price-variance` report.

export type VarianceCell = string | number | null;

export const DEFAULT_VARIANCE_THRESHOLD = 10;
const VS_PREVIOUS_COL = 9;
const VS_QUOTE_COL = 11;

export function isHighVariance(pct: number | null | undefined, threshold: number): boolean {
  if (pct == null || !(threshold > 0)) return false;
  return Math.abs(pct) >= threshold;
}

export function rowHasHighVariance(row: VarianceCell[], threshold: number): boolean {
  return [VS_PREVIOUS_COL, VS_QUOTE_COL].some((i) => {
    const v = row[i];
    return typeof v === "number" && isHighVariance(v, threshold);
  });
}

export function filterVarianceRows(
  rows: VarianceCell[][],
  opts: { query: string; onlyHigh: boolean; threshold: number },
): VarianceCell[][] {
  const q = opts.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !`${r[0] ?? ""} ${r[1] ?? ""}`.toLowerCase().includes(q)) return false;
    return !opts.onlyHigh || rowHasHighVariance(r, opts.threshold);
  });
}

export const isVarianceColumn = (index: number) => index === VS_PREVIOUS_COL || index === VS_QUOTE_COL;
