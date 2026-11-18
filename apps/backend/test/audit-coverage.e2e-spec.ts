/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped by design */
// Audit coverage: customers, reservations and ingredients each write a row per mutation.
//   AUDIT_COVERAGE_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand audit-coverage
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const run = process.env.AUDIT_COVERAGE_E2E ? describe : describe.skip;
const q = '?branchId=demo-branch';
const tag = randomUUID().slice(0, 6);

run('Audit coverage (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;

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
  });
  afterAll(() => app.close());

  const actionsFor = async (entity: string, entityId: string) => {
    const res = await owner
      .get(`/api/v1/audit-logs?entity=${entity}&pageSize=100`)
      .expect(200);
    return (res.body.data as { action: string; entityId: string }[])
      .filter((r) => r.entityId === entityId)
      .map((r) => r.action);
  };

  it('customer create/update/delete → 3 audit rows', async () => {
    const id = (
      await owner
        .post(`/api/v1/customers${q}`)
        .send({
          name: `Aud ${tag}`,
          phone: `98${Math.floor(Math.random() * 1e8)}`,
        })
        .expect(201)
    ).body.id;
    await owner
      .patch(`/api/v1/customers/${id}${q}`)
      .send({ name: `Aud2 ${tag}` })
      .expect(200);
    await owner.delete(`/api/v1/customers/${id}${q}`).expect(200);
    expect((await actionsFor('Customer', id)).sort()).toEqual([
      'customer.created',
      'customer.deleted',
      'customer.updated',
    ]);
  });

  it('ingredient create/update/delete → 3 audit rows', async () => {
    const id = (
      await owner
        .post(`/api/v1/inventory/ingredients${q}`)
        .send({ name: `Ing ${tag}`, unit: 'KG' })
        .expect(201)
    ).body.id;
    await owner
      .patch(`/api/v1/inventory/ingredients/${id}${q}`)
      .send({ name: `Ing2 ${tag}` })
      .expect(200);
    await owner.delete(`/api/v1/inventory/ingredients/${id}${q}`).expect(200);
    expect((await actionsFor('Ingredient', id)).sort()).toEqual([
      'ingredient.created',
      'ingredient.deleted',
      'ingredient.updated',
    ]);
  });

  it('reservation create/status change → audit rows', async () => {
    const id = (
      await owner
        .post(`/api/v1/reservations${q}`)
        .send({
          customerName: `Res ${tag}`,
          guestCount: 2,
          reservedAt: new Date(Date.now() + 86400000).toISOString(),
        })
        .expect(201)
    ).body.id;
    await owner
      .patch(`/api/v1/reservations/${id}/status${q}`)
      .send({ status: 'CANCELLED' })
      .expect(200);
    expect((await actionsFor('Reservation', id)).sort()).toEqual([
      'reservation.created',
      'reservation.status_changed',
    ]);
  });
});
