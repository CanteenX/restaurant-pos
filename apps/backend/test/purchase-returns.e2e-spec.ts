/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped by design */
// Purchase returns (debit notes): caps, stock and supplier-balance effects,
// permissions, audit and tenant isolation. Self-contained: registers its own
// two restaurants (A and B) and a cashier, so it runs on a freshly migrated
// DB with no seed and no opt-in flag.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- --runInBand purchase-returns
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
type Agent = ReturnType<typeof request.agent>;

describe('Purchase returns (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: Agent;
  let cashier: Agent;
  let other: Agent;
  let q: string;
  let oq: string;
  let ingredientId: string;
  let supplierId: string;
  let grnId: string;
  let grnItemId: string;
  let firstReturnId: string;
  let previousSignup: string | undefined;
  const PR = '/api/v1/inventory/purchase-returns';

  const login = async (email: string) => {
    const a = request.agent(app.getHttpServer());
    await a
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    return a;
  };
  const registerRestaurant = async (name: string) => {
    const email = `pr-${name}-${tag}@example.com`;
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        ownerName: `Owner ${name}`,
        email,
        password: PASSWORD,
        restaurantName: `PR ${name} ${tag}`,
        branchName: 'Main',
      })
      .expect(201);
    const agent = await login(email);
    const branchId = (await agent.get('/api/v1/branches').expect(200)).body[0]
      .id as string;
    return { agent, branchId };
  };
  const stock = async () =>
    Number(
      (
        await owner
          .get(`/api/v1/inventory/ingredients/${ingredientId}${q}`)
          .expect(200)
      ).body.currentStock,
    );
  const ret = (quantity: number, extra: object = {}) =>
    owner.post(`${PR}${q}`).send({
      goodsReceiptId: grnId,
      reason: 'DAMAGED',
      items: [{ goodsReceiptItemId: grnItemId, quantity }],
      ...extra,
    });

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
    const b = await registerRestaurant('b');
    other = b.agent;
    oq = `?branchId=${b.branchId}`;

    const roles = (await owner.get('/api/v1/users/roles').expect(200)).body;
    const cashierRole = roles.find((r: any) => r.name === 'CASHIER');
    const email = `cashier-pr-${tag}@example.com`;
    await owner
      .post('/api/v1/users')
      .send({
        name: `Cashier ${tag}`,
        email,
        password: PASSWORD,
        roleId: cashierRole.id,
        branchIds: [a.branchId],
      })
      .expect(201);
    cashier = await login(email);

    ingredientId = (
      await owner
        .post(`/api/v1/inventory/ingredients${q}`)
        .send({ name: `Paneer ${tag}`, unit: 'KG' })
        .expect(201)
    ).body.id;
    supplierId = (
      await owner
        .post(`/api/v1/inventory/suppliers${q}`)
        .send({ name: `Dairy ${tag}` })
        .expect(201)
    ).body.id;
    const grn = (
      await owner
        .post(`/api/v1/inventory/goods-receipts${q}`)
        .send({
          supplierId,
          items: [{ ingredientId, quantity: 10, unitCost: 12.5 }],
        })
        .expect(201)
    ).body;
    grnId = grn.id;
    grnItemId = grn.items[0].id;

    const invoice = (
      await owner
        .post(`/api/v1/inventory/supplier-invoices${q}`)
        .send({
          supplierId,
          goodsReceiptId: grnId,
          invoiceNumber: `INV-${tag}`,
          invoiceDate: new Date().toISOString(),
          totalAmount: 125,
        })
        .expect(201)
    ).body;
    await owner
      .post(`/api/v1/inventory/supplier-invoices/${invoice.id}/payments${q}`)
      .send({ amount: 25, paymentMethod: 'CASH' })
      .expect(201);

    // 3 kg spoiled in the kitchen: only 7 of the 10 received are left.
    await owner
      .post(`/api/v1/inventory/waste${q}`)
      .send({ ingredientId, quantity: 3, reason: 'SPOILED' })
      .expect(201);
  });

  afterAll(async () => {
    // Tenants are uniquely tagged per run and left in place: the stock
    // ledger's Restrict FKs (movements/receipts -> users) make teardown
    // order-sensitive, same as inventory-stock.e2e-spec.ts.
    if (previousSignup === undefined) delete process.env.ALLOW_PUBLIC_SIGNUP;
    else process.env.ALLOW_PUBLIC_SIGNUP = previousSignup;
    await app.close();
  });

  it('validates the body with the shared schema', async () => {
    await ret(-1).expect(400);
    await owner
      .post(`${PR}${q}`)
      .send({ goodsReceiptId: grnId, reason: 'NOPE', items: [] })
      .expect(400);
  });

  it('cannot return more than was received', async () => {
    const res = await ret(11).expect(400);
    expect(res.body.message).toMatch(/received 10/);
  });

  it('cannot return stock that was already used', async () => {
    const res = await ret(8).expect(400);
    expect(res.body.message).toMatch(/only 7 /);
    expect(await stock()).toBe(7);
  });

  it('deducts stock and values the debit note at the received cost', async () => {
    const res = await ret(4, { totalAmount: 1 }).expect(201);
    firstReturnId = res.body.id;
    expect(res.body.returnNumber).toBe('DN-0001');
    expect(Number(res.body.totalAmount)).toBe(50); // 4 x 12.50, client value ignored
    expect(res.body.supplierId).toBe(supplierId);
    expect(await stock()).toBe(3);

    const batches = (
      await owner
        .get(`/api/v1/inventory/ingredients/${ingredientId}/batches${q}`)
        .expect(200)
    ).body;
    expect(Number(batches[0].quantityRemaining)).toBe(3);

    const moves = (
      await owner
        .get(`/api/v1/inventory/ingredients/${ingredientId}/movements${q}`)
        .expect(200)
    ).body;
    const back = moves.find((m: any) => m.type === 'PURCHASE_RETURN');
    expect(Number(back.quantity)).toBe(-4);
    expect(back.note).toContain('DN-0001');
  });

  it('records an audit log entry', async () => {
    const row = await prisma.auditLog.findFirst({
      where: { entity: 'PurchaseReturn', entityId: firstReturnId },
    });
    expect(row?.action).toBe('purchase_return.created');
  });

  it('counts earlier returns: a second return is capped by what is left', async () => {
    await ret(4).expect(400); // only 3 still in stock
    const res = await ret(3).expect(201);
    expect(res.body.returnNumber).toBe('DN-0002');
    expect(Number(res.body.totalAmount)).toBe(37.5);
    expect(await stock()).toBe(0);
    await ret(0.001).expect(400);
  });

  it('reduces the supplier balance by the debit notes', async () => {
    const res = await owner
      .get(`/api/v1/inventory/suppliers/${supplierId}/balance${q}`)
      .expect(200);
    expect(res.body).toEqual({
      supplierId,
      invoiced: 125,
      paid: 25,
      returned: 87.5,
      balance: 12.5,
    });
  });

  it('lists and fetches returns, filtered by supplier', async () => {
    const list = (
      await owner.get(`${PR}${q}&supplierId=${supplierId}`).expect(200)
    ).body;
    expect(list).toHaveLength(2);
    expect(list[0].goodsReceipt.id).toBe(grnId);
    const one = (await owner.get(`${PR}/${firstReturnId}${q}`).expect(200))
      .body;
    expect(one.items[0].ingredient.id).toBe(ingredientId);
  });

  it('requires inventory.manage', async () => {
    await cashier.get(`${PR}${q}`).expect(403);
    await cashier
      .post(`${PR}${q}`)
      .send({
        goodsReceiptId: grnId,
        reason: 'DAMAGED',
        items: [{ goodsReceiptItemId: grnItemId, quantity: 1 }],
      })
      .expect(403);
    await cashier
      .get(`/api/v1/inventory/suppliers/${supplierId}/balance${q}`)
      .expect(403);
  });

  it('keeps 6dp per-gram costs on the debit note and the average (#193)', async () => {
    const saffron = (
      await owner
        .post(`/api/v1/inventory/ingredients${q}`)
        .send({ name: `Saffron ${tag}`, unit: 'G' })
        .expect(201)
    ).body.id;
    const receive = async (unitCost: number) =>
      (
        await owner
          .post(`/api/v1/inventory/goods-receipts${q}`)
          .send({
            supplierId,
            items: [{ ingredientId: saffron, quantity: 1000, unitCost }],
          })
          .expect(201)
      ).body;
    await receive(0.123456);
    const second = await receive(0.234567);
    const before = await prisma.ingredient.findUniqueOrThrow({
      where: { id: saffron },
    });
    const avg = Number(before.costPerUnit);
    expect(avg).toBe(0.179012); // (123.456 + 234.567) / 2000 at 6dp

    const res = await owner
      .post(`${PR}${q}`)
      .send({
        goodsReceiptId: second.id,
        reason: 'DAMAGED',
        items: [{ goodsReceiptItemId: second.items[0].id, quantity: 500 }],
      })
      .expect(201);
    expect(Number(res.body.items[0].unitCost)).toBe(0.234567);
    expect(Number(res.body.items[0].lineTotal)).toBe(117.28); // 500 x 0.234567
    expect(Number(res.body.totalAmount)).toBe(117.28);

    const after = await prisma.ingredient.findUniqueOrThrow({
      where: { id: saffron },
    });
    expect(Number(after.currentStock)).toBe(1500);
    // Remaining 1000 g @ 0.123456 + 500 g @ 0.234567, kept at 6dp.
    expect(Number(after.costPerUnit)).toBe(
      Math.round(((2000 * avg - 500 * 0.234567) / 1500) * 1e6) / 1e6,
    );
  });

  it('isolates tenants', async () => {
    // B cannot use A's branch at all.
    await other.get(`${PR}${q}`).expect(403);
    await other
      .post(`${PR}${q}`)
      .send({
        goodsReceiptId: grnId,
        reason: 'DAMAGED',
        items: [{ goodsReceiptItemId: grnItemId, quantity: 1 }],
      })
      .expect(403);
    // Leaving out branchId must never drop the tenant filter.
    await other.get(PR).expect(400);
    await other.get(`${PR}/${firstReturnId}`).expect(400);
    await other
      .post(PR)
      .send({
        goodsReceiptId: grnId,
        reason: 'DAMAGED',
        items: [{ goodsReceiptItemId: grnItemId, quantity: 1 }],
      })
      .expect(400);
    await other
      .get(`/api/v1/inventory/suppliers/${supplierId}/balance`)
      .expect(400);
    await other.get(`${PR}?branchId=`).expect(400);
    // From its own branch, A's records simply do not exist.
    await other
      .post(`${PR}${oq}`)
      .send({
        goodsReceiptId: grnId,
        reason: 'DAMAGED',
        items: [{ goodsReceiptItemId: grnItemId, quantity: 1 }],
      })
      .expect(404);
    await other.get(`${PR}/${firstReturnId}${oq}`).expect(404);
    await other
      .get(`/api/v1/inventory/suppliers/${supplierId}/balance${oq}`)
      .expect(404);
    expect((await other.get(`${PR}${oq}`).expect(200)).body).toEqual([]);
  });
});
