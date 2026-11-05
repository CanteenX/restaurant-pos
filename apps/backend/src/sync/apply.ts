import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  columnsToWrite,
  derivedTargets,
  isContended,
  orderProblems,
  ownerWinsOver,
  ownership,
  schemaSkew,
  yieldDelayMs,
} from './apply-rules';
import { DERIVED } from './derived';
import {
  assertRowMatchesPk,
  assertWellFormed,
  compact,
  Conflict,
  localizePermission,
  nextHlc,
  SyncChange,
} from './outbox';
import { syncTable } from './tables';

export interface ApplyResult {
  applied: number;
  skipped: number;
  conflicts: Conflict[];
}

/** Who is applying, on whose behalf (docs/MULTI-BRANCH-SYNC.md §4.4). */
export interface ApplyContext {
  /** Recorded as the outbox origin; '__skip' applies without logging. */
  origin: string;
  /** On an exact HLC tie from another peer, the incoming change wins. */
  tieWins: boolean;
  /** 'hq' applies a branch push; 'branch' applies a pull from HQ. */
  receiver: 'hq' | 'branch';
  /** HQ: branches the pushing peer owns. Branch: branches this install owns. */
  branches: string[];
  /**
   * Branch: this install's device id. Its own versions of rows it doesn't
   * own lose to the owner's changes (ownerWinsOver).
   */
  localPeer?: string;
}

interface TableMeta {
  pk: string[];
  cols: string[];
}

type Tx = Prisma.TransactionClient;
type Opts = ApplyContext & {
  schema: string;
  deviceId: string;
  permissionId: (key: string) => string | undefined;
};

const PAGE = 200;
/** Longest the applier waits for a row a local writer holds (lock_timeout). */
const LOCK_WAIT = '500ms';
/** Tries per slice before its changes wait for a later pass. */
const SLICE_TRIES = 5;

interface SliceResult extends ApplyResult {
  retry: SyncChange[];
}

/** A lock wait the applier gave up on: the whole slice is rolled back. */
class Contended extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_PASSES = 6;
/** Errors a later pass may get past: a parent row still to come. */
const RETRYABLE = /violates foreign key|23503|waiting for parent row/;

/**
 * Applies changes from a peer: last-writer-wins per row by HLC against
 * sync_versions (#81), ownership (rule 1) before any write, columns limited
 * to what the change carries (schema skew, §4.6), derived balances
 * recomputed from their ledger (rule 5) and, at HQ, settled orders checked
 * for consistency (rule 7 audit). Rows arrive in arbitrary table order, so a
 * change whose parent hasn't arrived yet is retried in later passes.
 */
