/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped by design */
// Reorder suggestions against a real, migrated + seeded Postgres.
//   REORDER_E2E=1 DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- reorder-suggestions
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

const run = process.env.REORDER_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const q = `?branchId=${BRANCH}`;
const tag = randomUUID().slice(0, 6);

run('Reorder suggestions (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    prisma = app.get(PrismaService);
    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
  });
  afterAll(() => app.close());

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
      where: { email: 'owner@demo.local' },
    });
    await prisma.stockMovement.create({
      data: {
        branchId: BRANCH,
        ingredientId: ing.body.id,
        type: 'CONSUMPTION',
        quantity: -70,
        createdById: user.id,
        createdAt: new Date(Date.now() - 2 * 86_400_000),
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
});
