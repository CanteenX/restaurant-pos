/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped by design */
// GraphQL mutations (#79) against a REAL, migrated + seeded Postgres.
//   GRAPHQL_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand graphql-write
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

const run = process.env.GRAPHQL_E2E ? describe : describe.skip;
const GQL = '/api/v1/graphql';
const BRANCH = 'demo-branch';
const ITEM = 'demo-item-cola';
const tag = randomUUID().slice(0, 6);

const CREATE = `mutation($branchId: ID!, $input: CreateOrderInput!, $key: String) {
  createOrder(branchId: $branchId, input: $input, idempotencyKey: $key) {
    id branchId channel acceptance status
    totals { subtotal total }
    items { name quantity unitPrice }
  }
}`;
const TOGGLE = `mutation($id: ID!, $available: Boolean!) {
  setMenuItemAvailability(id: $id, available: $available) { id isActive }
}`;

run('GraphQL mutations (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let otherRestaurantId: string;
  let otherItemId: string;
  const keys: Record<string, string> = {};
  const keyIds: string[] = [];

  const gql = (query: string, token?: string, variables?: object) => {
    const r = token
      ? request(app.getHttpServer())
          .post(GQL)
          .set('Authorization', `Bearer ${token}`)
      : owner.post(GQL);
    return r.send({ query, variables });
  };
  const codes = (body: { errors?: { extensions?: { code?: string } }[] }) =>
    (body.errors ?? []).map((e) => e.extensions?.code);
  const input = (over: Record<string, unknown> = {}) => ({
    customerName: `Gql Writer ${tag}`,
    customerPhone: '+91 98765 11111',
    items: [{ menuItemId: ITEM, quantity: 2 }],
    ...over,
  });
  const ordersBy = (name: string) =>
    prisma.order.count({
      where: { integrationKey: { name: `gqlw-${name}-${tag}` } },
    });

  beforeAll(async () => {
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
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);

    const specs: [string, string[], string?][] = [
      ['writer', ['orders:write']],
      ['reader', ['orders:read', 'menu:read']],
      ['locked', ['orders:write', 'menu:availability'], BRANCH],
      ['avail', ['menu:availability']],
      ['limited', ['orders:write']],
    ];
    for (const [name, scopes, branchId] of specs) {
      const res = await owner
        .post('/api/v1/integration-api-keys')
        .send({ name: `gqlw-${name}-${tag}`, scopes, branchId })
        .expect(201);
      keys[name] = res.body.token;
      keyIds.push(
        (
          await prisma.integrationApiKey.findFirstOrThrow({
            where: { name: `gqlw-${name}-${tag}` },
          })
        ).id,
      );
    }

    // A second tenant: its branch and dish must be unreachable.
    const r = await prisma.restaurant.create({
      data: { name: `GQL write other ${tag}` },
    });
    otherRestaurantId = r.id;
    const branch = await prisma.branch.create({
      data: { restaurantId: r.id, name: 'Other branch' },
    });
    const cat = await prisma.menuCategory.create({
      data: { branchId: branch.id, name: 'Other cat' },
    });
    otherItemId = (
      await prisma.menuItem.create({
        data: {
          branchId: branch.id,
          categoryId: cat.id,
          name: `Other dish ${tag}`,
          price: 99,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.menuItem.update({
      where: { id: ITEM },
      data: { isActive: true },
    });
    await prisma.order.deleteMany({
      where: { integrationKeyId: { in: keyIds } },
    });
    await prisma.integrationApiKey.deleteMany({
      where: { id: { in: keyIds } },
    });
    if (otherRestaurantId) {
      await prisma.restaurant.delete({ where: { id: otherRestaurantId } });
    }
    await app.close();
  });

  describe('createOrder', () => {
    it('creates a server-priced online order awaiting acceptance', async () => {
      const res = await gql(CREATE, keys.writer, {
        branchId: BRANCH,
        input: input({ notes: null }),
      });
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      const o = res.body.data.createOrder;
      const cola = await prisma.menuItem.findUniqueOrThrow({
        where: { id: ITEM },
      });
      expect(o).toMatchObject({
        branchId: BRANCH,
        channel: 'ONLINE',
        acceptance: 'PENDING',
        items: [{ quantity: 2 }],
      });
      // Priced from the live menu (prices are tax-inclusive).
      expect(o.items[0].unitPrice).toBeCloseTo(Number(cola.price));
      expect(o.totals.subtotal).toBeCloseTo(Number(cola.price) * 2);
    });

    it('is idempotent: a retry with the same key returns the same order', async () => {
      const idem = `gqlw-idem-${tag}`;
      const before = await ordersBy('writer');
      const vars = { branchId: BRANCH, input: input(), key: idem };
      const first = await gql(CREATE, keys.writer, vars);
      const second = await gql(CREATE, keys.writer, vars);
      expect(first.body.errors).toBeUndefined();
      expect(second.body.data.createOrder.id).toBe(
        first.body.data.createOrder.id,
      );
      expect(await ordersBy('writer')).toBe(before + 1);

      // Shared with the REST Idempotency-Key: same key + body, same order.
      const rest = await request(app.getHttpServer())
        .post(`/api/v1/integrations/locations/${BRANCH}/orders`)
        .set('Authorization', `Bearer ${keys.writer}`)
        .set('Idempotency-Key', idem)
        .send(input());
      expect(rest.body.id).toBe(first.body.data.createOrder.id);

      // Same key, different order: refused, nothing created.
      const changed = await gql(CREATE, keys.writer, {
        ...vars,
        input: input({ items: [{ menuItemId: ITEM, quantity: 3 }] }),
      });
      expect(changed.body.data).toBeNull();
      expect(codes(changed.body)).toEqual(['BAD_USER_INPUT']);
      expect(await ordersBy('writer')).toBe(before + 1);
    });

    it('validates input with the shared schema', async () => {
      const before = await ordersBy('writer');
      for (const vars of [
        { branchId: BRANCH, input: input({ customerPhone: 'call me' }) },
        { branchId: BRANCH, input: input({ type: 'DELIVERY' }) },
        { branchId: BRANCH, input: input({ type: 'DINE_IN' }) },
        { branchId: BRANCH, input: input(), key: 'bad key!' },
      ]) {
        const res = await gql(CREATE, keys.writer, vars);
        expect(codes(res.body)).toEqual(['BAD_USER_INPUT']);
      }
      // Amounts are not part of the input type at all.
      const priced = await gql(CREATE, keys.writer, {
        branchId: BRANCH,
        input: { ...input(), total: 1 },
      });
      expect(priced.status).toBe(200);
      expect(codes(priced.body)).toEqual([undefined]);
      expect(await ordersBy('writer')).toBe(before);
    });

    it('denies keys without orders:write and staff sessions', async () => {
      const vars = { branchId: BRANCH, input: input() };
      const reader = await gql(CREATE, keys.reader, vars);
      expect(codes(reader.body)).toEqual(['FORBIDDEN']);
      expect(reader.body.errors[0].message).toMatch(/orders:write/);
      const staff = await gql(CREATE, undefined, vars);
      expect(codes(staff.body)).toEqual(['FORBIDDEN']);
      expect(await ordersBy('reader')).toBe(0);
      const anon = await request(app.getHttpServer())
        .post(GQL)
        .set('Authorization', 'Bearer ordr_ext_nope')
        .send({ query: CREATE, variables: vars });
      expect(anon.status).toBe(401);
    });

    it("refuses another location or another tenant's branch", async () => {
      const otherBranch = await prisma.branch.findFirstOrThrow({
        where: { restaurantId: otherRestaurantId },
      });
      const locked = await gql(CREATE, keys.locked, {
        branchId: otherBranch.id,
        input: input(),
      });
      expect(codes(locked.body)).toEqual(['FORBIDDEN']);
      const foreign = await gql(CREATE, keys.writer, {
        branchId: otherBranch.id,
        input: input(),
      });
      expect(codes(foreign.body)).toEqual(['NOT_FOUND']);
      expect(
        await prisma.order.count({ where: { branchId: otherBranch.id } }),
      ).toBe(0);
    });

    it('allows one mutation field per request', async () => {
      const res = await gql(
        `mutation($i: CreateOrderInput!) {
          a: createOrder(branchId: "${BRANCH}", input: $i) { id }
          b: createOrder(branchId: "${BRANCH}", input: $i) { id }
        }`,
        keys.writer,
        { i: input() },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('write rate limit', () => {
    afterEach(() => delete process.env.INTEGRATION_WRITE_LIMIT_PER_MIN);

    it('shares the REST per-key write budget and answers 429 + Retry-After', async () => {
      // read per request, so lowering it here affects only this test
      process.env.INTEGRATION_WRITE_LIMIT_PER_MIN = '2';
      const rest = () =>
        request(app.getHttpServer())
          .post(`/api/v1/integrations/locations/${BRANCH}/orders`)
          .set('Authorization', `Bearer ${keys.limited}`)
          .send({ type: 'TAKEAWAY', ...input() });
      const viaGql = () =>
        gql(CREATE, keys.limited, { branchId: BRANCH, input: input() });

      expect((await rest()).status).toBe(201); // write 1 (REST)
      const second = await viaGql(); // write 2 (GraphQL)
      expect(second.status).toBe(200);
      expect(second.body.errors).toBeUndefined();

      const third = await viaGql(); // over the shared budget
      expect(third.status).toBe(429);
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
      expect(codes(third.body)).toEqual(['RATE_LIMITED']);
      expect((await rest()).status).toBe(429); // REST sees the same budget
      expect(await ordersBy('limited')).toBe(2);

      // reads are not writes: a query from the same key still runs
      const read = await gql('{ __typename }', keys.limited);
      expect(read.status).toBe(200);
    });
  });

  describe('setMenuItemAvailability', () => {
    it('marks a dish sold out through MenuService and audits the key', async () => {
      const res = await gql(TOGGLE, keys.avail, { id: ITEM, available: false });
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.setMenuItemAvailability).toEqual({
        id: ITEM,
        isActive: false,
      });
      const row = await prisma.menuItem.findUniqueOrThrow({
        where: { id: ITEM },
      });
      expect(row.isActive).toBe(false);
      const audit = await prisma.auditLog.findFirst({
        where: { entity: 'MenuItem', entityId: ITEM },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit?.userId).toBeNull();
      expect(audit?.metadata).toMatchObject({
        integrationKeyId: keyIds[3],
        changes: { isActive: false },
      });

      const back = await gql(TOGGLE, undefined, { id: ITEM, available: true });
      expect(back.body.data.setMenuItemAvailability.isActive).toBe(true);
    });

    it('denies a menu:read key and hides other tenants', async () => {
      const denied = await gql(TOGGLE, keys.reader, {
        id: ITEM,
        available: false,
      });
      expect(codes(denied.body)).toEqual(['FORBIDDEN']);
      const foreign = await gql(TOGGLE, keys.avail, {
        id: otherItemId,
        available: false,
      });
      expect(codes(foreign.body)).toEqual(['NOT_FOUND']);
      expect(
        (await prisma.menuItem.findUniqueOrThrow({ where: { id: ITEM } }))
          .isActive,
      ).toBe(true);
      expect(
        (
          await prisma.menuItem.findUniqueOrThrow({
            where: { id: otherItemId },
          })
        ).isActive,
      ).toBe(true);
    });

    it('lets a locked key toggle only its own location', async () => {
      const own = await gql(TOGGLE, keys.locked, { id: ITEM, available: true });
      expect(own.body.errors).toBeUndefined();
      const foreign = await gql(TOGGLE, keys.locked, {
        id: otherItemId,
        available: false,
      });
      expect(codes(foreign.body)).toEqual(['NOT_FOUND']);
    });
  });
});
