import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { captureSql } from './capture-sql';
import {
  assertWellFormed,
  clockSkewError,
  compact,
  Conflict,
  localizePermission,
  Rejected,
  rejectedChanges,
  SyncChange,
} from './outbox';
import { syncTable } from './tables';

export type { SyncChange } from './outbox';

/** Columns every outbox read returns, in wire shape. */
const CHANGE_COLS = `seq::text, tbl, pk, "pkKey", op, row, ts, origin, hlc::text, peer, "branchId", "schemaVersion"`;
type ChangeRow = Omit<SyncChange, 'ts'> & {
  seq: string;
  ts: Date;
  origin: string;
};
const toWire = (r: ChangeRow): SyncChange => {
  const { origin, ...rest } = r;
  void origin; // server bookkeeping, not part of the wire format
  return { ...rest, ts: r.ts.toISOString() };
};

export interface ApplyResult {
  applied: number;
  skipped: number;
  conflicts: Conflict[];
}

interface TableMeta {
  pk: string[];
  cols: string[];
}

type Tx = Prisma.TransactionClient;
type ApplyOpts = {
  origin: string;
  tieWins: boolean;
  permissionId: (key: string) => string | undefined;
};

const PULL_PAGE = 500;
const PUSH_PAGE = 200;
const MAX_FK_PASSES = 6;
const INTERVAL_MS = 30_000;
const MAX_CONFLICTS_KEPT = 50;

/**
 * Two-way sync between a local (embedded) install and a central server.
 *
 * Changes are captured by DB triggers into the sync_changes outbox (see the
 * 20261026000000_server_sync and 20261104130000_sync_outbox migrations) for
 * the tables classified in tables.ts. Resolution is last-writer-wins per row
 * by hybrid logical clock against sync_versions; on an exact tie the
 * server's version wins and a replayed change is skipped. Rows arrive in
 * arbitrary table order, so a change whose parent row hasn't arrived yet
 * (FK violation) is retried in later passes. Outbox entries are deleted only
 * once the server has acknowledged them.
 */
