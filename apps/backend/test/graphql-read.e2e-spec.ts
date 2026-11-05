/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped by design */
// GraphQL read resolvers (menu, orders, customers) against a REAL, migrated + seeded Postgres.
//   GRAPHQL_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand graphql-read
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import { createHash, randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

const run = process.env.GRAPHQL_E2E ? describe : describe.skip;
const GQL = '/api/v1/graphql';
const tag = randomUUID().slice(0, 6);

const ORDERS = `query($first: Int, $after: String) {
  orders(first: $first, after: $after) {
    nodes { id orderNumber branchId status totals { subtotal total } items { name quantity } }
    pageInfo { hasNextPage endCursor }
  }
}`;

run('GraphQL read resolvers (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let restaurantId: string;
  let ownerId: string;
  let otherRestaurantId: string;
  const other = { branchId: '', itemId: '', customerId: '' };
  const keys: Record<string, string> = {};
  const keyIds: Record<string, string> = {};
  const piiOrderIds: string[] = [];
  let lowOrderId: string;
  let staffOrderId: string;
  let customerId: string;

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

  const makeOrder = async (
    n: number,
    keyId: string | null,
    withCustomer = true,
  ) => {
    const o = await prisma.order.create({
      data: {
        branchId: 'demo-branch',
        orderNumber: `GQL-${tag}-${n}`,
        type: 'TAKEAWAY',
        channel: keyId ? 'ONLINE' : 'STAFF',
        createdById: ownerId,
        customerId: withCustomer ? customerId : null,
        integrationKeyId: keyId,
        subtotal: 200,
        taxAmount: 9.52,
        totalAmount: 200,
        items: {
          create: [
            {
              menuItemId: (
                await prisma.menuItem.findFirstOrThrow({
                  where: { branchId: 'demo-branch' },
                })
              ).id,
              nameSnapshot: `Thing ${n}`,
              unitPriceSnapshot: 100,
              taxRateSnapshot: 5,
              quantity: 2,
              lineTotal: 200,
            },
          ],
        },
      },
    });
    return o.id;
  };

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
    const ownerRow = await prisma.user.findFirstOrThrow({
      where: { email: 'owner@demo.local' },
    });
    ownerId = ownerRow.id;
    restaurantId = ownerRow.restaurantId;

    const keySpecs: [string, string[], string?][] = [
      ['menu', ['menu:read']],
      ['locked', ['menu:read'], 'demo-branch'],
      ['low', ['orders:read']],
      ['pii', ['orders:read', 'orders:read_customer']],
      ['cust', ['customers:read']],
    ];
    for (const [name, scopes, branchId] of keySpecs) {
      const res = await owner
        .post('/api/v1/integration-api-keys')
        .send({ name: `gqlr-${name}-${tag}`, scopes, branchId })
        .expect(201);
      keys[name] = res.body.token;
      keyIds[name] = (
        await prisma.integrationApiKey.findFirstOrThrow({
          where: { name: `gqlr-${name}-${tag}` },
        })
      ).id;
    }

    customerId = (
      await prisma.customer.create({
        data: {
          branchId: 'demo-branch',
          name: `Gql Guest ${tag}`,
          phone: `+9190000${Math.floor(Math.random() * 1e5)}`,
          email: `gql-${tag}@example.com`,
          allergies: 'peanuts',
        },
      })
    ).id;
    for (let n = 1; n <= 3; n++)
      piiOrderIds.push(await makeOrder(n, keyIds.pii));
    lowOrderId = await makeOrder(4, keyIds.low);
    staffOrderId = await makeOrder(5, null);

    // A second tenant with a menu item, a customer and an all-scope key.
    const r = await prisma.restaurant.create({
      data: { name: `GQL read other ${tag}` },
    });
    otherRestaurantId = r.id;
    const branch = await prisma.branch.create({
      data: { restaurantId: r.id, name: 'Other branch' },
    });
    other.branchId = branch.id;
    const cat = await prisma.menuCategory.create({
      data: { branchId: branch.id, name: 'Other cat' },
    });
    other.itemId = (
      await prisma.menuItem.create({
        data: {
          branchId: branch.id,
          categoryId: cat.id,
          name: `Other dish ${tag}`,
          price: 99,
        },
      })
    ).id;
    other.customerId = (
      await prisma.customer.create({
        data: { branchId: branch.id, name: `Other guest ${tag}` },
      })
    ).id;
    const role = await prisma.role.create({
      data: { restaurantId: r.id, name: `OWNER_${tag}`, label: 'Owner' },
    });
    const user = await prisma.user.create({
      data: {
        restaurantId: r.id,
        roleId: role.id,
        name: 'Other owner',
        email: `gqlr-${tag}@example.com`,
        passwordHash: 'x',
      },
    });
    keys.other = `ordr_ext_${randomUUID().replace(/-/g, '')}`;
    await prisma.integrationApiKey.create({
      data: {
        restaurantId: r.id,
        name: 'other',
        tokenHash: createHash('sha256').update(keys.other).digest('hex'),
        lastFour: keys.other.slice(-4),
        scopes: ['menu:read', 'orders:read', 'customers:read'],
        createdById: user.id,
      },
    });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({
      where: { orderNumber: { startsWith: `GQL-${tag}-` } },
    });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.integrationApiKey.deleteMany({
      where: { name: { startsWith: 'gqlr-', endsWith: tag } },
    });
    if (otherRestaurantId) {
      await prisma.restaurant.delete({ where: { id: otherRestaurantId } });
    }
    await app.close();
  });

  describe('tenant isolation', () => {
    it("never returns another tenant's menu items or customers", async () => {
      const res = await gql(
        '{ menuItems(first: 200) { nodes { id branchId } } customers(first: 100) { nodes { id } } }',
      );
      expect(res.status).toBe(200);
      const items = res.body.data.menuItems.nodes;
      expect(items.length).toBeGreaterThan(0);
      expect(items.map((i: { id: string }) => i.id)).not.toContain(
        other.itemId,
      );
      expect(
        res.body.data.customers.nodes.map((c: { id: string }) => c.id),
      ).not.toContain(other.customerId);
      const branches = await prisma.branch.findMany({
        where: { restaurantId },
        select: { id: true },
      });
      const own = new Set(branches.map((b) => b.id));
      for (const i of items) expect(own.has(i.branchId)).toBe(true);
    });

    it("refuses another tenant's branch as an argument", async () => {
      const res = await gql(
        `{ menuItems(branchId: "${other.branchId}") { nodes { id } } }`,
      );
      expect(codes(res.body)).toEqual(['FORBIDDEN']);
      expect(res.body.data).toBeNull();
    });

    it('returns null for an id that belongs to another tenant', async () => {
      const res = await gql(`{ customer(id: "${other.customerId}") { id } }`);
      expect(res.body.data.customer).toBeNull();
      const theirs = await gql(
        `{ order(id: "${staffOrderId}") { id } customer(id: "${customerId}") { id } }`,
        keys.other,
      );
      expect(theirs.body.data).toEqual({ order: null, customer: null });
    });

    it("gives the other tenant's key only its own menu", async () => {
      const res = await gql('{ menuItems { nodes { id } } }', keys.other);
      expect(res.body.data.menuItems.nodes).toEqual([{ id: other.itemId }]);
    });

    it('pins a location-locked key to its own branch', async () => {
      const res = await gql(
        '{ menuItems(first: 200) { nodes { branchId } } }',
        keys.locked,
      );
      const ids = res.body.data.menuItems.nodes.map(
        (n: { branchId: string }) => n.branchId,
      );
      expect(new Set(ids)).toEqual(new Set(['demo-branch']));
      const foreign = await gql(
        `{ menuItems(branchId: "${other.branchId}") { nodes { id } } }`,
        keys.locked,
      );
      expect(codes(foreign.body)).toEqual(['FORBIDDEN']);
    });
  });

  describe('pagination', () => {
    it('walks a key’s orders page by page with a cursor, no repeats', async () => {
      const first = await gql(ORDERS, keys.pii, { first: 2 });
      expect(first.status).toBe(200);
      const p1 = first.body.data.orders;
      expect(p1.nodes).toHaveLength(2);
      expect(p1.pageInfo.hasNextPage).toBe(true);
      const second = await gql(ORDERS, keys.pii, {
        first: 2,
        after: p1.pageInfo.endCursor,
      });
      const p2 = second.body.data.orders;
      expect(p2.nodes).toHaveLength(1);
      expect(p2.pageInfo.hasNextPage).toBe(false);
      const seen = [...p1.nodes, ...p2.nodes].map((o: { id: string }) => o.id);
      // Only the orders this key placed, newest first.
      expect(seen).toEqual([...piiOrderIds].reverse());
      expect(p1.nodes[0]).toMatchObject({
        status: 'OPEN',
        totals: { subtotal: 200, total: 200 },
        items: [{ name: 'Thing 3', quantity: 2 }],
      });
    });

    it('rejects a forged cursor as bad input', async () => {
      const res = await gql(ORDERS, keys.pii, { after: 'garbage' });
      expect(codes(res.body)).toEqual(['BAD_USER_INPUT']);
    });

    it('caps an oversized page at the server maximum', async () => {
      const res = await gql(
        '{ menuItems(first: 5000) { pageInfo { hasNextPage } } }',
      );
      // Charged at the requested size by the cost rule, so refused up front.
      expect(res.status).toBe(400);
    });

    it('pages menu categories in sort order', async () => {
      const res = await gql(
        '{ menuCategories(branchId: "demo-branch", first: 1) { nodes { id sortOrder } pageInfo { hasNextPage endCursor } } }',
        keys.menu,
      );
      const page = res.body.data.menuCategories;
      expect(page.nodes).toHaveLength(1);
      const next = await gql(
        `{ menuCategories(branchId: "demo-branch", first: 1, after: "${page.pageInfo.endCursor}") { nodes { id sortOrder } } }`,
        keys.menu,
      );
      const n2 = next.body.data.menuCategories.nodes;
      if (n2.length) {
        expect(n2[0].id).not.toBe(page.nodes[0].id);
        expect(n2[0].sortOrder).toBeGreaterThanOrEqual(page.nodes[0].sortOrder);
      }
    });
  });

  describe('field permissions', () => {
    it('hides order customer details from a key without orders:read_customer', async () => {
      const res = await gql(
        `{ order(id: "${lowOrderId}") { id orderNumber customer { name phone } } }`,
        keys.low,
      );
      expect(res.status).toBe(200);
      expect(res.body.data.order).toEqual({
        id: lowOrderId,
        orderNumber: `GQL-${tag}-4`,
        customer: null,
      });
      expect(codes(res.body)).toEqual(['FORBIDDEN']);
      expect(JSON.stringify(res.body)).not.toContain(`Gql Guest ${tag}`);
    });

    it('shows them with orders:read_customer', async () => {
      const res = await gql(
        `{ order(id: "${piiOrderIds[0]}") { customer { name email } } }`,
        keys.pii,
      );
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.order.customer).toEqual({
        name: `Gql Guest ${tag}`,
        email: `gql-${tag}@example.com`,
      });
    });

    it('limits a key to the orders it placed', async () => {
      const low = await gql(ORDERS, keys.low, { first: 20 });
      expect(
        low.body.data.orders.nodes.map((o: { id: string }) => o.id),
      ).toEqual([lowOrderId]);
      const staffOne = await gql(
        `{ order(id: "${staffOrderId}") { id } }`,
        keys.low,
      );
      expect(staffOne.body.data.order).toBeNull();
    });

    it('lets staff see all orders with their customer', async () => {
      const res = await gql(
        `{ order(id: "${staffOrderId}") { id customer { name } } }`,
      );
      expect(res.body.data.order).toEqual({
        id: staffOrderId,
        customer: { name: `Gql Guest ${tag}` },
      });
    });

    it('reports a tipped, settled order at the bill total', async () => {
      // No customer, so settling it earns no loyalty points on the shared guest.
      const tipped = await makeOrder(6, null, false);
      const pay = await owner
        .post(`/api/v1/orders/${tipped}/checkout?branchId=demo-branch`)
        .send({ tipAmount: 20, payments: [{ method: 'CASH', amount: 220 }] });
      expect(pay.status).toBe(201);
      const stored = await prisma.order.findUniqueOrThrow({
        where: { id: tipped },
      });
      expect(stored.status).toBe('PAID');
      expect(Number(stored.totalAmount)).toBe(220);
      const res = await gql(
        `{ order(id: "${tipped}") { status totals { subtotal tip total } } }`,
      );
      expect(res.body.data.order).toEqual({
        status: 'PAID',
        totals: { subtotal: 200, tip: 20, total: Number(stored.totalAmount) },
      });
    });

    it('keeps menu cost price staff-only', async () => {
      const key = await gql(
        '{ menuItems(first: 1) { nodes { name costPrice } } }',
        keys.menu,
      );
      expect(key.body.data.menuItems.nodes[0].costPrice).toBeNull();
      expect(codes(key.body)).toEqual(['FORBIDDEN']);
      const staff = await gql(
        '{ menuItems(first: 1) { nodes { costPrice } } }',
      );
      expect(staff.body.errors).toBeUndefined();
    });

    it('refuses a whole resolver the key has no scope for', async () => {
      for (const [q, k] of [
        ['{ customers { nodes { id } } }', keys.menu],
        ['{ orders { nodes { id } } }', keys.cust],
        ['{ menuItems { nodes { id } } }', keys.low],
      ] as const) {
        const res = await gql(q, k);
        expect(codes(res.body)).toEqual(['FORBIDDEN']);
        expect(res.body.data).toBeNull();
      }
    });

    it('serves customers to customers:read with an allow-listed shape', async () => {
      const res = await gql(
        `{ customers(search: "Gql Guest ${tag}") { nodes { id name email loyaltyPoints } } }`,
        keys.cust,
      );
      expect(res.body.data.customers.nodes).toEqual([
        {
          id: customerId,
          name: `Gql Guest ${tag}`,
          email: `gql-${tag}@example.com`,
          loyaltyPoints: 0,
        },
      ]);
      const bad = await gql(
        `{ customer(id: "${customerId}") { allergies } }`,
        keys.cust,
      );
      expect(bad.status).toBe(400);
    });
  });
});
