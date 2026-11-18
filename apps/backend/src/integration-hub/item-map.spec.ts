import { integrationItemMapPatchSchema } from '@nventra/types';
import { mergeItemMap } from './item-map';

describe('mergeItemMap', () => {
  const stored = { a: 'Z-1', b: 'Z-2' };

  it('adds and changes only the given dishes, keeping the rest', () => {
    expect(
      mergeItemMap(stored, { set: { b: 'Z-20', c: 'Z-3' }, remove: [] }),
    ).toEqual({
      a: 'Z-1',
      b: 'Z-20',
      c: 'Z-3',
    });
  });

  it('removes only the listed dishes', () => {
    expect(mergeItemMap(stored, { set: {}, remove: ['a', 'missing'] })).toEqual(
      {
        b: 'Z-2',
      },
    );
  });

  it('starts from an empty map when nothing is stored', () => {
    expect(mergeItemMap(undefined, { set: { a: 'Z-1' }, remove: [] })).toEqual({
      a: 'Z-1',
    });
  });

  it('never mutates the stored map', () => {
    const copy = { ...stored };
    mergeItemMap(stored, { set: { a: 'X' }, remove: ['b'] });
    expect(stored).toEqual(copy);
  });

  it('refuses two dishes on one platform item id, including stored ones', () => {
    expect(() =>
      mergeItemMap(stored, { set: { c: 'Z-1' }, remove: [] }),
    ).toThrow(/same platform item id/);
    // Freed by the same patch, so it is fine.
    expect(mergeItemMap(stored, { set: { c: 'Z-1' }, remove: ['a'] })).toEqual({
      b: 'Z-2',
      c: 'Z-1',
    });
  });
});

describe('integrationItemMapPatchSchema', () => {
  it('trims ids and defaults missing parts', () => {
    expect(
      integrationItemMapPatchSchema.parse({ set: { ' a ': ' Z-1 ' } }),
    ).toEqual({
      set: { a: 'Z-1' },
      remove: [],
    });
  });

  it('refuses an empty patch and an item both set and removed', () => {
    expect(integrationItemMapPatchSchema.safeParse({}).success).toBe(false);
    expect(
      integrationItemMapPatchSchema.safeParse({
        set: { a: 'Z' },
        remove: ['a'],
      }).success,
    ).toBe(false);
  });
});
