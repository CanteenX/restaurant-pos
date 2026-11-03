import { diffFields } from './audit-diff';

describe('diffFields', () => {
  it('returns only touched fields whose value changed', () => {
    expect(
      diffFields(
        { name: 'A', phone: '1', email: null },
        { name: 'B', phone: '1', email: 'x@y.z' },
      ),
    ).toEqual({
      name: { before: 'A', after: 'B' },
      email: { before: null, after: 'x@y.z' },
    });
  });
  it('ignores undefined and unchanged values, normalises decimals', () => {
    const dec = { toNumber: () => 2 };
    expect(
      diffFields({ cost: dec, n: 'a' }, { cost: 2, n: undefined }),
    ).toEqual({});
  });
});
