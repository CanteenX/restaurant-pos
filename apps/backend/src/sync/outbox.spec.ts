import {
  assertWellFormed,
  compact,
  HLC_SHIFT,
  hlcMs,
  isNewer,
  localizePermission,
  nextHlc,
  SyncChange,
} from './outbox';

const ch = (
  seq: number,
  pkKey: string,
  hlc: bigint | number,
  op: 'U' | 'D' = 'U',
  tbl = 'menu_items',
  peer = 'branch-a',
): SyncChange => ({
  seq: String(seq),
  tbl,
  pk: { id: pkKey },
  pkKey,
  op,
  row: op === 'U' ? { id: pkKey, v: seq } : null,
  ts: '2026-11-04T00:00:00.000Z',
  hlc: String(hlc),
  peer,
});

describe('outbox ordering', () => {
  it('nextHlc follows the wall clock and never goes backwards for a row', () => {
    const now = 1_793_800_000_000;
    expect(nextHlc(now)).toBe(BigInt(now) * HLC_SHIFT);
    // A rewound clock (or two edits in the same ms) still moves forward.
    const prev = String(BigInt(now + 5_000) * HLC_SHIFT);
    expect(nextHlc(now, prev)).toBe(BigInt(prev) + 1n);
    expect(hlcMs(String(nextHlc(now, prev)))).toBe(now + 5_000);
  });

  it('compact keeps the newest change per row and returns outbox order', () => {
    const out = compact([
      ch(1, 'a', 10),
      ch(2, 'b', 11),
      ch(3, 'a', 12),
      ch(4, 'c', 13),
      ch(5, 'b', 14),
    ]);
    expect(out.map((c) => c.seq)).toEqual(['3', '4', '5']);
  });

  it('orders by HLC, not by arrival, when a page mixes peers', () => {
    // seq 2 arrived later but carries an older clock: seq 1 still wins.
    const out = compact([ch(1, 'a', 20), ch(2, 'a', 15)]);
    expect(out.map((c) => c.seq)).toEqual(['1']);
  });

  it('treats the same key in different tables as different rows', () => {
    const out = compact([
      ch(1, 'a', 1, 'U', 'orders'),
      ch(2, 'a', 1, 'U', 'tables'),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('outbox tombstones', () => {
  it('a delete beats every older update of the row', () => {
    const out = compact([ch(1, 'a', 10), ch(2, 'a', 11, 'D'), ch(3, 'a', 9)]);
    expect(out).toHaveLength(1);
    expect(out[0].op).toBe('D');
    expect(
      isNewer({ hlc: '9', peer: 'x' }, { hlc: '11', peer: 'y' }, true),
    ).toBe(false);
  });

  it('an update newer than the delete resurrects the row', () => {
    const out = compact([ch(1, 'a', 10, 'D'), ch(2, 'a', 12)]);
    expect(out[0].op).toBe('U');
    expect(
      isNewer({ hlc: '12', peer: 'x' }, { hlc: '10', peer: 'x' }, false),
    ).toBe(true);
  });
});

describe('outbox replay', () => {
  it('replaying the same change is a no-op on either side', () => {
    const v = { hlc: '42', peer: 'branch-a' };
    expect(isNewer(v, v, true)).toBe(false);
    expect(isNewer(v, v, false)).toBe(false);
  });

  it('a true tie between two peers goes to the server side', () => {
    const mine = { hlc: '42', peer: 'branch-a' };
    const theirs = { hlc: '42', peer: 'hq' };
    expect(isNewer(theirs, mine, true)).toBe(true);
    expect(isNewer(mine, theirs, false)).toBe(false);
  });

  it('a row with no known version always takes the change', () => {
    expect(isNewer({ hlc: '1', peer: 'x' }, null, false)).toBe(true);
  });

  it('compacting an already compacted page changes nothing', () => {
    const page = compact([ch(1, 'a', 1), ch(2, 'a', 2), ch(3, 'b', 3)]);
    expect(compact([...page, ...page])).toEqual(page);
  });
});

describe('permission keys (G5)', () => {
  const ids: Record<string, string> = { 'orders.create': 'local-id-7' };
  const change: SyncChange = {
    ...ch(1, '{"roleId": "r1", "permissionKey": "orders.create"}', 5),
    tbl: 'role_permissions',
    pk: { roleId: 'r1', permissionKey: 'orders.create' },
    row: {
      roleId: 'r1',
      permissionId: 'remote-id',
      permissionKey: 'orders.create',
    },
  };

  it('maps the key to this install’s permission id in pk and row', () => {
    const out = localizePermission(change, (k) => ids[k]);
    expect(out.pk).toEqual({ roleId: 'r1', permissionId: 'local-id-7' });
    expect(out.row).toEqual({ roleId: 'r1', permissionId: 'local-id-7' });
    expect(out.pkKey).toBe(change.pkKey);
  });

  it('refuses a permission this install does not know', () => {
    expect(() => localizePermission(change, () => undefined)).toThrow(
      /unknown permission orders.create/,
    );
  });

  it('leaves other tables alone', () => {
    const c = ch(1, 'a', 1);
    expect(localizePermission(c, () => undefined)).toBe(c);
  });
});

describe('wire validation', () => {
  it('rejects changes without a usable clock or peer', () => {
    expect(() =>
      assertWellFormed({ ...ch(1, 'a', 1), hlc: '1; drop' }),
    ).toThrow(/hlc/);
    expect(() => assertWellFormed({ ...ch(1, 'a', 1), peer: '' })).toThrow(
      /peer/,
    );
    expect(() => assertWellFormed({ ...ch(1, 'a', 1), row: null })).toThrow(
      /row/,
    );
    expect(() => assertWellFormed(ch(1, 'a', 1, 'D'))).not.toThrow();
  });
});
