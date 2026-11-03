/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest bodies are untyped by design */
// Membership tiers and enrolments: lifecycle, permissions, tenant isolation.
//   MEMBERSHIPS_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand memberships
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

const run = process.env.MEMBERSHIPS_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const q = `?branchId=${BRANCH}`;
// The isolation test creates a second restaurant, which needs sign-up opened.
process.env.ALLOW_PUBLIC_SIGNUP = 'true';
const tag = randomUUID().slice(0, 6);
type Agent = ReturnType<typeof request.agent>;

run('Memberships (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Agent;
  let cashier: Agent;
  let customerId: string;
  let silver: string;
  let gold: string;
  const mem = () => `/api/v1/customers/${customerId}/membership`;

  const login = async (email: string) => {
    const a = request.agent(app.getHttpServer());
    await a
      .post('/api/v1/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(201);
    return a;
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
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    prisma = app.get(PrismaService);
    owner = await login('owner@demo.local');

    const roles = (await owner.get('/api/v1/users/roles').expect(200)).body;
    const cashierRole = roles.find((r: any) => r.name === 'CASHIER');
    const email = `cashier-mem-${tag}@demo.local`;
    await owner
      .post('/api/v1/users')
      .send({
        name: `Cashier ${tag}`,
        email,
        password: 'Password123!',
        roleId: cashierRole.id,
        branchIds: [BRANCH],
      })
      .expect(201);
    cashier = await login(email);

    customerId = (
      await owner
        .post(`/api/v1/customers${q}`)
        .send({
          name: `Member ${tag}`,
          phone: `97${Math.floor(Math.random() * 1e8)}`,
        })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.membershipTier.deleteMany({
      where: { name: { endsWith: tag } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: tag } } });
    await app.close();
  });

  it('creates tiers and refuses duplicates and bad input', async () => {
    silver = (
      await owner
        .post('/api/v1/memberships/tiers')
        .send({
          name: `Silver ${tag}`,
          rank: 1,
          discountPercent: 5,
          pointsMultiplier: 1.5,
          durationDays: 30,
        })
        .expect(201)
    ).body.id;
    gold = (
      await owner
        .post('/api/v1/memberships/tiers')
        .send({
          name: `Gold ${tag}`,
          rank: 2,
          discountPercent: 12.5,
          pointsMultiplier: 2,
        })
        .expect(201)
    ).body.id;
    await owner
      .post('/api/v1/memberships/tiers')
      .send({ name: `Gold ${tag}`, rank: 3 })
      .expect(409);
    await owner
      .post('/api/v1/memberships/tiers')
      .send({ name: 'Bad', rank: 1, discountPercent: 150 })
      .expect(400);
    const list = (await owner.get('/api/v1/memberships/tiers').expect(200))
      .body;
    expect(list.map((t: any) => t.id)).toEqual(
      expect.arrayContaining([silver, gold]),
    );
  });

  it('a cashier can read but not create tiers or enrol', async () => {
    await cashier.get('/api/v1/memberships/tiers').expect(200);
    await cashier.get(`${mem()}${q}`).expect(200);
    await cashier
      .post('/api/v1/memberships/tiers')
      .send({ name: `Cash ${tag}`, rank: 9, discountPercent: 90 })
      .expect(403);
    await cashier
      .patch(`/api/v1/memberships/tiers/${silver}`)
      .send({ discountPercent: 90 })
      .expect(403);
    await cashier.post(`${mem()}${q}`).send({ tierId: gold }).expect(403);
    await cashier.post(`${mem()}/expire${q}`).expect(403);
  });

  it('enrols, refuses a second enrolment, upgrades and expires', async () => {
    const m = (
      await owner.post(`${mem()}${q}`).send({ tierId: silver }).expect(201)
    ).body;
    expect(
      new Date(m.expiresAt).getTime() - new Date(m.startsAt).getTime(),
    ).toBe(30 * 86_400_000);
    let s = (await owner.get(`${mem()}${q}`).expect(200)).body;
    expect(s.benefit).toMatchObject({
      tierId: silver,
      discountPercent: 5,
      pointsMultiplier: 1.5,
    });

    await owner.post(`${mem()}${q}`).send({ tierId: gold }).expect(409);
    await owner
      .post(`${mem()}/upgrade${q}`)
      .send({ tierId: silver })
      .expect(400);
    await owner.post(`${mem()}/upgrade${q}`).send({ tierId: gold }).expect(201);
    s = (await owner.get(`${mem()}${q}`).expect(200)).body;
    expect(s.benefit).toMatchObject({
      tierId: gold,
      discountPercent: 12.5,
      pointsMultiplier: 2,
      expiresAt: null,
    });
    expect(s.history).toHaveLength(2);
    expect(s.history[1].endReason).toBe('UPGRADED');

    await owner.post(`${mem()}/expire${q}`).expect(201);
    s = (await owner.get(`${mem()}${q}`).expect(200)).body;
    expect(s.benefit).toMatchObject({
      tierId: null,
      discountPercent: 0,
      pointsMultiplier: 1,
    });
    await owner.post(`${mem()}/expire${q}`).expect(400);
  });

  it('a lapsed membership gives no benefit and can be renewed', async () => {
    await owner.post(`${mem()}${q}`).send({ tierId: silver }).expect(201);
    await prisma.customerMembership.updateMany({
      where: { customerId, endedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await owner.get(`${mem()}${q}`).expect(200)).body.benefit.tierId,
    ).toBeNull();
    await owner.post(`${mem()}${q}`).send({ tierId: silver }).expect(201);
    const open = await prisma.customerMembership.count({
      where: { customerId, endedAt: null },
    });
    expect(open).toBe(1);
  });

  it('concurrent enrolments leave exactly one open row', async () => {
    await owner.post(`${mem()}/expire${q}`).expect(201);
    const codes = (
      await Promise.all(
        [silver, gold, silver].map((tierId) =>
          owner.post(`${mem()}${q}`).send({ tierId }),
        ),
      )
    ).map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(2);
    expect(
      await prisma.customerMembership.count({
        where: { customerId, endedAt: null },
      }),
    ).toBe(1);
  });

  it('is isolated per restaurant', async () => {
    const email = `mem-other-${tag}@example.com`;
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ownerName: 'Other',
        email,
        password: 'Password123!',
        restaurantName: `Other ${tag}`,
        branchName: 'Main',
      })
      .expect(201);
    const other = await login(email);
    const otherBranch = (await other.get('/api/v1/branches').expect(200))
      .body[0].id;
    const oq = `?branchId=${otherBranch}`;

    const theirs = (await other.get('/api/v1/memberships/tiers').expect(200))
      .body;
    expect(theirs.map((t: any) => t.id)).not.toContain(silver);
    await other
      .patch(`/api/v1/memberships/tiers/${gold}`)
      .send({ discountPercent: 99 })
      .expect(404);
    // Our customer through their branch: not found; through our branch: refused.
    await other.get(`${mem()}${oq}`).expect(404);
    await other.post(`${mem()}${oq}`).send({ tierId: gold }).expect(404);
    await other.get(`${mem()}${q}`).expect(403);
    // Their customer cannot be put on our tier.
    const theirCustomer = (
      await other
        .post(`/api/v1/customers${oq}`)
        .send({ name: 'Theirs' })
        .expect(201)
    ).body.id;
    await other
      .post(`/api/v1/customers/${theirCustomer}/membership${oq}`)
      .send({ tierId: gold })
      .expect(404);
    expect(
      Number(
        (await prisma.membershipTier.findUniqueOrThrow({ where: { id: gold } }))
          .discountPercent,
      ),
    ).toBe(12.5);
  });
});
