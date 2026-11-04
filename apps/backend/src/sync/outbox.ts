/**
 * Pure outbox rules shared by capture, push/pull and apply. The SQL trigger
 * (migration 20261104130000_sync_outbox) stamps the same HLC as nextHlc().
 */

export interface SyncChange {
  /** Outbox position on the sending install (ordering only). */
  seq?: string;
  tbl: string;
  pk: Record<string, unknown>;
  pkKey: string;
  op: 'U' | 'D';
  row: Record<string, unknown> | null;
  /** Writer's wall clock, informational. */
  ts: string;
  /** Hybrid logical clock: (ms << 16) + counter, as a decimal string. */
  hlc: string;
  /** Device id of the install that made the change. */
  peer: string;
  branchId?: string | null;
  schemaVersion?: string | null;
}

export interface RowVersion {
  hlc: string;
  peer: string;
}

export const HLC_SHIFT = 65_536n;

/** Next HLC for a local write: wall clock, or one past the row's last version. */
export function nextHlc(nowMs: number, prev?: string | null): bigint {
  const wall = BigInt(Math.floor(nowMs)) * HLC_SHIFT;
  const after = prev ? BigInt(prev) + 1n : 0n;
  return wall > after ? wall : after;
}

export function hlcMs(hlc: string): number {
  return Number(BigInt(hlc) / HLC_SHIFT);
}

/**
 * Should `incoming` replace the row whose newest known version is `stored`?
 * Same HLC from the same peer is the same change replayed -> no (idempotent).
 * Same HLC from another peer is a true tie -> `tieWins` (the server's side).
 */
export function isNewer(
  incoming: RowVersion,
  stored: RowVersion | null | undefined,
  tieWins: boolean,
): boolean {
  if (!stored) return true;
  const a = BigInt(incoming.hlc);
  const b = BigInt(stored.hlc);
  if (a !== b) return a > b;
  if (incoming.peer === stored.peer) return false;
  return tieWins;
}

const rowKey = (c: SyncChange) => `${c.tbl}\u0000${c.pkKey}`;
const bySeq = (a: SyncChange, b: SyncChange) => {
  if (a.seq === undefined || b.seq === undefined) return 0;
  const x = BigInt(a.seq);
  const y = BigInt(b.seq);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Newest change per row (by HLC; on equal HLC the later log entry wins), in
 * outbox order. A tombstone beats every older update of its row and an update
 * newer than the tombstone resurrects it.
 */
export function compact(changes: SyncChange[]): SyncChange[] {
  const latest = new Map<string, SyncChange>();
  for (const c of changes) {
    const prev = latest.get(rowKey(c));
    if (!prev || BigInt(c.hlc) >= BigInt(prev.hlc)) latest.set(rowKey(c), c);
  }
  return [...latest.values()].sort(bySeq);
}

/**
 * Permission rows travel with the permission key instead of this install's
 * `permissions.id` (G5). Maps the key back to the receiving install's id.
 */
export function localizePermission(
  c: SyncChange,
  idByKey: (key: string) => string | undefined,
): SyncChange {
  const key = c.pk.permissionKey ?? c.row?.permissionKey;
  if (key === undefined) return c;
  if (typeof key !== 'string') throw new Error('invalid permissionKey');
  const id = idByKey(key);
  if (!id) throw new Error(`unknown permission ${key}`);
  const pk: Record<string, unknown> = { ...c.pk, permissionId: id };
  delete pk.permissionKey;
  let row = c.row;
  if (row) {
    row = { ...row, permissionId: id };
    delete row.permissionKey;
  }
  return { ...c, pk, row };
}

/** Checks a change from the wire before any SQL touches it. */
export function assertWellFormed(c: SyncChange): void {
  if (!c || typeof c.tbl !== 'string' || typeof c.pkKey !== 'string')
    throw new Error('malformed change');
  if (c.op !== 'U' && c.op !== 'D') throw new Error('malformed change op');
  if (typeof c.hlc !== 'string' || !/^\d{1,19}$/.test(c.hlc))
    throw new Error('change without a valid hlc');
  if (typeof c.peer !== 'string' || !c.peer)
    throw new Error('change without a peer');
  if (c.op === 'U' && (!c.row || typeof c.row !== 'object'))
    throw new Error('update without a row');
}
