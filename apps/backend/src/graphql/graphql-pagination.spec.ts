import { GraphQLError } from 'graphql';
import {
  decodeCursor,
  encodeCursor,
  keysetWhere,
  toConnection,
  type SortKey,
} from './graphql-pagination';

const byDate: SortKey = { field: 'createdAt', dir: 'desc', kind: 'date' };
const bySort: SortKey = { field: 'sortOrder', dir: 'asc', kind: 'number' };

describe('cursors', () => {
  it('round-trips a date sort key', () => {
    const at = new Date('2026-11-05T07:00:00.000Z');
    const c = encodeCursor(byDate, { createdAt: at, id: 'o1' });
    expect(decodeCursor(byDate, c)).toEqual({ value: at, id: 'o1' });
  });

  it('round-trips a number sort key', () => {
    const c = encodeCursor(bySort, { sortOrder: 3, id: 'm1' });
    expect(decodeCursor(bySort, c)).toEqual({ value: 3, id: 'm1' });
  });

  it.each([
    'not-base64!!',
    Buffer.from('{"x":1}').toString('base64url'),
    Buffer.from('["nope","o1"]').toString('base64url'),
    Buffer.from('[1]').toString('base64url'),
    Buffer.from('[1,2]').toString('base64url'),
  ])('rejects a malformed cursor %s as bad input', (bad) => {
    let err: unknown;
    try {
      decodeCursor(byDate, bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
  });

  it('rejects a cursor whose sort value has the wrong type', () => {
    const c = encodeCursor(bySort, { sortOrder: 3, id: 'm1' });
    expect(() => decodeCursor(byDate, c)).toThrow(GraphQLError);
  });
});

describe('keysetWhere', () => {
  it('is empty on the first page', () => {
    expect(keysetWhere(byDate, null)).toEqual({});
    expect(keysetWhere(byDate, undefined)).toEqual({});
  });

  it('continues strictly after the cursor row (descending)', () => {
    const at = new Date('2026-11-05T07:00:00.000Z');
    const c = encodeCursor(byDate, { createdAt: at, id: 'o5' });
    expect(keysetWhere(byDate, c)).toEqual({
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: 'o5' } }],
    });
  });

  it('continues strictly after the cursor row (ascending)', () => {
    const c = encodeCursor(bySort, { sortOrder: 2, id: 'm9' });
    expect(keysetWhere(bySort, c)).toEqual({
      OR: [{ sortOrder: { gt: 2 } }, { sortOrder: 2, id: { gt: 'm9' } }],
    });
  });
});

describe('toConnection', () => {
  const rows = [1, 2, 3].map((n) => ({ id: `o${n}`, sortOrder: n }));

  it('reports a next page when the extra row came back', () => {
    const conn = toConnection(bySort, rows, 2, (r) => r.id);
    expect(conn.nodes).toEqual(['o1', 'o2']);
    expect(conn.pageInfo.hasNextPage).toBe(true);
    expect(decodeCursor(bySort, conn.pageInfo.endCursor!)).toEqual({
      value: 2,
      id: 'o2',
    });
  });

  it('has no next page and no cursor when empty', () => {
    const conn = toConnection(bySort, [], 2, (r) => r);
    expect(conn).toEqual({
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
  });
});
