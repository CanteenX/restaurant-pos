/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Aggregator menu sync (#59) end to end against the mock partner: switching a
// dish off reaches the platform as unavailable, menu publishes match the menu.
//   AGG_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand aggregator-menu
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
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
const H = '/api/v1/integration-hub';
const P = 'partner-api';

run('Aggregator menu sync (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let outbox: IntegrationOutboxService;
  let owner: ReturnType<typeof request.agent>;
  let mock: AggregatorMock;
  let restaurantId: string;
  let connectionId: string;
  let item: { id: string; name: string; isActive: boolean };
  const EXT = `zom-${tag}`;

  const flushNow = async () => {
    await prisma.integrationOutbox.updateMany({
      where: { connectionId, status: 'PENDING' },
      data: { nextAttemptAt: new Date() },
    });
    await outbox.flush();
  };
  const setActive = (isActive: boolean) =>
    owner
      .patch(`/api/v1/menu/items/${item.id}?branchId=demo-branch`)
      .send({ isActive })
      .expect(200);

  beforeAll(async () => {
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
      where: { branchId: 'demo-branch', isActive: true },
      select: { id: true, name: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    mock = new AggregatorMock({ apiKey: API_KEY, webhookSecret: SECRET });
    const baseUrl = await mock.start();
    const saved = await owner
      .put(`${H}/${P}`)
      .send({
        externalAccountId: 'merchant-88',
        credentials: { baseUrl, apiKey: API_KEY, webhookSecret: SECRET },
        itemMap: { [item.id]: EXT },
      })
      .expect(200);
    connectionId = saved.body.id;
  });

  afterAll(async () => {
    await mock?.stop();
    await prisma.menuItem.update({
      where: { id: item.id },
      data: { isActive: true },
    });
    await prisma.integrationConnection.deleteMany({
      where: { restaurantId, provider: P },
    });
    await app.close();
  });

  it('refuses a map entry for a dish that is not ours', async () => {
    await owner
      .put(`${H}/${P}`)
      .send({ credentials: {}, itemMap: { 'not-our-item': 'x' } })
      .expect(400);
  });

  it('switching a dish off sends unavailable under the mapped id, and back on sends available', async () => {
    await setActive(false);
    await flushNow();
    expect(mock.availability[EXT]).toBe(false);
    await setActive(true);
    await flushNow();
    expect(mock.availability[EXT]).toBe(true);
  });

  it('keeps the item map when credentials are saved again', async () => {
    await owner.put(`${H}/${P}`).send({ credentials: {} }).expect(200);
    const row = await prisma.integrationConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect((row.config as { itemMap: Record<string, string> }).itemMap).toEqual(
      { [item.id]: EXT },
    );
  });

  it('publishes a menu that matches ours, on demand', async () => {
    await owner
      .post(`${H}/${P}/menu-sync`)
      .send({ branchId: 'demo-branch' })
      .expect(201);
    await flushNow();
    const sent = mock.menu as {
      items: { externalItemId: string; name: string; price: number }[];
    };
    const ours = await prisma.menuItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    const hit = sent.items.find((i) => i.externalItemId === EXT)!;
    expect(hit.name).toBe(ours.name);
    expect(hit.price).toBe(Number(ours.price));
  });

  it('refuses a menu publish for a branch of another restaurant', async () => {
    await owner
      .post(`${H}/${P}/menu-sync`)
      .send({ branchId: 'not-our-branch' })
      .expect(404);
  });
});