export class SyncApplier {
  private meta: Map<string, TableMeta> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly schemaVersion: () => Promise<string>,
  ) {}

  resetMeta() {
    this.meta = null;
  }

  async apply(changes: SyncChange[], ctx: ApplyContext): Promise<ApplyResult> {
    const meta = await this.tableMeta();
    const result: ApplyResult = { applied: 0, skipped: 0, conflicts: [] };
    const perms = new Map(
      (
        await this.prisma.$queryRawUnsafe<{ key: string; id: string }[]>(
          `SELECT key, id FROM permissions`,
        )
      ).map((p) => [p.key, p.id]),
    );
    const [{ deviceId }] = await this.prisma.$queryRawUnsafe<
      { deviceId: string }[]
    >(`SELECT "deviceId" FROM sync_state WHERE id = 1`);
    const opts: Opts = {
      ...ctx,
      deviceId,
      schema: await this.schemaVersion(),
      permissionId: (k) => perms.get(k),
    };
    let pending: SyncChange[] = [];
    for (const c of changes) {
      try {
        assertWellFormed(c);
        pending.push(c);
      } catch (e) {
        result.conflicts.push(conflictOf(c, e));
      }
    }
    pending = compact(pending);

    for (let pass = 0; pass < MAX_PASSES && pending.length; pass++) {
      const retry: SyncChange[] = [];
      // Deletes after upserts keeps cascades from removing rows a later
      // upsert in the same batch re-creates.
      const ordered = [...pending].sort(
        (a, b) => Number(a.op === 'D') - Number(b.op === 'D'),
      );
      for (let i = 0; i < ordered.length; i += PAGE) {
        const slice = ordered.slice(i, i + PAGE);
        const r = await this.applySliceYielding(slice, meta, opts, pass);
        result.applied += r.applied;
        result.skipped += r.skipped;
        result.conflicts.push(...r.conflicts);
        retry.push(...r.retry);
      }
      pending = retry;
    }
    return result;
  }

  /**
   * One slice in one transaction. The applier never makes the till wait
   * (#82 review): it gives up on a lock after LOCK_WAIT, and on that or a
   * deadlock the whole slice rolls back (freeing every row it had locked)
   * and is tried again after a short backoff. Postgres would otherwise pick
   * either side of a deadlock, often the POS write.
   */
  private async applySliceYielding(
    slice: SyncChange[],
    meta: Map<string, TableMeta>,
    opts: Opts,
    pass: number,
  ): Promise<SliceResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.applySlice(slice, meta, opts, pass);
      } catch (e) {
        if (!(e instanceof Contended)) throw e;
        if (attempt + 1 < SLICE_TRIES) {
          await sleep(yieldDelayMs(attempt));
          continue;
        }
        // Still contended: a later pass, or a retryable conflict.
        if (pass < MAX_PASSES - 1)
          return { applied: 0, skipped: 0, conflicts: [], retry: slice };
        return {
          applied: 0,
          skipped: 0,
          conflicts: slice.map((c) => conflictOf(c, e)),
          retry: [],
        };
      }
    }
  }

  private applySlice(
    slice: SyncChange[],
    meta: Map<string, TableMeta>,
    opts: Opts,
    pass: number,
  ): Promise<SliceResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const r: SliceResult = {
          applied: 0,
          skipped: 0,
          conflicts: [],
          retry: [],
        };
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_WAIT}'`);
        const done: SyncChange[] = [];
        for (const c of slice) {
          await tx.$executeRawUnsafe('SAVEPOINT sp');
          try {
            const did = await this.applyOne(tx, c, meta, opts);
            if (did) {
              r.applied++;
              done.push(c);
            } else r.skipped++;
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT sp');
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Rolling back to the savepoint keeps the slice's other locks.
            if (isContended(msg)) throw new Contended(msg);
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sp');
            if (RETRYABLE.test(msg) && pass < MAX_PASSES - 1) r.retry.push(c);
            else
              r.conflicts.push({
                ...conflictOf(c, e),
                ...(await this.restoreFor(tx, c, msg, meta, opts)),
              });
          }
        }
        // These lock parent rows too (#209 audit): a till holding one must
        // make the slice yield, not fail the whole push or pull.
        try {
          await this.recomputeDerived(tx, done);
          if (opts.receiver === 'hq') await this.checkOrders(tx, done, opts);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw isContended(msg) ? new Contended(msg) : e;
        }
        return r;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  }

  private async applyOne(
    tx: Tx,
    wire: SyncChange,
    meta: Map<string, TableMeta>,
    opts: Opts,
  ): Promise<boolean> {
    const t = meta.get(wire.tbl);
    // Classified on the sender but not here: report it, don't guess.
    if (!t || !t.pk.length) throw new Error(`unknown table ${wire.tbl}`);
    assertRowMatchesPk(wire, t.pk);
    const skew = schemaSkew(wire.schemaVersion, opts.schema);
    if (wire.op === 'U' && skew === 'newer')
      throw new Error('change from a newer app version; update this install');
    await this.lockApplyKey(tx, wire, t);
    const c = localizePermission(wire, opts.permissionId);
    // A local writer of this row commits before the LWW check reads its
    // version (#81 audit): the row lock is taken first.
    let branch: string | null = null;
    for (let attempt = 0; ; attempt++) {
      const exists = await this.lockRow(tx, c, t);
      if (!(await this.isNewer(tx, c, opts))) return false;
      branch = await this.assertOwner(tx, c, t, exists, opts);
      await tx.$queryRawUnsafe(
        `SELECT set_config('app.sync_origin', $1, true), set_config('app.sync_ts', $2, true),
                set_config('app.sync_hlc', $3, true), set_config('app.sync_peer', $4, true)`,
        opts.origin,
        c.ts,
        c.hlc,
        c.peer,
      );
      if (c.op === 'D' && !exists)
        return this.deleteAbsent(tx, c, t, opts, branch);
      if (await this.writeRow(tx, c, t, exists, opts)) break;
      if (attempt) throw new Error('row changed twice during apply');
    }
    // The trigger records the version when a row changed; a delete of a row
    // this install never had still needs its tombstone. Never lowers it.
    await tx.$executeRawUnsafe(
      `INSERT INTO sync_versions (tbl, "pkKey", hlc, peer, deleted, "branchId", ts)
       VALUES ($1, $2, $3::bigint, $4, $5, $6, $7::timestamptz)
       ON CONFLICT (tbl, "pkKey") DO UPDATE SET hlc = EXCLUDED.hlc, peer = EXCLUDED.peer,
         deleted = EXCLUDED.deleted, "branchId" = coalesce(EXCLUDED."branchId", sync_versions."branchId"), ts = EXCLUDED.ts
       WHERE EXCLUDED.hlc >= sync_versions.hlc`,
      c.tbl,
      c.pkKey,
      c.hlc,
      c.peer,
      c.op === 'D',
      branch,
      c.ts,
    );
    return true;
  }

  /**
   * Rule 1, resolved on this install: the incoming row's branch (through its
   * parent rows here, never the sender's `branchId` claim) and the branch of
   * the row as this install has it, so a row can't be moved between branches.
   * Returns that branch: the one stored on the version, never the wire's.
   */
  private async assertOwner(
    tx: Tx,
    c: SyncChange,
    t: TableMeta,
    exists: boolean,
    opts: Opts,
  ): Promise<string | null> {
    const table = syncTable(c.tbl);
    const cur = await this.currentBranchOf(tx, c, t, exists);
    let newBranch: string | null | undefined = null;
    if (c.op === 'U' && table?.branch) {
      const [n] = await tx.$queryRawUnsafe<{ b: string | null }[]>(
        `SELECT sync_branch_of($1, $2::jsonb) AS b`,
        c.tbl,
        JSON.stringify(c.row),
      );
      // A child's branch comes from its parent; absent parent = not yet here.
      newBranch = n.b ?? ('via' in table.branch ? undefined : null);
    } else if (c.op === 'D' && table?.branch && cur?.b == null) {
      // A row HQ doesn't hold: its pk names the branch when the branch
      // column is part of it; otherwise ownership checks the claim (#209).
      newBranch = await this.branchOfPk(tx, c, opts);
    }
    const routed = table?.routeTo ? c.row?.[table.routeTo] : null;
    const v = ownership({
      receiver: opts.receiver,
      tbl: c.tbl,
      table,
      op: c.op,
      exists: exists || cur !== undefined,
      newBranch,
      currentBranch: cur?.b ?? undefined,
      routedBranch: typeof routed === 'string' ? routed : null,
      branches: opts.branches,
    });
    if (!v.ok) throw new Error(v.error);
    return (c.op === 'D' ? cur?.b : undefined) ?? newBranch ?? null;
  }

  /** The row's branch as this install has it (row, else its version). */
  private async currentBranchOf(
    tx: Tx,
    c: SyncChange,
    t: TableMeta,
    exists: boolean,
  ): Promise<{ b: string | null } | undefined> {
    const tbl = q(c.tbl);
    const pkCols = t.pk.map(q).join(', ');
    const [cur] = exists
      ? await tx.$queryRawUnsafe<{ b: string | null }[]>(
          `SELECT sync_branch_of($1, to_jsonb(r)) AS b FROM ${tbl} r
            WHERE (${pkCols}) = (SELECT ${pkCols} FROM jsonb_populate_record(NULL::${tbl}, $2::jsonb))`,
          c.tbl,
          JSON.stringify(c.pk),
        )
      : await tx.$queryRawUnsafe<{ b: string | null }[]>(
          `SELECT "branchId" AS b FROM sync_versions WHERE tbl = $1 AND "pkKey" = $2`,
          c.tbl,
          c.pkKey,
        );
    return cur;
  }

  /** A delete's branch from its pk; at HQ, else the claim ownership checks. */
  private async branchOfPk(tx: Tx, c: SyncChange, opts: Opts) {
    const [p] = await tx.$queryRawUnsafe<{ b: string | null }[]>(
      `SELECT sync_branch_of($1, $2::jsonb) AS b`,
      c.tbl,
      JSON.stringify(c.pk),
    );
    if (p.b) return p.b;
    return opts.receiver === 'hq' ? (c.branchId ?? null) : null;
  }

  /**
   * A delete of a row that was absent when locked. A local transaction may
   * be creating it right now: its uncommitted row is invisible to DELETE, but
   * its version row is not, so the tombstone upsert waits for it and then
   * re-runs the LWW check against that version (#81 review 4).
   */
  private async deleteAbsent(
    tx: Tx,
    c: SyncChange,
    t: TableMeta,
    opts: Opts,
    branch: string | null,
  ): Promise<boolean> {
    const won = await tx.$queryRawUnsafe<unknown[]>(
      `INSERT INTO sync_versions AS v (tbl, "pkKey", hlc, peer, deleted, "branchId", ts)
       VALUES ($1, $2, $3::bigint, $4, true, $5, $6::timestamptz)
       ON CONFLICT (tbl, "pkKey") DO UPDATE SET hlc = EXCLUDED.hlc, peer = EXCLUDED.peer,
         deleted = true, "branchId" = coalesce(EXCLUDED."branchId", v."branchId"), ts = EXCLUDED.ts
       WHERE ($8::text IS NOT NULL AND v.peer = $8)
          OR NOT (v.hlc > EXCLUDED.hlc OR (v.hlc = EXCLUDED.hlc AND (v.peer = EXCLUDED.peer OR NOT $7::boolean)))
       RETURNING 1`,
      c.tbl,
      c.pkKey,
      c.hlc,
      c.peer,
      branch,
      c.ts,
      opts.tieWins,
      this.ignoredPeer(c, opts),
    );
    if (!won.length) return false;
    if (await this.lockRow(tx, c, t)) await this.writeRow(tx, c, t, true, opts);
    return true;
  }

  /**
   * Recomputes the row key as the sender's trigger did (sync_pk on the wire
   * pk) and serialises every apply of this row until commit (#81 audit).
   */
  private async lockApplyKey(tx: Tx, wire: SyncChange, t: TableMeta) {
    const [{ k }] = await tx.$queryRawUnsafe<{ k: string }[]>(
      `SELECT x.k FROM (SELECT sync_pk($1::text[], $2::jsonb)::text AS k) x,
         LATERAL (SELECT pg_advisory_xact_lock(hashtext('sync_row'), hashtext($3 || chr(1) || x.k))) l`,
      t.pk,
      JSON.stringify(wire.pk),
      wire.tbl,
    );
    if (k !== wire.pkKey) throw new Error('pkKey does not match pk');
  }

  /** Locks the target row (waiting out any open writer); false if absent. */
  private async lockRow(tx: Tx, c: SyncChange, t: TableMeta) {
    const tbl = q(c.tbl);
    const pkCols = t.pk.map(q).join(', ');
    const r = await tx.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM ${tbl} WHERE (${pkCols}) = (SELECT ${pkCols} FROM jsonb_populate_record(NULL::${tbl}, $1::jsonb)) FOR UPDATE`,
      JSON.stringify(c.pk),
    );
    return r.length > 0;
  }

  private async isNewer(tx: Tx, c: SyncChange, opts: Opts) {
    const r = await tx.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT NOT EXISTS (
         SELECT 1 FROM sync_versions WHERE tbl = $1 AND "pkKey" = $2
            AND ($6::text IS NULL OR peer <> $6)
            AND (hlc > $3::bigint OR (hlc = $3::bigint AND (peer = $4 OR NOT $5::boolean)))) AS ok`,
      c.tbl,
      c.pkKey,
      c.hlc,
      c.peer,
      opts.tieWins,
      this.ignoredPeer(c, opts),
    );
    return r[0].ok;
  }

  private ignoredPeer(c: SyncChange, opts: Opts) {
    return ownerWinsOver(opts.receiver, syncTable(c.tbl), opts.localPeer);
  }

  /**
   * HQ rejecting a branch's change to an HQ-owned row answers with its own
   * copy of the row (or a tombstone when it has none), so the branch puts
   * the row back instead of keeping a value HQ will never take (#83).
   */
  private async restoreFor(
    tx: Tx,
    wire: SyncChange,
    msg: string,
    meta: Map<string, TableMeta>,
    opts: Opts,
  ): Promise<{ restore?: SyncChange }> {
    const t = meta.get(wire.tbl);
    if (
      opts.receiver !== 'hq' ||
      !msg.startsWith('not-owner') ||
      syncTable(wire.tbl)?.owner !== 'hq' ||
      !t
    )
      return {};
    let local: SyncChange;
    try {
      local = localizePermission(wire, opts.permissionId);
    } catch {
      return {};
    }
    const tbl = q(wire.tbl);
    const pkCols = t.pk.map(q).join(', ');
    const [r] = await tx.$queryRawUnsafe<
      {
        row: Record<string, unknown> | null;
        hlc: string | null;
        peer: string | null;
      }[]
    >(
      `SELECT (SELECT sync_capture_row($1, to_jsonb(x)) FROM ${tbl} x
                WHERE (${pkCols}) = (SELECT ${pkCols} FROM jsonb_populate_record(NULL::${tbl}, $2::jsonb))) AS row,
              v.hlc::text AS hlc, v.peer
         FROM (SELECT 1) one
         LEFT JOIN sync_versions v ON v.tbl = $1 AND v."pkKey" = $3`,
      wire.tbl,
      JSON.stringify(local.pk),
      wire.pkKey,
    );
    return {
      restore: {
        tbl: wire.tbl,
        pk: wire.pk,
        pkKey: wire.pkKey,
        op: r.row ? 'U' : 'D',
        row: r.row,
        ts: new Date().toISOString(),
        hlc: r.hlc ?? nextHlc(Date.now()).toString(),
        peer: r.peer ?? opts.deviceId,
        schemaVersion: opts.schema,
      },
    };
  }

  /**
   * Writes the change. Only the columns the change carries are written
   * (columnsToWrite), so an older sender keeps newer columns' values. An
   * upsert of a row that was absent when locked only inserts; false means a
   * concurrent writer created it first.
   */
  private async writeRow(
    tx: Tx,
    c: SyncChange,
    t: TableMeta,
    exists: boolean,
    opts: Opts,
  ): Promise<boolean> {
    const tbl = q(c.tbl);
    const pkCols = t.pk.map(q).join(', ');
    if (c.op === 'D') {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${tbl} WHERE (${pkCols}) = (SELECT ${pkCols} FROM jsonb_populate_record(NULL::${tbl}, $1::jsonb))`,
        JSON.stringify(c.pk),
      );
      return true;
    }
    const cols = columnsToWrite({
      rowKeys: Object.keys(c.row ?? {}),
      cols: t.cols,
      pk: t.pk,
      strip: syncTable(c.tbl)?.strip ?? [],
      skew: schemaSkew(c.schemaVersion, opts.schema),
    });
    const list = cols.map(q).join(', ');
    const sets = cols
      .filter((x) => !t.pk.includes(x))
      .map((x) => `${q(x)} = EXCLUDED.${q(x)}`);
    const onConflict =
      exists && sets.length
        ? `ON CONFLICT (${pkCols}) DO UPDATE SET ${sets.join(', ')}`
        : `ON CONFLICT (${pkCols}) DO NOTHING`;
    const n = await tx.$executeRawUnsafe(
      `INSERT INTO ${tbl} (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::${tbl}, $1::jsonb) ${onConflict}`,
      JSON.stringify(c.row),
    );
    return exists || n > 0;
  }

  /**
   * Rule 5: sets each touched derived balance from its ledger (derived.ts),
   * a read-modify-write `set` under the row lock UPDATE takes. The update
   * keeps the row's current sync version (same HLC and peer) and writes no
   * outbox entry, so a recompute on this install never outranks a later
   * edit from the row's owner.
   */
  private async recomputeDerived(tx: Tx, done: SyncChange[]) {
    const targets = derivedTargets(done);
    for (const d of DERIVED) {
      for (const id of targets.get(`${d.table}.${d.column}`) ?? []) {
        const [v] = await tx.$queryRawUnsafe<
          { hlc: string; peer: string; ts: Date }[]
        >(
          `SELECT hlc::text, peer, ts FROM sync_versions WHERE tbl = $1 AND "pkKey" = jsonb_build_object($3::text, $2::text)::text`,
          d.table,
          id,
          d.key,
        );
        await tx.$queryRawUnsafe(
          `SELECT set_config('app.sync_origin', '__skip', true), set_config('app.sync_hlc', $1, true),
                  set_config('app.sync_peer', $2, true), set_config('app.sync_ts', $3, true)`,
          v?.hlc ?? '',
          v?.peer ?? '',
          v ? v.ts.toISOString() : '',
        );
        await tx.$executeRawUnsafe(
          `UPDATE ${q(d.table)} t SET ${q(d.column)} = ${d.expr}
            WHERE t.${q(d.key)} = $1 AND t.${q(d.column)} IS DISTINCT FROM ${d.expr}`,
          id,
        );
      }
    }
  }

  /**
   * Rule 7 audit: HQ takes a branch's settled order as priced there, but a
   * PAID order whose lines, total and payments don't reconcile is flagged in
   * sync_order_flags (shown in /sync/status) instead of being trusted
   * silently. Re-evaluated whenever the order or one of its lines, payments
   * or refunds arrives, so a flag clears once the missing rows land.
   */
  private async checkOrders(tx: Tx, done: SyncChange[], ctx: ApplyContext) {
    const ids = new Set<string>();
    for (const c of done) {
      if (c.op !== 'U' || !c.row) continue;
      if (c.tbl === 'orders' && typeof c.row.id === 'string') ids.add(c.row.id);
      if (
        ['order_items', 'payments', 'refunds'].includes(c.tbl) &&
        typeof c.row.orderId === 'string'
      )
        ids.add(c.row.orderId);
    }
    if (!ids.size) return;
    const list = [...ids];
    const orders = await tx.$queryRawUnsafe<
      {
        id: string;
        branchId: string;
        status: string;
        subtotal: string;
        discountAmount: string;
        loyaltyDiscountAmount: string;
        tipAmount: string;
        deliveryFee: string;
        totalAmount: string;
      }[]
    >(
      `SELECT id, "branchId", status::text, subtotal::text, "discountAmount"::text,
              "loyaltyDiscountAmount"::text, "tipAmount"::text, "deliveryFee"::text, "totalAmount"::text
         FROM orders WHERE id = ANY($1::text[])`,
      list,
    );
    const rowsOf = async (table: string, col: string) => {
      const rows = await tx.$queryRawUnsafe<{ o: string; v: string }[]>(
        `SELECT "orderId" AS o, ${q(col)}::text AS v FROM ${q(table)} WHERE "orderId" = ANY($1::text[])`,
        list,
      );
      const by = new Map<string, string[]>();
      for (const r of rows) by.set(r.o, [...(by.get(r.o) ?? []), r.v]);
      return (id: string) => by.get(id) ?? [];
    };
    const items = await rowsOf('order_items', 'lineTotal');
    const pays = await rowsOf('payments', 'amount');
    const refs = await rowsOf('refunds', 'amount');
    for (const o of orders) {
      const problems = orderProblems(
        o,
        items(o.id).map((lineTotal) => ({ lineTotal })),
        pays(o.id).map((amount) => ({ amount })),
        refs(o.id).map((amount) => ({ amount })),
      );
      if (problems.length)
        await tx.$executeRawUnsafe(
          `INSERT INTO sync_order_flags ("orderId", "branchId", peer, problems)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT ("orderId") DO UPDATE SET problems = EXCLUDED.problems,
             peer = EXCLUDED.peer, "flaggedAt" = now()`,
          o.id,
          o.branchId,
          ctx.origin,
          JSON.stringify(problems),
        );
      else
        await tx.$executeRawUnsafe(
          `DELETE FROM sync_order_flags WHERE "orderId" = $1`,
          o.id,
        );
    }
  }

  private async tableMeta(): Promise<Map<string, TableMeta>> {
    if (this.meta) return this.meta;
    const cols = await this.prisma.$queryRawUnsafe<{ t: string; c: string }[]>(
      `SELECT c.relname AS t, a.attname AS c FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND sync_is_synced_table(c.relname)
        ORDER BY c.relname, a.attnum`,
    );
    const pks = await this.prisma.$queryRawUnsafe<{ t: string; c: string }[]>(
      `SELECT c.relname AS t, a.attname AS c FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (k.conkey)
        WHERE k.contype = 'p' AND c.relnamespace = 'public'::regnamespace`,
    );
    const m = new Map<string, TableMeta>();
    for (const { t, c } of cols) {
      if (!m.has(t)) m.set(t, { pk: [], cols: [] });
      m.get(t)!.cols.push(c);
    }
    for (const { t, c } of pks) m.get(t)?.pk.push(c);
    this.meta = m;
    return m;
  }
}

function q(id: string) {
  return `"${id.replace(/"/g, '""')}"`;
}

function conflictOf(c: SyncChange, e: unknown): Conflict {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    seq: typeof c?.seq === 'string' ? c.seq : undefined,
    tbl: String(c?.tbl),
    pk: String(c?.pkKey),
    error: msg.split('\n').pop() ?? msg,
  };
}
