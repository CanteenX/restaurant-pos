/**
 * Pure apply rules for multi-branch sync (#82, docs/MULTI-BRANCH-SYNC.md
 * §4.4): ownership, schema skew, derived-balance targets, order
 * reconciliation at HQ and retry backoff. No I/O, so every rule is unit
 * tested in apply.spec.ts; apply.ts feeds them what it reads from the DB.
 */
import { DERIVED } from './derived';
import { SyncChange } from './outbox';
import { SYNC_TABLES, SyncTable } from './tables';

export type Verdict =
  { ok: true } | { ok: false; retry: boolean; error: string };

export interface OwnershipInput {
  /** The install applying the change: HQ (server) or a branch (client). */
  receiver: 'hq' | 'branch';
  tbl: string;
  table: SyncTable | undefined;
  op: 'U' | 'D';
  /** The row already exists on the receiver (or has a version there). */
  exists: boolean;
  /**
   * Branch of the incoming row, resolved on the receiver (through parent
   * rows for child tables). `undefined`: a parent row is not there yet;
   * `null`: restaurant-wide. For a delete at HQ: the branch from the pk when
   * it holds the branch column, else the sender's claim.
   */
  newBranch: string | null | undefined;
  /** Branch of the receiver's current version of the row, if known. */
  currentBranch: string | null | undefined;
  /** Second branch the row is routed to (stock transfer destination). */
  routedBranch: string | null;
  /** HQ: branches the sending peer owns. Branch: branches this install owns. */
  branches: string[];
}

const ok: Verdict = { ok: true };
const no = (error: string, retry = false): Verdict => ({
  ok: false,
  retry,
  error,
});

/** Rule 1: a change for a row the sender does not own is never applied. */
export function ownership(i: OwnershipInput): Verdict {
  const t = i.table;
  if (!t) return no(`not-synced: ${i.tbl}`);
  if (i.receiver === 'branch') {
    if (t.owner === 'hq') return ok;
    // A branch only takes its own rows back (restore), plus transfers sent
    // to it; never other branches' orders, customers or audit trail.
    const mine = (b: string | null | undefined) =>
      !!b && i.branches.includes(b);
    if (i.op === 'U' && i.newBranch === undefined)
      return no('waiting for parent row', true);
    const branch = i.op === 'D' ? i.currentBranch : i.newBranch;
    if (mine(branch) || mine(i.routedBranch)) return ok;
    return no(`not-owner: row belongs to branch ${branch ?? 'none'}`);
  }
  if (t.owner === 'hq') return no(`not-owner: ${i.tbl} is HQ-owned`);
  if (!t.branch) {
    // Restaurant-wide branch rows (audit trail): append-only inserts.
    if (i.op === 'U' && !i.exists) return ok;
    return no(`not-owner: ${i.tbl} is append-only`);
  }
  if (i.exists && i.currentBranch && !i.branches.includes(i.currentBranch))
    return no(`not-owner: row belongs to branch ${i.currentBranch}`);
  if (i.op === 'D') {
    // A delete of a row HQ doesn't hold (or whose branch it can't tell)
    // goes by the branch resolved here: it must be one of the peer's, or a
    // tombstone would claim another branch's row for good (#209 audit).
    const b = i.currentBranch ?? i.newBranch;
    if (b && i.branches.includes(b)) return ok;
    return no(`not-owner: row belongs to branch ${b ?? 'none'}`);
  }
  if (i.newBranch === undefined) return no('waiting for parent row', true);
  if (!i.newBranch || !i.branches.includes(i.newBranch))
    return no(`not-owner: row belongs to branch ${i.newBranch ?? 'none'}`);
  return ok;
}

export type Skew = 'same' | 'older' | 'newer';

/**
 * Migration names start with a UTC timestamp, so they order as strings.
 * Entries without a version predate #81 and count as older.
 */
export function schemaSkew(
  change: string | null | undefined,
  local: string,
): Skew {
  if (!change || change < local) return 'older';
  return change === local ? 'same' : 'newer';
}

/**
 * Columns an upsert writes: the ones the change carries and this table has,
 * minus stripped ones. A change from an older schema lacks newer columns;
 * leaving them out keeps their default / current value instead of writing
 * NULL (§4.6). A newer sender's columns can't be stored here, so the change
 * is refused rather than silently losing them.
 */
export function columnsToWrite(a: {
  rowKeys: string[];
  cols: string[];
  pk: string[];
  strip: string[];
  skew: Skew;
}): string[] {
  if (a.skew === 'newer')
    throw new Error('change from a newer app version; update this install');
  const keys = new Set(a.rowKeys);
  for (const k of a.pk)
    if (!keys.has(k)) throw new Error(`row missing key column ${k}`);
  const strip = new Set(a.strip);
  return a.cols.filter((c) => keys.has(c) && !strip.has(c));
}

/** `table.column` -> ids whose derived balance must be recomputed. */
export function derivedTargets(
  changes: SyncChange[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const d of DERIVED) out.set(`${d.table}.${d.column}`, new Set());
  for (const c of changes) {
    if (c.op !== 'U' || !c.row) continue;
    for (const d of DERIVED) {
      const ids = out.get(`${d.table}.${d.column}`)!;
      const key = c.row[d.key];
      if (c.tbl === d.table && typeof key === 'string') ids.add(key);
      const fk = c.row[d.fk];
      if (c.tbl === d.ledger && typeof fk === 'string') ids.add(fk);
    }
  }
  return out;
}

