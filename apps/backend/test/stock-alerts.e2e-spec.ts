/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Opt-in (needs a migrated + seeded database):
//   STOCK_ALERTS_E2E=1 DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- stock-alerts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { StockAlertsService } from './../src/modules/inventory/stock-alerts.service';

const run = process.env.STOCK_ALERTS_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const tag = randomUUID().slice(0, 6);

run('Stock alerts (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;
  let prisma: PrismaService;
  let alerts: StockAlertsService;
  let ingredientId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    prisma = app.get(PrismaService);
    alerts = app.get(StockAlertsService);
    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
    const ing = await owner
      .post(`/api/v1/inventory/ingredients?branchId=${BRANCH}`)
      .send({ name: `Cream-${tag}`, unit: 'PIECE' })
      .expect(201);
    ingredientId = ing.body.id;
    await prisma.stockBatch.create({
      data: {
        branchId: BRANCH,
        ingredientId,
        batchNumber: `E-${tag}`,
        quantityReceived: 5,
        quantityRemaining: 5,
        unitCost: 1,
        expiryDate: new Date(Date.now() + 2 * 86_400_000),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('notifies once for a near-expiry batch, even when run twice', async () => {
    await alerts.run(new Date());
    await alerts.run(new Date());
    const rows = await prisma.notification.findMany({
      where: {
        branchId: BRANCH,
        type: 'stock.expiring',
        recipient: { email: 'owner@demo.local' },
      },
    });
    const mine = rows.filter((r) => r.body.includes(`Cream-${tag}`));
    expect(mine).toHaveLength(1);
  });
});
