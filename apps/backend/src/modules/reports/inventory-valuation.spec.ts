import { inventoryValuationRows } from './inventory-valuation';

describe('inventoryValuationRows', () => {
  it('exports per-unit cost at 6dp and money at 2dp (#69)', () => {
    // ₹45/kg bought into a G item: 0.045/g must not export as 0.05
    const rows = inventoryValuationRows([
      { name: 'Flour', unit: 'G', currentStock: 2500, costPerUnit: 0.045 },
      { name: 'Oil', unit: 'L', currentStock: 3, costPerUnit: 123.456789 },
    ]);
    expect(rows).toEqual([
      ['Flour', 'G', 2500, 0.045, 112.5],
      ['Oil', 'L', 3, 123.456789, 370.37],
      ['Total', '', '', '', 482.87],
    ]);
  });
});
