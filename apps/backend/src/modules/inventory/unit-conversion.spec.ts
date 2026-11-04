import { unitConversionSchema } from '@nventra/types';
import {
  UnitConversionError,
  conversionFactor,
  toBaseQuantity,
  toBaseUnitCost,
  validatePackSizes,
  type PackSizes,
  type Unit,
} from './unit-conversion';

const none: PackSizes = new Map();

describe('unit conversion', () => {
  describe('global table', () => {
    it('converts mass exactly in both directions', () => {
      expect(toBaseQuantity(1.5, 'KG', 'G', none)).toBe(1500);
      expect(toBaseQuantity(250, 'G', 'KG', none)).toBe(0.25);
      expect(toBaseQuantity(0.001, 'KG', 'G', none)).toBe(1);
      expect(toBaseQuantity(12.345, 'KG', 'G', none)).toBe(12345);
    });

    it('converts volume exactly in both directions', () => {
      expect(toBaseQuantity(2.2, 'L', 'ML', none)).toBe(2200);
      expect(toBaseQuantity(330, 'ML', 'L', none)).toBe(0.33);
    });

    it('converts counts (dozen <-> piece)', () => {
      expect(toBaseQuantity(2, 'DOZEN', 'PIECE', none)).toBe(24);
      expect(toBaseQuantity(6, 'PIECE', 'DOZEN', none)).toBe(0.5);
    });

    it('avoids binary float drift (0.1 + 0.2 style inputs)', () => {
      // 0.3 * 1000 in floats is 300.00000000000006
      expect(toBaseQuantity(0.3, 'KG', 'G', none)).toBe(300);
      expect(toBaseQuantity(1.005, 'L', 'ML', none)).toBe(1005);
      expect(toBaseQuantity(0.07, 'KG', 'G', none)).toBe(70);
    });

    it('is the identity for the base unit and when unit is omitted', () => {
      expect(toBaseQuantity(3.333, 'G', 'G', none)).toBe(3.333);
      expect(toBaseQuantity(3.333, undefined, 'G', none)).toBe(3.333);
    });

    it('rounds half-up to the 3dp stock scale', () => {
      // 5 pieces = 0.41666.. dozen
      expect(toBaseQuantity(5, 'PIECE', 'DOZEN', none)).toBe(0.417);
      expect(toBaseQuantity(1.5, 'G', 'KG', none)).toBe(0.002); // 0.0015
    });

    it('keeps the sign for signed quantities (adjustments)', () => {
      expect(toBaseQuantity(-1.5, 'KG', 'G', none)).toBe(-1500);
      expect(toBaseQuantity(-1.5, 'G', 'KG', none)).toBe(-0.002);
    });

    it('rejects a non-zero quantity too small for the base unit', () => {
      expect(() => toBaseQuantity(0.4, 'G', 'KG', none)).toThrow(
        UnitConversionError,
      );
    });
  });

  describe('incompatible units', () => {
    it.each([
      ['G', 'L'],
      ['KG', 'ML'],
      ['L', 'PIECE'],
      ['PIECE', 'KG'],
      ['PACK', 'G'],
      ['BOX', 'PIECE'],
      ['G', 'PACK'],
    ] as const)('rejects %s -> %s without a pack size', (from, base) => {
      expect(() => toBaseQuantity(1, from, base, none)).toThrow(
        UnitConversionError,
      );
      expect(() => conversionFactor(from, base, none)).toThrow(
        /cannot be converted/,
      );
    });
  });

  describe('per-ingredient pack sizes', () => {
    const flourBag: PackSizes = new Map<Unit, string | number>([
      ['PACK', '25'],
      ['BOX', 50],
    ]); // base KG
    const eggs: PackSizes = new Map<Unit, string | number>([
      ['BOX', 30],
      ['G', '0.02'],
    ]); // base PIECE: tray of 30, ~50 g each

    it('converts packs and boxes into the base unit', () => {
      expect(toBaseQuantity(2, 'PACK', 'KG', flourBag)).toBe(50);
      expect(toBaseQuantity(1.5, 'BOX', 'KG', flourBag)).toBe(75);
      expect(toBaseQuantity(3, 'BOX', 'PIECE', eggs)).toBe(90);
    });

    it('supports cross-dimension sizes (grams of a counted item)', () => {
      expect(toBaseQuantity(100, 'G', 'PIECE', eggs)).toBe(2);
    });

    it('still rejects units the ingredient has no size for', () => {
      expect(() => toBaseQuantity(1, 'L', 'KG', flourBag)).toThrow(
        UnitConversionError,
      );
    });

    it('global conversions are not overridden by pack sizes', () => {
      expect(toBaseQuantity(1, 'G', 'KG', new Map([['G', 5]]))).toBe(0.001);
    });
  });

  describe('unit cost', () => {
    it('converts a per-entered-unit cost to a per-base-unit cost', () => {
      expect(toBaseUnitCost(40, 'KG', 'G', none)).toBe(0.04);
      expect(toBaseUnitCost(1000, 'PACK', 'KG', new Map([['PACK', 25]]))).toBe(
        40,
      );
      expect(toBaseUnitCost(0.04, 'G', 'KG', none)).toBe(40);
    });

    it('keeps 6dp so per-gram costs are not truncated', () => {
      // ₹33.33/kg -> 0.03333/g (4dp would be 0.0333, a 0.09% error)
      expect(toBaseUnitCost(33.33, 'KG', 'G', none)).toBe(0.03333);
    });

    it('rejects incompatible cost conversions', () => {
      expect(() => toBaseUnitCost(10, 'L', 'G', none)).toThrow(
        UnitConversionError,
      );
    });
  });

  describe('validatePackSizes', () => {
    it('accepts package and cross-dimension sizes', () => {
      expect(() =>
        validatePackSizes('KG', [
          { unit: 'PACK', factor: 25 },
          { unit: 'PIECE', factor: 0.25 },
        ]),
      ).not.toThrow();
    });

    it('rejects the base unit itself', () => {
      expect(() =>
        validatePackSizes('KG', [{ unit: 'KG', factor: 1 }]),
      ).toThrow(/base unit/);
    });

    it('rejects sizes that would contradict the global table', () => {
      expect(() =>
        validatePackSizes('KG', [{ unit: 'G', factor: 0.002 }]),
      ).toThrow(/fixed/);
    });

    it('rejects duplicate and non-positive sizes', () => {
      expect(() =>
        validatePackSizes('KG', [
          { unit: 'PACK', factor: 25 },
          { unit: 'PACK', factor: 10 },
        ]),
      ).toThrow(/once/);
      expect(() =>
        validatePackSizes('KG', [{ unit: 'PACK', factor: 0 }]),
      ).toThrow(/positive/);
    });
  });
});

describe('unitConversionSchema factor', () => {
  // ingredient_unit_conversions.factor is DECIMAL(14,6): the stored factor
  // must be exactly what the user entered, never rounded or zeroed.
  const parse = (factor: unknown) =>
    unitConversionSchema.safeParse({ unit: 'PACK', factor });

  it.each([25, 0.5, 0.000001, '0.020000', 1_000_000])('accepts %p', (f) => {
    expect(parse(f).success).toBe(true);
  });

  it.each([0, -1, 0.0000004, 0.0000333, 1.1234567, 1_000_001])(
    'rejects %p',
    (f) => {
      expect(parse(f).success).toBe(false);
    },
  );
});

describe('base-unit identity path', () => {
  it('rounds base-unit entries to 3dp like converted ones', () => {
    expect(toBaseQuantity(1.23456, undefined, 'KG', none)).toBe(1.235);
    expect(toBaseQuantity(1.23456, 'KG', 'KG', none)).toBe(1.235);
  });
  it('rejects a base-unit entry too small to store', () => {
    expect(() => toBaseQuantity(0.0004, undefined, 'KG', none)).toThrow(
      UnitConversionError,
    );
  });
});
