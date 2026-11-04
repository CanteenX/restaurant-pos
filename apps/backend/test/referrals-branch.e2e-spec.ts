/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Referral staff routes validate branchId at the boundary (#147): a missing
// or blank branchId is a 400 instead of silently matching "any branch of my
// restaurant", and another restaurant's branch is a 403. Runs against any
// migrated Postgres; creates and removes its own throw-away restaurants.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- referrals-branch
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

const tag = randomUUID().slice(0, 8);
const email = `ref-branch-${tag}@example.com`;
const password = 'Password123!';

describe('Referrals branchId validation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let agent: ReturnType<typeof request.agent>;
  const restaurantIds: string[] = [];
  let branchId: string;
  let foreignBranchId: string;
  let customerId: string;

  const routes = () => [
    {
      name: 'stats',
      send: (q: string) => agent.get(`/api/v1/referrals/stats${q}`),
    },
    {
      name: 'customer',
      send: (q: string) =>
        agent.get(`/api/v1/referrals/customer/${customerId}${q}`),
    },
    {
      name: 'apply',
      send: (q: string) =>
        agent
          .post(`/api/v1/referrals/apply${q}`)
          .send({ customerId, code: 'ABCDEFG' }),
    },
  ];

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
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    prisma = app.get(PrismaService);

    const mine = await prisma.restaurant.create({
      data: { name: `RefBranch ${tag}` },
    });
    const other = await prisma.restaurant.create({
      data: { name: `RefForeign ${tag}` },
    });
    restaurantIds.push(mine.id, other.id);
    branchId = (
      await prisma.branch.create({
        data: { name: 'Mine', restaurantId: mine.id },
      })
    ).id;
    foreignBranchId = (
      await prisma.branch.create({
        data: { name: 'Foreign', restaurantId: other.id },
      })
    ).id;
    customerId = (
      await prisma.customer.create({ data: { branchId, name: 'Ref Cust' } })
    ).id;

    const perm = await prisma.permission.upsert({
      where: { key: 'customers.manage' },
      update: {},
      create: {
        key: 'customers.manage',
        label: 'Manage Customers',
        category: 'Customers',
      },
    });
    const role = await prisma.role.create({
      data: { restaurantId: mine.id, name: `REF_${tag}`, label: 'Ref' },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: perm.id },
    });
    await prisma.user.create({
      data: {
        restaurantId: mine.id,
        roleId: role.id,
        name: 'Ref Staff',
        email,
        passwordHash: await bcrypt.hash(password, 4),
      },
    });
    agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
  });

  afterAll(async () => {
    const where = { restaurantId: { in: restaurantIds } };
    await prisma.customer.deleteMany({ where: { branch: where } });
    await prisma.user.deleteMany({ where });
    await prisma.role.deleteMany({ where });
    await prisma.restaurant.deleteMany({
      where: { id: { in: restaurantIds } },
    });
    await app.close();
  });

  it.each(['stats', 'customer', 'apply'])(
    '%s rejects a missing branchId with 400 before touching the service',
    async (name) => {
      const route = routes().find((r) => r.name === name)!;
      const res = await route.send('').expect(400);
      expect(res.body.message).toBe('Validation failed');
      expect(JSON.stringify(res.body.issues)).toMatch(/branchId/);
    },
  );

  it.each(['stats', 'customer', 'apply'])(
    '%s rejects a blank branchId with 400',
    async (name) => {
      const route = routes().find((r) => r.name === name)!;
      const res = await route.send('?branchId=%20%20').expect(400);
      expect(res.body.message).toBe('Validation failed');
    },
  );

  it.each(['stats', 'customer', 'apply'])(
    "%s refuses another restaurant's branch with 403",
    async (name) => {
      const route = routes().find((r) => r.name === name)!;
      await route.send(`?branchId=${foreignBranchId}`).expect(403);
    },
  );

  it('still serves the caller’s own branch', async () => {
    const q = `?branchId=${branchId}`;
    const stats = await agent.get(`/api/v1/referrals/stats${q}`).expect(200);
    expect(stats.body).toEqual(
      expect.objectContaining({ total: 0, rewarded: 0 }),
    );
    const list = await agent
      .get(`/api/v1/referrals/customer/${customerId}${q}`)
      .expect(200);
    expect(list.body.made).toEqual([]);
    // Referrals are off for a new restaurant: the service's own refusal, not
    // the boundary validation, answers.
    const apply = await agent
      .post(`/api/v1/referrals/apply${q}`)
      .send({ customerId, code: 'ABCDEFG' })
      .expect(400);
    expect(apply.body.message).not.toBe('Validation failed');
  });
});
