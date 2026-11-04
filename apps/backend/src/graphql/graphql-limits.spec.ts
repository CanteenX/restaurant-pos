import { buildSchema, parse, validate } from 'graphql';
import {
  costLimitRule,
  depthLimitRule,
  validationRules,
} from './graphql-limits';

const schema = buildSchema(`
  type Item { id: ID!, name: String!, children(first: Int): [Item!]! }
  type Query { item: Item!, items(first: Int): [Item!]! }
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
