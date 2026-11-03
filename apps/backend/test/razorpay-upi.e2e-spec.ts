/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Dynamic UPI QR through the Razorpay adapter, against the local Razorpay
// mock server (never the real API). Self-contained: registers its own
// restaurant, so it runs on a freshly migrated DB with no seed.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- --runInBand razorpay-upi
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  MOCK_KEY_ID,
  MOCK_KEY_SECRET,
  startRazorpayMock,
  type RazorpayMock,
} from './razorpay-mock-server';

const tag = randomUUID().slice(0, 6);
const PASSWORD = 'Password123!';
const P = '/api/v1/payment-gateway';
const HUB = '/api/v1/integration-hub';
type Agent = ReturnType<typeof request.agent>;

describe('Razorpay UPI QR (e2e, mock server)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mock: RazorpayMock;
  let owner: Agent;
  let q: string;
  let categoryId: string;
  const saved: Record<string, string | undefined> = {};

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
  const attempt = (orderId: string) =>
    owner.post(`${P}/orders/${orderId}/attempts${q}`).send({
      provider: 'razorpay',
      idempotencyKey: randomUUID(),
    });
  const connect = (keySecret: string) =>
    owner
      .put(`${HUB}/razorpay`)
      .send({ credentials: { keyId: MOCK_KEY_ID, keySecret } })
      .expect(200);

  beforeAll(async () => {
    mock = await startRazorpayMock();
    for (const k of ['ALLOW_PUBLIC_SIGNUP', 'RAZORPAY_API_BASE']) {
      saved[k] = process.env[k];
    }
    process.env.ALLOW_PUBLIC_SIGNUP = 'true';
    process.env.RAZORPAY_API_BASE = mock.url;
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

    const email = `rzp-${tag}@example.com`;
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ownerName: 'Owner Rzp',
        email,
        password: PASSWORD,
        restaurantName: `RZP ${tag}`,
        branchName: 'Main',
      })
      .expect(201);
    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    const branchId = (await owner.get('/api/v1/branches').expect(200)).body[0]
      .id as string;
    q = `?branchId=${branchId}`;
    categoryId = (
      await owner
        .post(`/api/v1/menu/categories${q}`)
        .send({ name: `Mains ${tag}` })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await app.close();
    await mock.close();
  });

  it('offers no gateway to the till until Razorpay is connected and tested', async () => {
    expect((await owner.get(`${P}/available`).expect(200)).body).toEqual([]);

    await connect('wrong-secret-wrong-secret');
    const bad = await owner.post(`${HUB}/razorpay/test`).expect(201);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.connection.status).toBe('AUTH_EXPIRED');
    expect((await owner.get(`${P}/available`).expect(200)).body).toEqual([]);

    await connect(MOCK_KEY_SECRET);
    const ok = await owner.post(`${HUB}/razorpay/test`).expect(201);
    expect(ok.body.connection.status).toBe('CONNECTED');
    expect((await owner.get(`${P}/available`).expect(200)).body).toEqual([
      { key: 'razorpay', name: 'Razorpay' },
    ]);
  });

  it('never returns the key secret from the API', async () => {
    const list = await owner.get(HUB).expect(200);
    const dump = JSON.stringify(list.body);
    expect(dump).not.toContain(MOCK_KEY_SECRET);
    const rzp = list.body.find((p: { key: string }) => p.key === 'razorpay');
    expect(rzp.connection.credentialsSet).toMatchObject({ keySecret: true });
  });

  it('creates an amount-locked QR for the exact balance and settles once paid', async () => {
    const orderId = await newOrder(250.5);
    const a = (await attempt(orderId).expect(201)).body;
    expect(a).toMatchObject({
      provider: 'razorpay',
      status: 'PENDING',
      amount: '250.50',
      settled: false,
    });
    expect(a.externalId).toMatch(/^qr_/);
    expect(a.action.type).toBe('UPI_INTENT');
    expect(a.action.value).toMatch(/^upi:\/\/pay\?/);
    expect(a.action.value).toContain('am=250.50');
    expect(JSON.stringify(a)).not.toContain(MOCK_KEY_SECRET);

    const qr = mock.qrs.find((x) => x.id === a.externalId)!;
    expect(qr).toMatchObject({
      payment_amount: 25_050,
      fixed_amount: true,
      usage: 'single_use',
    });
    expect(qr.notes.attempt_id).toBe(a.id);

    // Not paid yet: polling changes nothing.
    const pending = await owner
      .post(`${P}/attempts/${a.id}/refresh`)
      .expect(201);
    expect(pending.body).toMatchObject({ status: 'PENDING', settled: false });

    await request(mock.url)
      .post(`/__mock/qr_codes/${a.externalId}/pay`)
      .send({})
      .expect(200);
    const paid = await owner.post(`${P}/attempts/${a.id}/refresh`).expect(201);
    expect(paid.body).toMatchObject({ status: 'SUCCEEDED', settled: true });
    await owner.post(`${P}/attempts/${a.id}/refresh`).expect(201);

    const rows = await prisma.payment.findMany({ where: { orderId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      method: 'UPI',
      reference: `razorpay:${a.externalId}`,
    });
    expect(rows[0].amount.toFixed(2)).toBe('250.50');
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(order.status).toBe('PAID');
  });

  it('never settles a short payment', async () => {
    const orderId = await newOrder(99);
    const a = (await attempt(orderId).expect(201)).body;
    await request(mock.url)
      .post(`/__mock/qr_codes/${a.externalId}/pay`)
      .send({ amount: 100 })
      .expect(200);
    const r = await owner.post(`${P}/attempts/${a.id}/refresh`).expect(201);
    expect(r.body.settled).toBe(false);
    expect(r.body.settlementError).toBeTruthy();
    expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
  });

  it('marks the attempt FAILED (no payment) when Razorpay is unreachable', async () => {
    const orderId = await newOrder(80);
    process.env.RAZORPAY_API_BASE = 'http://127.0.0.1:9';
    try {
      const a = (await attempt(orderId).expect(201)).body;
      expect(a).toMatchObject({ status: 'FAILED', failureCode: 'NETWORK' });
    } finally {
      process.env.RAZORPAY_API_BASE = mock.url;
    }
  });
});
