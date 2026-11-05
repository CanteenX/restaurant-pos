import { GraphQLError } from 'graphql';

// Keyset (cursor) pagination. A cursor is an opaque base64url encoding of the
// last row's sort value and id; the next page is "strictly after" that pair,
// so rows inserted meanwhile never shift or repeat a page. The cursor is only
// a position: the tenant filter is always applied on top of it, so a cursor
// copied from another tenant's response just yields an empty or unrelated
// page of the caller's own data, never another tenant's rows.

export type SortKey = Readonly<{
  field: string;
  dir: 'asc' | 'desc';
  kind: 'date' | 'number';
}>;

export type Position = { value: Date | number; id: string };

export type Connection<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export function encodeCursor(key: SortKey, row: object): string {
  const r = row as Record<string, unknown>;
  const v = r[key.field];
  const value = v instanceof Date ? v.toISOString() : Number(v);
  return Buffer.from(JSON.stringify([value, r.id])).toString('base64url');
}

export function decodeCursor(key: SortKey, cursor: string): Position {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw badCursor();
  const [raw, id] = parsed as unknown[];
  if (typeof id !== 'string' || !id) throw badCursor();
  if (key.kind === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw badCursor();
    return { value: raw, id };
  }
  const at = typeof raw === 'string' ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) throw badCursor();
  return { value: at, id };
}

/** Prisma `where` fragment for the rows after `after` (empty = first page). */
export function keysetWhere(
  key: SortKey,
  after: string | null | undefined,
): Record<string, unknown> {
  if (!after) return {};
  const { value, id } = decodeCursor(key, after);
  const op = key.dir === 'desc' ? 'lt' : 'gt';
  return {
    OR: [
      { [key.field]: { [op]: value } },
      { [key.field]: value, id: { [op]: id } },
    ],
  };
}

export function keysetOrderBy(key: SortKey) {
  return [{ [key.field]: key.dir }, { id: key.dir }];
}

/**
 * `rows` must be fetched with `take: size + 1`: the extra row only tells us
 * whether a next page exists and is never returned.
 */
export function toConnection<R extends object, T>(
  key: SortKey,
  rows: R[],
  size: number,
  map: (row: R) => T,
): Connection<T> {
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    nodes: page.map(map),
    pageInfo: {
      hasNextPage: rows.length > size,
      endCursor: last ? encodeCursor(key, last) : null,
    },
  };
}

function badCursor() {
  return new GraphQLError('Invalid pagination cursor', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}
