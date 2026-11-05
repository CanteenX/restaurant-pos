import { suggestReorder, groupBySupplier } from './reorder-suggestions';

const base = {
  ingredientId: 'i1',
  name: 'Flour',
  unit: 'KG',
  currentStock: 10,
  reorderLevel: 20,
  consumedInWindow: 70,
  windowDays: 7,
  leadTimeDays: 2,
  packSize: null as number | null,
  supplierId: 's1' as string | null,
  supplierName: 'Acme' as string | null,
};

describe('suggestReorder', () => {
  it('averages daily consumption over the window', () => {
    expect(suggestReorder(base)?.avgDailyConsumption).toBe(10);
  });

  it('targets reorderLevel plus lead-time demand', () => {
    // target = 20 + 10*2 = 40; need 40 - 10 = 30
    expect(suggestReorder(base)?.suggestedQuantity).toBe(30);
  });

  it('rounds up to a whole pack', () => {
    const s = suggestReorder({ ...base, packSize: 25 });
    expect(s?.suggestedQuantity).toBe(50);
    expect(s?.packs).toBe(2);
  });

  it('returns null when stock covers the target', () => {
    expect(suggestReorder({ ...base, currentStock: 40 })).toBeNull();
    expect(suggestReorder({ ...base, currentStock: 99 })).toBeNull();
  });

  it('ignores items with no reorder level and no consumption', () => {
    expect(
      suggestReorder({ ...base, reorderLevel: 0, consumedInWindow: 0 }),
    ).toBeNull();
  });

  it('treats missing lead time as zero days', () => {
    // target = 20; need 10
    expect(
      suggestReorder({ ...base, leadTimeDays: null })?.suggestedQuantity,
    ).toBe(10);
  });

  it('rounds to 3 decimals', () => {
    const s = suggestReorder({
      ...base,
      consumedInWindow: 10,
      windowDays: 3,
      leadTimeDays: 1,
      reorderLevel: 0,
      currentStock: 0,
    });
    expect(s?.suggestedQuantity).toBe(3.333);
  });
});

describe('groupBySupplier', () => {
  it('groups by supplier and builds a purchase-request payload', () => {
    const a = suggestReorder(base)!;
    const b = suggestReorder({
      ...base,
      ingredientId: 'i2',
      supplierId: null,
      supplierName: null,
    })!;
    const groups = groupBySupplier([a, b]);
    expect(groups).toHaveLength(2);
    const acme = groups.find((g) => g.supplierId === 's1')!;
    expect(acme.purchaseRequest.items).toEqual([
      { ingredientId: 'i1', quantityRequested: 30 },
    ]);
    expect(groups.find((g) => g.supplierId === null)).toBeDefined();
  });
});
