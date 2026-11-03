/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped by design */
// Purchase price variance report against a REAL, migrated + seeded Postgres.
// Opt-in: PRICE_VARIANCE_E2E=1 DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- price-variance
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const run = process.env.PRICE_VARIANCE_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const q = `?branchId=${BRANCH}`;
const tag = randomUUID().slice(0, 6);

run('Price variance report (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
  });
  afterAll(() => app.close());

  it('reports last/avg/min/max and variance vs previous and quote', async () => {
    const ing = await owner
      .post(`/api/v1/inventory/ingredients${q}`)
      .send({ name: `pv-ing-${tag}`, unit: 'KG' })
      .expect(201);
    const sup = await owner
      .post(`/api/v1/inventory/suppliers${q}`)
      .send({ name: `pv-sup-${tag}` })
      .expect(201);
    await owner
      .post(`/api/v1/inventory/quotations${q}`)
      .send({
        supplierId: sup.body.id,
        items: [
          { ingredientId: ing.body.id, quantityQuoted: 10, unitPrice: 100 },
        ],
      })
      .expect(201);
    for (const unitCost of [100, 120]) {
      await owner
        .post(`/api/v1/inventory/goods-receipts${q}`)
        .send({
          supplierId: sup.body.id,
          items: [{ ingredientId: ing.body.id, quantity: 5, unitCost }],
        })
        .expect(201);
    }

    const day = new Date().toISOString().slice(0, 10);
    const range = `${q}&from=${day}&to=${day}`;
    const res = await owner
      .get(`/api/v1/reports/price-variance${range}`)
      .expect(200);
    const idx = (c: string) => res.body.columns.indexOf(c);
    const row = res.body.rows.find(
      (r: unknown[]) => r[idx('Ingredient')] === `pv-ing-${tag}`,
    );
    expect(row[idx('Receipts')]).toBe(2);
    expect(row[idx('Last cost')]).toBe(120);
    expect(row[idx('Average cost')]).toBe(110);
    expect(row[idx('Min cost')]).toBe(100);
    expect(row[idx('Max cost')]).toBe(120);
    expect(row[idx('Variance vs previous %')]).toBe(20);
    expect(row[idx('Variance vs quote %')]).toBe(20);

    const csv = await owner
      .get(`/api/v1/reports/price-variance/csv${range}`)
      .expect(200);
    expect(csv.text).toContain(`pv-ing-${tag}`);
  });
});
