/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Online payment through the mock gateway: attempt -> signed confirmation ->
// order settled exactly once. Self-contained (registers its own restaurants),
// so it runs on a freshly migrated DB with no seed and no opt-in flag.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- --runInBand payment-gateway
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  MOCK_DECLINE_PAISE,
  signMockWebhook,
} from './../src/integration-hub/payments/mock-gateway';
import { PrismaService } from './../src/prisma/prisma.service';

const tag = randomUUID().slice(0, 6);
const PASSWORD = 'Password123!';
const SECRET = `mock_${tag}_0123456789abcdef`;
const P = '/api/v1/payment-gateway';
type Agent = ReturnType<typeof request.agent>;

describe('Payment gateway (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Agent;
  let other: Agent;
  let q: string;
  let restaurantId: string;
  let categoryId: string;
  let previousSignup: string | undefined;

  const login = async (email: string) => {
    const a = request.agent(app.getHttpServer());
    await a
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    return a;
  };
  const registerRestaurant = async (name: string) => {
    const email = `pg-${name}-${tag}@example.com`;
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ownerName: `Owner ${name}`,
        email,
        password: PASSWORD,
        restaurantName: `PG ${name} ${tag}`,
        branchName: 'Main',
      })
      .expect(201);
    const agent = await login(email);
    const branchId = (await agent.get('/api/v1/branches').expect(200)).body[0]
      .id as string;
    return { agent, branchId };
  };
  const newOrder = async (price: number) => {
    const item = (
      await owner
        .post(`/api/v1/menu/items${q}`)
        .send({
          categoryId,
          name: `Dish-${price}-${randomUUID().slice(0, 4)}`,
          price,
          taxRatePercent: 0,
        })
        .expect(201)
    ).body;
    return (
      await owner
        .post(`/api/v1/orders${q}`)
        .send({
          type: 'TAKEAWAY',
          guestName: 'Walk-in',
          items: [{ menuItemId: item.id, quantity: 1, modifierIds: [] }],
        })
        .expect(201)
    ).body.id as string;
  };
  const attempt = (orderId: string, body: object = {}) =>
    owner.post(`${P}/orders/${orderId}/attempts${q}`).send({
      provider: 'mock-gateway',
      idempotencyKey: randomUUID(),
      ...body,
    });
  const webhook = (body: object, secret = SECRET) => {
    const raw = JSON.stringify(body);
    return request(app.getHttpServer())
      .post(`${P}/webhook/${restaurantId}/mock-gateway`)
      .set('Content-Type', 'application/json')
      .set('X-Mock-Signature', signMockWebhook(secret, raw))
      .send(raw);
  };
  const payments = (orderId: string) =>
    prisma.payment.findMany({ where: { orderId } });

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
    app = mod.createNestApplication({ rawBody: true });
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    prisma = app.get(PrismaService);

    const a = await registerRestaurant('a');
    owner = a.agent;
    q = `?branchId=${a.branchId}`;
    restaurantId = (
      await prisma.branch.findUniqueOrThrow({ where: { id: a.branchId } })
    ).restaurantId;
    other = (await registerRestaurant('b')).agent;
    categoryId = (
      await owner
        .post(`/api/v1/menu/categories${q}`)
        .send({ name: `Mains ${tag}` })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    if (previousSignup === undefined) delete process.env.ALLOW_PUBLIC_SIGNUP;
    else process.env.ALLOW_PUBLIC_SIGNUP = previousSignup;
    await app.close();
  });

  it('refuses a payment until the gateway is connected', async () => {
    const orderId = await newOrder(250.5);
    await attempt(orderId).expect(400);
    await attempt(orderId, { provider: 'zomato' }).expect(404);
    await owner
      .put('/api/v1/integration-hub/mock-gateway')
      .send({ credentials: { webhookSecret: SECRET } })
      .expect(200);
  });

  it('creates an attempt for the server-computed balance, idempotently', async () => {
    const orderId = await newOrder(250.5);
    const key = randomUUID();
    const first = await attempt(orderId, { idempotencyKey: key }).expect(201);
    expect(first.body).toMatchObject({
      status: 'PENDING',
      amount: '250.50',
      method: 'UPI',
      settled: false,
    });
    expect(first.body.externalId).toMatch(/^mock_pay_/);
    expect(first.body.action.value).toContain('am=250.50');
    const again = await attempt(orderId, { idempotencyKey: key }).expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(await prisma.gatewayPayment.count({ where: { orderId } })).toBe(1);
    // Not more than is owed.
    await attempt(orderId, { amount: 250.51 }).expect(400);
  });

  it('confirmation settles the order once; repeats are a no-op', async () => {
    const orderId = await newOrder(250.5);
    const a = (await attempt(orderId).expect(201)).body;

    await webhook(
      { externalId: a.externalId, status: 'SUCCEEDED' },
      'x'.repeat(24),
    ).expect(401);
    expect(await payments(orderId)).toHaveLength(0);

    const ok = await webhook({
      externalId: a.externalId,
      status: 'SUCCEEDED',
    }).expect(200);
    expect(ok.body).toMatchObject({ status: 'SUCCEEDED', settled: true });

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(order.status).toBe('PAID');
    let rows = await payments(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      method: 'UPI',
      reference: `mock-gateway:${a.externalId}`,
    });
    expect(rows[0].amount.toFixed(2)).toBe('250.50');

    await webhook({ externalId: a.externalId, status: 'SUCCEEDED' }).expect(
      200,
    );
    await webhook({ externalId: a.externalId, status: 'FAILED' }).expect(200);
    const polled = await owner
      .post(`${P}/attempts/${a.id}/refresh`)
      .expect(201);
    expect(polled.body).toMatchObject({ status: 'SUCCEEDED', settled: true });
    rows = await payments(orderId);
    expect(rows).toHaveLength(1);

    await attempt(orderId).expect(400); // the bill is closed
  });

  it('concurrent confirmations still record one payment', async () => {
    const orderId = await newOrder(120);
    const a = (await attempt(orderId).expect(201)).body;
    const body = { externalId: a.externalId, status: 'SUCCEEDED' };
    const res = await Promise.all([
      webhook(body),
      webhook(body),
      webhook(body),
    ]);
    for (const r of res) expect(r.status).toBe(200);
    expect(await payments(orderId)).toHaveLength(1);
    const row = await prisma.gatewayPayment.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(row.paymentId).not.toBeNull();
    expect(row.settlementError).toBeNull();
  });

  it('a part payment leaves the rest of the bill open', async () => {
    const orderId = await newOrder(300);
    const a = (await attempt(orderId, { amount: 100 }).expect(201)).body;
    expect(a.amount).toBe('100.00');
    await webhook({ externalId: a.externalId, status: 'SUCCEEDED' }).expect(
      200,
    );
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(order.status).toBe('OPEN');
    expect(await payments(orderId)).toHaveLength(1);
    const rest = (await attempt(orderId).expect(201)).body;
    expect(rest.amount).toBe('200.00');
  });

  it('maps a decline to FAILED and touches nothing on the order', async () => {
    const orderId = await newOrder(MOCK_DECLINE_PAISE / 100);
    const a = (await attempt(orderId).expect(201)).body;
    expect(a).toMatchObject({ status: 'FAILED', failureCode: 'DECLINED' });
    expect(await payments(orderId)).toHaveLength(0);
  });

  it('flags a success that arrives after the bill was closed another way', async () => {
    const orderId = await newOrder(80);
    const a = (await attempt(orderId).expect(201)).body;
    await owner
      .post(`/api/v1/orders/${orderId}/checkout${q}`)
      .send({ payments: [{ method: 'CASH', amount: 80 }] })
      .expect(201);
    await webhook({ externalId: a.externalId, status: 'SUCCEEDED' }).expect(
      200,
    );
    const view = (await owner.get(`${P}/attempts/${a.id}`).expect(200)).body;
    expect(view.status).toBe('SUCCEEDED');
    expect(view.settled).toBe(false);
    expect(view.settlementError).toBeTruthy();
    expect(await payments(orderId)).toHaveLength(1); // the cash only
  });

  it('flags a confirmation for a different amount and never settles it', async () => {
    const orderId = await newOrder(200);
    const a = (await attempt(orderId).expect(201)).body;
    const r = await webhook({
      externalId: a.externalId,
      status: 'SUCCEEDED',
      amountMinor: 100,
    }).expect(200);
    expect(r.body.settled).toBe(false);
    // A repeat of the bad report does not flag (or audit) it a second time.
    await webhook({
      externalId: a.externalId,
      status: 'SUCCEEDED',
      amountMinor: 100,
    }).expect(200);
    // A later, correct-looking confirmation must not settle a flagged attempt.
    await webhook({
      externalId: a.externalId,
      status: 'SUCCEEDED',
      amountMinor: 20000,
    }).expect(200);
    expect(await payments(orderId)).toHaveLength(0);
    const view = (await owner.get(`${P}/attempts/${a.id}`).expect(200)).body;
    expect(view.settlementError).toBeTruthy();
    expect(view.settled).toBe(false);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(order.status).toBe('OPEN');
    expect(
      await prisma.auditLog.count({
        where: { action: 'payment.gateway_unsettled', entityId: orderId },
      }),
    ).toBe(1);
  });

  it('acknowledges a signed webhook for an unknown payment without effect', async () => {
    const r = await webhook({
      externalId: `mock_pay_unknown_${tag}`,
      status: 'SUCCEEDED',
      amountMinor: 100,
    }).expect(200);
    expect(r.body).toMatchObject({ ok: true, ignored: true });
  });

  it('keeps attempts inside their restaurant', async () => {
    const orderId = await newOrder(50);
    const a = (await attempt(orderId).expect(201)).body;
    await other.get(`${P}/attempts/${a.id}`).expect(404);
    await other
      .post(`${P}/orders/${orderId}/attempts${q}`)
      .send({
        provider: 'mock-gateway',
        idempotencyKey: randomUUID(),
      })
      .expect(403);
  });
});