type Money = string | number | { toString(): string };
const paise = (v: Money | null | undefined) => Math.round(Number(v ?? 0) * 100);
const fmt = (p: number) => (p / 100).toFixed(2);
const sum = (rows: Money[]) => rows.reduce<number>((s, v) => s + paise(v), 0);

export interface OrderMoney {
  status: string;
  subtotal: Money;
  discountAmount: Money;
  loyaltyDiscountAmount: Money;
  tipAmount: Money;
  deliveryFee: Money;
  totalAmount: Money;
}

/**
 * HQ never reprices a branch's settled order (rule 7) but checks that it is
 * internally consistent, with the same tax-inclusive arithmetic as
 * settlement.ts: lines add up to the subtotal, the total follows from it,
 * and payments settle it. Only PAID orders are judged; an open order is
 * still being built. Returns the problems found (empty = consistent).
 */
export function orderProblems(
  o: OrderMoney,
  items: { lineTotal: Money }[],
  payments: { amount: Money }[],
  refunds: { amount: Money }[],
): string[] {
  if (o.status !== 'PAID') return [];
  const problems: string[] = [];
  const lines = sum(items.map((i) => i.lineTotal));
  const subtotal = paise(o.subtotal);
  const total = paise(o.totalAmount);
  if (lines !== subtotal)
    problems.push(
      `line items add up to ${fmt(lines)}, order subtotal is ${fmt(subtotal)}`,
    );
  const expected =
    subtotal -
    paise(o.discountAmount) -
    paise(o.loyaltyDiscountAmount) +
    paise(o.tipAmount) +
    paise(o.deliveryFee);
  if (expected !== total)
    problems.push(
      `total ${fmt(total)} should be ${fmt(expected)} (subtotal - discounts - loyalty + tip + delivery)`,
    );
  const paid = sum(payments.map((p) => p.amount));
  if (paid !== total)
    problems.push(
      `payments add up to ${fmt(paid)}, order total is ${fmt(total)}`,
    );
  const refunded = sum(refunds.map((r) => r.amount));
  if (refunded > paid)
    problems.push(
      `refunds add up to ${fmt(refunded)}, more than the ${fmt(paid)} paid`,
    );
  return problems;
}

/** URL with host case and trailing slashes normalised; null if invalid. */
function serverId(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * The stored peer key proves a re-registration, but only to the HQ that
 * issued it; re-pointing to another (or mistyped) server never sends it.
 */
export function keyForServer(
  s: { serverUrl: string | null; peerKey: string | null },
  serverUrl: string,
): string | null {
  if (!s.peerKey || !s.serverUrl) return null;
  const a = serverId(s.serverUrl);
  return a !== null && a === serverId(serverUrl) ? s.peerKey : null;
}

export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 10 * 60_000;

/** Wait before the next attempt after `failures` failed cycles in a row. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
}

/** What the server's pull filter needs to know about the classification. */
export function pullScope(tables = SYNC_TABLES) {
  const names = Object.keys(tables).sort();
  return {
    hqTables: names.filter((t) => tables[t].owner === 'hq'),
    routed: names
      .filter((t) => tables[t].routeTo)
      .map((t) => ({ tbl: t, col: tables[t].routeTo! })),
  };
}

/**
 * A lock wait the applier should yield on instead of reporting: a deadlock
 * (40P01), its own lock_timeout (55P03) or a serialization failure (40001).
 */
export function isContended(message: string): boolean {
  return /deadlock detected|40P01|lock timeout|55P03|could not serialize|40001/.test(
    message,
  );
}

/** Backoff before re-trying a contended slice: 100 ms doubling, jittered. */
export function yieldDelayMs(attempt: number, rand = Math.random): number {
  const base = 100 * 2 ** Math.min(attempt, 4);
  return Math.round(base * (0.75 + rand() / 2));
}

/**
 * Rows this install does not own are the owner's to decide (#83). A branch
 * that edited an HQ-owned row anyway has its own version on top; HQ's next
 * value (or the restore HQ sends back when it rejects that edit) must still
 * apply, so the receiver's own versions of such rows are ignored by LWW.
 * Returns the peer id whose versions to ignore, or null for plain LWW.
 */
export function ownerWinsOver(
  receiver: 'hq' | 'branch',
  table: SyncTable | undefined,
  localPeer: string | undefined,
): string | null {
  if (receiver !== 'branch' || !table || !localPeer) return null;
  return table.owner === 'hq' ? localPeer : null;
}

/**
 * How many changes (in order) fit one push body of at most `maxBytes` as
 * JSON, at least one. HQ's body limit (BODY_LIMIT, 100 kB by default) would
 * otherwise refuse a page of large rows with HTTP 413 on every cycle (#83).
 */
export function fitPushPage(changes: SyncChange[], maxBytes: number): number {
  let size = '{"changes":[]}'.length;
  for (let i = 0; i < changes.length; i++) {
    size += JSON.stringify(changes[i]).length + (i ? 1 : 0);
    if (size > maxBytes) return Math.max(i, 1);
  }
  return changes.length;
}
