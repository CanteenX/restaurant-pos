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
   * `null`: restaurant-wide or a delete.
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
  if (i.op === 'D') return ok;
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
      if (c.tbl === d.table && typeof c.row.id === 'string') ids.add(c.row.id);
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
