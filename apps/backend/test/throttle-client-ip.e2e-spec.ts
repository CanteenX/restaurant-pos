// Login throttling keys per real client, not per proxy (#19). In the compose
// topology the backend's only peer is the web container, which rewrites
// X-Forwarded-For to the one address it resolved (apps/web/lib/client-ip.mjs).
// With the compose default TRUST_PROXY=1 the backend must use that entry and
// nothing a client managed to put to its left.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- throttle-client-ip
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { applyTrustProxy } from './../src/common/trust-proxy';

const LOGIN = '/api/v1/auth/login';
const LIMIT = 5; // @Throttle on AuthController.login

function login(app: NestExpressApplication, xff: string) {
  return request(app.getHttpServer())
    .post(LOGIN)
    .set('X-Forwarded-For', xff)
    .send({
      email: `nobody-${randomUUID()}@example.com`,
      password: 'wrong-pw',
    });
}

async function exhaust(app: NestExpressApplication, xff: string) {
  for (let i = 0; i < LIMIT; i++) {
    const res = await login(app, xff);
    expect(res.status).not.toBe(429);
  }
  expect((await login(app, xff)).status).toBe(429);
}

describe('Login throttle per client IP (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    applyTrustProxy(app, '1'); // the docker-compose default
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('gives two forwarded client IPs independent login buckets', async () => {
    await exhaust(app, '198.51.100.10');
    const other = await login(app, '198.51.100.11');
    expect(other.status).not.toBe(429);
  });

  it('ignores spoofed entries beyond the trusted hop count', async () => {
    await exhaust(app, '198.51.100.20');
    // An outside client prepends its own guesses; the trusted hop still
    // reports the real address on the right, so the bucket is the same.
    for (const spoof of ['203.0.113.1', '203.0.113.2, 203.0.113.3']) {
      const res = await login(app, `${spoof}, 198.51.100.20`);
      expect(res.status).toBe(429);
    }
  });
});

describe('TRUST_PROXY validation', () => {
  it.each(['true', '-1', '6', '1.5', '10.0.0.0/8', 'loopback'])(
    'rejects %p',
    (v) => {
      const set = jest.fn();
      expect(() => applyTrustProxy({ set }, v)).toThrow(/TRUST_PROXY/);
      expect(set).not.toHaveBeenCalled();
    },
  );

  it('ignores an empty or unset value and accepts 0-5', () => {
    const set = jest.fn();
    applyTrustProxy({ set }, undefined);
    applyTrustProxy({ set }, '');
    expect(set).not.toHaveBeenCalled();
    applyTrustProxy({ set }, '0');
    applyTrustProxy({ set }, '5');
    expect(set.mock.calls).toEqual([
      ['trust proxy', 0],
      ['trust proxy', 5],
    ]);
  });
});
