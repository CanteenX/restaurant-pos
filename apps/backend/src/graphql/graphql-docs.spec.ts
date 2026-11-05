import { readFileSync } from 'fs';
import { parse, validate } from 'graphql';
import { join } from 'path';
import { schema } from './graphql.schema';

// docs/GRAPHQL.md promises its examples work: every ```graphql block must
// parse and validate against the schema the server runs.
const doc = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'docs', 'GRAPHQL.md'),
  'utf8',
);
const blocks = [...doc.matchAll(/```graphql\n([\s\S]*?)```/g)].map((m) => m[1]);

describe('docs/GRAPHQL.md examples', () => {
  it('has examples', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(4);
  });

  it.each(blocks.map((b, i) => [i + 1, b]))(
    'example %i validates against the schema',
    (_n, source) => {
      expect(validate(schema, parse(source))).toEqual([]);
    },
  );
});
