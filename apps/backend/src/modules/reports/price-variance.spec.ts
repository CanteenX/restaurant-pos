import { computePriceVariance, type PriceReceipt } from './price-variance';

const r = (
  unitCost: number,
  day: number,
  over: Partial<PriceReceipt> = {},
): PriceReceipt => ({
  ingredientId: 'i1',
  ingredientName: 'Tomato',
  unit: 'KG',
  supplierId: 's1',
  supplierName: 'Fresh Co',
  unitCost,
  receivedAt: new Date(Date.UTC(2026, 0, day)),
  ...over,
});

describe('computePriceVariance', () => {
  it('computes last, avg, min, max and variance vs previous receipt', () => {
    const rows = computePriceVariance([r(100, 3), r(80, 1), r(120, 2)], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      receipts: 3,
      lastCost: 100,
      avgCost: 100,
      minCost: 80,
      maxCost: 120,
      previousCost: 120,
      varianceVsPrevPct: -16.67,
      quotedPrice: null,
      varianceVsQuotePct: null,
    });
  });

  it('has no previous variance for a single receipt', () => {
    const [row] = computePriceVariance([r(50, 1)], []);
    expect(row.previousCost).toBeNull();
    expect(row.varianceVsPrevPct).toBeNull();
  });

  it('compares the last cost to the latest quotation for the same supplier', () => {
    const [row] = computePriceVariance(
      [r(110, 2), r(100, 1)],
      [
        {
          ingredientId: 'i1',
          supplierId: 's1',
          unitPrice: 90,
          quotedAt: new Date(Date.UTC(2025, 11, 1)),
        },
        {
          ingredientId: 'i1',
          supplierId: 's1',
          unitPrice: 100,
          quotedAt: new Date(Date.UTC(2025, 11, 20)),
        },
        {
          ingredientId: 'i1',
          supplierId: 's2',
          unitPrice: 1,
          quotedAt: new Date(Date.UTC(2026, 0, 1)),
        },
      ],
    );
    expect(row.quotedPrice).toBe(100);
    expect(row.varianceVsQuotePct).toBe(10);
  });

  it('groups per ingredient and supplier and sorts by name', () => {
    const rows = computePriceVariance(
      [
        r(10, 1, { ingredientId: 'i2', ingredientName: 'Onion' }),
        r(10, 1, { supplierId: 's2', supplierName: 'Agro' }),
        r(10, 1),
      ],
      [],
    );
    expect(rows.map((x) => [x.ingredientName, x.supplierName])).toEqual([
      ['Onion', 'Fresh Co'],
      ['Tomato', 'Agro'],
      ['Tomato', 'Fresh Co'],
    ]);
  });

  it('avoids division by zero', () => {
    const [row] = computePriceVariance(
      [r(5, 2), r(0, 1)],
      [
        {
          ingredientId: 'i1',
          supplierId: 's1',
          unitPrice: 0,
          quotedAt: new Date(0),
        },
      ],
    );
    expect(row.varianceVsPrevPct).toBeNull();
    expect(row.varianceVsQuotePct).toBeNull();
  });
});
