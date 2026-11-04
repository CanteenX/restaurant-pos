// Multi-branch sync 2/4 (#81): change capture and the durable outbox against
// a real, migrated Postgres. Self-contained (registers its own restaurant).
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- sync-outbox
// Other suites may write while sync is on here, so every assertion is
// scoped to this suite's own rows.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from '@prisma/client';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { SyncChange } from './../src/sync/outbox';
import { SyncService } from './../src/sync/sync.service';
import { LOCAL_TABLES, SYNC_TABLES } from './../src/sync/tables';

const tag = randomUUID().slice(0, 6);
const BOOT_TIMEOUT_MS = 60_000;

interface OutboxRow {
  seq: string;
  tbl: string;
  pk: Record<string, unknown>;
  pkKey: string;
  op: string;
  row: Record<string, unknown> | null;
  hlc: string;
  peer: string;
  branchId: string | null;
  schemaVersion: string | null;
}

describe('Sync outbox (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let sync: SyncService;
  let branchId: string;
  let restaurantId: string;
  let ownerId: string;
  let deviceId: string;
  let previousSignup: string | undefined;
  const realFetch = global.fetch;

  const outbox = (ids: string[]) =>
    prisma.$queryRawUnsafe<OutboxRow[]>(
      `SELECT seq::text, tbl, pk, "pkKey", op, row, hlc::text, peer, "branchId", "schemaVersion"
         FROM sync_changes WHERE pk ->> 'id' = ANY ($1::text[]) ORDER BY sync_changes.seq`,
      ids,
    );
  const key = (id: string) => JSON.stringify({ id }).replace(':', ': ');

  beforeAll(async () => {
    previousSignup = process.env.ALLOW_PUBLIC_SIGNUP;
    process.env.ALLOW_PUBLIC_SIGNUP = 'true';
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 60,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    prisma = app.get(PrismaService);
    sync = app.get(SyncService);

    const email = `sync-outbox-${tag}@example.com`;
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ownerName: 'Sync Owner',
        email,
        password: 'Password123!',
        restaurantName: `Sync ${tag}`,
        branchName: 'Main',
      })
      .expect(201);
    const owner = await prisma.user.findFirstOrThrow({ where: { email } });
    ownerId = owner.id;
    restaurantId = owner.restaurantId;
    branchId = (
      await prisma.branch.findFirstOrThrow({ where: { restaurantId } })
    ).id;

    // A branch install whose HQ is unreachable: writes must queue up.
    await prisma.$executeRawUnsafe(
      `UPDATE sync_state SET enabled = true, role = 'client', "serverUrl" = 'http://127.0.0.1:9',
         "apiKey" = 'offline-test-key-0000', "lastPushSeq" = 0, "lastPullSeq" = 0, "lastError" = NULL
       WHERE id = 1`,
    );
    deviceId = (await sync.state()).deviceId;
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    global.fetch = realFetch;
    await prisma.$executeRawUnsafe(
      `UPDATE sync_state SET enabled = false, "serverUrl" = NULL, "apiKey" = NULL,
         "lastPushSeq" = 0, "lastPullSeq" = 0, "lastError" = NULL, conflicts = '[]' WHERE id = 1`,
    );
    await prisma.$executeRawUnsafe('DELETE FROM sync_changes');
    await prisma.$executeRawUnsafe('DELETE FROM sync_versions');
    await prisma.$executeRawUnsafe('DELETE FROM sync_cursors');
    await prisma.$executeRawUnsafe('DELETE FROM sync_rejected');
    await prisma.permission.deleteMany({ where: { key: `sync.test.${tag}` } });
    process.env.ALLOW_PUBLIC_SIGNUP = previousSignup;
    await app.close();
  });

  it('installs the capture trigger on exactly the synced tables', async () => {
    const rows = await prisma.$queryRawUnsafe<{ t: string }[]>(
      `SELECT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
        WHERE g.tgname = 'sync_log' AND c.relnamespace = 'public'::regnamespace`,
    );
    const withTrigger = new Set(rows.map((r) => r.t));
    expect([...withTrigger].filter((t) => t in LOCAL_TABLES)).toEqual([]);
    expect(Object.keys(SYNC_TABLES).filter((t) => !withTrigger.has(t))).toEqual(
      [],
    );
  });

  it('offline writes accumulate in order with clock, branch and tombstones', async () => {
    const floor = await prisma.floor.create({
      data: { branchId, name: `F-${tag}` },
    });
    const table = await prisma.table.create({
      data: { floorId: floor.id, number: `T-${tag}` },
    });
    await prisma.floor.update({
      where: { id: floor.id },
      data: { name: `F2-${tag}` },
    });
    await prisma.floor.update({
      where: { id: floor.id },
      data: { name: `F3-${tag}` },
    });
    await prisma.table.delete({ where: { id: table.id } });

    const rows = await outbox([floor.id, table.id]);
    expect(rows.map((r) => `${r.tbl}:${r.op}`)).toEqual([
      'floors:U',
      'tables:U',
      'floors:U',
      'floors:U',
      'tables:D',
    ]);
    const floorHlc = rows
      .filter((r) => r.tbl === 'floors')
      .map((r) => BigInt(r.hlc));
    expect(floorHlc[0] < floorHlc[1] && floorHlc[1] < floorHlc[2]).toBe(true);
    // The table has no branchId column: its branch comes from the floor.
    expect(rows.every((r) => r.branchId === branchId)).toBe(true);
    expect(rows.every((r) => r.peer === deviceId)).toBe(true);
    expect(rows[0].schemaVersion).toBe(await sync.schemaVersion());
    const tomb = rows[4];
    expect(tomb.row).toBeNull();
    expect(tomb.pkKey).toBe(key(table.id));
    const v = await prisma.$queryRawUnsafe<
      { deleted: boolean; branchId: string }[]
    >(
      `SELECT deleted, "branchId" FROM sync_versions WHERE tbl = 'tables' AND "pkKey" = $1`,
      tomb.pkKey,
    );
    expect(v).toEqual([{ deleted: true, branchId }]);

    // HQ unreachable: the cycle fails and nothing is lost.
    await expect(sync.runOnce()).rejects.toThrow();
    expect(await outbox([floor.id, table.id])).toHaveLength(5);
  });

  it('strips sealed 2FA secrets and ships permission grants by key', async () => {
    await prisma.user.update({
      where: { id: ownerId },
      data: { twoFactorSecret: 'sealed-with-this-install-key' },
    });
    const [u] = (await outbox([ownerId])).slice(-1);
    expect(u.row).not.toHaveProperty('twoFactorSecret');
    expect(u.row).toHaveProperty('passwordHash');

    const role = await prisma.role.create({
      data: {
        restaurantId,
        name: `r-${tag}`,
        label: 'Sync role',
        isSystem: false,
      },
    });
    const permKey = `sync.test.${tag}`;
    const perm = await prisma.permission.create({
      data: { key: permKey, label: 'Sync test', category: 'Test' },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: perm.id },
    });
    const grants = await prisma.$queryRawUnsafe<OutboxRow[]>(
      `SELECT pk, row FROM sync_changes WHERE tbl = 'role_permissions' AND pk ->> 'roleId' = $1`,
      role.id,
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].pk).toEqual({ roleId: role.id, permissionKey: permKey });
    expect(grants[0].row?.permissionKey).toBe(permKey);

    // Nothing is captured for local tables.
    const local = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM sync_changes WHERE tbl = ANY ($1::text[])`,
      Object.keys(LOCAL_TABLES),
    );
    expect(Number(local[0].n)).toBe(0);
  });

  it('drains in outbox order once HQ is back, resuming after a drop mid-batch', async () => {
    // Make the batch cross a digit boundary (…9999 -> …10000) so text vs
    // numeric ordering of seq would show. setval only ever moves forward.
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('sync_changes', 'seq'),
         greatest(nextval(pg_get_serial_sequence('sync_changes', 'seq')),
                  power(10, length((nextval(pg_get_serial_sequence('sync_changes', 'seq')) + 500)::text))::bigint - 200))`,
    );
    const created = await prisma.floor.createManyAndReturn({
      data: Array.from({ length: 450 }, (_, i) => ({
        branchId,
        name: `Bulk-${tag}-${i}`,
      })),
      select: { id: true },
    });
    const mine = (await outbox(created.map((f) => f.id))).map((r) => r.seq);
    expect(mine).toHaveLength(450);

    const received: string[] = [];
    let pushes = 0;
    let dropOn = 2;
    const schema = await sync.schemaVersion();
    global.fetch = (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.split('/').pop();
      const reply = (body: unknown) =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      if (path === 'ping')
        return reply({ ok: true, role: 'server', schema, now: Date.now() });
      if (path === 'pull')
        return reply({ changes: [], nextSeq: '0', hasMore: false });
      pushes++;
      if (pushes === dropOn) return Promise.reject(new Error('link down'));
      const body = JSON.parse(init?.body as string) as {
        changes: SyncChange[];
      };
      for (const c of body.changes) received.push(c.seq!);
      return reply({ applied: body.changes.length, skipped: 0, conflicts: [] });
    };

    await expect(sync.runOnce()).rejects.toThrow('link down');
    const afterDrop = await sync.state();
    expect(afterDrop.lastPushSeq).toBeGreaterThan(0n);
    // The acknowledged page is gone, the rest still queued.
    const left = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM sync_changes WHERE seq <= $1`,
      afterDrop.lastPushSeq,
    );
    expect(Number(left[0].n)).toBe(0);
    expect((await outbox(created.map((f) => f.id))).length).toBeGreaterThan(0);

    dropOn = -1;
    await sync.runOnce();
    expect(await outbox(created.map((f) => f.id))).toHaveLength(0);
    const seqs = received.map(BigInt);
    expect(seqs.every((s, i) => i === 0 || s > seqs[i - 1])).toBe(true);
    for (const s of mine)
      expect(received.filter((r) => r === s)).toHaveLength(1);
  });

  it('replay is idempotent and a tombstone beats older updates', async () => {
    const floor = await prisma.floor.create({
      data: { branchId, name: `R-${tag}` },
    });
    const [captured] = await outbox([floor.id]);
    const base = BigInt(captured.hlc);
    const change = (op: 'U' | 'D', bump: bigint, name: string): SyncChange => ({
      tbl: 'floors',
      pk: { id: floor.id },
      pkKey: captured.pkKey,
      op,
      row: op === 'U' ? { ...captured.row, name } : null,
      ts: new Date().toISOString(),
      hlc: String(base + bump),
      peer: 'branch-z',
      branchId,
    });
    const name = async () =>
      (await prisma.floor.findUnique({ where: { id: floor.id } }))?.name;

    const edit = change('U', 1000n, `Remote-${tag}`);
    expect((await sync.push('branch-z', [edit])).applied).toBe(1);
    const again = await sync.push('branch-z', [edit]);
    expect([again.applied, again.skipped]).toEqual([0, 1]);
    expect(await name()).toBe(`Remote-${tag}`);

    expect(
      (await sync.push('branch-z', [change('D', 2000n, '')])).applied,
    ).toBe(1);
    expect(await name()).toBeUndefined();
    const stale = await sync.push('branch-z', [change('U', 1500n, 'stale')]);
    expect([stale.applied, stale.skipped]).toEqual([0, 1]);
    expect(await name()).toBeUndefined();

    await sync.push('branch-z', [change('U', 3000n, `Back-${tag}`)]);
    expect(await name()).toBe(`Back-${tag}`);
  });

  it('server compaction drops superseded entries every client has pulled', async () => {
    const floor = await prisma.floor.create({
      data: { branchId, name: `C-${tag}` },
    });
    for (const n of [1, 2, 3])
      await prisma.floor.update({
        where: { id: floor.id },
        data: { name: `C${n}-${tag}` },
      });
    expect(await outbox([floor.id])).toHaveLength(4);
    const top = (await outbox([floor.id])).pop()!.seq;

    // A client still behind holds compaction back.
    await sync.pull(0n, `lagging-${tag}`, 1);
    await sync.compactOutbox();
    expect(await outbox([floor.id])).toHaveLength(4);

    await sync.pull(BigInt(top), `lagging-${tag}`, 1);
    await sync.compactOutbox();
    const kept = await outbox([floor.id]);
    expect(kept.map((r) => r.row?.name)).toEqual([`C3-${tag}`]);
  });

  /**
   * HQ stand-in: ping ok (its clock `offsetMs` from ours), `pull` from the
   * given page, `push` via handler.
   */
  const fakeHq = async (
    pull: { changes: SyncChange[]; nextSeq: string },
    push: (changes: SyncChange[]) => Promise<unknown>,
    offsetMs = 0,
  ) => {
    const schema = await sync.schemaVersion();
    global.fetch = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.split('/').pop();
      const reply = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200 });
      if (path === 'ping')
        return reply({
          ok: true,
          role: 'server',
          schema,
          now: Date.now() + offsetMs,
        });
      if (path === 'pull') return reply({ ...pull, hasMore: false });
      const body = JSON.parse(init?.body as string) as {
        changes: SyncChange[];
      };
      return reply(await push(body.changes));
    };
  };

  it('upgrade: entries queued before the migration are backfilled and pushed', async () => {
    const floor = await prisma.floor.create({
      data: { branchId, name: `L-${tag}` },
    });
    await prisma.floor.update({
      where: { id: floor.id },
      data: { name: `L2-${tag}` },
    });
    const [first] = await outbox([floor.id]);
    // Make them look like pre-#81 entries: same ms, no clock, no peer.
    await prisma.$executeRawUnsafe(
      `UPDATE sync_changes SET hlc = 0, peer = '', "branchId" = NULL, ts = $2::timestamptz
        WHERE pk ->> 'id' = $1`,
      floor.id,
      '2026-11-01T10:00:00.000Z',
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM sync_versions WHERE "pkKey" = $1`,
      first.pkKey,
    );
    // Relayed (server-side) and seed entries from before the upgrade.
    const relayed = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO sync_changes (tbl, pk, "pkKey", op, row, ts, origin)
       VALUES ('floors', $1::jsonb, $2, 'D', NULL, now(), 'branch-q'),
              ('floors', $1::jsonb, $2, 'U', '{}'::jsonb, 'epoch', 'seed')`,
      JSON.stringify({ id: relayed }),
      key(relayed),
    );

    await prisma.$executeRawUnsafe('SELECT sync_backfill_legacy()');

    const rows = await outbox([floor.id, relayed]);
    const mine = rows.filter((r) => r.pk.id === floor.id);
    const ms = Date.parse('2026-11-01T10:00:00.000Z');
    expect(mine.map((r) => r.peer)).toEqual([deviceId, deviceId]);
    expect(mine.map((r) => BigInt(r.hlc))).toEqual([
      BigInt(ms) * 65536n + 1n,
      BigInt(ms) * 65536n + 2n,
    ]);
    expect(mine.every((r) => r.branchId === branchId)).toBe(true);
    const other = rows.filter((r) => r.pk.id === relayed);
    expect(other.map((r) => [r.peer, BigInt(r.hlc) > 0n])).toEqual([
      ['branch-q', true],
      ['seed', false],
    ]);
    // The newest backfilled version is registered, so a later edit orders after it.
    const [v] = await prisma.$queryRawUnsafe<{ hlc: string; peer: string }[]>(
      `SELECT hlc::text, peer FROM sync_versions WHERE tbl = 'floors' AND "pkKey" = $1`,
      first.pkKey,
    );
    expect(v).toEqual({ hlc: mine[1].hlc, peer: deviceId });

    // HQ holds an older version of the row from another branch: ours wins.
    const results: Awaited<ReturnType<SyncService['push']>>[] = [];
    await fakeHq({ changes: [], nextSeq: '0' }, async (changes) => {
      await prisma.$executeRawUnsafe(
        `UPDATE sync_versions SET hlc = $2::bigint, peer = 'hq' WHERE tbl = 'floors' AND "pkKey" = $1`,
        first.pkKey,
        String(BigInt(ms - 60_000) * 65536n),
      );
      const r = await sync.push('legacy-client', changes);
      results.push(r);
      return r;
    });
    await sync.runOnce();
    const conflicts = results.flatMap((r) => r.conflicts);
    expect(conflicts.filter((c) => c.pk === first.pkKey)).toEqual([]);
    expect(results.reduce((n, r) => n + r.applied, 0)).toBeGreaterThan(0);
    const [after] = await prisma.$queryRawUnsafe<
      { hlc: string; peer: string }[]
    >(
      `SELECT hlc::text, peer FROM sync_versions WHERE tbl = 'floors' AND "pkKey" = $1`,
      first.pkKey,
    );
    expect(after).toEqual({ hlc: mine[1].hlc, peer: deviceId });
    const rejected = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM sync_rejected WHERE "pkKey" = $1`,
      first.pkKey,
    );
    expect(Number(rejected[0].n)).toBe(0);
  });

  it('rejected changes are kept in sync_rejected, not pruned with the page', async () => {
    await prisma.$executeRawUnsafe('DELETE FROM sync_changes');
    const floor = await prisma.floor.create({
      data: { branchId, name: `X-${tag}` },
    });
    const [queued] = await outbox([floor.id]);
    const bad: SyncChange = {
      seq: '987654',
      tbl: 'floors',
      pk: { id: `bad-${tag}` },
      pkKey: key(`bad-${tag}`),
      op: 'U',
      row: { id: `bad-${tag}` },
      ts: new Date().toISOString(),
      hlc: '1',
      peer: '',
    };
    await fakeHq({ changes: [bad], nextSeq: '987654' }, (changes) =>
      Promise.resolve({
        applied: 0,
        skipped: 0,
        conflicts: changes.map((c) => ({
          seq: c.seq,
          tbl: c.tbl,
          pk: c.pkKey,
          error: 'violates foreign key constraint',
        })),
      }),
    );
    const r = await sync.runOnce();
    expect(r?.conflicts).toBe(2);
    expect(await outbox([floor.id])).toHaveLength(0);

    const kept = await prisma.$queryRawUnsafe<
      { side: string; pkKey: string; change: SyncChange; error: string }[]
    >(
      `SELECT side, "pkKey", change, error FROM sync_rejected WHERE "pkKey" = ANY ($1::text[]) ORDER BY id`,
      [queued.pkKey, bad.pkKey],
    );
    expect(kept.map((k) => [k.side, k.pkKey, k.error])).toEqual([
      ['pull', bad.pkKey, 'change without a peer'],
      ['push', queued.pkKey, 'violates foreign key constraint'],
    ]);
    expect(kept[1].change.seq).toBe(queued.seq);
    expect(kept[1].change.row?.name).toBe(`X-${tag}`);
    expect((await sync.publicStatus()).rejectedChanges).toBeGreaterThanOrEqual(
      2,
    );
  });
  // A writer holds a lower seq while a later writer commits first (#81 review).
  const holdOpenWrite = async (name: string) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let wrote!: (id: string) => void;
    const written = new Promise<string>((r) => (wrote = r));
    const done = prisma.$transaction(
      async (tx) => {
        const f = await tx.floor.create({ data: { branchId, name } });
        wrote(f.id);
        await gate;
      },
      { timeout: 30_000 },
    );
    return { id: await written, commit: async () => (release(), done) };
  };

  it('an entry whose transaction commits after a higher seq is still pushed', async () => {
    await prisma.$executeRawUnsafe('DELETE FROM sync_changes');
    await prisma.$executeRawUnsafe(
      `UPDATE sync_state SET "lastPushSeq" = 0, "lastPullSeq" = 0 WHERE id = 1`,
    );
    const slow = await holdOpenWrite(`Slow-${tag}`);
    const fast = await prisma.floor.create({
      data: { branchId, name: `Fast-${tag}` },
    });
    const received: string[] = [];
    await fakeHq({ changes: [], nextSeq: '0' }, (changes) => {
      for (const c of changes) received.push(String(c.pk.id));
      return Promise.resolve({
        applied: changes.length,
        skipped: 0,
        conflicts: [],
      });
    });
    try {
      await sync.runOnce();
      // Nothing past the open writer's entry is pushed or pruned yet.
      expect(received).not.toContain(fast.id);
      expect(await outbox([fast.id])).toHaveLength(1);
    } finally {
      await slow.commit();
    }
    await sync.runOnce();
    expect(received.filter((id) => id === slow.id)).toHaveLength(1);
    expect(received.filter((id) => id === fast.id)).toHaveLength(1);
    expect(await outbox([slow.id, fast.id])).toHaveLength(0);
  });

  it('server pull never moves a cursor past a still-open write', async () => {
    await prisma.$executeRawUnsafe('DELETE FROM sync_changes');
    const head = await prisma.$queryRawUnsafe<{ s: string }[]>(
      `SELECT coalesce(max(seq), 0)::text AS s FROM sync_changes`,
    );
    const since = BigInt(head[0].s);
    const slow = await holdOpenWrite(`SlowPull-${tag}`);
    const fast = await prisma.floor.create({
      data: { branchId, name: `FastPull-${tag}` },
    });
    const seen: string[] = [];
    let page: Awaited<ReturnType<SyncService['pull']>>;
    try {
      page = await sync.pull(since, `other-${tag}`);
      for (const c of page.changes) seen.push(String(c.pk.id));
    } finally {
      await slow.commit();
    }
    page = await sync.pull(BigInt(page.nextSeq), `other-${tag}`);
    for (const c of page.changes) seen.push(String(c.pk.id));
    expect(seen).toContain(slow.id);
    expect(seen).toContain(fast.id);
  });
  it('a PC whose clock is off stops before syncing and loses nothing', async () => {
    await prisma.$executeRawUnsafe('DELETE FROM sync_changes');
    await prisma.$executeRawUnsafe('DELETE FROM sync_rejected');
    await prisma.$executeRawUnsafe(
      `UPDATE sync_state SET "lastPushSeq" = 0, "lastPullSeq" = 0 WHERE id = 1`,
    );
    const floor = await prisma.floor.create({
      data: { branchId, name: `Skew-${tag}` },
    });
    const hqChange: SyncChange = {
      seq: '42',
      tbl: 'floors',
      pk: { id: `hq-${tag}` },
      pkKey: key(`hq-${tag}`),
      op: 'D',
      row: null,
      ts: new Date().toISOString(),
      hlc: (BigInt(Date.now()) * 65536n).toString(),
      peer: 'hq',
    };
    const pushed: SyncChange[] = [];
    for (const offsetMs of [6 * 60_000, -6 * 60_000]) {
      await fakeHq(
        { changes: [hqChange], nextSeq: '42' },
        (changes) => {
          pushed.push(...changes);
          return Promise.resolve({ applied: 0, skipped: 0, conflicts: [] });
        },
        offsetMs,
      );
      const way = offsetMs > 0 ? 'behind' : 'ahead of';
      await expect(sync.runOnce()).rejects.toThrow(
        `This PC's clock is 6 min ${way} the server; fix the time to resume sync.`,
      );
      const s = await sync.state();
      expect(s.lastError).toMatch(/clock is 6 min/);
      expect(s.lastPullSeq).toBe(0n);
      expect(s.lastPushSeq).toBe(0n);
    }
    expect(pushed).toHaveLength(0);
    expect(await outbox([floor.id])).toHaveLength(1);
    const rejected = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM sync_rejected`,
    );
    expect(Number(rejected[0].n)).toBe(0);

    // Clock fixed: the same entry goes out and the error clears.
    await fakeHq({ changes: [], nextSeq: '0' }, (changes) => {
      pushed.push(...changes);
      return Promise.resolve({
        applied: changes.length,
        skipped: 0,
        conflicts: [],
      });
    });
    await sync.runOnce();
    expect(pushed.map((c) => c.pk.id)).toContain(floor.id);
    expect(await outbox([floor.id])).toHaveLength(0);
    expect((await sync.state()).lastError).toBeNull();
  });

  // ---- #81 audit -----------------------------------------------------------

  it('VERI*FACTU settings stay on this install (sealed cert, local counters)', async () => {
    const s = await prisma.verifactuSettings.create({
      data: { branchId, installationNumber: `I-${tag}`, nextNumber: 7 },
    });
    try {
      expect(await outbox([s.id])).toHaveLength(0);
      const r = await sync.push('branch-z', [
        {
          tbl: 'verifactu_settings',
          pk: { id: s.id },
          pkKey: key(s.id),
          op: 'U',
          row: { id: s.id, branchId, installationNumber: 'x', nextNumber: 1 },
          ts: new Date().toISOString(),
          hlc: String(BigInt(Date.now()) * 65536n),
          peer: 'branch-z',
        },
      ]);
      expect(r.conflicts.map((c) => c.error)).toEqual([
        'unknown table verifactu_settings',
      ]);
      const after = await prisma.verifactuSettings.findUniqueOrThrow({
        where: { id: s.id },
      });
      expect(after.nextNumber).toBe(7);
    } finally {
      await prisma.verifactuSettings.delete({ where: { id: s.id } });
    }
  });

  it('rejects a change whose pkKey or row names another row than pk', async () => {
    const [a, b] = await Promise.all(
      ['A', 'B'].map((n) =>
        prisma.floor.create({ data: { branchId, name: `K${n}-${tag}` } }),
      ),
    );
    const [ca] = await outbox([a.id]);
    const base: SyncChange = {
      tbl: 'floors',
      pk: { id: a.id },
      pkKey: ca.pkKey,
      op: 'U',
      row: { ...ca.row, name: `Hijack-${tag}` },
      ts: new Date().toISOString(),
      hlc: String(BigInt(ca.hlc) + 1000n),
      peer: 'branch-z',
    };
    const r = await sync.push('branch-z', [
      { ...base, pkKey: key(b.id) },
      {
        ...base,
        hlc: String(BigInt(ca.hlc) + 2000n),
        row: { ...base.row, id: b.id },
      },
    ]);
    expect(r.conflicts.map((c) => c.error).sort()).toEqual([
      'pkKey does not match pk',
      'row does not match pk',
    ]);
    expect(r.applied).toBe(0);
    const names = await prisma.floor.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    expect(names.map((n) => n.name)).toEqual([`KA-${tag}`, `KB-${tag}`]);
    const [vb] = await prisma.$queryRawUnsafe<{ peer: string }[]>(
      `SELECT peer FROM sync_versions WHERE tbl = 'floors' AND "pkKey" = $1`,
      key(b.id),
    );
    expect(vb.peer).toBe(deviceId);
  });

  it('two concurrent pushes of one row: the newer HLC wins on both sides', async () => {
    const floor = await prisma.floor.create({
      data: { branchId, name: `C-${tag}` },
    });
    const [cap] = await outbox([floor.id]);
    const at = (bump: bigint, name: string, peer: string): SyncChange => ({
      tbl: 'floors',
      pk: { id: floor.id },
      pkKey: cap.pkKey,
      op: 'U',
      row: { ...cap.row, name },
      ts: new Date().toISOString(),
      hlc: String(BigInt(cap.hlc) + bump),
      peer,
    });
    const waiting = async (n: number) => {
      for (let i = 0; i < 200; i++) {
        const [w] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND (query LIKE '%INSERT INTO "floors"%' OR query LIKE '%pg_advisory_xact_lock(hashtext(''sync_row'')%')`,
        );
        if (Number(w.n) >= n) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`expected ${n} blocked pushes`);
    };
    // Hold the row so both pushes are in flight at the same time.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT 1 FROM floors WHERE id = $1 FOR UPDATE`,
          floor.id,
        );
        locked();
        await gate;
      },
      { timeout: 30_000 },
    );
    await isLocked;
    const newer = sync.push('branch-new', [
      at(2000n, `New-${tag}`, 'branch-new'),
    ]);
    await waiting(1);
    const older = sync.push('branch-old', [
      at(1000n, `Old-${tag}`, 'branch-old'),
    ]);
    await waiting(2);
    release();
    await holder;
    const [rn, ro] = await Promise.all([newer, older]);
    expect([rn.applied, rn.conflicts]).toEqual([1, []]);
    expect([ro.applied, ro.skipped, ro.conflicts]).toEqual([0, 1, []]);
    const row = await prisma.floor.findUniqueOrThrow({
      where: { id: floor.id },
    });
    expect(row.name).toBe(`New-${tag}`);
    const [v] = await prisma.$queryRawUnsafe<{ hlc: string; peer: string }[]>(
      `SELECT hlc::text, peer FROM sync_versions WHERE tbl = 'floors' AND "pkKey" = $1`,
      cap.pkKey,
    );
    expect(v).toEqual({ hlc: at(2000n, '', '').hlc, peer: 'branch-new' });
  }, 30_000);

  it('an open writer in another database on the cluster does not stall sync', async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/postgres';
    const other = new PrismaClient({
      datasources: { db: { url: url.toString() } },
    });
    const head = async () =>
      (
        await prisma.$queryRawUnsafe<{ h: string; s: string }[]>(
          `SELECT sync_seq_head()::text AS h, sync_safe_seq()::text AS s`,
        )
      )[0];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const tx = other.$transaction(
      async (t) => {
        // Same key shape as sync_mark_inflight(), at seq 0 of that database.
        await t.$queryRawUnsafe(
          `SELECT pg_advisory_xact_lock_shared(1::bigint << 40)::text`,
        );
        held();
        await gate;
      },
      { timeout: 30_000 },
    );
    try {
      await isHeld;
      // Without the database filter the bound would drop to 0 here. Writers
      // of other suites in this database may still lower it, never to 0.
      const now = await head();
      expect(BigInt(now.h)).toBeGreaterThan(0n);
      expect(BigInt(now.s)).toBeGreaterThan(0n);
    } finally {
      release();
      await tx;
      await other.$disconnect();
    }
  }, 30_000);
});