@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SyncService.name);
  private meta: Map<string, TableMeta> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.installCapture();
    const envKey = process.env.SYNC_API_KEY?.trim();
    if (envKey) {
      // This process is the central server other devices sync with.
      await this.prisma.$executeRawUnsafe(
        `UPDATE sync_state SET role = 'server', enabled = true, "apiKey" = $1 WHERE id = 1`,
        envKey,
      );
      if (!(await this.state()).seeded)
        await this.prisma.$executeRawUnsafe('SELECT sync_seed()');
      this.log.log('Sync server mode enabled (SYNC_API_KEY set)');
    }
    if (process.env.NODE_ENV !== 'test') {
      this.timer = setInterval(
        () => void this.runOnce().catch(() => undefined),
        INTERVAL_MS,
      );
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Regenerates the classification functions from tables.ts, (un)installs
   * the row triggers to match and records the schema version stamped on
   * every captured change. Serialised so two processes can't race the DDL.
   */
  async installCapture() {
    const schema = await this.schemaVersion();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext('sync_capture'))`,
      );
      for (const sql of captureSql()) await tx.$executeRawUnsafe(sql);
      await tx.$queryRawUnsafe('SELECT sync_install_triggers()');
      await tx.$executeRawUnsafe(
        `UPDATE sync_state SET "schemaVersion" = $1 WHERE id = 1`,
        schema,
      );
    });
    this.meta = null;
  }

  async state() {
    const rows = await this.prisma.$queryRawUnsafe<
      {
        enabled: boolean;
        role: string;
        deviceId: string;
        serverUrl: string | null;
        apiKey: string | null;
        seeded: boolean;
        lastPullSeq: bigint;
        lastPushSeq: bigint;
        lastSyncAt: Date | null;
        lastError: string | null;
        conflicts: unknown[];
      }[]
    >(`SELECT * FROM sync_state WHERE id = 1`);
    return rows[0];
  }

  async publicStatus() {
    const s = await this.state();
    const pending = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM sync_changes WHERE seq > $1`,
      s.lastPushSeq,
    );
    const rejected = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM sync_rejected`,
    );
    return {
      enabled: s.enabled,
      role: s.role,
      serverUrl: s.serverUrl,
      hasKey: !!s.apiKey,
      lastSyncAt: s.lastSyncAt,
      lastError: s.lastError,
      pendingChanges: s.role === 'client' ? Number(pending[0].n) : 0,
      rejectedChanges: Number(rejected[0].n),
      conflicts: s.conflicts,
    };
  }

  async schemaVersion(): Promise<string> {
    const r = await this.prisma.$queryRawUnsafe<{ m: string }[]>(
      `SELECT max(migration_name) AS m FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
    );
    return r[0].m;
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

  private q(id: string) {
    return `"${id.replace(/"/g, '""')}"`;
  }

  /**
   * Applies changes with last-writer-wins. `origin` is recorded in the log
   * (so the server can relay to other devices without echoing back to the
   * sender); '__skip' applies without logging (client applying a pull).
   */
  async applyChanges(
    changes: SyncChange[],
    opts: { origin: string; tieWins: boolean },
  ): Promise<ApplyResult> {
    const meta = await this.tableMeta();
    const result: ApplyResult = { applied: 0, skipped: 0, conflicts: [] };
    const perms = new Map(
      (
        await this.prisma.$queryRawUnsafe<{ key: string; id: string }[]>(
          `SELECT key, id FROM permissions`,
        )
      ).map((p) => [p.key, p.id]),
    );
    const applyOpts: ApplyOpts = { ...opts, permissionId: (k) => perms.get(k) };
    let pending: SyncChange[] = [];
    for (const c of changes) {
      try {
        assertWellFormed(c);
        pending.push(c);
      } catch (e) {
        result.conflicts.push({
          seq: typeof c?.seq === 'string' ? c.seq : undefined,
          tbl: String(c?.tbl),
          pk: String(c?.pkKey),
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    pending = compact(pending);

    for (let pass = 0; pass < MAX_FK_PASSES && pending.length; pass++) {
      const retry: SyncChange[] = [];
      const lastError = new Map<SyncChange, string>();
      // Deletes after upserts on the first passes keeps cascades from
      // removing rows a later upsert in the same batch re-creates.
      const ordered = [...pending].sort(
        (a, b) => Number(a.op === 'D') - Number(b.op === 'D'),
      );
      for (let i = 0; i < ordered.length; i += PUSH_PAGE) {
        const slice = ordered.slice(i, i + PUSH_PAGE);
        await this.prisma.$transaction(
          async (tx) => {
            for (const c of slice) {
              await tx.$executeRawUnsafe('SAVEPOINT sp');
              try {
                const did = await this.applyOne(tx, c, meta, applyOpts);
                if (did) result.applied++;
                else result.skipped++;
                await tx.$executeRawUnsafe('RELEASE SAVEPOINT sp');
              } catch (e) {
                await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sp');
                const msg = e instanceof Error ? e.message : String(e);
                lastError.set(c, msg);
                if (
                  /violates foreign key|23503/.test(msg) &&
                  pass < MAX_FK_PASSES - 1
                )
                  retry.push(c);
                else
                  result.conflicts.push({
                    seq: c.seq,
                    tbl: c.tbl,
                    pk: c.pkKey,
                    error: msg.split('\n').pop() ?? msg,
                  });
              }
            }
          },
          { timeout: 120_000, maxWait: 30_000 },
        );
      }
      pending = retry;
    }
    return result;
  }

  private async applyOne(
    tx: Tx,
    wire: SyncChange,
    meta: Map<string, TableMeta>,
    opts: ApplyOpts,
  ): Promise<boolean> {
    const t = meta.get(wire.tbl);
    if (!t || !t.pk.length) throw new Error(`unknown table ${wire.tbl}`);
    const c = localizePermission(wire, opts.permissionId);
    const newer = await tx.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT NOT EXISTS (
         SELECT 1 FROM sync_versions WHERE tbl = $1 AND "pkKey" = $2
            AND (hlc > $3::bigint OR (hlc = $3::bigint AND (peer = $4 OR NOT $5::boolean)))) AS ok`,
      c.tbl,
      c.pkKey,
      c.hlc,
      c.peer,
      opts.tieWins,
    );
    if (!newer[0].ok) return false;
    await tx.$queryRawUnsafe(
      `SELECT set_config('app.sync_origin', $1, true), set_config('app.sync_ts', $2, true),
              set_config('app.sync_hlc', $3, true), set_config('app.sync_peer', $4, true)`,
      opts.origin,
      c.ts,
      c.hlc,
      c.peer,
    );
    const tbl = this.q(c.tbl);
    const pkCols = t.pk.map((p) => this.q(p)).join(', ');
    if (c.op === 'D') {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${tbl} WHERE (${pkCols}) = (SELECT ${pkCols} FROM jsonb_populate_record(NULL::${tbl}, $1::jsonb))`,
        JSON.stringify(c.pk),
      );
    } else {
      // Stripped columns never arrive; keep this install's value.
      const keep = new Set(syncTable(c.tbl)?.strip ?? []);
      const sets = t.cols
        .filter((x) => !t.pk.includes(x) && !keep.has(x))
        .map((x) => `${this.q(x)} = EXCLUDED.${this.q(x)}`);
      const onConflict = sets.length
        ? `ON CONFLICT (${pkCols}) DO UPDATE SET ${sets.join(', ')}`
        : `ON CONFLICT (${pkCols}) DO NOTHING`;
      await tx.$executeRawUnsafe(
        `INSERT INTO ${tbl} SELECT * FROM jsonb_populate_record(NULL::${tbl}, $1::jsonb) ${onConflict}`,
        JSON.stringify(c.row),
      );
    }
    // The trigger records the version when a row changed; a delete of a row
    // this install never had still needs its tombstone.
    await tx.$executeRawUnsafe(
      `INSERT INTO sync_versions (tbl, "pkKey", hlc, peer, deleted, "branchId", ts)
       VALUES ($1, $2, $3::bigint, $4, $5, $6, $7::timestamptz)
       ON CONFLICT (tbl, "pkKey") DO UPDATE SET hlc = EXCLUDED.hlc, peer = EXCLUDED.peer,
         deleted = EXCLUDED.deleted, "branchId" = coalesce(EXCLUDED."branchId", sync_versions."branchId"), ts = EXCLUDED.ts`,
      c.tbl,
      c.pkKey,
      c.hlc,
      c.peer,
      c.op === 'D',
      c.branchId ?? null,
      c.ts,
    );
    return true;
  }

  /**
   * Highest outbox seq below every still-open writer (sync_safe_seq in the
   * migration). Must run as its own statement BEFORE the outbox read, so that
   * read's snapshot sees every entry up to the bound that will ever commit;
   * cursors and pruning then never pass an entry not yet visible.
   */
  private async safeSeq(): Promise<bigint> {
    const r = await this.prisma.$queryRawUnsafe<{ s: bigint }[]>(
      'SELECT sync_safe_seq() AS s',
    );
    return BigInt(r[0].s);
  }

  // ---- server side -------------------------------------------------------

  async pull(since: bigint, device: string, limit = PULL_PAGE) {
    // A client asking from `since` has everything up to it (compaction bound).
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO sync_cursors (device, seq, "seenAt") VALUES ($1, $2, now())
       ON CONFLICT (device) DO UPDATE SET seq = EXCLUDED.seq, "seenAt" = now()`,
      device,
      since,
    );
    const upTo = await this.safeSeq();
    const rows = await this.prisma.$queryRawUnsafe<ChangeRow[]>(
      `SELECT ${CHANGE_COLS} FROM sync_changes WHERE seq > $1 AND seq <= $2 ORDER BY sync_changes.seq LIMIT $3`,
      since,
      upTo,
      limit,
    );
    const nextSeq = rows.length ? rows[rows.length - 1].seq : since.toString();
    const mine = rows.filter((r) => r.origin !== device).map(toWire);
    return {
      changes: compact(mine),
      nextSeq,
      hasMore: rows.length === limit,
    };
  }

  /**
   * Server-side compaction (G8): every client has pulled past `min(cursor)`,
   * so below it an entry superseded by a newer one for the same row, and any
   * tombstone, is no longer needed. The newest upsert of each row is kept so
   * a newly joining client still gets every row. Returns entries removed.
   */
  async compactOutbox(): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `WITH floor AS (SELECT coalesce(min(seq), 0) AS s FROM sync_cursors)
       DELETE FROM sync_changes c USING floor
        WHERE c.seq <= floor.s
          AND (c.op = 'D' OR EXISTS (
                SELECT 1 FROM sync_changes n
                 WHERE n.tbl = c.tbl AND n."pkKey" = c."pkKey" AND n.seq > c.seq))`,
    );
  }

  async push(device: string, changes: SyncChange[]) {
    return this.applyChanges(changes, { origin: device, tieWins: false });
  }

  // ---- client side -------------------------------------------------------

  /** Dead-letters rejected changes so pruning or a cursor move can't lose them. */
  private keepRejected(side: 'push' | 'pull', rejected: Rejected[]) {
    return this.prisma.$executeRawUnsafe(
      `INSERT INTO sync_rejected (side, tbl, "pkKey", change, error)
       SELECT $1, x.tbl, x."pkKey", x.change, x.error
         FROM jsonb_to_recordset($2::jsonb) AS x(tbl text, "pkKey" text, change jsonb, error text)`,
      side,
      JSON.stringify(rejected),
    );
  }

  private async call<T>(
    s: { serverUrl: string | null; apiKey: string | null },
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (!s.serverUrl || !s.apiKey)
      throw new Error('Server address and sync key are required');
    const res = await fetch(
      `${s.serverUrl.replace(/\/+$/, '')}/api/v1/sync-peer/${path}`,
      {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-sync-key': s.apiKey,
          ...init.headers,
        },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (res.status === 401 || res.status === 403)
      throw new Error('Server rejected the sync key');
    if (!res.ok) throw new Error(`Server answered HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Checks the server before any data moves: it is a sync server, on the same
   * schema, and its clock agrees with this PC's (HLCs come from local clocks,
   * so a skewed PC must stop here rather than have its changes rejected).
   */
  async testConnection(serverUrl: string, apiKey: string) {
    const sent = Date.now();
    const r = await this.call<{
      ok: boolean;
      role: string;
      schema: string;
      now?: number;
    }>({ serverUrl, apiKey }, 'ping');
    // The server read its clock somewhere in the round trip: take the middle.
    const localAtServer = (sent + Date.now()) / 2;
    const local = await this.schemaVersion();
    if (r.role !== 'server')
      throw new Error(
        'That address is not a sync server (SYNC_API_KEY is not set there)',
      );
    if (r.schema !== local) {
      throw new Error(
        `App versions differ (this PC: ${local}, server: ${r.schema}). Update both to the same version first.`,
      );
    }
    const skew = clockSkewError(localAtServer, r.now);
    if (skew) throw new Error(skew);
    return { ok: true, schema: r.schema };
  }

  /** mode 'adopt': replace local data with the server's. 'merge': keep and merge both. */
  async enable(serverUrl: string, apiKey: string, mode: 'adopt' | 'merge') {
    // A cycle already in flight holds the previous sequence numbers.
    await this.running?.catch(() => undefined);
    await this.testConnection(serverUrl, apiKey);
    const meta = await this.tableMeta();
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE sync_state SET enabled = false, role = 'client', "serverUrl" = $1, "apiKey" = $2,
             "lastPullSeq" = 0, "lastPushSeq" = 0, "lastError" = NULL, conflicts = '[]' WHERE id = 1`,
          serverUrl.replace(/\/+$/, ''),
          apiKey,
        );
        await tx.$executeRawUnsafe('DELETE FROM sync_changes');
        await tx.$executeRawUnsafe('DELETE FROM sync_versions');
        if (mode === 'adopt') {
          await tx.$queryRawUnsafe(
            `SELECT set_config('app.sync_origin', '__skip', true)`,
          );
          // The append-only VERI*FACTU chain can't be replaced; an empty one
          // only needs its truncate guard stepped around.
          const chain = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM verifactu_records`,
          );
          if (Number(chain[0].n) > 0) {
            throw new Error(
              'This PC already has VERI*FACTU invoice records, which cannot be replaced. Use "merge" instead.',
            );
          }
          await tx.$executeRawUnsafe(
            `ALTER TABLE verifactu_records DISABLE TRIGGER USER`,
          );
          const tables = [...meta.keys()].map((t) => this.q(t)).join(', ');
          await tx.$executeRawUnsafe(
            `TRUNCATE ${tables}, verifactu_records CASCADE`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE verifactu_records ENABLE TRIGGER USER`,
          );
        }
        await tx.$executeRawUnsafe(
          `UPDATE sync_state SET enabled = true, seeded = ${mode === 'adopt'} WHERE id = 1`,
        );
        if (mode === 'merge') await tx.$executeRawUnsafe('SELECT sync_seed()');
      },
      { timeout: 120_000 },
    );
    return this.runOnce();
  }

  async disable() {
    await this.running?.catch(() => undefined);
    await this.prisma.$executeRawUnsafe(
      `UPDATE sync_state SET enabled = false, "lastError" = NULL WHERE id = 1 AND role = 'client'`,
    );
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM sync_changes WHERE (SELECT role FROM sync_state) = 'client'`,
    );
  }

  runOnce(): Promise<{
    pulled: number;
    pushed: number;
    conflicts: number;
  } | null> {
    if (this.running) return this.running as Promise<never>;
    const p = this.cycle().finally(() => {
      this.running = null;
    });
    this.running = p;
    return p;
  }

  private async cycle() {
    const s = await this.state();
    if (s.enabled && s.role === 'server') {
      await this.compactOutbox();
      return null;
    }
    if (!s.enabled || s.role !== 'client') return null;
    let pulled = 0;
    let pushed = 0;
    const conflicts: ApplyResult['conflicts'] = [];
    try {
      await this.testConnection(s.serverUrl!, s.apiKey!);

      let since = s.lastPullSeq;
      for (;;) {
        const page = await this.call<{
          changes: SyncChange[];
          nextSeq: string;
          hasMore: boolean;
        }>(s, `pull?since=${since}&device=${encodeURIComponent(s.deviceId)}`);
        const r = await this.applyChanges(page.changes, {
          origin: '__skip',
          tieWins: true,
        });
        pulled += r.applied;
        conflicts.push(...r.conflicts);
        since = BigInt(page.nextSeq);
        // The cursor moves past rejected server changes: keep them first.
        await this.prisma.$transaction([
          this.keepRejected('pull', rejectedChanges(page.changes, r.conflicts)),
          this.prisma.$executeRawUnsafe(
            `UPDATE sync_state SET "lastPullSeq" = $1 WHERE id = 1`,
            since,
          ),
        ]);
        if (!page.hasMore) break;
      }

      let pushedTo = s.lastPushSeq;
      const upTo = await this.safeSeq();
      for (;;) {
        const rows = await this.prisma.$queryRawUnsafe<ChangeRow[]>(
          `SELECT ${CHANGE_COLS} FROM sync_changes WHERE seq > $1 AND seq <= $2 ORDER BY sync_changes.seq LIMIT $3`,
          pushedTo,
          upTo,
          PUSH_PAGE,
        );
        if (!rows.length) break;
        const changes = compact(rows.map(toWire));
        const r = await this.call<ApplyResult>(s, 'push', {
          method: 'POST',
          body: JSON.stringify({ device: s.deviceId, changes }),
        });
        pushed += r.applied;
        conflicts.push(...r.conflicts);
        pushedTo = BigInt(rows[rows.length - 1].seq);
        // Acknowledged by the server: keep what it rejected, then advance the
        // cursor and drop the page together, so a crash replays at most this
        // page (idempotent).
        await this.prisma.$transaction([
          this.keepRejected('push', rejectedChanges(changes, r.conflicts)),
          this.prisma.$executeRawUnsafe(
            `UPDATE sync_state SET "lastPushSeq" = $1 WHERE id = 1`,
            pushedTo,
          ),
          this.prisma.$executeRawUnsafe(
            `DELETE FROM sync_changes WHERE seq <= $1`,
            pushedTo,
          ),
        ]);
        if (rows.length < PUSH_PAGE) break;
      }

      const kept = [
        ...conflicts.map((c) => ({ ...c, at: new Date().toISOString() })),
        ...(s.conflicts ?? []),
      ].slice(0, MAX_CONFLICTS_KEPT);
      await this.prisma.$executeRawUnsafe(
        `UPDATE sync_state SET "lastSyncAt" = now(), "lastError" = NULL, conflicts = $1::jsonb WHERE id = 1`,
        JSON.stringify(kept),
      );
      return { pulled, pushed, conflicts: conflicts.length };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`sync failed: ${msg}`);
      await this.prisma.$executeRawUnsafe(
        `UPDATE sync_state SET "lastError" = $1 WHERE id = 1`,
        msg,
      );
      throw e;
    }
  }
}
