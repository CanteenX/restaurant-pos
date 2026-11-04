import { buildSchema, parse, validate } from 'graphql';
import {
  clampPage,
  costLimitRule,
  depthLimitRule,
  validationRules,
} from './graphql-limits';

const schema = buildSchema(`
  interface Node { id: ID! }
  type Item implements Node {
    id: ID!
    name: String!
    children(first: Int): [Item!]!
    tags(first: Int): [String!]!
  }
  type Query {
    item: Item!
    node: Node!
    items(first: Int): [Item!]!
    many(first: Int = 500): [Item!]!
  }
`);

const errorsFor = (query: string, rules: ReturnType<typeof validationRules>) =>
  validate(schema, parse(query), rules).map((e) => e.message);

describe('depthLimitRule', () => {
  const rules = [depthLimitRule(3)];

  it('allows a query at the limit', () => {
    expect(errorsFor('{ item { children { id } } }', rules)).toEqual([]);
  });

  it('rejects a query deeper than the limit', () => {
    const errs = errorsFor('{ item { children { children { id } } } }', rules);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/depth 4 exceeds the maximum of 3/);
  });

  it('counts depth through fragments and inline fragments', () => {
    const q = `
      { item { ...F } }
      fragment F on Item { children { ... on Item { children { id } } } }
    `;
    expect(errorsFor(q, rules)[0]).toMatch(/depth 4/);
  });

  it('does not count __typename as nesting', () => {
    expect(errorsFor('{ item { children { __typename id } } }', rules)).toEqual(
      [],
    );
  });
});

