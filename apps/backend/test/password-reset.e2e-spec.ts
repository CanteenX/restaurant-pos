/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Password reset by email (#224): request, reset, sessions revoked, expired
// and reused tokens rejected, enumeration-safe answers, per-IP limit, 2FA
// kept. Runs against any migrated Postgres; creates and removes its own
// throw-away restaurant. Email goes to an in-memory mock transport.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- password-reset
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PasswordResetService } from './../src/auth/password-reset.service';
import { AuthTokensService } from './../src/auth/tokens/auth-tokens.service';
import {
  EmailService,
  type OutgoingEmail,
} from './../src/modules/email/email.service';
import { PrismaService } from './../src/prisma/prisma.service';

const tag = randomUUID().slice(0, 8);
const password = 'Password123!';
const NEW_PASSWORD = 'BrandNewPass9';
const BASE = '/api/v1/auth/password-reset';
const PUBLIC_URL = 'https://pos.e2e.example';

describe('Password reset (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let resets: PasswordResetService;
  let restaurantId: string;
  const sent: OutgoingEmail[] = [];
  const emails = {
    a: `reset-a-${tag}@example.com`,
    b: `reset-b-${tag}@example.com`,
    off: `reset-off-${tag}@example.com`,
  };
  const ids: Record<string, string> = {};
  const dupEmail = `dup-${tag}@example.com`;
  const OTHER_PASSWORD = 'SecondPass99';
  let otherRestaurantId: string;
  const savedUrl = process.env.PUBLIC_URL;

  const http = () => request(app.getHttpServer());
  const login = (email: string, pw: string) =>
    http().post('/api/v1/auth/login').send({ email, password: pw });
  const askReset = (email: string) =>
    http().post(`${BASE}/request`).set('Host', 'evil.example').send({ email });
  const tokenFrom = (mail: OutgoingEmail) => {
    const m = /#token=([A-Za-z0-9_.%-]+)/.exec(mail.text);
    if (!m) throw new Error('no reset link in mail');
    return decodeURIComponent(m[1]);
  };
  const latestTokenFor = async (email: string) => {
    sent.length = 0;
    await askReset(email).expect(202);
    await resets.idle();
    expect(sent).toHaveLength(1);
    return tokenFrom(sent[0]);
  };

  beforeAll(async () => {
    process.env.PUBLIC_URL = PUBLIC_URL;
    // Room for every request this file makes before the flood test.
    process.env.PASSWORD_RESET_IP_LIMIT = '8';
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
      .overrideProvider(EmailService)
      .useValue({
        isConfigured: () => true,
        send: (mail: OutgoingEmail) => {
          sent.push(mail);
          return Promise.resolve();
        },
      })
      .compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    resets = app.get(PasswordResetService);

    const restaurant = await prisma.restaurant.create({
      data: { name: `Reset Bistro ${tag}` },
    });
    restaurantId = restaurant.id;
    const branch = await prisma.branch.create({
      data: { restaurantId, name: 'Main' },
    });
    const role = await prisma.role.create({
      data: { restaurantId, name: `CASHIER_${tag}`, label: 'Cashier' },
    });
    const passwordHash = await bcrypt.hash(password, 4);
    for (const [key, email] of Object.entries(emails)) {
      const u = await prisma.user.create({
        data: {
          restaurantId,
          roleId: role.id,
          name: `User ${key}`,
          email,
          passwordHash,
          isActive: key !== 'off',
          branches: { create: { branchId: branch.id } },
        },
      });
      ids[key] = u.id;
    }
    // The same address, cased differently, in a second restaurant (#224 review).
    const other = await prisma.restaurant.create({
      data: { name: `Second Cafe ${tag}` },
    });
    otherRestaurantId = other.id;
    const otherBranch = await prisma.branch.create({
      data: { restaurantId: other.id, name: 'Main' },
    });
    const otherRole = await prisma.role.create({
      data: {
        restaurantId: other.id,
        name: `CASHIER_${tag}`,
        label: 'Cashier',
      },
    });
    const dup = await prisma.user.create({
      data: {
        restaurantId,
        roleId: role.id,
        name: 'Dup in first',
        email: dupEmail,
        passwordHash,
        branches: { create: { branchId: branch.id } },
      },
    });
    const dup2 = await prisma.user.create({
      data: {
        restaurantId: other.id,
        roleId: otherRole.id,
        name: 'Dup in second',
        email: dupEmail.toUpperCase(),
        passwordHash: await bcrypt.hash(OTHER_PASSWORD, 4),
        branches: { create: { branchId: otherBranch.id } },
      },
    });
    ids.dup = dup.id;
    ids.dup2 = dup2.id;
  });

  afterAll(async () => {
    process.env.PUBLIC_URL = savedUrl;
    delete process.env.PASSWORD_RESET_IP_LIMIT;
    await prisma.auditLog.deleteMany({
      where: { userId: { in: Object.values(ids) } },
    });
    for (const id of [restaurantId, otherRestaurantId]) {
      await prisma.user.deleteMany({ where: { restaurantId: id } });
      await prisma.role.deleteMany({ where: { restaurantId: id } });
      await prisma.restaurant.delete({ where: { id } });
    }
    await app.close();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it('tells the login page that reset is available', async () => {
    const res = await http().get(`${BASE}/enabled`).expect(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it('answers the same for known, unknown and inactive addresses', async () => {
    const known = await askReset(emails.a).expect(202);
    const unknown = await askReset(`nobody-${tag}@example.com`).expect(202);
    const inactive = await askReset(emails.off).expect(202);
    await resets.idle();
    expect(unknown.body).toEqual(known.body);
    expect(inactive.body).toEqual(known.body);
    expect(known.body).toEqual({ ok: true });
    expect(sent.map((m) => m.to)).toEqual([emails.a]);
  });

  it('resets: link from PUBLIC_URL, old sessions die, token single-use', async () => {
    const before = await login(emails.a, password).expect(201);
    const cookie = before.headers['set-cookie'] as unknown as string[];
    // A reset request was already sent above; this one replaces it.
    const token = await latestTokenFor(emails.a);
    const mail = sent[0];
    expect(mail.text).toContain(`${PUBLIC_URL}/reset-password#token=`);
    expect(mail.text).not.toContain('evil.example');
    expect(mail.html).toContain('Reset password');

    // Only a hash is stored.
    const rows = await prisma.authToken.findMany({
      where: { userId: ids.a },
    });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token.split('.')[1]);

    // Password policy.
    await http()
      .post(`${BASE}/confirm`)
      .send({ token, password: 'short' })
      .expect(400);

    await http()
      .post(`${BASE}/confirm`)
      .send({ token, password: NEW_PASSWORD })
      .expect(200);

    await http().get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    await login(emails.a, password).expect(401);
    await login(emails.a, NEW_PASSWORD).expect(201);

    // Reuse is rejected.
    await http()
      .post(`${BASE}/confirm`)
      .send({ token, password: 'AnotherPass9' })
      .expect(400);

    const audit = await prisma.auditLog.findMany({
      where: { userId: ids.a, action: { startsWith: 'auth.password_reset' } },
      select: { action: true, metadata: true },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'auth.password_reset.completed',
      'auth.password_reset.requested',
      'auth.password_reset.requested',
    ]);
    expect(JSON.stringify(audit)).not.toContain(emails.a);
  });

  it('rejects an expired token', async () => {
    const { token } = await app.get(AuthTokensService).issue({
      userId: ids.a,
      restaurantId,
      purpose: 'PASSWORD_RESET',
      ttlMs: 30 * 60_000,
    });
    await prisma.authToken.updateMany({
      where: { userId: ids.a, usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await http()
      .post(`${BASE}/confirm`)
      .send({ token, password: 'AnotherPass9' })
      .expect(400);
    await login(emails.a, NEW_PASSWORD).expect(201);
  });

  it('a newer request invalidates the older link; 2FA stays on', async () => {
    await prisma.user.update({
      where: { id: ids.b },
      data: { twoFactorEnabled: true },
    });
    const first = await latestTokenFor(emails.b);
    const second = await latestTokenFor(emails.b);
    await http()
      .post(`${BASE}/confirm`)
      .send({ token: first, password: NEW_PASSWORD })
      .expect(400);
    await http()
      .post(`${BASE}/confirm`)
      .send({ token: second, password: NEW_PASSWORD })
      .expect(200);
    const b = await prisma.user.findUniqueOrThrow({ where: { id: ids.b } });
    expect(b.twoFactorEnabled).toBe(true);
    expect(await bcrypt.compare(NEW_PASSWORD, b.passwordHash)).toBe(true);
  });

  it('same email in two restaurants (any case): one link each; login and reset agree', async () => {
    sent.length = 0;
    await askReset(`  ${dupEmail.replace('dup', 'DuP')}  `).expect(202);
    await resets.idle();
    expect(sent.map((m) => m.to).sort()).toEqual(
      [dupEmail, dupEmail.toUpperCase()].sort(),
    );
    const forSecond = sent.find((m) => m.to === dupEmail.toUpperCase())!;
    const forFirst = sent.find((m) => m.to === dupEmail)!;
    expect(forSecond.text).toContain(`Second Cafe ${tag}`);
    expect(forFirst.text).toContain(`Reset Bistro ${tag}`);

    // Resetting the second restaurant's account changes only that one, and
    // login (any case) then reaches it with the new password.
    await http()
      .post(`${BASE}/confirm`)
      .send({ token: tokenFrom(forSecond), password: NEW_PASSWORD })
      .expect(200);
    const second = await login(dupEmail, NEW_PASSWORD).expect(201);
    expect(second.body.user.restaurantId).toBe(otherRestaurantId);
    const first = await login(dupEmail.toUpperCase(), password).expect(201);
    expect(first.body.user.restaurantId).toBe(restaurantId);
    await login(dupEmail, OTHER_PASSWORD).expect(401);
  });

  it('issuing is atomic and per purpose: parallel requests leave one live link; invites survive', async () => {
    const tokens = app.get(AuthTokensService);
    const invite = await tokens.issue({
      userId: ids.dup,
      restaurantId,
      purpose: 'STAFF_INVITE',
      ttlMs: 72 * 3600_000,
    });
    const issueReset = () =>
      tokens.issue({
        userId: ids.dup,
        restaurantId,
        purpose: 'PASSWORD_RESET',
        ttlMs: 30 * 60_000,
      });
    await Promise.all([issueReset(), issueReset(), issueReset()]);
    const live = await prisma.authToken.findMany({
      where: { userId: ids.dup, usedAt: null },
      select: { purpose: true },
    });
    expect(live.map((r) => r.purpose).sort()).toEqual([
      'PASSWORD_RESET',
      'STAFF_INVITE',
    ]);
    expect(await tokens.peek(invite.token, 'STAFF_INVITE')).not.toBeNull();
  });

  it('rejects malformed tokens at the boundary', async () => {
    await http()
      .post(`${BASE}/confirm`)
      .send({ token: 'not-a-token', password: NEW_PASSWORD })
      .expect(400);
  });

  it('limits requests per IP with a 429 (same for any address)', async () => {
    let status = 0;
    for (let i = 0; i < 12 && status !== 429; i++) {
      const res = await askReset(`flood-${i}-${tag}@example.com`);
      status = res.status;
    }
    expect(status).toBe(429);
    await askReset(emails.a).expect(429);
  });
});
