import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { hostname } from 'os';
import { PrismaService } from '../prisma/prisma.service';
import { ApplyContext, ApplyResult, SyncApplier } from './apply';
import {
  backoffMs,
  fitPushPage,
  keyForServer,
  pullScope,
  tooLargeToPush,
} from './apply-rules';
import { installCapture } from './capture-install';
import {
  clockSkewError,
  compact,
  Rejected,
  rejectedChanges,
  SyncChange,
} from './outbox';
import { SyncPeersService } from './peers.service';
import { RejectedReplay } from './rejected';

export type { SyncChange } from './outbox';
export type { ApplyResult } from './apply';

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

/** A registered branch install as the server sees it (from its key). */
export interface PeerIdentity {
  id: string;
  branchIds: string[];
}

/** The cycle stopped before moving data; it resumes on its own once fixed. */
class SyncPaused extends Error {
  constructor(
    readonly reason: 'schema' | 'clock',
    message: string,
  ) {
    super(message);
  }
}

const PULL_PAGE = 500;
const PUSH_PAGE = 200;
/** Below HQ's default 100 kB body limit (BODY_LIMIT), with headroom. */
const PUSH_MAX_BYTES = 64_000;
const TICK_MS = 30_000;
const MAX_CONFLICTS_KEPT = 50;
const ADOPT_LEDGER_ERROR =
  'This PC already has VERI*FACTU invoice records, which cannot be replaced. Use "merge" instead.';
const SCOPE = pullScope();
const withoutRestore = (c: ApplyResult['conflicts'][number]) => ({
  seq: c.seq,
  tbl: c.tbl,
  pk: c.pk,
  error: c.error,
});

/**
 * Two-way sync between branch installs (clients) and HQ (the server),
 * docs/MULTI-BRANCH-SYNC.md. Changes are captured by DB triggers into the
 * sync_changes outbox for the tables classified in tables.ts (#81) and
 * applied on the other side by SyncApplier (apply.ts, #82): ownership first,
 * then last-writer-wins per row by hybrid logical clock. A branch registers
 * at HQ once with the bootstrap key and then syncs with its own key; HQ
 * relays to each branch only what that branch may see. Outbox entries are
 * deleted only once the server has acknowledged them.
 */
