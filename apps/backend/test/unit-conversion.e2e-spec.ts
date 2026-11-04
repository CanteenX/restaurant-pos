/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Unit conversion end-to-end against a REAL, migrated + seeded Postgres.
// Opt-in (needs a database):
//   INVENTORY_E2E=1 DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- unit-conversion
// Buys in KG / PACK / L, uses in G / ML, and checks the base-unit stock ledger.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const run = process.env.INVENTORY_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const q = `?branchId=${BRANCH}`;
const tag = randomUUID().slice(0, 6);

run('Unit conversion (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;
  let categoryId: string;
  let supplierId: string;

  const inv = (path: string) => `/api/v1/inventory/${path}${q}`;
  const get = async (ingredientId: string) =>
    (await owner.get(inv(`ingredients/${ingredientId}`)).expect(200)).body as {
      currentStock: string;
      costPerUnit: string;
    };
  const stockOf = async (ingredientId: string) =>
    Number((await get(ingredientId)).currentStock);
  const ingredient = async (name: string, unit: string) =>
    (
      await owner
        .post(inv('ingredients'))
        .send({ name: `${name}-${tag}`, unit })
        .expect(201)
    ).body.id as string;
  const receive = (
    items: {
      ingredientId: string;
      quantity: number;
      unit?: string;
      unitCost: number;
    }[],
  ) => owner.post(inv('goods-receipts')).send({ supplierId, items });
  const sell = async (menuItemId: string, quantity: number) => {
    const order = await owner
      .post(`/api/v1/orders${q}`)
      .send({
        type: 'TAKEAWAY',
        items: [{ menuItemId, quantity, modifierIds: [] }],
      })
      .expect(201);
    await owner
      .post(`/api/v1/orders/${order.body.id}/checkout${q}`)
      .send({
        payments: [{ method: 'CASH', amount: Number(order.body.totalAmount) }],
      })
      .expect(201);
  };
  const menuItem = async (name: string) =>
    (
      await owner
        .post(`/api/v1/menu/items${q}`)
        .send({
          categoryId,
          name: `${name}-${tag}`,
          price: 100,
          taxRatePercent: 0,
        })
        .expect(201)
    ).body.id as string;

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
    const cats = await owner.get(`/api/v1/menu/categories${q}`).expect(200);
    categoryId = cats.body[0].id;
    supplierId = (
      await owner
        .post(inv('suppliers'))
        .send({ name: `units-supplier-${tag}` })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('receives in KG, sells a recipe in G, and stock is correct', async () => {
    const flour = await ingredient('flour-g', 'G');
    const roti = await menuItem('Roti');

    // 2.5 kg at ₹40/kg -> 2500 g at ₹0.04/g
    await receive([
      { ingredientId: flour, quantity: 2.5, unit: 'KG', unitCost: 40 },
    ]).expect(201);
    expect(await stockOf(flour)).toBe(2500);
    expect(Number((await get(flour)).costPerUnit)).toBe(0.04);

    // Recipe entered in KG for a G-based item: 0.06 kg -> 60 g
    const recipe = await owner
      .patch(inv(`menu-items/${roti}/recipe`))
      .send({ lines: [{ ingredientId: flour, quantity: 0.06, unit: 'KG' }] })
      .expect(200);
    expect(recipe.body.lines[0]).toMatchObject({
      quantity: 60,
      unit: 'G',
      enteredUnit: 'KG',
      enteredQuantity: 0.06,
    });
    expect(recipe.body.totalCost).toBe(2.4); // 60 g x ₹0.04

    await sell(roti, 3);
    expect(await stockOf(flour)).toBe(2320); // 2500 - 3 x 60
  });

  it('receives by pack size into a KG item and deducts a G recipe', async () => {
    const rice = await ingredient('rice-kg', 'KG');
    const biryani = await menuItem('Biryani');
    await owner
      .put(inv(`ingredients/${rice}/conversions`))
      .send({ conversions: [{ unit: 'PACK', factor: 25 }] })
      .expect(200);

    // 2 x 25 kg bags at ₹1500/bag, plus 0.5 kg loose at ₹70/kg
    const grn = await receive([
      { ingredientId: rice, quantity: 2, unit: 'PACK', unitCost: 1500 },
      { ingredientId: rice, quantity: 500, unit: 'G', unitCost: 0.07 },
    ]).expect(201);
    expect(grn.body.items[0]).toMatchObject({
      enteredUnit: 'PACK',
      enteredQuantity: '2',
    });
    expect(Number(grn.body.items[0].quantity)).toBe(50);
    expect(Number(grn.body.items[0].unitCost)).toBe(60);
    expect(await stockOf(rice)).toBe(50.5);

    await owner
      .patch(inv(`menu-items/${biryani}/recipe`))
      .send({ lines: [{ ingredientId: rice, quantity: 150, unit: 'G' }] })
      .expect(200);
    await sell(biryani, 4);
    expect(await stockOf(rice)).toBe(49.9); // 50.5 - 4 x 0.15
  });

  it('pack-size routes require branchId and never cross tenants', async () => {
    const rice = await ingredient('rice-tenant', 'KG');
    await owner
      .put(inv(`ingredients/${rice}/conversions`))
      .send({ conversions: [{ unit: 'PACK', factor: 25 }] })
      .expect(200);

    const oe = `units-other-${tag}@example.com`;
    const previousSignup = process.env.ALLOW_PUBLIC_SIGNUP;
    process.env.ALLOW_PUBLIC_SIGNUP = 'true'; // a second restaurant
    const registered = request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ownerName: 'Other',
        email: oe,
        password: 'Password123!',
        restaurantName: `Units Other ${tag}`,
        branchName: 'Main',
      });
    try {
      await registered.expect(201);
    } finally {
      if (previousSignup === undefined) delete process.env.ALLOW_PUBLIC_SIGNUP;
      else process.env.ALLOW_PUBLIC_SIGNUP = previousSignup;
    }
    const other = request.agent(app.getHttpServer());
    await other
      .post('/api/v1/auth/login')
      .send({ email: oe, password: 'Password123!' })
      .expect(201);

    const path = `/api/v1/inventory/ingredients/${rice}/conversions`;
    // No branchId: rejected at the boundary, not matched across tenants.
    await other.get(path).expect(400);
    await other
      .put(path)
      .send({ conversions: [{ unit: 'PACK', factor: 1 }] })
      .expect(400);
    await other.get(`${path}?branchId=`).expect(400);
    // The owner's own branchId belongs to another restaurant: forbidden.
    await other.get(`${path}${q}`).expect(403);
    await other
      .put(`${path}${q}`)
      .send({ conversions: [{ unit: 'PACK', factor: 1 }] })
      .expect(403);
    // Also blocked on the owner's own session without branchId.
    await owner.get(path).expect(400);

    const mine = await owner.get(inv(`ingredients/${rice}/conversions`));
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual([
      expect.objectContaining({ unit: 'PACK', factor: '25' }),
    ]);
  });

  it('logs waste and adjustments in a convertible unit', async () => {
    const milk = await ingredient('milk-ml', 'ML');
    await receive([
      { ingredientId: milk, quantity: 2, unit: 'L', unitCost: 60 },
    ]).expect(201);
    expect(await stockOf(milk)).toBe(2000);

    await owner
      .post(inv('waste'))
      .send({
        ingredientId: milk,
        quantity: 0.25,
        unit: 'L',
        reason: 'SPOILED',
      })
      .expect(201);
    expect(await stockOf(milk)).toBe(1750);

    await owner
      .post(inv(`ingredients/${milk}/adjust`))
      .send({ quantity: -0.5, unit: 'L', note: 'stocktake' })
      .expect(201);
    expect(await stockOf(milk)).toBe(1250);
  });

  it('rejects incompatible units and leaves stock untouched', async () => {
    const oil = await ingredient('oil-l', 'L');
    await receive([{ ingredientId: oil, quantity: 1, unitCost: 120 }]).expect(
      201,
    );

    const bad = await receive([
      { ingredientId: oil, quantity: 1, unit: 'KG', unitCost: 100 },
    ]).expect(400);
    expect(bad.body.message).toMatch(/cannot be converted/);
    await owner
      .post(inv('waste'))
      .send({ ingredientId: oil, quantity: 1, unit: 'PACK', reason: 'OTHER' })
      .expect(400);
    await owner
      .put(inv(`ingredients/${oil}/conversions`))
      .send({ conversions: [{ unit: 'ML', factor: 0.002 }] })
      .expect(400);
    expect(await stockOf(oil)).toBe(1);
  });

  it('refuses to change the base unit once stock history exists', async () => {
    const sugar = await ingredient('sugar-kg', 'KG');
    await receive([{ ingredientId: sugar, quantity: 5, unitCost: 45 }]).expect(
      201,
    );
    await owner
      .patch(inv(`ingredients/${sugar}`))
      .send({ unit: 'G' })
      .expect(400);
    // Same unit (an unchanged edit form) is still fine.
    await owner
      .patch(inv(`ingredients/${sugar}`))
      .send({ unit: 'KG', reorderLevel: 2 })
      .expect(200);
    expect(await stockOf(sugar)).toBe(5);
  });
});