describe('costLimitRule', () => {
  it('charges one per field', () => {
    expect(errorsFor('{ item { id name } }', [costLimitRule(3)])).toEqual([]);
    expect(errorsFor('{ item { id name } }', [costLimitRule(2)])[0]).toMatch(
      /cost 3 exceeds the maximum of 2/,
    );
  });

  it('multiplies child cost by a list page size', () => {
    // items(first: 10) { id name } = 1 + 10 * 2
    expect(
      errorsFor('{ items(first: 10) { id name } }', [costLimitRule(20)])[0],
    ).toMatch(/cost 21/);
  });

  it('reads page sizes from variables', () => {
    const doc = parse('query Q($n: Int) { items(first: $n) { id } }');
    const errs = validate(schema, doc, [costLimitRule(50, { n: 100 })]);
    expect(errs[0]?.message).toMatch(/cost 101/);
  });

  it('charges an operation variable default when the variable is omitted', () => {
    // Review on #172: $n defaulted to 100000 used to be charged as 1.
    const q = `query Q($n: Int = 100000) {
      items(first: $n) { children(first: $n) { id name } }
    }`;
    expect(errorsFor(q, [costLimitRule(1000)])[0]).toMatch(/exceeds/);
  });

  it('a supplied variable overrides its default', () => {
    const doc = parse('query Q($n: Int = 100000) { items(first: $n) { id } }');
    expect(validate(schema, doc, [costLimitRule(50, { n: 10 })])).toEqual([]);
  });

  it('charges a schema argument default when the argument is omitted', () => {
    // many(first: Int = 500) { id } = 1 + 500 * 1
    expect(errorsFor('{ many { id } }', [costLimitRule(1000)])).toEqual([]);
    expect(errorsFor('{ many { id } }', [costLimitRule(500)])[0]).toMatch(
      /cost 501/,
    );
  });

  it('resolves page arguments on fields reached through fragments', () => {
    const q = `
      query Q($n: Int = 1000) { node { ... on Item { children(first: $n) { id } } ...F } }
      fragment F on Item { children(first: 1000) { id } }
    `;
    // 1 (node) + (1 + 1000) + (1 + 1000)
    expect(errorsFor(q, [costLimitRule(1000)])[0]).toMatch(/cost 2003/);
  });

  it('charges aliases separately (alias bombs)', () => {
    const fields = Array.from({ length: 30 }, (_, i) => `a${i}: item { id }`);
    expect(
      errorsFor(`{ ${fields.join(' ')} }`, [costLimitRule(50)])[0],
    ).toMatch(/cost 60/);
  });

  it('charges a paged list its page size even when the sub-selection is free', () => {
    // Review on #172: __typename-only pages used to cost 1 whatever `first` was.
    // items(first: 100000) { __typename } = 1 + 100000 * max(1, 0)
    expect(
      errorsFor('{ items(first: 100000) { __typename } }', [
        costLimitRule(1000),
      ])[0],
    ).toMatch(/cost 100001 exceeds/);
    expect(
      errorsFor('{ item { children(first: 100000) { __typename } } }', [
        costLimitRule(1000),
      ])[0],
    ).toMatch(/exceeds/);
  });

  it('rejects aliased copies of a free-sub-selection page', () => {
    const fields = Array.from(
      { length: 900 },
      (_, i) => `a${i}: items(first: 100000) { __typename }`,
    );
    expect(
      errorsFor(`{ ${fields.join(' ')} }`, [costLimitRule(1000)])[0],
    ).toMatch(/cost 90000900 exceeds/);
  });

  it('charges a small free-sub-selection page its page size', () => {
    // items(first: 10) { __typename } = 1 + 10
    expect(
      errorsFor('{ items(first: 10) { __typename } }', [costLimitRule(10)])[0],
    ).toMatch(/cost 11/);
  });

  it('applies the page size to a leaf list with a page argument', () => {
    // item { tags(first: 100000) } = 1 + (1 + 100000)
    expect(
      errorsFor('{ item { tags(first: 100000) } }', [costLimitRule(1000)])[0],
    ).toMatch(/cost 100002 exceeds/);
    // item { tags } with no page given = 1 + (1 + 1)
    expect(errorsFor('{ item { tags } }', [costLimitRule(3)])).toEqual([]);
  });

  it('treats an explicit null page like an omitted one', () => {
    // many(first: null) is charged the schema default 500, not 1.
    expect(
      errorsFor('{ many(first: null) { id } }', [costLimitRule(500)])[0],
    ).toMatch(/cost 501/);
    const doc = parse('query Q($n: Int = 100000) { many(first: $n) { id } }');
    expect(
      validate(schema, doc, [costLimitRule(500, { n: null })])[0]?.message,
    ).toMatch(/cost 501/);
    // No schema default: null falls back to a single item.
    expect(
      errorsFor('{ items(first: null) { id } }', [costLimitRule(2)]),
    ).toEqual([]);
  });

  it('expands fragment spreads', () => {
    const q = '{ item { ...F ...F } } fragment F on Item { id name }';
    // spreads of the same fragment are both charged: 1 + 2 + 2
    expect(errorsFor(q, [costLimitRule(4)])[0]).toMatch(/cost 5/);
  });
});

describe('clampPage', () => {
  const opts = { defaultSize: 50, max: 200 };

  it('uses the default when the argument is omitted or null', () => {
    expect(clampPage(undefined, opts)).toBe(50);
    expect(clampPage(null, opts)).toBe(50);
  });

  it('clamps to the server maximum', () => {
    expect(clampPage(100000, opts)).toBe(200);
  });

  it('keeps an in-range value and floors bad values to 1', () => {
    expect(clampPage(20, opts)).toBe(20);
    expect(clampPage(0, opts)).toBe(1);
    expect(clampPage(-5, opts)).toBe(1);
    expect(clampPage(2.5, opts)).toBe(2);
  });
});

describe('validationRules', () => {
  const introspection = '{ __schema { types { name } } }';

  it('blocks introspection in production', () => {
    const errs = errorsFor(
      introspection,
      validationRules({ production: true }),
    );
    expect(errs.some((m) => /introspection/i.test(m))).toBe(true);
  });

  it('allows introspection outside production', () => {
    expect(
      errorsFor(introspection, validationRules({ production: false })),
    ).toEqual([]);
  });
});
