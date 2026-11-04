/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped by design */
// Reorder suggestions + preferred-supplier tenant isolation against a real,
// migrated Postgres. Self-contained: registers its own two restaurants (A and
// B), so it runs on a freshly migrated DB with no seed and no opt-in flag.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- reorder-suggestions
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

const tag = randomUUID().slice(0, 6);
const PASSWORD = 'Password123!';
const DAY_MS = 86_400_000;
// App boot + two registrations (bcrypt) can exceed jest's 5 s default.
const BOOT_TIMEOUT_MS = 60_000;
type Agent = ReturnType<typeof request.agent>;

describe('Reorder suggestions (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Agent;
  let other: Agent;
  let q: string;
  let oq: string;
  let ownerEmail: string;
  let previousSignup: string | undefined;

  const registerRestaurant = async (name: string) => {
    const email = `reorder-${name}-${tag}@example.com`;
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ownerName: `Owner ${name}`,
        email,
        password: PASSWORD,
        restaurantName: `Reorder ${name} ${tag}`,
        branchName: 'Main',
      })
      .expect(201);
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    const branchId = (await agent.get('/api/v1/branches').expect(200)).body[0]
      .id as string;
    return { agent, branchId, email };
  };

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
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    prisma = app.get(PrismaService);

    const a = await registerRestaurant('a');
    owner = a.agent;
    q = `?branchId=${a.branchId}`;
    ownerEmail = a.email;
    const b = await registerRestaurant('b');
    other = b.agent;
    oq = `?branchId=${b.branchId}`;
  }, BOOT_TIMEOUT_MS);
  afterAll(async () => {
    process.env.ALLOW_PUBLIC_SIGNUP = previousSignup;
    await app.close();
  });

  it('suggests whole packs from seeded consumption, grouped by supplier', async () => {
    const sup = await owner
      .post(`/api/v1/inventory/suppliers${q}`)
      .send({ name: `Sup-${tag}` })
      .expect(201);
    const ing = await owner
      .post(`/api/v1/inventory/ingredients${q}`)
      .send({
        name: `Rice-${tag}`,
        unit: 'KG',
        reorderLevel: 20,
        leadTimeDays: 2,
        packSize: 25,
        preferredSupplierId: sup.body.id,
      })
      .expect(201);
    await owner
      .post(`/api/v1/inventory/ingredients/${ing.body.id}/adjust${q}`)
      .send({ quantity: 10, note: 'opening' })
      .expect(201);
    const user = await prisma.user.findFirstOrThrow({
      where: { email: ownerEmail },
    });
    await prisma.stockMovement.create({
      data: {
        branchId: ing.body.branchId,
        ingredientId: ing.body.id,
        type: 'CONSUMPTION',
        quantity: -70,
        createdById: user.id,
        createdAt: new Date(Date.now() - 2 * DAY_MS),
      },
    });

    const res = await owner
      .get(`/api/v1/inventory/reorder-suggestions${q}&days=7`)
      .expect(200);
    const group = res.body.groups.find(
      (g: { supplierId: string }) => g.supplierId === sup.body.id,
    );
    expect(group).toBeDefined();
    const s = group.suggestions.find(
      (x: { ingredientId: string }) => x.ingredientId === ing.body.id,
    );
    // avg 10/day, target 20 + 10*2 = 40, shortfall 30 -> 2 packs of 25
    expect(s.avgDailyConsumption).toBe(10);
    expect(s.suggestedQuantity).toBe(50);
    expect(group.purchaseRequest.items).toContainEqual({
      ingredientId: ing.body.id,
      quantityRequested: 50,
    });
  });

  it('rejects an invalid look-back window', async () => {
    await owner
      .get(`/api/v1/inventory/reorder-suggestions${q}&days=0`)
      .expect(400);
  });

  it('rejects a preferred supplier from another tenant (400, no link)', async () => {
    const foreign = await other
      .post(`/api/v1/inventory/suppliers${oq}`)
      .send({ name: `Foreign-${tag}` })
      .expect(201);
    await owner
      .post(`/api/v1/inventory/ingredients${q}`)
      .send({
        name: `Oil-${tag}`,
        unit: 'L',
        preferredSupplierId: foreign.body.id,
      })
      .expect(400);

    const ing = await owner
      .post(`/api/v1/inventory/ingredients${q}`)
      .send({ name: `Salt-${tag}`, unit: 'KG' })
      .expect(201);
    await owner
      .patch(`/api/v1/inventory/ingredients/${ing.body.id}${q}`)
      .send({ preferredSupplierId: foreign.body.id })
      .expect(400);
    const after = await prisma.ingredient.findUniqueOrThrow({
      where: { id: ing.body.id },
    });
    expect(after.preferredSupplierId).toBeNull();
  });

  it('rejects an unknown preferred supplier id with 400, not 500', async () => {
    await owner
      .post(`/api/v1/inventory/ingredients${q}`)
      .send({
        name: `Sugar-${tag}`,
        unit: 'KG',
        preferredSupplierId: `missing-${tag}`,
      })
      .expect(400);
  });
});
