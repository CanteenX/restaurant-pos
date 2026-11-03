/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// PIN quick-switch login against a real, migrated Postgres. Self-contained:
// creates its own restaurant, role and user, and removes them afterwards.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- pin-login
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PIN_MAX_FAILURES } from './../src/auth/auth.service';
import { PrismaService } from './../src/prisma/prisma.service';

const tag = randomUUID().slice(0, 8);
const PIN = '48261937';
const WRONG = '13572468';
const PASSWORD = 'Password123!';
const EMAIL = `pin-${tag}@example.com`;

function cookieOf(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).find((c) => c.includes('_session=')) ?? '';
}
/** Cookie name + attributes, without the token value or expiry time. */
function cookieShape(cookie: string): string[] {
  const [nameValue, ...attrs] = cookie.split(';').map((p) => p.trim());
  return [
    nameValue.split('=')[0],
    ...attrs.filter((a) => !/^expires=/i.test(a)).sort(),
  ];
}

describe('PIN login (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let userId = '';
  let restaurantId = '';

  beforeAll(async () => {
    // The route throttle (5/min/IP) is covered by @Throttle; switch it off
    // here so the service-level lockout is what these tests exercise.
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

    const restaurant = await prisma.restaurant.create({
      data: { name: `PIN e2e ${tag}` },
    });
    restaurantId = restaurant.id;
    const role = await prisma.role.create({
      data: { restaurantId, name: 'WAITER', label: 'Waiter' },
    });
    const user = await prisma.user.create({
      data: {
        restaurantId,
        roleId: role.id,
        name: 'Pin Tester',
        email: EMAIL,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        pinHash: await bcrypt.hash(PIN, 4),
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    if (prisma && restaurantId) {
      await prisma.auditLog.deleteMany({ where: { entityId: userId } });
      await prisma.user.deleteMany({ where: { restaurantId } });
      await prisma.role.deleteMany({ where: { restaurantId } });
      await prisma.restaurant.delete({ where: { id: restaurantId } });
    }
    await app?.close();
  });

  const pinLogin = (pin: string, id = userId) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/pin-login')
      .send({ userId: id, pin });

  it('the right PIN sets the same session cookie as password login', async () => {
    const pinRes = await pinLogin(PIN).expect(201);
    expect(pinRes.body.user.id).toBe(userId);
    const pinCookie = cookieOf(pinRes);
    expect(pinCookie).toMatch(/HttpOnly/i);

    const pwRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(201);
    expect(cookieShape(pinCookie)).toEqual(cookieShape(cookieOf(pwRes)));

    // The cookie is a working session.
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', pinCookie.split(';')[0])
      .expect(200);
    expect(me.body.user.id).toBe(userId);

    const ok = await prisma.auditLog.count({
      where: { entityId: userId, action: 'auth.pin_login.success' },
    });
    expect(ok).toBe(1);
  });

  it('never returns the PIN or its hash', async () => {
    const good = await pinLogin(PIN).expect(201);
    const bad = await pinLogin(WRONG).expect(401);
    for (const res of [good, bad]) {
      expect(res.text).not.toContain(PIN);
      expect(res.text).not.toMatch(/\$2[aby]\$/);
      expect(res.text).not.toMatch(/pinHash/i);
    }
  });

  it('an unknown user gets the same 401 as a wrong PIN', async () => {
    const wrong = await pinLogin(WRONG).expect(401);
    const unknown = await pinLogin(WRONG, `ghost-${tag}`).expect(401);
    expect(unknown.body.message).toBe(wrong.body.message);
    expect(cookieOf(unknown)).toBe('');
  });

  it('repeated failures lock the account (423), audited, without logging the PIN', async () => {
    // Earlier tests left one failure on the counter, then succeeded (reset)
    // or failed once more; start clean with a success.
    await pinLogin(PIN).expect(201);
    for (let i = 0; i < PIN_MAX_FAILURES; i++) {
      await pinLogin(WRONG).expect(401);
    }
    const locked = await pinLogin(PIN);
    expect(locked.status).toBe(423);
    expect(cookieOf(locked)).toBe('');

    const failures = await prisma.auditLog.findMany({
      where: { entityId: userId, action: 'auth.pin_login.failure' },
    });
    expect(failures.length).toBeGreaterThanOrEqual(PIN_MAX_FAILURES);
    const lockRows = await prisma.auditLog.count({
      where: { entityId: userId, action: 'auth.pin_login.locked' },
    });
    expect(lockRows).toBe(1);
    const dumped = JSON.stringify(failures);
    expect(dumped).not.toContain(WRONG);
    expect(dumped).not.toContain(PIN);
  });
});
