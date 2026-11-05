import {
  assertRowMatchesPk,
  assertWellFormed,
  clockSkewError,
  compact,
  HLC_SHIFT,
  hlcMs,
  isNewer,
  localizePermission,
  MAX_CLOCK_SKEW_MS,
  MAX_HLC_FUTURE_MS,
  nextHlc,
  rejectedChanges,
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

describe('assertWellFormed hlc bounds', () => {
  const now = Date.UTC(2026, 10, 4, 12, 0, 0);
  const at = (ms: number) => (BigInt(ms) * HLC_SHIFT).toString();

  it('rejects an hlc above the bigint range', () => {
    for (const hlc of ['9223372036854775807', '9999999999999999999'])
      expect(() => assertWellFormed({ ...ch(1, 'a', 1), hlc }, now)).toThrow(
        /hlc/,
      );
  });

  it('accepts a few minutes of propagated skew, rejects beyond the loose ceiling', () => {
    // Clocks inside the per-device limit compound through HLCs (a +4 min
    // device's edit reaching a -2 min one): that must not be dead-lettered.
    expect(() =>
      assertWellFormed({ ...ch(1, 'a', 1), hlc: at(now + 10 * 60_000) }, now),
    ).not.toThrow();
    expect(() =>
      assertWellFormed(
        { ...ch(1, 'a', 1), hlc: at(now + MAX_HLC_FUTURE_MS) },
        now,
      ),
    ).not.toThrow();
    expect(() =>
      assertWellFormed(
        { ...ch(1, 'a', 1), hlc: (BigInt(at(now)) + 65_535n).toString() },
        now,
      ),
    ).not.toThrow();
    expect(() =>
      assertWellFormed(
        { ...ch(1, 'a', 1), hlc: at(now + MAX_HLC_FUTURE_MS + 1) },
        now,
      ),
    ).toThrow(/future/);
    // Seed entries carry hlc 0.
    expect(() =>
      assertWellFormed({ ...ch(1, 'a', 1), hlc: '0' }, now),
    ).not.toThrow();
  });
});

describe('clockSkewError', () => {
  const server = Date.UTC(2026, 10, 4, 12, 0, 0);

  it('is null while this PC is within the allowed skew', () => {
    expect(clockSkewError(server, server)).toBeNull();
    expect(clockSkewError(server + MAX_CLOCK_SKEW_MS, server)).toBeNull();
    expect(clockSkewError(server - MAX_CLOCK_SKEW_MS, server)).toBeNull();
  });

  it('says how far and which way the clock is off beyond it', () => {
    expect(clockSkewError(server + 6 * 60_000, server)).toBe(
      "This PC's clock is 6 min ahead of the server; fix the time to resume sync.",
    );
    expect(clockSkewError(server - 6 * 60_000 - 20_000, server)).toBe(
      "This PC's clock is 6 min behind the server; fix the time to resume sync.",
    );
  });

  it('refuses a server that does not report its clock', () => {
    expect(clockSkewError(server, undefined)).toMatch(/clock/);
    expect(clockSkewError(server, Number.NaN)).toMatch(/clock/);
  });
});

describe('rejectedChanges', () => {
  const sent = [ch(1, 'a', 10), ch(2, 'b', 20), ch(3, 'c', 30, 'D')];

  it('matches conflicts to the changes that were sent, by seq first', () => {
    const out = rejectedChanges(sent, [
      { seq: '3', tbl: 'menu_items', pk: 'c', error: 'fk' },
      { seq: '1', tbl: 'menu_items', pk: 'zzz', error: 'unknown table' },
    ]);
    expect(out.map((r) => [r.change?.seq, r.error])).toEqual([
      ['3', 'fk'],
      ['1', 'unknown table'],
    ]);
  });

  it('falls back to table + row when the conflict carries no seq', () => {
    const out = rejectedChanges(sent, [
      { tbl: 'menu_items', pk: 'b', error: 'malformed change' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].change?.seq).toBe('2');
  });

  it('keeps an unmatched conflict as a stub so nothing is silently dropped', () => {
    const out = rejectedChanges(sent, [
      { tbl: 'orders', pk: 'x', error: 'malformed change' },
    ]);
    expect(out).toEqual([
      {
        tbl: 'orders',
        pkKey: 'x',
        change: null,
        error: 'malformed change',
      },
    ]);
  });
});

describe('assertRowMatchesPk (#81 audit)', () => {
  it('accepts a row whose primary key equals pk', () => {
    expect(() => assertRowMatchesPk(ch(1, 'a', 1), ['id'])).not.toThrow();
    expect(() => assertRowMatchesPk(ch(1, 'a', 1, 'D'), ['id'])).not.toThrow();
  });

  it('rejects an update whose row is another row than pk', () => {
    const c = { ...ch(1, 'a', 1), row: { id: 'b', v: 1 } };
    expect(() => assertRowMatchesPk(c, ['id'])).toThrow(
      /row does not match pk/,
    );
  });

  it('rejects a pk missing a key column or holding a non-scalar', () => {
    expect(() =>
      assertRowMatchesPk({ ...ch(1, 'a', 1, 'D'), pk: {} }, ['id']),
    ).toThrow(/pk/);
    expect(() =>
      assertRowMatchesPk({ ...ch(1, 'a', 1, 'D'), pk: { id: { x: 1 } } }, [
        'id',
      ]),
    ).toThrow(/pk/);
    expect(() =>
      assertRowMatchesPk({ ...ch(1, 'a', 1, 'D'), pk: { id: 'a', x: 1 } }, [
        'id',
      ]),
    ).toThrow(/pk/);
  });

  it('matches permission rows by key instead of the sender id', () => {
    const c: SyncChange = {
      ...ch(1, 'k', 1, 'U', 'role_permissions'),
      pk: { roleId: 'r1', permissionKey: 'orders.create' },
      row: {
        roleId: 'r1',
        permissionId: 'sender-id',
        permissionKey: 'orders.create',
      },
    };
    expect(() =>
      assertRowMatchesPk(c, ['roleId', 'permissionId']),
    ).not.toThrow();
    const other = { ...c, row: { ...c.row, permissionKey: 'orders.void' } };
    expect(() => assertRowMatchesPk(other, ['roleId', 'permissionId'])).toThrow(
      /row does not match pk/,
    );
  });
});
