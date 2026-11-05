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

/** Largest HLC Postgres can store, minus room for the trigger's `+ 1`. */
const MAX_HLC = 9_223_372_036_854_775_807n - 1n;
/**
 * Largest gap allowed between this PC's clock and the server's. Beyond it a
 * client cycle stops before pulling or pushing (cursors untouched, nothing
 * pruned) until the time is fixed, instead of dead-lettering real data
 * (#81 review). Every device within it keeps HLCs at most 2x it apart.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/**
 * Per-change ceiling: how far ahead of the receiver's clock an incoming HLC
 * may be. Deliberately loose, so skew propagated through HLCs between
 * devices that each pass the clock check is never rejected; it only stops a
 * broken or hostile device from winning LWW for a row for days.
 */
export const MAX_HLC_FUTURE_MS = 24 * 60 * 60_000;

/** Why this PC must not sync against a server reporting `serverMs`, or null. */
export function clockSkewError(
  localMs: number,
  serverMs: number | undefined,
): string | null {
  if (typeof serverMs !== 'number' || !Number.isFinite(serverMs))
    return 'The server did not report its clock; update it to the same version as this PC.';
  const diff = localMs - serverMs;
  if (Math.abs(diff) <= MAX_CLOCK_SKEW_MS) return null;
  const min = Math.round(Math.abs(diff) / 60_000);
  const way = diff > 0 ? 'ahead of' : 'behind';
  return `This PC's clock is ${min} min ${way} the server; fix the time to resume sync.`;
}

/** Checks a change from the wire before any SQL touches it. */
export function assertWellFormed(c: SyncChange, nowMs = Date.now()): void {
  if (!c || typeof c.tbl !== 'string' || typeof c.pkKey !== 'string')
    throw new Error('malformed change');
  if (c.op !== 'U' && c.op !== 'D') throw new Error('malformed change op');
  if (typeof c.hlc !== 'string' || !/^\d{1,19}$/.test(c.hlc))
    throw new Error('change without a valid hlc');
  const hlc = BigInt(c.hlc);
  if (hlc >= MAX_HLC) throw new Error('change hlc out of range');
  if (
    hlc >
    (BigInt(Math.floor(nowMs + MAX_HLC_FUTURE_MS)) + 1n) * HLC_SHIFT - 1n
  )
    throw new Error('change hlc too far in the future');
  if (typeof c.peer !== 'string' || !c.peer)
    throw new Error('change without a peer');
  if (c.op === 'U' && (!c.row || typeof c.row !== 'object'))
    throw new Error('update without a row');
}

const isScalar = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * The DML keys on `pk`/`row` while LWW and tombstones key on `pkKey`, so the
 * three must name the same row (#81 audit). `pk` holds exactly the table's
 * key columns (permission rows: `permissionKey` in place of the sender's
 * `permissionId`, G5) with scalar values, and an update's row repeats them.
 * The server separately recomputes `pkKey` from `pk` (sync_pk).
 */
export function assertRowMatchesPk(c: SyncChange, pkCols: string[]): void {
  const pk = c.pk;
  if (!pk || typeof pk !== 'object' || Array.isArray(pk))
    throw new Error('malformed pk');
  const cols = pkCols.map((x) =>
    x === 'permissionId' && 'permissionKey' in pk ? 'permissionKey' : x,
  );
  const keys = Object.keys(pk);
  if (keys.length !== cols.length || !cols.every((x) => isScalar(pk[x])))
    throw new Error('malformed pk');
  if (c.op === 'U' && !cols.every((x) => c.row?.[x] === pk[x]))
    throw new Error('row does not match pk');
}

export interface Conflict {
  /** Outbox position of the rejected change on the sender, when known. */
  seq?: string;
  tbl: string;
  pk: string;
  error: string;
  /**
   * HQ's own copy of an HQ-owned row a branch tried to change (or a
   * tombstone if HQ has none), so the branch can put the row back (#83).
   */
  restore?: SyncChange;
}

export interface Rejected {
  tbl: string;
  pkKey: string;
  /** The change as sent, or null when the conflict can't be matched to one. */
  change: SyncChange | null;
  error: string;
}

/**
 * Pairs the conflicts a peer reported with the changes that were sent, so a
 * rejected change is kept (sync_rejected) instead of being pruned with the
 * acknowledged page. Matches by seq, else by table + row.
 */
export function rejectedChanges(
  sent: SyncChange[],
  conflicts: Conflict[],
): Rejected[] {
  return conflicts.map((k) => {
    const change =
      (k.seq !== undefined && sent.find((c) => c.seq === k.seq)) ||
      sent.find((c) => c.tbl === k.tbl && c.pkKey === k.pk) ||
      null;
    return {
      tbl: change?.tbl ?? k.tbl,
      pkKey: change?.pkKey ?? k.pk,
      change,
      error: k.error,
    };
  });
}
