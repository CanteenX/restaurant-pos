import { buildSchema, parse, validate } from 'graphql';
import {
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

  it('expands fragment spreads', () => {
    const q = '{ item { ...F ...F } } fragment F on Item { id name }';
    // spreads of the same fragment are both charged: 1 + 2 + 2
    expect(errorsFor(q, [costLimitRule(4)])[0]).toMatch(/cost 5/);
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
