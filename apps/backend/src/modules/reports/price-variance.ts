// Pure price-variance maths for the ingredient purchase-price report.

export interface PriceReceipt {
  ingredientId: string;
  ingredientName: string;
  unit: string;
  supplierId: string;
  supplierName: string;
  unitCost: number;
  receivedAt: Date;
}

export interface PriceQuote {
  ingredientId: string;
  supplierId: string;
  unitPrice: number;
  quotedAt: Date;
}

export interface PriceVarianceRow {
  ingredientName: string;
  supplierName: string;
  unit: string;
  receipts: number;
  lastCost: number;
  avgCost: number;
  minCost: number;
  maxCost: number;
  previousCost: number | null;
  varianceVsPrevPct: number | null;
  quotedPrice: number | null;
  varianceVsQuotePct: number | null;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

function pct(now: number, base: number | null): number | null {
  if (base == null || base === 0) return null;
  return round2(((now - base) / base) * 100);
}

export function computePriceVariance(
  receipts: PriceReceipt[],
  quotes: PriceQuote[],
): PriceVarianceRow[] {
  const groups = new Map<string, PriceReceipt[]>();
  for (const x of receipts) {
    const k = `${x.ingredientId}|${x.supplierId}`;
    const g = groups.get(k);
    if (g) g.push(x);
    else groups.set(k, [x]);
  }

  const latestQuote = new Map<string, PriceQuote>();
  for (const q of quotes) {
    const k = `${q.ingredientId}|${q.supplierId}`;
    const cur = latestQuote.get(k);
    if (!cur || q.quotedAt > cur.quotedAt) latestQuote.set(k, q);
  }

  const rows: PriceVarianceRow[] = [];
  for (const [k, g] of groups) {
    g.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    const costs = g.map((x) => x.unitCost);
    const last = costs[costs.length - 1];
    const prev = costs.length > 1 ? costs[costs.length - 2] : null;
    const quote = latestQuote.get(k)?.unitPrice ?? null;
    rows.push({
      ingredientName: g[0].ingredientName,
      supplierName: g[0].supplierName,
      unit: g[0].unit,
      receipts: g.length,
      lastCost: round4(last),
      avgCost: round4(costs.reduce((s, c) => s + c, 0) / costs.length),
      minCost: round4(Math.min(...costs)),
      maxCost: round4(Math.max(...costs)),
      previousCost: prev == null ? null : round4(prev),
      varianceVsPrevPct: pct(last, prev),
      quotedPrice: quote == null ? null : round4(quote),
      varianceVsQuotePct: pct(last, quote),
    });
  }
  return rows.sort(
    (a, b) =>
      a.ingredientName.localeCompare(b.ingredientName) ||
      a.supplierName.localeCompare(b.supplierName),
  );
}
