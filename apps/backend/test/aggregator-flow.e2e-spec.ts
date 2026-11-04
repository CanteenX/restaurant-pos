/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest bodies are untyped by design */
// Aggregator adapter (#58) end to end against the mock partner (test/mocks):
// order in -> accept -> ready -> the platform sees each status; decline and
// platform-cancel paths; outbound failures retried, dead-lettered and surfaced.
//   AGG_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand aggregator-flow
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { IntegrationOutboxService } from './../src/integration-hub/outbox/integration-outbox.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { AggregatorMock } from './mocks/aggregator-mock';

process.env.ALLOW_PUBLIC_SIGNUP = 'true';
// The mock listens on 127.0.0.1 over http.
process.env.WEBHOOKS_ALLOW_PRIVATE = 'true';
process.env.WEBHOOKS_ALLOW_INSECURE = 'true';
const run = process.env.AGG_E2E ? describe : describe.skip;
const tag = randomUUID().slice(0, 6);
const API_KEY = `key_${tag}`;
const SECRET = `whsec_${tag}_0123456789abcdef`;
const OUTLET = `outlet-${tag}`;
const H = '/api/v1/integration-hub';
const P = 'partner-api';

run('Aggregator adapter flow (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let outbox: IntegrationOutboxService;
  let owner: ReturnType<typeof request.agent>;
  let mock: AggregatorMock;
  let restaurantId: string;
  let connectionId: string;
  let item: { id: string; name: string };
  let modifier: { id: string; name: string };
  let groupId: string;
  let webhookUrl: string;

  const extId = (n: string) => `pc-${tag}-${n}`;
  const created = (n: string, extra: Record<string, unknown> = {}) => ({
    event: 'order.created',
    orderId: extId(n),
    outletId: OUTLET,
    paymentMode: 'PREPAID',
    customer: { name: 'Ravi', phone: '9876500022' },
    delivery: { address: '4 Residency Road', pincode: '560025' },
    items: [{ name: item.name, quantity: 1 }],
    ...extra,
  });
  const push = async (event: unknown, times = 1) => {
    const res = await mock.push(webhookUrl, event, { secret: SECRET, times });
    return res.map((r) => ({ status: r.status, body: JSON.parse(r.body) }));
  };
  const orderOf = (n: string) =>
    prisma.order.findFirstOrThrow({
      where: { externalSource: P, externalOrderId: extId(n) },
      include: { kots: true, items: { include: { modifiers: true } } },
    });
  const rows = (n: string) =>
    prisma.integrationOutbox.findMany({
      where: { connectionId, dedupeKey: { contains: extId(n) } },
      orderBy: { createdAt: 'asc' },
    });
  // Make every pending row due now (instead of waiting for the backoff), then send.
  const flushNow = async () => {
    await prisma.integrationOutbox.updateMany({
      where: { connectionId, status: 'PENDING' },
      data: { nextAttemptAt: new Date() },
    });
    await outbox.flush();
  };
  const accept = (id: string) =>
    owner.post(`/api/v1/orders/${id}/accept?branchId=demo-branch`).expect(201);
  const card = async () =>
    ((await owner.get(H).expect(200)).body as any[]).find((p) => p.key === P);
  const readyAll = async (n: string) => {
    for (const k of (await orderOf(n)).kots) {
      for (const status of ['ACCEPTED', 'PREPARING', 'READY']) {
        await owner
          .patch(`/api/v1/kds/tickets/${k.id}/status?branchId=demo-branch`)
          .send({ status })
          .expect(200);
      }
    }
  };

  beforeAll(async () => {
    // The 10 s cron would race the explicit flushes below.
    jest
      .spyOn(IntegrationOutboxService.prototype, 'tick')
      .mockResolvedValue(undefined);
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
    app = mod.createNestApplication({ rawBody: true });
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: [] });
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as unknown as { address(): AddressInfo };
    const port = server.address().port;
    prisma = app.get(PrismaService);
    outbox = app.get(IntegrationOutboxService);
    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
    restaurantId = (
      await prisma.branch.findUniqueOrThrow({ where: { id: 'demo-branch' } })
    ).restaurantId;
    await prisma.integrationConnection.deleteMany({
      where: { restaurantId, provider: P },
    });
    item = await prisma.menuItem.findFirstOrThrow({
      where: { branchId: 'demo-branch', category: { showOnWebsite: true } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const group = await prisma.modifierGroup.create({
      data: {
        branchId: 'demo-branch',
        name: `Add-ons ${tag}`,
        maxSelect: 3,
        modifiers: { create: [{ name: `Extra Dip ${tag}` }] },
        menuItems: { create: [{ menuItemId: item.id }] },
      },
      include: { modifiers: true },
    });
    groupId = group.id;
    modifier = group.modifiers[0];
    mock = new AggregatorMock({ apiKey: API_KEY, webhookSecret: SECRET });
    const baseUrl = await mock.start();
    webhookUrl = `http://127.0.0.1:${port}${H}/webhook/${restaurantId}/${P}`;

    const saved = await owner
      .put(`${H}/${P}`)
      .send({
        externalAccountId: 'merchant-77',
        credentials: { baseUrl, apiKey: API_KEY, webhookSecret: SECRET },
        outlets: { [OUTLET]: 'demo-branch' },
      })
      .expect(200);
    connectionId = saved.body.id;
  });

  afterAll(async () => {
    await mock?.stop();
    await prisma.order.deleteMany({
      where: { externalSource: P, externalOrderId: { contains: tag } },
    });
    await prisma.modifierGroup.deleteMany({ where: { id: groupId } });
    await prisma.integrationConnection.deleteMany({
      where: { restaurantId, provider: P },
    });
    await app.close();
  });

  it('keeps credentials encrypted and tests the connection against the partner', async () => {
    const row = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(row.credentialsEnc).not.toContain(API_KEY);
    expect(row.credentialsEnc).not.toContain(SECRET);
    const c = await card();
    expect(JSON.stringify(c)).not.toContain(API_KEY);
    expect(c.capabilities.updateOrderStatus).toBe(true);
    expect(c.connection.outlets).toEqual({ [OUTLET]: 'demo-branch' });
    const t = await owner.post(`${H}/${P}/test`).expect(201);
    expect(t.body.ok).toBe(true);
    expect(mock.calls.at(-1)!.path).toBe('/v1/ping');
  });

  it('refuses an outlet mapped to a branch of another restaurant', async () => {
    await owner
      .put(`${H}/${P}`)
      .send({ credentials: {}, outlets: { x: 'not-our-branch' } })
      .expect(400);
  });

  it('order in -> accept -> ready: the platform sees ACCEPTED then READY, once each', async () => {
    const res = await push(
      created('1', {
        items: [
          {
            name: item.name.toLowerCase(),
            quantity: 2,
            modifiers: [{ name: modifier.name.toUpperCase() }],
          },
        ],
      }),
      2, // duplicate delivery
    );
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect(res[1].body.duplicate).toBe(true);
    const order = await orderOf('1');
    expect(order.branchId).toBe('demo-branch'); // via the outlet map
    expect(order.items[0].modifiers.map((m) => m.modifierId)).toEqual([
      modifier.id,
    ]);
    // Nothing is sent before staff decide.
    expect(await rows('1')).toHaveLength(0);

    await accept(order.id);
    // A double tap is refused and queues nothing more.
    await owner
      .post(`/api/v1/orders/${order.id}/accept?branchId=demo-branch`)
      .expect(409);
    await outbox.flush();
    expect(mock.orderStatuses(extId('1'))).toEqual(['ACCEPTED']);
    const sent = mock.calls.at(-1)!;
    expect(sent.signatureValid).toBe(true);
    expect(sent.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(sent.headers['idempotency-key']).toBeTruthy();

    await readyAll('1');
    await outbox.flush();
    await outbox.flush();
    expect(mock.orderStatuses(extId('1'))).toEqual(['ACCEPTED', 'READY']);
    expect((await rows('1')).map((r) => r.status)).toEqual(['DONE', 'DONE']);
    expect((await card()).connection.status).toBe('CONNECTED');
  });

  it('a staff decline is sent as REJECTED with the reason', async () => {
    await push(created('2'));
    const order = await orderOf('2');
    await owner
      .post(`/api/v1/orders/${order.id}/reject?branchId=demo-branch`)
      .send({ reason: 'Out of paneer' })
      .expect(201);
    await outbox.flush();
    expect(mock.orderStatuses(extId('2'))).toEqual(['REJECTED']);
    expect(mock.calls.at(-1)!.body).toMatchObject({
      status: 'REJECTED',
      reason: 'Out of paneer',
    });
  });

  it('a platform cancellation is not echoed back to the platform', async () => {
    await push(created('3'));
    const res = await push({
      event: 'order.cancelled',
      orderId: extId('3'),
      reason: 'Customer cancelled',
    });
    expect(res[0].body.cancelled).toBe(true);
    expect((await orderOf('3')).acceptance).toBe('REJECTED');
    expect(await rows('3')).toHaveLength(0);
  });

  it('retries a failed call, holds later statuses back until it lands, and reports it', async () => {
    await push(created('4'));
    const order = await orderOf('4');
    const path = `/v1/orders/${extId('4')}/status`;
    mock.failNext('500', { path, times: 2 });
    await accept(order.id);
    await outbox.flush();
    let [acc] = await rows('4');
    expect(acc).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(acc.lastError).toMatch(/HTTP 500/);
    expect(acc.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect((await card()).connection.lastError).toMatch(/HTTP 500/);
    expect((await card()).connection.outbox).toEqual({ pending: 1, dead: 0 });

    // READY is queued while ACCEPTED still waits: it must not overtake it.
    await readyAll('4');
    await outbox.flush(); // ACCEPTED not due yet; READY is due but held
    expect(mock.orderStatuses(extId('4'))).toEqual([]);
    await flushNow(); // ACCEPTED fails a second time; READY still held
    expect(mock.orderStatuses(extId('4'))).toEqual([]);
    await flushNow(); // ACCEPTED lands
    await flushNow(); // then READY
    expect(mock.orderStatuses(extId('4'))).toEqual(['ACCEPTED', 'READY']);
    [acc] = await rows('4');
    expect(acc).toMatchObject({ status: 'DONE', attempts: 3 });
    const logs = (await owner.get(`${H}/${P}/logs`).expect(200)).body as any[];
    expect(logs.some((l) => l.event === 'status_retry')).toBe(true);
  });

  it('dead-letters a refused call, surfaces it, and retries it on request', async () => {
    await push(created('5'));
    const order = await orderOf('5');
    mock.failNext('401', { path: `/v1/orders/${extId('5')}/status` });
    await accept(order.id);
    await outbox.flush();
    expect((await rows('5'))[0].status).toBe('DEAD');
    let c = await card();
    expect(c.connection.status).toBe('AUTH_EXPIRED');
    expect(c.connection.outbox).toEqual({ pending: 0, dead: 1 });
    const note = await prisma.notification.findFirst({
      where: { type: 'integration.failed', entityId: connectionId },
    });
    expect(note).not.toBeNull();

    const r = await owner.post(`${H}/${P}/outbox/retry`).expect(201);
    expect(r.body.requeued).toBe(1);
    await outbox.flush();
    expect(mock.orderStatuses(extId('5'))).toEqual(['ACCEPTED']);
    c = await card();
    expect(c.connection.status).toBe('CONNECTED');
    expect(c.connection.outbox).toEqual({ pending: 0, dead: 0 });
  });

  it('records the platform total and warns when it drifts from our price', async () => {
    await push(created('6', { platformTotal: 1, packagingCharge: 15 }));
    const order = await orderOf('6');
    expect(order.notes).toContain('platform total 1.00, packaging 15.00');
    expect(Number(order.totalAmount)).toBeGreaterThan(2);
    const logs = (await owner.get(`${H}/${P}/logs`).expect(200)).body as any[];
    expect(
      logs.find(
        (l) => l.event === 'price_mismatch' && l.message.includes(extId('6')),
      ),
    ).toBeTruthy();
  });

  it('refuses an add-on that is not on the dish, creating nothing', async () => {
    const res = await push(
      created('7', {
        items: [
          { name: item.name, quantity: 1, modifiers: [{ name: 'Gold leaf' }] },
        ],
      }),
    );
    expect(res[0].status).toBe(422);
    expect(res[0].body.message).toMatch(/Gold leaf/);
    expect(
      await prisma.order.count({
        where: { externalSource: P, externalOrderId: extId('7') },
      }),
    ).toBe(0);
  });

  it('sends nothing for orders from inbound-only providers', async () => {
    const n = await prisma.$transaction((tx) =>
      outbox.enqueueOrderStatus(
        tx,
        {
          id: 'x',
          branchId: 'demo-branch',
          externalSource: 'zomato',
          externalOrderId: 'z-1',
        },
        'ACCEPTED',
      ),
    );
    expect(n).toBe(0);
  });
});
