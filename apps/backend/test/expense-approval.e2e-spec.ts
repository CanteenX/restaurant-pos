/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Expense approvals above a threshold (#74). Opt-in:
//   EXPENSE_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand expense-approval
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const run = process.env.EXPENSE_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const tag = randomUUID().slice(0, 6);
// A far-future day nobody has closed, unique per run.
const DAY = `2031-${String(1 + (parseInt(tag, 16) % 12)).padStart(2, '0')}-${String(1 + (parseInt(tag, 16) % 28)).padStart(2, '0')}`;

run('Expense approvals (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;
  let manager: ReturnType<typeof request.agent>;
  let cashier: ReturnType<typeof request.agent>;

  async function staff(role: string) {
    const roles = (await owner.get('/api/v1/users/roles').expect(200))
      .body as { id: string; name: string }[];
    const email = `${role.toLowerCase()}-${tag}@demo.local`;
    await owner
      .post('/api/v1/users')
      .send({
        name: `${role} ${tag}`,
        email,
        password: 'Password123!',
        roleId: roles.find((r) => r.name === role)!.id,
        branchIds: [BRANCH],
      })
      .expect(201);
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(201);
    return agent;
  }

  const expense = (amount: number, note = tag) => ({
    spentOn: DAY,
    category: `Repairs ${tag}`,
    amount,
    note,
    paidFromCash: true,
  });
  const preview = async () =>
    (
      await owner
        .get('/api/v1/accounting/closing/preview')
        .query({ branchId: BRANCH, date: DAY })
        .expect(200)
    ).body as { cashExpenses: number };

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
    manager = await staff('RESTAURANT_MANAGER');
    cashier = await staff('CASHIER');
    await owner
      .patch('/api/v1/settings/restaurant')
      .send({ expenseApprovalThreshold: 1000 })
      .expect(200);
  });

  afterAll(async () => {
    await owner
      .patch('/api/v1/settings/restaurant')
      .send({ expenseApprovalThreshold: null })
      .expect(200);
    await app.close();
  });

  it('auto-approves expenses at or under the threshold', async () => {
    const res = await owner
      .post('/api/v1/accounting/expenses')
      .query({ branchId: BRANCH })
      .send(expense(1000))
      .expect(201);
    expect(res.body.status).toBe('APPROVED');
    expect((await preview()).cashExpenses).toBe(1000);
  });

  it('holds a large expense as PENDING, out of the cash close, and notifies approvers', async () => {
    const res = await owner
      .post('/api/v1/accounting/expenses')
      .query({ branchId: BRANCH })
      .send(expense(5000, `big ${tag}`))
      .expect(201);
    expect(res.body.status).toBe('PENDING');
    expect((await preview()).cashExpenses).toBe(1000);

    const queue = await manager
      .get('/api/v1/accounting/expenses/pending')
      .query({ branchId: BRANCH })
      .expect(200);
    expect(queue.body.map((e: { id: string }) => e.id)).toContain(res.body.id);

    const inbox = await manager.get('/api/v1/notifications').expect(200);
    expect(
      inbox.body.data.some(
        (n: { type: string; entityId: string }) =>
          n.type === 'expense.pending' && n.entityId === res.body.id,
      ),
    ).toBe(true);
  });

  it('blocks self-approval, then lets another approver approve once', async () => {
    const { body: e } = await owner
      .post('/api/v1/accounting/expenses')
      .query({ branchId: BRANCH })
      .send(expense(2500))
      .expect(201);
    await owner
      .post(`/api/v1/accounting/expenses/${e.id}/approve`)
      .query({ branchId: BRANCH })
      .send({})
      .expect(403);
    const ok = await manager
      .post(`/api/v1/accounting/expenses/${e.id}/approve`)
      .query({ branchId: BRANCH })
      .send({ note: 'invoice checked' })
      .expect(201);
    expect(ok.body).toMatchObject({
      status: 'APPROVED',
      decisionNote: 'invoice checked',
    });
    expect(ok.body.decidedById).toBeTruthy();
    expect((await preview()).cashExpenses).toBe(3500);
    await manager
      .post(`/api/v1/accounting/expenses/${e.id}/reject`)
      .query({ branchId: BRANCH })
      .send({})
      .expect(400);

    const audit = await owner
      .get('/api/v1/audit-logs')
      .query({ entity: 'Expense', entityId: e.id });
    if (audit.status === 200) {
      expect(JSON.stringify(audit.body)).toContain('expense.approved');
    }
  });

  it('rejected expenses never count', async () => {
    const { body: e } = await manager
      .post('/api/v1/accounting/expenses')
      .query({ branchId: BRANCH })
      .send(expense(4000))
      .expect(201);
    const res = await owner
      .post(`/api/v1/accounting/expenses/${e.id}/reject`)
      .query({ branchId: BRANCH })
      .send({ note: 'duplicate' })
      .expect(201);
    expect(res.body.status).toBe('REJECTED');
    expect((await preview()).cashExpenses).toBe(3500);
    const listed = await owner
      .get('/api/v1/accounting/expenses')
      .query({ branchId: BRANCH, from: DAY, to: DAY, status: 'REJECTED' })
      .expect(200);
    expect(listed.body.map((x: { id: string }) => x.id)).toEqual([e.id]);
  });

  it('is denied without expenses.approve', async () => {
    await cashier
      .get('/api/v1/accounting/expenses/pending')
      .query({ branchId: BRANCH })
      .expect(403);
    await cashier
      .post('/api/v1/accounting/expenses/x/approve')
      .query({ branchId: BRANCH })
      .send({})
      .expect(403);
  });
});
