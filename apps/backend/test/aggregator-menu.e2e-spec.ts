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

  const setPrice = (price: number) =>
    owner
      .patch(`/api/v1/menu/items/${item.id}?branchId=demo-branch`)
      .send({ price })
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

  it('off -> on -> off in quick succession leaves the platform off (review #200.1)', async () => {
    await setActive(false);
    await flushNow();
    await setActive(true);
    await flushNow();
    await setActive(false);
    await flushNow();
    expect(mock.availability[EXT]).toBe(false);
    await setActive(true);
    await flushNow();
    expect(mock.availability[EXT]).toBe(true);
  });

  it('coalesces edits only into a push not yet sent', async () => {
    await setActive(false);
    await setActive(true);
    const queued = await prisma.integrationOutbox.count({
      where: { connectionId, kind: 'item.availability', status: 'PENDING' },
    });
    expect(queued).toBe(1);
    await flushNow();
    expect(mock.availability[EXT]).toBe(true);
  });

  it('two price edits in one minute both reach the platform (review #200.2)', async () => {
    const before = await prisma.menuItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    const sentPrice = () =>
      (
        mock.menu as { items: { externalItemId: string; price: number }[] }
      ).items.find((i) => i.externalItemId === EXT)!.price;
    try {
      await setPrice(111);
      await flushNow();
      expect(sentPrice()).toBe(111);
      await setPrice(222);
      await flushNow();
      expect(sentPrice()).toBe(222);
    } finally {
      await prisma.menuItem.update({
        where: { id: item.id },
        data: { price: before.price },
      });
    }
  });

  it('a bulk price change publishes the new prices (review #200.4)', async () => {
    const cat = await prisma.menuItem.findUniqueOrThrow({
      where: { id: item.id },
      select: { categoryId: true },
    });
    const snapshot = await prisma.menuItem.findMany({
      where: { branchId: 'demo-branch', categoryId: cat.categoryId },
      select: { id: true, price: true, halfPrice: true },
    });
    try {
      await owner
        .post('/api/v1/menu/items/bulk-price?branchId=demo-branch')
        .send({ percent: 10, categoryId: cat.categoryId, roundToWhole: true })
        .expect(201);
      await flushNow();
      const ours = await prisma.menuItem.findUniqueOrThrow({
        where: { id: item.id },
      });
      const sent = (
        mock.menu as { items: { externalItemId: string; price: number }[] }
      ).items.find((i) => i.externalItemId === EXT)!;
      expect(sent.price).toBe(Number(ours.price));
      expect(sent.price).not.toBe(
        Number(snapshot.find((x) => x.id === item.id)!.price),
      );
    } finally {
      for (const x of snapshot) {
        await prisma.menuItem.update({
          where: { id: x.id },
          data: { price: x.price, halfPrice: x.halfPrice },
        });
      }
    }
  });

  it('an on-demand publish queues only for the requested connection (review #200.5)', async () => {
    const spy = jest.spyOn(outbox, 'enqueueMenuPush');
    try {
      await owner
        .post(`${H}/${P}/menu-sync`)
        .send({ branchId: 'demo-branch' })
        .expect(201);
      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        'demo-branch',
        connectionId,
      );
    } finally {
      spy.mockRestore();
    }
    const other = await prisma.$transaction((tx) =>
      outbox.enqueueMenuPush(tx, 'demo-branch', 'some-other-connection'),
    );
    expect(other).toBe(0);
    await flushNow();
  });

  it("with two branches, each branch's menu goes only to its own outlet (review #200.3)", async () => {
    const second = await prisma.branch.create({
      data: { restaurantId, name: `Second ${tag}` },
    });
    try {
      await owner
        .put(`${H}/${P}`)
        .send({
          credentials: {},
          outlets: { [`out-a-${tag}`]: 'demo-branch' },
        })
        .expect(200);
      // Branch B has no outlet on this connection: nothing is queued for it.
      await owner
        .post(`${H}/${P}/menu-sync`)
        .send({ branchId: second.id })
        .expect(400);
      expect(
        await prisma.$transaction((tx) =>
          outbox.enqueueMenuPush(tx, second.id),
        ),
      ).toBe(0);

      await owner
        .put(`${H}/${P}`)
        .send({
          credentials: {},
          outlets: {
            [`out-a-${tag}`]: 'demo-branch',
            [`out-b-${tag}`]: second.id,
          },
        })
        .expect(200);
      mock.menuByOutlet = {};
      mock.availabilityByOutlet = {};
      await owner
        .post(`${H}/${P}/menu-sync`)
        .send({ branchId: 'demo-branch' })
        .expect(201);
      await setActive(false);
      await flushNow();
      const a = mock.menuByOutlet[`out-a-${tag}`] as {
        outletId: string;
        items: { externalItemId: string }[];
      };
      expect(a.outletId).toBe(`out-a-${tag}`);
      expect(a.items.some((i) => i.externalItemId === EXT)).toBe(true);
      expect(mock.menuByOutlet[`out-b-${tag}`]).toBeUndefined();
      expect(mock.availabilityByOutlet[`out-a-${tag}`]).toEqual({
        [EXT]: false,
      });
      expect(mock.availabilityByOutlet[`out-b-${tag}`]).toBeUndefined();
    } finally {
      await owner.put(`${H}/${P}`).send({ credentials: {}, outlets: {} });
      await prisma.branch.delete({ where: { id: second.id } });
    }
  });

  it("with two branches and no outlet map, each push carries its own branchId (review #200 round 2)", async () => {
    const second = await prisma.branch.create({
      data: { restaurantId, name: `Third ${tag}` },
    });
    try {
      await setActive(true);
      await flushNow();
      mock.menuByBranch = {};
      mock.availabilityByBranch = {};
      await owner
        .post(`${H}/${P}/menu-sync`)
        .send({ branchId: second.id })
        .expect(201);
      await owner
        .post(`${H}/${P}/menu-sync`)
        .send({ branchId: 'demo-branch' })
        .expect(201);
      await setActive(false);
      await flushNow();
      const a = mock.menuByBranch['demo-branch'] as {
        branchId: string;
        outletId?: string;
        items: { externalItemId: string }[];
      };
      const b = mock.menuByBranch[second.id] as {
        branchId: string;
        items: unknown[];
      };
      expect(a.branchId).toBe('demo-branch');
      expect(a.outletId).toBeUndefined();
      expect(a.items.some((i) => i.externalItemId === EXT)).toBe(true);
      expect(b.branchId).toBe(second.id);
      expect(b.items).toEqual([]);
      expect(mock.availabilityByBranch['demo-branch']).toEqual({
        [EXT]: false,
      });
      expect(mock.availabilityByBranch[second.id]).toBeUndefined();
    } finally {
      await prisma.integrationOutbox.deleteMany({
        where: { connectionId, branchId: second.id },
      });
      await prisma.branch.delete({ where: { id: second.id } });
    }
  });

  it('refuses a menu publish for a branch of another restaurant', async () => {
    await owner
      .post(`${H}/${P}/menu-sync`)
      .send({ branchId: 'not-our-branch' })
      .expect(404);
  });
});
