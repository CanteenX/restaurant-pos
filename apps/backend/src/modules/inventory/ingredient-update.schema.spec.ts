import { ingredientSchema, ingredientUpdateSchema } from '@nventra/types';

// PATCH ingredients/:id body. Must reject bad planning fields with a
// validation error (400 at the controller) and must NOT inject defaults: an
// omitted isActive/reorderLevel has to stay omitted so the row keeps its value.
describe('ingredientUpdateSchema', () => {
  const bad = (body: unknown) =>
    expect(ingredientUpdateSchema.safeParse(body).success).toBe(false);

  it('applies no defaults to omitted fields', () => {
    expect(ingredientUpdateSchema.parse({ leadTimeDays: 3 })).toEqual({
      leadTimeDays: 3,
    });
    expect(ingredientUpdateSchema.parse({})).toEqual({});
  });

  it('rejects negative or fractional lead time and non-positive pack size', () => {
    bad({ leadTimeDays: -3 });
    bad({ leadTimeDays: 1.5 });
    bad({ packSize: -5 });
    bad({ packSize: 0 });
    bad({ packSize: 'abc' });
  });

  it('only accepts a non-empty string or null as preferredSupplierId', () => {
    bad({ preferredSupplierId: 123 });
    bad({ preferredSupplierId: { not: 'x' } });
    bad({ preferredSupplierId: '' });
    expect(ingredientUpdateSchema.parse({ preferredSupplierId: null })).toEqual(
      { preferredSupplierId: null },
    );
  });

  it('rejects wrong types for the base fields', () => {
    bad({ isActive: 'yes' });
    bad({ unit: 'BUCKET' });
    bad({ name: '' });
    bad({ reorderLevel: -1 });
  });

  it('caps lead time at 365 days', () => {
    bad({ leadTimeDays: 366 });
    expect(ingredientUpdateSchema.parse({ leadTimeDays: 365 })).toEqual({
      leadTimeDays: 365,
    });
  });

  it('drops branchId, currentStock and other non-editable keys', () => {
    // stock moves only via the StockMovement ledger; branch is not movable
    expect(
      ingredientUpdateSchema.parse({
        name: 'Rice',
        branchId: 'other-branch',
        currentStock: 999,
        costPerUnit: 1,
        createdAt: '2020-01-01',
      }),
    ).toEqual({ name: 'Rice' });
  });

  it('keeps create defaults on ingredientSchema', () => {
    const v = ingredientSchema.parse({ name: 'Rice', unit: 'KG' });
    expect(v.isActive).toBe(true);
    expect(v.reorderLevel).toBe(0);
  });
});
