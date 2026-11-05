/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped by design */
// Multi-branch sync 3/4 (#82): HQ applying branch pushes against a real,
// migrated Postgres. Peers and per-peer keys, ownership, duplicate and
// out-of-order changes converging, derived balances from their ledger,
// settled-order reconciliation, schema skew, the branch-filtered pull, and
// the client's pause / backoff / registration / parked-retry loop.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- sync-apply
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { addWalletEntry } from './../src/modules/customers/wallet-ledger';
import { PrismaService } from './../src/prisma/prisma.service';
import { SyncChange } from './../src/sync/outbox';
import { SyncPeersService } from './../src/sync/peers.service';
import { SyncService } from './../src/sync/sync.service';
import { lockSyncState } from './sync-e2e-lock';

const tag = randomUUID().slice(0, 6);
const BOOT = `bootstrap-${tag}-0123456789`;
type Row = Record<string, unknown> & { id: string };
interface Peer {
  id: string;
  key: string;
}

describe('Sync apply at HQ (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let sync: SyncService;
  let restaurantId: string;
  let ownerId: string;
  let b1: string;
  let b2: string;
  let menuItemId: string;
  let schema: string;
  let p1: Peer;
  let p2: Peer;
  let unlock: () => Promise<void> = () => Promise.resolve();
  const realFetch = global.fetch;

  const key = (id: string) => JSON.stringify({ id }).replace(':', ': ');
  const uid = (p: string) => `${p}-${tag}-${randomUUID().slice(0, 8)}`;
  // Ahead of every local write in this suite (well inside the 24 h bound).
  let tick = (BigInt(Date.now()) + 60_000n) * 65536n;
  const hlc = () => String((tick += 65536n));
  const ch = (
    tbl: string,
    row: Row,
    peer: Peer,
    over: Partial<SyncChange> = {},
  ): SyncChange => ({
    tbl,
    pk: { id: row.id },
    pkKey: key(row.id),
    op: 'U',
    row,
    ts: new Date().toISOString(),
    hlc: hlc(),
    peer: peer.id,
    schemaVersion: schema,
    ...over,
  });
  const del = (tbl: string, id: string, peer: Peer): SyncChange => ({
    ...ch(tbl, { id }, peer),
    op: 'D',
    row: null,
  });
  const http = () => request(app.getHttpServer());
  const push = (p: Peer, changes: SyncChange[], device?: string) =>
    http()
      .post('/api/v1/sync-peer/push')
      .set('x-sync-peer', p.id)
      .set('x-sync-key', p.key)
      .send({ device, changes });
  const register = (id: string, branchIds?: string[], currentKey?: string) =>
    http()
      .post('/api/v1/sync-peer/register')
      .set('x-sync-key', BOOT)
      .send({ id, name: `Install ${id}`, branchIds, currentKey });

  let orderNo = 0;
  const order = (branchId: string, extra: Record<string, unknown> = {}) => ({
    id: uid('ord'),
    branchId,
    orderNumber: `S-${tag}-${++orderNo}`,
    createdById: ownerId,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
  const item = (orderId: string, lineTotal: string) => ({
    id: uid('itm'),
    orderId,
    menuItemId,
    nameSnapshot: 'Synced dish',
    unitPriceSnapshot: lineTotal,
    taxRateSnapshot: '5',
    quantity: 1,
    lineTotal,
  });
  const payment = (orderId: string, amount: string) => ({
    id: uid('pay'),
    orderId,
    method: 'CASH',
    amount,
  });
  const orderRow = (id: string) => prisma.order.findUnique({ where: { id } });

  beforeAll(async () => {
    unlock = await lockSyncState();
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
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    sync = app.get(SyncService);
    schema = await sync.schemaVersion();

    const email = `sync-apply-${tag}@example.com`;
    await http()
      .post('/api/v1/auth/register')
      .send({
        ownerName: 'Sync HQ',
        email,
        password: 'Password123!',
        restaurantName: `HQ ${tag}`,
        branchName: 'Main',
      })
      .expect(201);
    const owner = await prisma.user.findFirstOrThrow({ where: { email } });
    ownerId = owner.id;
    restaurantId = owner.restaurantId;
    b1 = (await prisma.branch.findFirstOrThrow({ where: { restaurantId } })).id;
    b2 = (
      await prisma.branch.create({ data: { restaurantId, name: 'Second' } })
    ).id;
    const cat = await prisma.menuCategory.create({
      data: { branchId: b1, name: `Cat-${tag}` },
    });
    menuItemId = (
      await prisma.menuItem.create({
        data: {
          branchId: b1,
          categoryId: cat.id,
          name: `Dish-${tag}`,
          price: 100,
        },
      })
    ).id;

    // This install is HQ for the suite.
    await prisma.$executeRawUnsafe(
      `UPDATE sync_state SET enabled = true, role = 'server', "apiKey" = $1, "peerKey" = NULL,
         "branchIds" = '{}', failures = 0, "nextAttemptAt" = NULL, "pausedReason" = NULL,
         "lastError" = NULL WHERE id = 1`,
      BOOT,
    );
    const r1 = await register(uid('peer1'), [b1]).expect(200);
    const r2 = await register(uid('peer2'), [b2]).expect(200);
    p1 = { id: r1.body.id, key: r1.body.key };
    p2 = { id: r2.body.id, key: r2.body.key };
  }, 60_000);

  afterAll(async () => {
    global.fetch = realFetch;
    await prisma.$executeRawUnsafe(
      `UPDATE sync_state SET enabled = false, role = 'client', "serverUrl" = NULL, "apiKey" = NULL,
         "peerKey" = NULL, "branchIds" = '{}', failures = 0, "nextAttemptAt" = NULL,
         "pausedReason" = NULL, "lastPushSeq" = 0, "lastPullSeq" = 0, "lastError" = NULL,
         conflicts = '[]' WHERE id = 1`,
    );
    for (const t of [
      'sync_changes',
      'sync_versions',
      'sync_cursors',
      'sync_rejected',
      'sync_order_flags',
    ])
      await prisma.$executeRawUnsafe(`DELETE FROM ${t}`);
    await prisma.syncPeer.deleteMany({ where: { id: { contains: tag } } });
    await app.close();
    await unlock();
  });

  // ---- peers and keys (G12, G13) -----------------------------------------

  describe('registration and per-peer keys', () => {
    it('issues each install its own key and stores only its hash', async () => {
      expect(p1.key).toMatch(/^[0-9a-f]{64}$/);
      const rec = await prisma.syncPeer.findUniqueOrThrow({
        where: { id: p1.id },
      });
      expect(rec.branchIds).toEqual([b1]);
      expect(rec.keyHash).not.toContain(p1.key);
      expect(JSON.stringify(rec)).not.toContain(p1.key);
    });

    it('allows one install per branch and asks which branch when ambiguous', async () => {
      const taken = await register(uid('peer3'), [b1]).expect(409);
      expect(taken.body.message).toMatch(/already synced by/);
      const choose = await register(uid('peer4')).expect(400);
      expect(choose.body.message).toMatch(/Choose which branch/);
      await register(uid('peer5'), ['no-such-branch']).expect(400);
      await http()
        .post('/api/v1/sync-peer/register')
        .set('x-sync-key', 'wrong-bootstrap-key-000')
        .send({ id: uid('peer6'), name: 'x', branchIds: [b1] })
        .expect(401);
    });

    it('syncs only with a peer key; the bootstrap key just pings and registers', async () => {
      await http()
        .get('/api/v1/sync-peer/ping')
        .set('x-sync-key', BOOT)
        .expect(200);
      await http()
        .get('/api/v1/sync-peer/pull?since=0')
        .set('x-sync-key', BOOT)
        .expect(401);
      await push({ id: p1.id, key: p2.key }, []).expect(401);
      await push(p1, []).expect(200);
    });

    it('a revoked install is cut off without touching the others', async () => {
      const tmpBranch = await prisma.branch.create({
        data: { restaurantId, name: `Tmp-${tag}` },
      });
      const reg = await register(uid('peer8'), [tmpBranch.id]).expect(200);
      const p = { id: reg.body.id, key: reg.body.key };
      await push(p, []).expect(200);
      await app.get(SyncPeersService).revoke(p.id);
      await push(p, []).expect(401);
      await register(p.id, [tmpBranch.id]).expect(409);
      await push(p1, []).expect(200);
    });

    it('the bootstrap key alone cannot take over an active install (#82 review)', async () => {
      const tmpBranch = await prisma.branch.create({
        data: { restaurantId, name: `Own-${tag}` },
      });
      const reg = await register(uid('peer9'), [tmpBranch.id]).expect(200);
      const p = { id: reg.body.id, key: reg.body.key };
      const hijack = await register(p.id, [tmpBranch.id]).expect(409);
      expect(hijack.body.message).toMatch(/already registered at HQ/);
      await register(p.id, [tmpBranch.id], 'f'.repeat(64)).expect(409);
      await push(p, []).expect(200);

      // The install itself re-registering (re-enabling) proves its key.
      const again = await register(p.id, [tmpBranch.id], p.key).expect(200);
      expect(again.body.key).not.toBe(p.key);
      await push(p, []).expect(401);
      await push({ id: p.id, key: again.body.key }, []).expect(200);
    });
  });

  // ---- ownership (rule 1) --------------------------------------------------

  describe('ownership', () => {
    it('rejects HQ-owned rows from a branch and never applies them', async () => {
      const before = await prisma.menuItem.findUniqueOrThrow({
        where: { id: menuItemId },
      });
      const r = await push(p1, [
        ch('menu_items', { id: menuItemId, branchId: b1, price: '1.00' }, p1),
      ]).expect(200);
      expect(r.body.conflicts.map((c: { error: string }) => c.error)).toEqual([
        'not-owner: menu_items is HQ-owned',
      ]);
      const after = await prisma.menuItem.findUniqueOrThrow({
        where: { id: menuItemId },
      });
      expect(after.price.toString()).toBe(before.price.toString());
    });

    it("rejects another branch's rows, including through a parent row", async () => {
      const theirs = order(b2);
      expect((await push(p2, [ch('orders', theirs, p2)])).body.applied).toBe(1);
      const r = await push(p1, [
        ch('orders', order(b2), p1),
        ch('order_items', item(theirs.id, '10.00'), p1),
        // Moving their order into my branch is still their order.
        ch('orders', { ...theirs, branchId: b1 }, p1),
      ]).expect(200);
      expect(r.body.applied).toBe(0);
      expect(
        r.body.conflicts.map((c: { error: string }) => c.error).sort(),
      ).toEqual([
        `not-owner: row belongs to branch ${b2}`,
        `not-owner: row belongs to branch ${b2}`,
        `not-owner: row belongs to branch ${b2}`,
      ]);
      expect((await orderRow(theirs.id))?.branchId).toBe(b2);
    });

    it('takes the device id from the key, not from the request body', async () => {
      const mine = order(b1);
      await push(p1, [ch('orders', mine, p1)], 'spoofed-device').expect(200);
      const [entry] = await prisma.$queryRawUnsafe<{ origin: string }[]>(
        `SELECT origin FROM sync_changes WHERE tbl = 'orders' AND pk ->> 'id' = $1`,
        mine.id,
      );
      expect(entry.origin).toBe(p1.id);
    });

    it("stamps the authoring peer from the key, never the wire's claim (#82 review)", async () => {
      const mine = order(b1);
      await push(p1, [ch('orders', mine, p1, { peer: p2.id })]).expect(200);
      const rows = await prisma.$queryRawUnsafe<{ peer: string }[]>(
        `SELECT peer FROM sync_versions WHERE tbl = 'orders' AND "pkKey" = $1
         UNION ALL
         SELECT peer FROM sync_changes WHERE tbl = 'orders' AND "pkKey" = $1`,
        key(mine.id),
      );
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.every((r) => r.peer === p1.id)).toBe(true);
    });
  });

  // ---- lock contention with local writers (#82 review) ---------------------

  describe('lock contention', () => {
    it('yields to a local writer holding the row and applies once it commits', async () => {
      const mine = order(b1, { notes: 'before' });
      await push(p1, [ch('orders', mine, p1)]).expect(200);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const local = prisma.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`,
            mine.id,
          );
          locked();
          await gate;
          await tx.order.update({
            where: { id: mine.id },
            data: { notes: 'local' },
          });
        },
        { timeout: 30_000 },
      );
      await isLocked;
      setTimeout(release, 1_200);
      const started = Date.now();
      const r = await push(p1, [
        ch('orders', { ...mine, notes: 'synced' }, p1),
      ]).expect(200);
      await local; // the local writer never errored
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
      expect([r.body.applied, r.body.conflicts]).toEqual([1, []]);
      expect((await orderRow(mine.id))?.notes).toBe('synced');
    });

    it('yields when the derived recompute meets a locked parent row', async () => {
      // A till's plain UPDATE of the customer holds FOR NO KEY UPDATE: the
      // ledger insert (FK, FOR KEY SHARE) passes, the walletBalance recompute
      // after it waits and must yield instead of failing the push (#209 audit).
      const c = { id: uid('cus'), branchId: b1, name: 'Busy Guest' };
      await push(p1, [ch('customers', c, p1)]).expect(200);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const local = prisma.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT 1 FROM customers WHERE id = $1 FOR NO KEY UPDATE`,
            c.id,
          );
          locked();
          await gate;
        },
        { timeout: 30_000 },
      );
      await isLocked;
      setTimeout(release, 1_200);
      const r = await push(p1, [
        ch(
          'customer_wallet_entries',
          {
            id: uid('wal'),
            branchId: b1,
            customerId: c.id,
            delta: '25.00',
            reason: 'REFUND_CREDIT',
            idempotencyKey: uid('k'),
          },
          p1,
        ),
      ]).expect(200);
      await local;
      expect([r.body.applied, r.body.conflicts]).toEqual([1, []]);
      const row = await prisma.customer.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(row.walletBalance.toString()).toBe('25');
    });
  });

  // ---- duplicate and out-of-order changes converge -------------------------

  describe('convergence', () => {
    it('applies a child sent before its parent in the same page', async () => {
      const o = order(b1);
      const i = item(o.id, '25.00');
      const r = await push(p1, [
        ch('order_items', i, p1),
        ch('orders', o, p1),
      ]).expect(200);
      expect([r.body.applied, r.body.conflicts]).toEqual([2, []]);
      expect(
        await prisma.orderItem.findUnique({ where: { id: i.id } }),
      ).not.toBeNull();
    });

    it('a child pushed before its parent is parked and applies once the parent lands', async () => {
      const o = order(b1);
      const i = ch('order_items', item(o.id, '5.00'), p1);
      const first = await push(p1, [i]).expect(200);
      expect(first.body.conflicts[0].error).toBe('waiting for parent row');
      await push(p1, [ch('orders', o, p1)]).expect(200);
      // The client re-tries parked rejections every cycle (sync.service).
      expect((await push(p1, [i])).body.applied).toBe(1);
    });

    it('duplicates are skipped, whether in one page or replayed later', async () => {
      const o = order(b1, { notes: `dup-${tag}` });
      const c = ch('orders', o, p1);
      const first = await push(p1, [c, c]).expect(200);
      expect([first.body.applied, first.body.skipped]).toEqual([1, 0]);
      const replay = await push(p1, [c]).expect(200);
      expect([replay.body.applied, replay.body.skipped]).toEqual([0, 1]);
    });

    it('older versions arriving late lose to the newest, and tombstones hold', async () => {
      const o = order(b1);
      const v1 = ch('orders', { ...o, notes: 'v1' }, p1);
      const v2 = ch('orders', { ...o, notes: 'v2' }, p1);
      const v3 = ch('orders', { ...o, notes: 'v3' }, p1);
      await push(p1, [v3]).expect(200);
      const late = await push(p1, [v1, v2]).expect(200);
      expect([late.body.applied, late.body.skipped]).toEqual([0, 1]);
      expect((await orderRow(o.id))?.notes).toBe('v3');

      const gone = del('orders', o.id, p1);
      await push(p1, [gone]).expect(200);
      await push(p1, [v3]).expect(200); // stale replay
      expect(await orderRow(o.id)).toBeNull();
      await push(p1, [ch('orders', { ...o, notes: 'v4' }, p1)]).expect(200);
      expect((await orderRow(o.id))?.notes).toBe('v4');
    });
  });

  // ---- derived balances (rule 5) -------------------------------------------

  describe('derived balances', () => {
    it('recomputes walletBalance from the wallet ledger, ignoring the wire', async () => {
      const c = {
        id: uid('cus'),
        branchId: b1,
        name: 'Ledger Guest',
        walletBalance: '999.00',
      };
      const entry = (delta: string) => ({
        id: uid('wal'),
        branchId: b1,
        customerId: c.id,
        delta,
        reason: 'REFUND_CREDIT',
        idempotencyKey: uid('k'),
      });
      const customer = ch('customers', c, p1);
      const r = await push(p1, [
        customer,
        ch('customer_wallet_entries', entry('50.00'), p1),
        ch('customer_wallet_entries', entry('-10.00'), p1),
      ]).expect(200);
      expect(r.body.conflicts).toEqual([]);
      const read = () =>
        prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
      expect((await read()).walletBalance.toString()).toBe('40');

      // A later customer edit with a stale wire balance changes nothing.
      await push(p1, [
        ch('customers', { ...c, name: 'Renamed', walletBalance: '5.00' }, p1),
      ]).expect(200);
      const after = await read();
      expect([after.name, after.walletBalance.toString()]).toEqual([
        'Renamed',
        '40',
      ]);
      // The recompute keeps the owner's version and writes no outbox entry.
      const [v] = await prisma.$queryRawUnsafe<{ peer: string }[]>(
        `SELECT peer FROM sync_versions WHERE tbl = 'customers' AND "pkKey" = $1`,
        key(c.id),
      );
      expect(v.peer).toBe(p1.id);
      const origins = await prisma.$queryRawUnsafe<{ origin: string }[]>(
        `SELECT DISTINCT origin FROM sync_changes WHERE tbl = 'customers' AND pk ->> 'id' = $1`,
        c.id,
      );
      expect(origins).toEqual([{ origin: p1.id }]);
    });

    it("refuses a wallet entry for another branch's customer (#209 audit)", async () => {
      const c = {
        id: uid('cus'),
        branchId: b2,
        name: 'Other Branch Guest',
        walletBalance: '0.00',
      };
      expect(
        (await push(p2, [ch('customers', c, p2)]).expect(200)).body.applied,
      ).toBe(1);
      // Branch 1 claims the entry is its own; the customer says otherwise.
      const forged = {
        id: uid('wal'),
        branchId: b1,
        customerId: c.id,
        delta: '10000.00',
        reason: 'REFUND_CREDIT',
        idempotencyKey: uid('k'),
      };
      const r = await push(p1, [
        ch('customer_wallet_entries', forged, p1),
      ]).expect(200);
      expect(r.body.applied).toBe(0);
      expect(r.body.conflicts.map((x: { error: string }) => x.error)).toEqual([
        `not-owner: row belongs to branch ${b2}`,
      ]);
      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(after.walletBalance.toString()).toBe('0');
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM customer_wallet_entries WHERE id = $1`,
        forged.id,
      );
      expect(rows).toEqual([]);
    });

    it('recomputes a gift card balance from its redemptions', async () => {
      const o = order(b1);
      const card = {
        id: uid('gc'),
        branchId: b1,
        code: uid('GC'),
        initialValue: '100.00',
        balance: '999.00',
      };
      await push(p1, [
        ch('orders', o, p1),
        ch('gift_cards', card, p1),
        ch(
          'gift_card_redemptions',
          {
            id: uid('red'),
            giftCardId: card.id,
            orderId: o.id,
            amount: '30.00',
          },
          p1,
        ),
      ]).expect(200);
      const gc = await prisma.giftCard.findUniqueOrThrow({
        where: { id: card.id },
      });
      expect(gc.balance.toString()).toBe('70');
    });

    it('recomputes a petty-cash float from its signed entries', async () => {
      const float = {
        branchId: b1,
        balance: '999.00',
        updatedAt: new Date().toISOString(),
      };
      const entry = (kind: string, amount: string) => ({
        id: uid('pce'),
        branchId: b1,
        businessDate: '2026-11-05',
        kind,
        amount,
        balanceAfter: '0.00',
        reason: 'synced',
        createdById: ownerId,
      });
      const fk = JSON.stringify({ branchId: b1 }).replace(':', ': ');
      const r = await push(p1, [
        ch('petty_cash_floats', float as unknown as Row, p1, {
          pk: { branchId: b1 },
          pkKey: fk,
        }),
        ch('petty_cash_entries', entry('TOP_UP', '500.00'), p1),
        ch('petty_cash_entries', entry('PAYOUT', '-120.50'), p1),
        ch('petty_cash_entries', entry('ADJUST', '0.25'), p1),
      ]).expect(200);
      expect(r.body.conflicts).toEqual([]);
      const f = await prisma.pettyCashFloat.findUniqueOrThrow({
        where: { branchId: b1 },
      });
      expect(f.balance.toString()).toBe('379.75');
    });

    it('store credit is booked in the ledger with a rounded set, once per key', async () => {
      const c = await prisma.customer.create({
        data: { branchId: b1, name: `Wallet ${tag}` },
      });
      const credit = (delta: number, k: string) =>
        prisma.$transaction((tx) =>
          addWalletEntry(tx, {
            customerId: c.id,
            delta,
            reason: 'REFUND_CREDIT',
            idempotencyKey: k,
          }),
        );
      await Promise.all([credit(12.344, `a-${tag}`), credit(0.66, `b-${tag}`)]);
      await credit(0.66, `b-${tag}`); // retried request
      const row = await prisma.customer.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect(row.walletBalance.toString()).toBe('13');
      const n = await prisma.customerWalletEntry.count({
        where: { customerId: c.id },
      });
      expect(n).toBe(2);
    });
  });

  // ---- settled orders (rule 7 audit) ---------------------------------------

  describe('order reconciliation', () => {
    it('flags a paid order whose payments do not settle it, and clears it once they do', async () => {
      const o = order(b1, {
        status: 'PAID',
        subtotal: '100.00',
        totalAmount: '100.00',
      });
      await push(p1, [
        ch('orders', o, p1),
        ch('order_items', item(o.id, '100.00'), p1),
        ch('payments', payment(o.id, '60.00'), p1),
      ]).expect(200);
      const flag = await prisma.syncOrderFlag.findUnique({
        where: { orderId: o.id },
      });
      expect(flag?.problems).toEqual([
        'payments add up to 60.00, order total is 100.00',
      ]);
      expect([flag?.branchId, flag?.peer]).toEqual([b1, p1.id]);
      expect((await sync.publicStatus()).flaggedOrders).toBeGreaterThan(0);
      // HQ keeps the branch's figures: nothing is repriced.
      expect((await orderRow(o.id))?.totalAmount.toString()).toBe('100');

      await push(p1, [ch('payments', payment(o.id, '40.00'), p1)]).expect(200);
      expect(
        await prisma.syncOrderFlag.findUnique({ where: { orderId: o.id } }),
      ).toBeNull();
    });

    it('flags lines that do not add up to the total', async () => {
      const o = order(b1, {
        status: 'PAID',
        subtotal: '80.00',
        totalAmount: '80.00',
      });
      await push(p1, [
        ch('orders', o, p1),
        ch('order_items', item(o.id, '50.00'), p1),
        ch('payments', payment(o.id, '80.00'), p1),
      ]).expect(200);
      const flags = await sync.orderFlags();
      expect(flags.find((f) => f.orderId === o.id)?.problems).toEqual([
        'line items add up to 50.00, order subtotal is 80.00',
      ]);
    });
  });

  // ---- schema skew (G9, §4.6) ----------------------------------------------

  describe('schema skew', () => {
    it('an older sender never nulls a column it does not know', async () => {
      const c = {
        id: uid('cus'),
        branchId: b1,
        name: 'Old',
        phone: `+91-${tag}`,
      };
      await push(p1, [ch('customers', c, p1)]).expect(200);
      await push(p1, [
        ch(
          'customers',
          { id: c.id, branchId: b1, name: 'Edited on old app' },
          p1,
          { schemaVersion: '20261001000000_older' },
        ),
      ]).expect(200);
      const row = await prisma.customer.findUniqueOrThrow({
        where: { id: c.id },
      });
      expect([row.name, row.phone]).toEqual(['Edited on old app', c.phone]);
    });

    it('refuses a change from a newer app version', async () => {
      const r = await push(p1, [
        ch('orders', order(b1), p1, { schemaVersion: '29991231000000_future' }),
      ]).expect(200);
      expect(r.body.conflicts[0].error).toBe(
        'change from a newer app version; update this install',
      );
    });
  });

  // ---- pull filter (G2) ----------------------------------------------------

  describe('branch-filtered pull', () => {
    it("each branch gets HQ rows for it, transfers sent to it, never another branch's data or its own echo", async () => {
      const mineCat = await prisma.menuCategory.create({
        data: { branchId: b1, name: `P1-${tag}` },
      });
      const theirCat = await prisma.menuCategory.create({
        data: { branchId: b2, name: `P2-${tag}` },
      });
      const theirOrder = order(b2);
      const transfer = {
        id: uid('trf'),
        restaurantId,
        fromBranchId: b2,
        toBranchId: b1,
        fromBranchName: 'Second',
        toBranchName: 'Main',
        ingredientName: 'Rice',
        unit: 'kg',
        quantity: '2',
        unitCost: '50',
        createdById: ownerId,
      };
      await push(p2, [
        ch('orders', theirOrder, p2),
        ch('stock_transfers', transfer, p2),
      ]).expect(200);
      const myOrder = order(b1);
      await push(p1, [ch('orders', myOrder, p1)]).expect(200);

      const seen = async (peer: Peer) => {
        const ids: string[] = [];
        let since = '0';
        for (;;) {
          const r = await http()
            .get(`/api/v1/sync-peer/pull?since=${since}`)
            .set('x-sync-peer', peer.id)
            .set('x-sync-key', peer.key)
            .expect(200);
          ids.push(...r.body.changes.map((c: SyncChange) => String(c.pk.id)));
          since = r.body.nextSeq;
          if (!r.body.hasMore) return ids;
        }
      };
      const one = await seen(p1);
      expect(one).toEqual(expect.arrayContaining([mineCat.id, transfer.id]));
      expect(one).not.toContain(theirCat.id);
      expect(one).not.toContain(theirOrder.id);
      expect(one).not.toContain(myOrder.id); // its own echo
      const two = await seen(p2);
      expect(two).toContain(theirCat.id);
      expect(two).not.toContain(mineCat.id);
      expect(two).not.toContain(myOrder.id);
    });
  });

  // ---- the branch side of the loop -----------------------------------------

  describe('client loop: pause, backoff, registration, parked retry', () => {
    type Handler = (path: string, init?: RequestInit) => unknown;
    const calls: { path: string; headers: Record<string, string> }[] = [];
    const fakeHq = (handle: Handler) => {
      global.fetch = (url: string, init?: RequestInit) => {
        const u = new URL(url);
        const path = u.pathname.split('/').pop()!;
        calls.push({
          path,
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        const body = handle(path, init);
        if (body instanceof Response) return Promise.resolve(body);
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      };
    };
    const ok = (path: string, init?: RequestInit, schemaName = schema) => {
      if (path === 'ping')
        return {
          ok: true,
          role: 'server',
          schema: schemaName,
          now: Date.now(),
        };
      if (path === 'register')
        return { id: 'ignored', key: 'issued-peer-key', branchIds: [b1] };
      if (path === 'pull') return { changes: [], nextSeq: '0', hasMore: false };
      const sent = JSON.parse(init?.body as string) as { changes: unknown[] };
      return { applied: sent.changes.length, skipped: 0, conflicts: [] };
    };

    beforeAll(async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE sync_state SET role = 'client', "serverUrl" = 'http://hq.test', "apiKey" = $1,
           "peerKey" = NULL, "branchIds" = ARRAY[$2], failures = 0, "nextAttemptAt" = NULL,
           "lastPullSeq" = 0, "lastPushSeq" = (SELECT coalesce(max(seq), 0) FROM sync_changes)
         WHERE id = 1`,
        BOOT,
        b1,
      );
    });

    it('pauses on a version mismatch with backoff, keeps queuing, and resumes once fixed', async () => {
      fakeHq((p, i) => ok(p, i, '29991231000000_future'));
      const queued = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM sync_changes`,
      );
      await expect(sync.runOnce()).rejects.toThrow(
        /App versions differ.*Update this branch/,
      );
      let s = await sync.publicStatus();
      expect([s.pausedReason, s.failures]).toEqual(['schema', 1]);
      const wait = new Date(s.nextAttemptAt!).getTime() - Date.now();
      expect(wait).toBeGreaterThan(20_000);
      expect(wait).toBeLessThanOrEqual(30_000);
      // Capture goes on while paused.
      await prisma.floor.create({ data: { branchId: b1, name: `Q-${tag}` } });
      const more = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM sync_changes`,
      );
      expect(Number(more[0].n)).toBeGreaterThan(Number(queued[0].n));

      // The timer waits out the backoff; a manual run doesn't.
      calls.length = 0;
      expect(await sync.runScheduled()).toBeNull();
      expect(calls).toEqual([]);
      await expect(sync.runOnce()).rejects.toThrow(/App versions differ/);
      s = await sync.publicStatus();
      expect(s.failures).toBe(2);
      expect(new Date(s.nextAttemptAt!).getTime() - Date.now()).toBeGreaterThan(
        50_000,
      );

      fakeHq((p, i) => ok(p, i));
      calls.length = 0;
      await sync.runOnce();
      s = await sync.publicStatus();
      expect([
        s.pausedReason,
        s.failures,
        s.nextAttemptAt,
        s.lastError,
      ]).toEqual([null, 0, null, null]);
      // Registered with the bootstrap key once, then its own key only.
      expect(calls.map((c) => c.path)).toEqual(
        expect.arrayContaining(['register', 'pull', 'push']),
      );
      const after = calls.slice(
        calls.findIndex((c) => c.path === 'register') + 1,
      );
      const st = await sync.state();
      expect([st.peerKey, st.apiKey]).toEqual(['issued-peer-key', null]);
      expect(after.length).toBeGreaterThan(0);
      expect(
        after.every(
          (c) =>
            c.headers['x-sync-key'] === 'issued-peer-key' &&
            c.headers['x-sync-peer'] === st.deviceId,
        ),
      ).toBe(true);
    });

    it('a revoked key surfaces a clear error', async () => {
      fakeHq((p, i) =>
        p === 'pull' ? new Response('{}', { status: 401 }) : ok(p, i),
      );
      await expect(sync.runOnce()).rejects.toThrow(
        /HQ rejected this install's sync key/,
      );
      expect((await sync.publicStatus()).pausedReason).toBeNull();
    });

    it('re-tries a parked pull rejection once its parent row exists', async () => {
      fakeHq((p, i) => ok(p, i));
      const floorId = uid('flr');
      const table = ch(
        'tables',
        {
          id: uid('tbl'),
          floorId,
          number: `T-${tag}`,
          updatedAt: new Date().toISOString(),
        },
        p1,
      );
      const r = await sync.applyChanges([table], {
        origin: '__skip',
        tieWins: true,
        receiver: 'branch',
        branches: [b1],
      });
      expect(r.conflicts[0].error).toMatch(/foreign key/);
      await prisma.$executeRawUnsafe(
        `INSERT INTO sync_rejected (side, tbl, "pkKey", change, error) VALUES ('pull', $1, $2, $3::jsonb, $4)`,
        table.tbl,
        table.pkKey,
        JSON.stringify(table),
        r.conflicts[0].error,
      );
      await prisma.floor.create({
        data: { id: floorId, branchId: b1, name: `F-${tag}` },
      });
      await sync.runOnce();
      expect(
        await prisma.table.findUnique({ where: { id: String(table.row!.id) } }),
      ).not.toBeNull();
      const left = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM sync_rejected WHERE "pkKey" = $1`,
        table.pkKey,
      );
      expect(Number(left[0].n)).toBe(0);
    });
  });
});
