/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped by design */
// Petty cash float (#72) against a REAL, migrated + seeded Postgres. Opt-in:
//   PETTY_CASH_E2E=1 DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- petty-cash
// Uses the seeded demo branch and a random far-future business date, and
// asserts balance deltas, so it can be re-run against the same database.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomInt, randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const run = process.env.PETTY_CASH_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const q = `?branchId=${BRANCH}`;
const tag = randomUUID().slice(0, 6);
const D = new Date(Date.UTC(2031, 0, 1) + randomInt(0, 3650) * 86_400_000)
  .toISOString()
  .slice(0, 10);
const BASE = '/api/v1/accounting/petty-cash';

run('Petty cash ledger (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;
  let cashier: ReturnType<typeof request.agent>;
  let start = 0;

  const balance = async () =>
    Number((await owner.get(`${BASE}${q}`).expect(200)).body.balance);

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

    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);

    const roles = (await owner.get('/api/v1/users/roles').expect(200)).body as {
      id: string;
      name: string;
    }[];
    const email = `pc-cashier-${tag}@demo.local`;
    await owner
      .post('/api/v1/users')
      .send({
        name: `PC Cashier ${tag}`,
        email,
        password: 'Password123!',
        roleId: roles.find((r) => r.name === 'CASHIER')!.id,
        branchIds: [BRANCH],
      })
      .expect(201);
    cashier = request.agent(app.getHttpServer());
    await cashier
      .post('/api/v1/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(201);
    start = await balance();
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires petty_cash.manage', async () => {
    await cashier.get(`${BASE}${q}`).expect(403);
    await cashier
      .post(`${BASE}/entries${q}`)
      .send({ kind: 'TOP_UP', businessDate: D, amount: 10, reason: 'x' })
      .expect(403);
  });

  it('validates input with the shared schema', async () => {
    await owner
      .post(`${BASE}/entries${q}`)
      .send({ kind: 'ADJUST', businessDate: D, amount: 0, reason: 'x' })
      .expect(400);
    await owner
      .post(`${BASE}/entries${q}`)
      .send({ kind: 'PAYOUT', businessDate: D, amount: 5, reason: 'x' })
      .expect(400); // category required
    await owner
      .post(`${BASE}/entries${q}`)
      .send({ kind: 'STEAL', businessDate: D, amount: 5, reason: 'x' })
      .expect(400);
  });

  it('top-up from the till and a payout move the balance exactly', async () => {
    const top = await owner
      .post(`${BASE}/entries${q}`)
      .send({
        kind: 'TOP_UP',
        businessDate: D,
        amount: 1000,
        reason: `Float ${tag}`,
        fromTill: true,
      })
      .expect(201);
    expect(Number(top.body.balanceAfter)).toBe(start + 1000);

    const pay = await owner
      .post(`${BASE}/entries${q}`)
      .send({
        kind: 'PAYOUT',
        businessDate: D,
        amount: 250.5,
        category: `Petty ${tag}`,
        reason: 'Market run',
        receiptRef: `R-${tag}`,
      })
      .expect(201);
    expect(Number(pay.body.amount)).toBe(-250.5);
    expect(pay.body.expenseId).toBeTruthy();
    expect(await balance()).toBe(Math.round((start + 749.5) * 100) / 100);

    // Payout larger than the float is refused and changes nothing.
    await owner
      .post(`${BASE}/entries${q}`)
      .send({
        kind: 'PAYOUT',
        businessDate: D,
        amount: start + 100000,
        category: 'Too much',
        reason: 'x',
      })
      .expect(400);
    expect(await balance()).toBe(Math.round((start + 749.5) * 100) / 100);
  });

  it('a payout is one expense, counted once and never against the till', async () => {
    const exps = (
      await owner
        .get(`/api/v1/accounting/expenses${q}&from=${D}&to=${D}`)
        .expect(200)
    ).body as { id: string; category: string; paidFromCash: boolean }[];
    const mine = exps.filter((e) => e.category === `Petty ${tag}`);
    expect(mine).toHaveLength(1);
    expect(mine[0].paidFromCash).toBe(false);

    const pnl = (
      await owner
        .get(`/api/v1/accounting/profit-loss${q}&from=${D}&to=${D}`)
        .expect(200)
    ).body;
    expect(
      pnl.expenses.find((e: any) => e.category === `Petty ${tag}`).amount,
    ).toBe(250.5);

    const prev = (
      await owner
        .get(`/api/v1/accounting/closing/preview${q}&date=${D}`)
        .expect(200)
    ).body;
    expect(prev.cashExpenses).toBe(0); // payout not taken off the till
    expect(prev.pettyCashTopUps).toBe(1000); // moved out of the drawer
    expect(prev.expectedCash).toBe(-1000);

    // The linked expense can't be deleted behind the ledger's back.
    await owner
      .delete(`/api/v1/accounting/expenses/${mine[0].id}${q}`)
      .expect(400);
  });

  it('summarises the day', async () => {
    const s = (await owner.get(`${BASE}/summary${q}&date=${D}`).expect(200))
      .body;
    expect(s.topUps).toBe(1000);
    expect(s.payouts).toBe(250.5);
    expect(Math.round((s.closingBalance - s.openingBalance) * 100) / 100).toBe(
      749.5,
    );
    const list = (
      await owner.get(`${BASE}/entries${q}&from=${D}&to=${D}`).expect(200)
    ).body;
    expect(list.some((e: any) => e.expense?.category === `Petty ${tag}`)).toBe(
      true,
    );
  });

  it('reconciles a short count as an adjustment', async () => {
    const before = await balance();
    const r = (
      await owner
        .post(`${BASE}/reconcile${q}`)
        .send({ businessDate: D, countedCash: before - 10, note: tag })
        .expect(201)
    ).body;
    expect(r.variance).toBe(-10);
    expect(r.entry.kind).toBe('ADJUST');
    expect(await balance()).toBe(Math.round((before - 10) * 100) / 100);

    const same = (
      await owner
        .post(`${BASE}/reconcile${q}`)
        .send({ businessDate: D, countedCash: before - 10 })
        .expect(201)
    ).body;
    expect(same).toMatchObject({ variance: 0, entry: null });
  });

  it('day close records till top-ups and then locks them', async () => {
    const closing = (
      await owner
        .post(`/api/v1/accounting/closing${q}`)
        .send({ businessDate: D, openingFloat: 1000, countedCash: 0 })
        .expect(201)
    ).body;
    expect(Number(closing.pettyCashTopUps)).toBe(1000);
    expect(Number(closing.expectedCash)).toBe(0);
    expect(Number(closing.variance)).toBe(0);

    await owner
      .post(`${BASE}/entries${q}`)
      .send({
        kind: 'TOP_UP',
        businessDate: D,
        amount: 5,
        reason: 'late',
        fromTill: true,
      })
      .expect(400);
  });

  it('concurrent movements never lose an update', async () => {
    const before = await balance();
    const res = await Promise.all(
      Array.from({ length: 6 }, () =>
        owner.post(`${BASE}/entries${q}`).send({
          kind: 'TOP_UP',
          businessDate: D,
          amount: 1.1,
          reason: `race ${tag}`,
        }),
      ),
    );
    const ok = res.filter((r) => r.status === 201).length;
    expect(ok).toBeGreaterThan(0);
    expect(res.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(await balance()).toBe(Math.round((before + ok * 1.1) * 100) / 100);
  });
});
