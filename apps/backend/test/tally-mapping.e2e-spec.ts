/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- supertest bodies are untyped by design */
// Tally ledger mapping API and permissions. Opt-in:
//   TALLY_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand tally-mapping
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const run = process.env.TALLY_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const tag = randomUUID().slice(0, 6);

run('Tally ledger mapping (e2e)', () => {
  let app: INestApplication<App>;
  let owner: ReturnType<typeof request.agent>;
  let cashier: ReturnType<typeof request.agent>;

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
    const email = `cashier-${tag}@demo.local`;
    await owner
      .post('/api/v1/users')
      .send({
        name: `Cashier ${tag}`,
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns defaults, saves overrides and validates', async () => {
    const got = await owner.get('/api/v1/accounting/tally-mapping').expect(200);
    expect(got.body.sales).toBeDefined();
    const put = await owner
      .put('/api/v1/accounting/tally-mapping')
      .send({ sales: `Food Sales ${tag}` })
      .expect(200);
    expect(put.body.sales).toBe(`Food Sales ${tag}`);
    await owner
      .put('/api/v1/accounting/tally-mapping')
      .send({ sales: 'A & B' })
      .expect(400);
  });

  it('is denied without accounting.manage', async () => {
    await cashier.get('/api/v1/accounting/tally-mapping').expect(403);
    await cashier
      .put('/api/v1/accounting/tally-mapping')
      .send({ sales: 'X' })
      .expect(403);
  });
});
