// Multi-branch sync 4/4 (#83): two running installs converge. HQ and a
// branch each run the full app on their own Postgres database (created and
// migrated here, dropped afterwards); the branch talks to HQ over real HTTP.
// Both sides edit while "offline" (no sync cycle), then reconnect, and every
// scenario asserts the same rows on both databases with nothing lost.
//
// Opt-in (two migrations, ~1 min):
//   SYNC_CONVERGENCE_E2E=1 DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- sync-convergence
// SYNC_CONVERGENCE_DISABLE=1 runs the same edits without ever syncing: the
// suite must then fail (scripts/sync-convergence.sh checks both).
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { AppModule } from './../src/app.module';
import { addWalletEntry } from './../src/modules/customers/wallet-ledger';
import { PrismaService } from './../src/prisma/prisma.service';
import { SyncService } from './../src/sync/sync.service';

const run = process.env.SYNC_CONVERGENCE_E2E ? describe : describe.skip;
const SYNC_ON = process.env.SYNC_CONVERGENCE_DISABLE !== '1';
const tag = randomUUID().slice(0, 6);
const BOOT = `convergence-${tag}-0123456789`;
const BRANCH = 'demo-branch';

run('Two-install convergence (e2e)', () => {
  const baseUrl = process.env.DATABASE_URL!;
  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  const dbUrl = (suffix: string) => {
    const u = new URL(baseUrl);
    u.pathname = `/${u.pathname.slice(1)}_${suffix}_${tag}`;
    return u;
  };
  const hqUrl = dbUrl('hq');
  const brUrl = dbUrl('br');
  let hqApp: INestApplication;
  let brApp: INestApplication;
  let hq: PrismaService;
  let br: PrismaService;
  let brSync: SyncService;
  let hqAddress: string;
  const realFetch = global.fetch;

  const boot = async (url: URL, syncKey?: string) => {
    process.env.DATABASE_URL = url.toString();
    if (syncKey) process.env.SYNC_API_KEY = syncKey;
    else delete process.env.SYNC_API_KEY;
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
    const app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    return app;
  };

  /** One branch cycle; a second one pulls what HQ relayed meanwhile. */
  const reconnect = async () => {
    if (!SYNC_ON) return;
    await brSync.runOnce();
    await brSync.runOnce();
  };
  /** The same query on both installs. */
  const both = async <T>(q: (db: PrismaService) => Promise<T>) => ({
    hq: await q(hq),
    br: await q(br),
  });

  beforeAll(async () => {
    const cwd = path.join(__dirname, '..');
    for (const u of [hqUrl, brUrl]) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${u.pathname.slice(1)}"`);
      const env = { ...process.env, DATABASE_URL: u.toString() };
      execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd, env });
    }
    // HQ has the restaurant (demo seed); the branch starts empty and adopts it.
    execFileSync('npx', ['ts-node', 'prisma/seed.ts'], {
      cwd,
      env: { ...process.env, DATABASE_URL: hqUrl.toString() },
    });
    hqApp = await boot(hqUrl, BOOT);
    await hqApp.listen(0, '127.0.0.1');
    hqAddress = `http://127.0.0.1:${((hqApp.getHttpServer() as Server).address() as AddressInfo).port}`;
    hq = hqApp.get(PrismaService);
    brApp = await boot(brUrl);
    br = brApp.get(PrismaService);
    brSync = brApp.get(SyncService);
    if (SYNC_ON) await brSync.enable(hqAddress, BOOT, 'adopt', [BRANCH]);
  }, 300_000);

  afterAll(async () => {
    global.fetch = realFetch;
    await brApp?.close();
    await hqApp?.close();
    process.env.DATABASE_URL = baseUrl;
    delete process.env.SYNC_API_KEY;
    for (const u of [hqUrl, brUrl])
      await admin.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${u.pathname.slice(1)}" WITH (FORCE)`,
      );
    await admin.$disconnect();
  });

  it('the branch adopts HQ: same menu, staff and branch rows', async () => {
    const r = await both((db) =>
      Promise.all([
        db.menuItem.count({ where: { branchId: BRANCH } }),
        db.user.count(),
        db.branch.findUnique({ where: { id: BRANCH }, select: { name: true } }),
      ]),
    );
    expect(r.hq[0]).toBeGreaterThan(0);
    expect(r.br).toEqual(r.hq);
  });

  it('create/create: rows created on each side while offline end up on both', async () => {
    const category = await hq.menuCategory.findFirstOrThrow({
      where: { branchId: BRANCH },
    });
    const dish = await hq.menuItem.create({
      data: {
        branchId: BRANCH,
        categoryId: category.id,
        name: `HQ dish ${tag}`,
        price: 210,
      },
    });
    const atHq = await hq.customer.create({
      data: { branchId: BRANCH, name: `HQ guest ${tag}` },
    });
    const atBranch = await br.customer.create({
      data: {
        branchId: BRANCH,
        name: `Branch guest ${tag}`,
        phone: '9000011111',
      },
    });
    await reconnect();
    const r = await both((db) =>
      Promise.all([
        db.menuItem.findUnique({
          where: { id: dish.id },
          select: { name: true, price: true },
        }),
        db.customer.findMany({
          where: { id: { in: [atHq.id, atBranch.id] } },
          select: { id: true, name: true, phone: true },
          orderBy: { id: 'asc' },
        }),
      ]),
    );
    expect(r.hq[1]).toHaveLength(2);
    expect(r.br).toEqual(r.hq);
  });

  it('update/update: the newest edit of a branch row wins on both sides; HQ wins its own rows', async () => {
    const guest = await br.customer.create({
      data: { branchId: BRANCH, name: `Guest ${tag}` },
    });
    await reconnect();
    // Offline: HQ edits first, the branch edits later -> the branch's wins.
    await hq.customer.update({
      where: { id: guest.id },
      data: { name: 'HQ edit', notes: 'from HQ' },
    });
    await new Promise((r) => setTimeout(r, 5));
    await br.customer.update({
      where: { id: guest.id },
      data: { name: 'Branch edit' },
    });
    // An HQ-owned row edited on both: HQ owns it, so HQ's value stands
    // everywhere and the branch's edit is kept on the branch for review.
    const dish = await hq.menuItem.findFirstOrThrow({
      where: { branchId: BRANCH },
    });
    await hq.menuItem.update({ where: { id: dish.id }, data: { price: 333 } });
    await br.menuItem.update({ where: { id: dish.id }, data: { price: 1 } });
    // Only the branch edits this HQ-owned row: it is put back to HQ's.
    const other = await hq.menuItem.findFirstOrThrow({
      where: { branchId: BRANCH, id: { not: dish.id } },
    });
    await br.menuItem.update({
      where: { id: other.id },
      data: { name: 'Renamed at branch' },
    });
    await reconnect();
    const r = await both((db) =>
      Promise.all([
        db.customer.findUnique({
          where: { id: guest.id },
          select: { name: true },
        }),
        db.menuItem.findUnique({
          where: { id: dish.id },
          select: { price: true },
        }),
        db.menuItem.findUnique({
          where: { id: other.id },
          select: { name: true },
        }),
      ]),
    );
    expect(r.hq[0]?.name).toBe('Branch edit');
    expect(r.hq[1]?.price.toString()).toBe('333');
    expect(r.hq[2]?.name).toBe(other.name);
    expect(r.br).toEqual(r.hq);
    const kept = await br.$queryRawUnsafe<{ error: string }[]>(
      `SELECT error FROM sync_rejected WHERE tbl = 'menu_items' AND "pkKey" = ANY ($1::text[])`,
      [dish.id, other.id].map((id) =>
        JSON.stringify({ id }).replace(':', ': '),
      ),
    );
    expect(kept.map((k) => k.error)).toEqual([
      'not-owner: menu_items is HQ-owned',
      'not-owner: menu_items is HQ-owned',
    ]);
  });

  it('delete/update: the newest action wins on both sides', async () => {
    const [a, b] = await Promise.all(
      ['A', 'B'].map((n) =>
        br.customer.create({
          data: { branchId: BRANCH, name: `Del ${n} ${tag}` },
        }),
      ),
    );
    await reconnect();
    // a: HQ updates, then the branch deletes -> deleted on both.
    await hq.customer.update({
      where: { id: a.id },
      data: { notes: 'HQ note' },
    });
    await new Promise((r) => setTimeout(r, 5));
    await br.customer.delete({ where: { id: a.id } });
    // b: HQ deletes, then the branch updates -> back on both, with the update.
    await hq.customer.delete({ where: { id: b.id } });
    await new Promise((r) => setTimeout(r, 5));
    await br.customer.update({ where: { id: b.id }, data: { notes: 'kept' } });
    await reconnect();
    const r = await both((db) =>
      db.customer.findMany({
        where: { id: { in: [a.id, b.id] } },
        select: { id: true, notes: true },
      }),
    );
    expect(r.hq).toEqual([{ id: b.id, notes: 'kept' }]);
    expect(r.br).toEqual(r.hq);
  });

  it('balances converge: store credit booked at the branch is the same total at HQ', async () => {
    const guest = await br.customer.create({
      data: { branchId: BRANCH, name: `Wallet ${tag}` },
    });
    for (const [i, delta] of [12.5, 7.25, -4].entries())
      await br.$transaction((tx) =>
        addWalletEntry(tx, {
          customerId: guest.id,
          delta,
          reason: 'REFUND_CREDIT',
          idempotencyKey: `conv-${tag}-${i}`,
        }),
      );
    await reconnect();
    const r = await both((db) =>
      db.customer.findUnique({
        where: { id: guest.id },
        select: { walletBalance: true },
      }),
    );
    expect(r.hq?.walletBalance.toString()).toBe('15.75');
    expect(r.br).toEqual(r.hq);
  });

  it('a network drop mid-batch loses and duplicates nothing', async () => {
    const created = await br.customer.createManyAndReturn({
      data: Array.from({ length: 450 }, (_, i) => ({
        branchId: BRANCH,
        name: `Bulk ${tag} ${i}`,
      })),
      select: { id: true },
    });
    let pushes = 0;
    global.fetch = (url: string, init?: RequestInit) => {
      if (url.includes('/sync-peer/push') && ++pushes === 2)
        return Promise.reject(new Error('link down'));
      return realFetch(url, init);
    };
    if (SYNC_ON) await expect(brSync.runOnce()).rejects.toThrow('link down');
    global.fetch = realFetch;
    await reconnect();
    const ids = created.map((c) => c.id);
    const r = await both((db) =>
      db.customer.count({ where: { id: { in: ids } } }),
    );
    expect(r).toEqual({ hq: 450, br: 450 });
    const status = await brSync.publicStatus();
    expect([status.pendingChanges, status.lastError]).toEqual([0, null]);
  });
});
