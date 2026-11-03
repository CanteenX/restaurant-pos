import {
  membershipTierSchema,
  membershipTierUpdateSchema,
} from '@nventra/types';

describe('membership tier schemas', () => {
  it('create applies defaults for omitted benefit fields', () => {
    expect(membershipTierSchema.parse({ name: 'Silver', rank: 1 })).toEqual({
      name: 'Silver',
      rank: 1,
      discountPercent: 0,
      pointsMultiplier: 1,
      active: true,
    });
  });

  it('a partial update contains only the fields sent (no defaults)', () => {
    expect(membershipTierUpdateSchema.parse({ name: 'X' })).toEqual({
      name: 'X',
    });
    expect(membershipTierUpdateSchema.parse({ active: false })).toEqual({
      active: false,
    });
  });

  it('update still validates field ranges and rejects an empty body', () => {
    expect(
      membershipTierUpdateSchema.safeParse({ discountPercent: 150 }).success,
    ).toBe(false);
    expect(membershipTierUpdateSchema.safeParse({}).success).toBe(false);
  });
});
