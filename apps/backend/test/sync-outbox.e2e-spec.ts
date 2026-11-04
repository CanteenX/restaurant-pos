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
      if (path === 'ping') return reply({ ok: true, role: 'server', schema });
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
});
