/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// GraphQL endpoint auth + tenant isolation against a REAL, migrated + seeded Postgres.
//   GRAPHQL_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand graphql-auth
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import { createHash, randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

const run = process.env.GRAPHQL_E2E ? describe : describe.skip;
const GQL = '/api/v1/graphql';
const VIEWER = '{ viewer { kind id restaurantId branchId grants } }';
const tag = randomUUID().slice(0, 6);

run('GraphQL auth and tenant guard (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  let demoRestaurantId: string;
  let otherRestaurantId: string;
  const keys: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const gql = (query: string, token?: string, variables?: object) => {
    const r = http().post(GQL);
    if (token) r.set('Authorization', `Bearer ${token}`);
    return r.send({ query, variables });
  };

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
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    owner = request.agent(app.getHttpServer());
    const login = await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
    demoRestaurantId = login.body.user?.restaurantId ?? login.body.restaurantId;
    if (!demoRestaurantId) {
      const me = await owner.get('/api/v1/auth/me').expect(200);
      demoRestaurantId = me.body.restaurantId ?? me.body.user?.restaurantId;
    }

    for (const [name, branchId] of [
      ['open', undefined],
      ['locked', 'demo-branch'],
    ] as const) {
      const res = await owner
        .post('/api/v1/integration-api-keys')
        .send({ name: `gql-${name}-${tag}`, scopes: ['menu:read'], branchId })
        .expect(201);
      keys[name] = res.body.token;
    }

    // A second tenant with its own key, created directly.
    const other = await prisma.restaurant.create({
      data: { name: `GQL other ${tag}` },
    });
    otherRestaurantId = other.id;
    const role = await prisma.role.create({
      data: { restaurantId: other.id, name: `OWNER_${tag}`, label: 'Owner' },
    });
    const user = await prisma.user.create({
      data: {
        restaurantId: other.id,
        roleId: role.id,
        name: 'Other owner',
        email: `gql-${tag}@example.com`,
        passwordHash: 'x',
      },
    });
    keys.other = `ordr_ext_${randomUUID().replace(/-/g, '')}`;
    await prisma.integrationApiKey.create({
      data: {
        restaurantId: other.id,
        name: 'other',
        tokenHash: createHash('sha256').update(keys.other).digest('hex'),
        lastFour: keys.other.slice(-4),
        scopes: ['menu:read'],
        createdById: user.id,
      },
    });
    keys.revoked = `ordr_ext_${randomUUID().replace(/-/g, '')}`;
    await prisma.integrationApiKey.create({
      data: {
        restaurantId: other.id,
        name: 'revoked',
        tokenHash: createHash('sha256').update(keys.revoked).digest('hex'),
        lastFour: keys.revoked.slice(-4),
        scopes: ['menu:read'],
        createdById: user.id,
        revokedAt: new Date(),
      },
    });
    keys.expired = `ordr_ext_${randomUUID().replace(/-/g, '')}`;
    await prisma.integrationApiKey.create({
      data: {
        restaurantId: other.id,
        name: 'expired',
        tokenHash: createHash('sha256').update(keys.expired).digest('hex'),
        lastFour: keys.expired.slice(-4),
        scopes: ['menu:read'],
        createdById: user.id,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
  });

  afterAll(async () => {
    const list = await owner.get('/api/v1/integration-api-keys');
    for (const k of (list.body ?? []) as { id: string; name: string }[]) {
      if (k.name.endsWith(tag)) {
        await owner.delete(`/api/v1/integration-api-keys/${k.id}`);
      }
    }
    if (otherRestaurantId) {
      await prisma.restaurant.delete({ where: { id: otherRestaurantId } });
    }
    await app.close();
  });

  describe('unauthenticated', () => {
    it('rejects a request with no credential', async () => {
      const res = await gql(VIEWER);
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain('restaurantId');
    });

    it('rejects an unknown key', async () => {
      expect((await gql(VIEWER, 'ordr_ext_nope')).status).toBe(401);
    });

    it('rejects a revoked key', async () => {
      expect((await gql(VIEWER, keys.revoked)).status).toBe(401);
    });

    it('rejects an expired key', async () => {
      expect((await gql(VIEWER, keys.expired)).status).toBe(401);
    });

    it('rejects a non-integration bearer token', async () => {
      expect((await gql(VIEWER, 'ordr_staff_whatever')).status).toBe(401);
    });

    it('does not accept GET queries', async () => {
      const res = await http()
        .get(GQL)
        .query({ query: VIEWER })
        .set('Authorization', `Bearer ${keys.open}`);
      expect(res.status).toBe(405);
    });

    it('refuses a non-JSON body even with a session cookie', async () => {
      const res = await owner
        .post(GQL)
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ query: VIEWER }));
      expect(res.status).toBe(415);
    });
  });

  describe('tenant scoping', () => {
    it('scopes an integration key to its own restaurant', async () => {
      const res = await gql(VIEWER, keys.open).expect(200);
      expect(res.body.data.viewer).toMatchObject({
        kind: 'INTEGRATION_KEY',
        restaurantId: demoRestaurantId,
        branchId: null,
        grants: ['menu:read'],
      });
    });

    it("scopes another restaurant's key to that restaurant", async () => {
      const res = await gql(VIEWER, keys.other).expect(200);
      expect(res.body.data.viewer.restaurantId).toBe(otherRestaurantId);
      expect(res.body.data.viewer.restaurantId).not.toBe(demoRestaurantId);
    });

    it('ignores a client-supplied tenant header', async () => {
      const res = await http()
        .post(GQL)
        .set('Authorization', `Bearer ${keys.other}`)
        .set('X-Restaurant-Id', demoRestaurantId)
        .send({ query: VIEWER, variables: { restaurantId: demoRestaurantId } })
        .expect(200);
      expect(res.body.data.viewer.restaurantId).toBe(otherRestaurantId);
    });

    it('carries the branch lock of a location-scoped key', async () => {
      const res = await gql(VIEWER, keys.locked).expect(200);
      expect(res.body.data.viewer.branchId).toBe('demo-branch');
    });

    it('scopes a staff session to the staff member’s restaurant', async () => {
      const res = await owner.post(GQL).send({ query: VIEWER }).expect(200);
      expect(res.body.data.viewer).toMatchObject({
        kind: 'STAFF',
        restaurantId: demoRestaurantId,
        branchId: null,
      });
    });
  });

  describe('query limits', () => {
    it('rejects an over-complex query before executing it', async () => {
      const fields = Array.from(
        { length: 600 },
        (_, i) => `a${i}: viewer { id }`,
      );
      const res = await gql(`{ ${fields.join(' ')} }`, keys.open);
      expect(res.status).toBe(400);
      expect(res.body.data).toBeUndefined();
      expect(res.body.errors[0].message).toMatch(/cost \d+ exceeds/);
    });

    it('rejects an invalid document with a 400', async () => {
      const res = await gql('{ viewer { nope } }', keys.open);
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toMatch(/nope/);
    });

    it('rejects an oversized body via the shared schema', async () => {
      const res = await gql(
        `{ viewer { id } } #${'x'.repeat(60_000)}`,
        keys.open,
      );
      expect(res.status).toBe(400);
    });
  });
});