@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SyncService.name);
  private readonly applier: SyncApplier;
  private readonly replay: RejectedReplay;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private retryAllNext = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly peers: SyncPeersService,
  ) {
    this.applier = new SyncApplier(prisma, () => this.schemaVersion());
    this.replay = new RejectedReplay(prisma, this.applier);
  }

  async onModuleInit() {
    if (!process.env.NVENTRA_DATABASE_URL_FILE) await this.installCapture();
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
    await this.queueWalletOpenings();
    if (process.env.NODE_ENV !== 'test') {
      this.timer = setInterval(
        () => void this.runScheduled().catch(() => undefined),
        TICK_MS,
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
    await installCapture(this.prisma);
    this.applier.resetMeta();
  }

  /**
   * The wallet ledger's opening entries were written by a migration, before
   * any trigger existed on the table. On a syncing branch they are queued
   * once (touched without change) so HQ gets the branch's own opening
   * balance, which supersedes the copy HQ opened from its older data.
   */
  private async queueWalletOpenings() {
    const s = await this.state();
    if (!s.enabled || s.role !== 'client') return;
    await this.prisma.$executeRawUnsafe(
      `UPDATE customer_wallet_entries w SET reason = w.reason
        WHERE w.reason = 'OPENING' AND NOT EXISTS (
          SELECT 1 FROM sync_versions v WHERE v.tbl = 'customer_wallet_entries'
             AND v."pkKey" = jsonb_build_object('id', w.id)::text)`,
    );
  }

  async state() {
    const rows = await this.prisma.$queryRawUnsafe<
      {
        enabled: boolean;
        role: string;
        deviceId: string;
        serverUrl: string | null;
        apiKey: string | null;
        peerKey: string | null;
        branchIds: string[] | null;
        seeded: boolean;
        lastPullSeq: bigint;
        lastPushSeq: bigint;
        lastSyncAt: Date | null;
        lastError: string | null;
        conflicts: unknown[];
        failures: number;
        nextAttemptAt: Date | null;
        pausedReason: string | null;
      }[]
    >(`SELECT * FROM sync_state WHERE id = 1`);
    return rows[0];
  }

  async publicStatus() {
    const s = await this.state();
    const count = async (sql: string, ...args: unknown[]) =>
      Number(
        (await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(sql, ...args))[0].n,
      );
    const server = s.role === 'server';
    return {
      enabled: s.enabled,
      role: s.role,
      serverUrl: s.serverUrl,
      hasKey: !!(s.apiKey || s.peerKey),
      registered: !!s.peerKey,
      branchIds: s.branchIds ?? [],
      lastSyncAt: s.lastSyncAt,
      lastError: s.lastError,
      // 'schema' / 'clock': transfer waits (changes keep queuing) until fixed.
      pausedReason: s.pausedReason,
      failures: s.failures,
      nextAttemptAt: s.nextAttemptAt,
      pendingChanges: server
        ? 0
        : await count(
            `SELECT count(*) AS n FROM sync_changes WHERE seq > $1`,
            s.lastPushSeq,
          ),
      rejectedChanges: await count(`SELECT count(*) AS n FROM sync_rejected`),
      flaggedOrders: server
        ? await count(`SELECT count(*) AS n FROM sync_order_flags`)
        : 0,
      peers: server
        ? await count(
            `SELECT count(*) AS n FROM sync_peers WHERE "revokedAt" IS NULL`,
          )
        : 0,
      conflicts: s.conflicts,
    };
  }

  /** HQ: settled branch orders that did not reconcile, newest first. */
  orderFlags() {
    return this.prisma.syncOrderFlag.findMany({
      orderBy: { flaggedAt: 'desc' },
      take: 100,
    });
  }

  async schemaVersion(): Promise<string> {
    const r = await this.prisma.$queryRawUnsafe<{ m: string }[]>(
      `SELECT max(migration_name) AS m FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
    );
    return r[0].m;
  }

  /** Applies changes as `ctx` describes (apply.ts). */
  applyChanges(changes: SyncChange[], ctx: ApplyContext): Promise<ApplyResult> {
    return this.applier.apply(changes, ctx);
  }

  /**
   * Highest outbox seq below every still-open writer (sync_safe_seq in the
   * migration). Must run as its own statement BEFORE the outbox read, so that
   * read's snapshot sees every entry up to the bound that will ever commit.
   */
  private async safeSeq(): Promise<bigint> {
    const r = await this.prisma.$queryRawUnsafe<{ s: bigint }[]>(
      'SELECT sync_safe_seq() AS s',
    );
    return BigInt(r[0].s);
  }

  // ---- server side -------------------------------------------------------

  /**
   * One page of HQ's outbox for `peer` (G2): HQ-owned rows that are
   * restaurant-wide or of the peer's branches, the peer's own branch rows
   * (restore), and rows routed to it (stock transfers in). Never other
   * branches' data and never the peer's own echo. The filter runs in SQL,
   * so a page past filtered entries still advances the cursor to the bound.
   */
  async pull(since: bigint, peer: PeerIdentity, limit = PULL_PAGE) {
    // A client asking from `since` has everything up to it (compaction bound).
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO sync_cursors (device, seq, "seenAt") VALUES ($1, $2, now())
       ON CONFLICT (device) DO UPDATE SET seq = EXCLUDED.seq, "seenAt" = now()`,
      peer.id,
      since,
    );
    const upTo = await this.safeSeq();
    const routed = SCOPE.routed
      .map(
        (r, i) =>
          `(tbl = $${6 + 2 * i} AND row ->> $${7 + 2 * i} = ANY ($5::text[]))`,
      )
      .join(' OR ');
    const rows = await this.prisma.$queryRawUnsafe<ChangeRow[]>(
      `SELECT ${CHANGE_COLS} FROM sync_changes
        WHERE seq > $1 AND seq <= $2 AND origin <> $3
          AND ((tbl = ANY ($4::text[]) AND ("branchId" IS NULL OR "branchId" = ANY ($5::text[])))
               OR "branchId" = ANY ($5::text[])${routed ? ` OR ${routed}` : ''})
        ORDER BY sync_changes.seq LIMIT ${Number(limit)}`,
      since,
      upTo,
      peer.id,
      SCOPE.hqTables,
      peer.branchIds,
      ...SCOPE.routed.flatMap((r) => [r.tbl, r.col]),
    );
    const full = rows.length === limit;
    const bound = upTo > since ? upTo : since;
    return {
      changes: compact(rows.map(toWire)),
      nextSeq: full ? rows[rows.length - 1].seq : bound.toString(),
      hasMore: full,
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
                 WHERE n.tbl = c.tbl AND n."pkKey" = c."pkKey"
                   AND (n.hlc > c.hlc OR (n.hlc = c.hlc AND n.seq > c.seq))))`,
    );
  }

  /**
   * A branch's page, applied with its ownership (rule 1). A branch pushes
   * only what it wrote (pulled rows skip its outbox), so the authoring peer
   * is always the authenticated one: never the wire's claim (LWW ties and
   * echo filtering use it).
   */
  push(peer: PeerIdentity, changes: SyncChange[]) {
    const own = changes.map((c) => ({ ...c, peer: peer.id }));
    return this.applier.apply(own, {
      origin: peer.id,
      tieWins: false,
      receiver: 'hq',
      branches: peer.branchIds,
    });
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

  /** Keeps a push page's rejections, then advances the cursor past it. */
  private ackPush(rejected: Rejected[], pushedTo: bigint) {
    return this.prisma.$transaction([
      this.keepRejected('push', rejected),
      this.prisma.$executeRawUnsafe(
        `UPDATE sync_state SET "lastPushSeq" = $1 WHERE id = 1`,
        pushedTo,
      ),
      this.prisma.$executeRawUnsafe(
        `DELETE FROM sync_changes WHERE seq <= $1`,
        pushedTo,
      ),
    ]);
  }

  /**
   * Calls the server. With `peer`, authenticates as this registered
   * install; otherwise with the bootstrap key (connection test, register).
   */
  private async call<T>(
    s: {
      serverUrl: string | null;
      apiKey: string | null;
      peer?: { id: string; key: string };
    },
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const key = s.peer?.key ?? s.apiKey;
    if (!s.serverUrl || !key)
      throw new Error('Server address and sync key are required');
    const res = await fetch(
      `${s.serverUrl.replace(/\/+$/, '')}/api/v1/sync-peer/${path}`,
      {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-sync-key': key,
          ...(s.peer ? { 'x-sync-peer': s.peer.id } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (res.status === 401 || res.status === 403)
      throw new Error(
        s.peer
          ? "HQ rejected this install's sync key (revoked?). Enter the sync key again in Settings > Sync."
          : 'Server rejected the sync key',
      );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      const msg = typeof body?.message === 'string' ? body.message : '';
      throw new Error(msg || `Server answered HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Checks the server before any data moves: it is a sync server, on the same
   * schema, and its clock agrees with this PC's. A mismatch pauses transfer
   * (SyncPaused); changes keep queuing in the outbox meanwhile (§4.6).
   */
  async testConnection(
    serverUrl: string,
    apiKey: string | null,
    peer?: { id: string; key: string },
  ) {
    const sent = Date.now();
    const r = await this.call<{
      ok: boolean;
      role: string;
      schema: string;
      now?: number;
    }>({ serverUrl, apiKey, peer }, 'ping');
    // The server read its clock somewhere in the round trip: take the middle.
    const localAtServer = (sent + Date.now()) / 2;
    const local = await this.schemaVersion();
    if (r.role !== 'server')
      throw new Error(
        'That address is not a sync server (SYNC_API_KEY is not set there)',
      );
    if (r.schema !== local) {
      throw new SyncPaused(
        'schema',
        `App versions differ (this PC: ${local}, server: ${r.schema}). Update ${r.schema > local ? 'this branch' : 'HQ'} to the same version; changes keep queuing meanwhile.`,
      );
    }
    const skew = clockSkewError(localAtServer, r.now);
    if (skew) throw new SyncPaused('clock', skew);
    return { ok: true, schema: r.schema };
  }

  /** Gets this install's own key from HQ (bootstrap key auth). */
  private async register(
    serverUrl: string,
    apiKey: string,
    deviceId: string,
    branchIds: string[],
    currentKey?: string | null,
  ) {
    return this.call<{ id: string; key: string; branchIds: string[] }>(
      { serverUrl, apiKey },
      'register',
      {
        method: 'POST',
        body: JSON.stringify({
          id: deviceId,
          name: hostname().slice(0, 80) || deviceId,
          branchIds,
          ...(currentKey ? { currentKey } : {}),
        }),
      },
    );
  }

  /** Branches this install runs: given, or its only local branch in merge mode. */
  private async localBranchIds(
    mode: 'adopt' | 'merge',
    given?: string[],
  ): Promise<string[]> {
    if (given?.length) return [...new Set(given)];
    if (mode === 'adopt') return [];
    const rows = await this.prisma.branch.findMany({ select: { id: true } });
    return rows.length === 1 ? [rows[0].id] : [];
  }

  /** mode 'adopt': replace local data with the server's. 'merge': keep and merge both. */
  async enable(
    serverUrl: string,
    apiKey: string,
    mode: 'adopt' | 'merge',
    branchIds?: string[],
  ) {
    // A cycle already in flight holds the previous sequence numbers.
    await this.running?.catch(() => undefined);
    await this.testConnection(serverUrl, apiKey);
    const s = await this.state();
    // Registration first, so a refused branch choice changes nothing here.
    const reg = await this.register(
      serverUrl,
      apiKey,
      s.deviceId,
      await this.localBranchIds(mode, branchIds),
      // Re-enabling against the same HQ: prove it with its key (#209 audit).
      keyForServer(s, serverUrl),
    );
    const managed = Boolean(process.env.NVENTRA_DATABASE_URL_FILE);
    const meta = mode === 'adopt' && !managed ? await this.syncedTables() : [];
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE sync_state SET enabled = false, role = 'client', "serverUrl" = $1, "apiKey" = NULL,
             "peerKey" = $2, "branchIds" = $3::text[], "lastPullSeq" = 0, "lastPushSeq" = 0,
             "lastError" = NULL, conflicts = '[]', failures = 0, "nextAttemptAt" = NULL,
             "pausedReason" = NULL WHERE id = 1`,
          serverUrl.replace(/\/+$/, ''),
          reg.key,
          reg.branchIds,
        );
        await tx.$executeRawUnsafe('DELETE FROM sync_changes');
        await tx.$executeRawUnsafe('DELETE FROM sync_versions');
        if (mode === 'adopt' && managed) {
          const [result] = await tx.$queryRaw<{ reset: boolean }[]>`
            SELECT public.sync_reset_for_adopt() AS reset`;
          if (!result.reset) throw new Error(ADOPT_LEDGER_ERROR);
        }
        if (mode === 'adopt' && !managed) {
          await tx.$queryRawUnsafe(
            `SELECT set_config('app.sync_origin', '__skip', true)`,
          );
          // The append-only VERI*FACTU chain can't be replaced; an empty one
          // only needs its truncate guard stepped around.
          const chain = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM verifactu_records`,
          );
          if (Number(chain[0].n) > 0) {
            throw new Error(ADOPT_LEDGER_ERROR);
          }
          await tx.$executeRawUnsafe(
            `ALTER TABLE verifactu_records DISABLE TRIGGER USER`,
          );
          const tables = meta.map((t) => `"${t}"`).join(', ');
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

  private async syncedTables(): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ t: string }[]>(
      `SELECT c.relname AS t FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND sync_is_synced_table(c.relname)`,
    );
    return rows.map((r) => r.t);
  }

  async disable() {
    await this.running?.catch(() => undefined);
    await this.prisma.$executeRawUnsafe(
      `UPDATE sync_state SET enabled = false, "lastError" = NULL, "pausedReason" = NULL,
         failures = 0, "nextAttemptAt" = NULL WHERE id = 1 AND role = 'client'`,
    );
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM sync_changes WHERE (SELECT role FROM sync_state) = 'client'`,
    );
  }

  /** Timer tick: a client in backoff waits until its next attempt is due. */
  async runScheduled() {
    const s = await this.state();
    if (s.nextAttemptAt && s.nextAttemptAt.getTime() > Date.now()) return null;
    return this.runOnce();
  }

  /** One cycle now (also from Settings > Sync > Sync now, ignoring backoff). */
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
    try {
      const r = await this.transfer(s);
      await this.prisma.$executeRawUnsafe(
        `UPDATE sync_state SET "lastSyncAt" = now(), "lastError" = NULL, conflicts = $1::jsonb,
           failures = 0, "nextAttemptAt" = NULL, "pausedReason" = NULL WHERE id = 1`,
        JSON.stringify(
          [
            ...r.conflictList.map((c) => ({
              ...c,
              at: new Date().toISOString(),
            })),
            ...(s.conflicts ?? []),
          ].slice(0, MAX_CONFLICTS_KEPT),
        ),
      );
      return { pulled: r.pulled, pushed: r.pushed, conflicts: r.conflicts };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const paused = e instanceof SyncPaused ? e.reason : null;
      const failures = (s.failures ?? 0) + 1;
      this.log.warn(`sync failed: ${msg}`);
      await this.prisma.$executeRawUnsafe(
        `UPDATE sync_state SET "lastError" = $1, failures = $2, "pausedReason" = $3,
           "nextAttemptAt" = now() + ($4::text || ' milliseconds')::interval WHERE id = 1`,
        msg,
        failures,
        paused,
        String(backoffMs(failures)),
      );
      throw e;
    }
  }

  /** Registers if needed, then pulls and pushes every page. */
  private async transfer(s: Awaited<ReturnType<SyncService['state']>>) {
    let conn = { ...s };
    if (!conn.peerKey) {
      // Enabled before #82 with the shared key: get this install's own key.
      if (!conn.apiKey)
        throw new Error('Enter the sync key in Settings > Sync');
      await this.testConnection(conn.serverUrl!, conn.apiKey);
      const reg = await this.register(
        conn.serverUrl!,
        conn.apiKey,
        conn.deviceId,
        conn.branchIds ?? [],
      );
      await this.prisma.$executeRawUnsafe(
        `UPDATE sync_state SET "peerKey" = $1, "branchIds" = $2::text[], "apiKey" = NULL WHERE id = 1`,
        reg.key,
        reg.branchIds,
      );
      conn = {
        ...conn,
        peerKey: reg.key,
        branchIds: reg.branchIds,
        apiKey: null,
      };
    }
    // Only rejections kept before this cycle are re-tried at its end.
    const [{ m: keptBefore }] = await this.prisma.$queryRawUnsafe<
      { m: bigint }[]
    >(`SELECT coalesce(max(id), 0) AS m FROM sync_rejected`);
    const peer = { id: conn.deviceId, key: conn.peerKey! };
    const link = { serverUrl: conn.serverUrl, apiKey: null, peer };
    await this.testConnection(conn.serverUrl!, null, peer);

    let pulled = 0;
    let pushed = 0;
    const conflictList: ApplyResult['conflicts'] = [];
    let since = conn.lastPullSeq;
    for (;;) {
      const page = await this.call<{
        changes: SyncChange[];
        nextSeq: string;
        hasMore: boolean;
      }>(link, `pull?since=${since}`);
      const r = await this.applier.apply(page.changes, {
        origin: '__skip',
        tieWins: true,
        receiver: 'branch',
        branches: conn.branchIds ?? [],
        localPeer: conn.deviceId,
      });
      pulled += r.applied;
      conflictList.push(...r.conflicts);
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

    let pushedTo = conn.lastPushSeq;
    const upTo = await this.safeSeq();
    for (;;) {
      const rows = await this.prisma.$queryRawUnsafe<ChangeRow[]>(
        `SELECT ${CHANGE_COLS} FROM sync_changes WHERE seq > $1 AND seq <= $2 ORDER BY sync_changes.seq LIMIT $3`,
        pushedTo,
        upTo,
        PUSH_PAGE,
      );
      if (!rows.length) break;
      // As many rows as fit HQ's body limit; the rest go in the next page.
      const wire = rows.map(toWire);
      const fit = fitPushPage(wire, PUSH_MAX_BYTES);
      if (!fit) {
        // Too big for any push (#83 review): dead-letter it and move on, or
        // every later change would wait behind it forever.
        const tooBig = tooLargeToPush(wire[0], PUSH_MAX_BYTES)!;
        conflictList.push({
          seq: wire[0].seq,
          tbl: tooBig.tbl,
          pk: tooBig.pkKey,
          error: tooBig.error,
        });
        pushedTo = BigInt(rows[0].seq);
        await this.ackPush([tooBig], pushedTo);
        continue;
      }
      const changes = compact(wire.slice(0, fit));
      const r = await this.call<ApplyResult>(link, 'push', {
        method: 'POST',
        body: JSON.stringify({ changes }),
      });
      pushed += r.applied;
      conflictList.push(...r.conflicts.map(withoutRestore));
      pushedTo = BigInt(rows[fit - 1].seq);
      await this.replay.applyRestores(r.conflicts, {
        branches: conn.branchIds ?? [],
        localPeer: conn.deviceId,
      });
      // Acknowledged by the server: keep what it rejected, then advance the
      // cursor and drop the page together, so a crash replays at most this
      // page (idempotent).
      await this.ackPush(rejectedChanges(changes, r.conflicts), pushedTo);
      if (rows.length < PUSH_PAGE && fit === rows.length) break;
    }
    // Re-tried rejections are already kept: not counted as new conflicts.
    const all = this.retryAllNext;
    this.retryAllNext = false;
    const retried = await this.replay.retry({
      all,
      keptBefore,
      branches: conn.branchIds ?? [],
      localPeer: conn.deviceId,
      maxPushBytes: PUSH_MAX_BYTES,
      push: (changes) =>
        this.call<ApplyResult>(link, 'push', {
          method: 'POST',
          body: JSON.stringify({ changes }),
        }),
    });
    return {
      pulled: pulled + retried.pulled,
      pushed: pushed + retried.pushed,
      conflicts: conflictList.length,
      conflictList,
    };
  }

  /** Settings > Sync: re-try every kept rejection in the next cycle, now. */
  retryAllRejected() {
    this.retryAllNext = true;
    return this.runOnce();
  }
}
