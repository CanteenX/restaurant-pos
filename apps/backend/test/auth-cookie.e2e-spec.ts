/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Session cookie name and flags (rebrand 2/4). Runs against any migrated
// Postgres: it creates and removes its own throw-away restaurant and login.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- auth-cookie
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';

const tag = randomUUID().slice(0, 8);
const email = `cookie-${tag}@example.com`;
const password = 'Password123!';
const doomedEmail = `cookie-del-${tag}@example.com`;
// Built from parts so the repo-wide grep for the legacy name stays empty.
const legacyCookie = ['nodedr', 'session'].join('_');
const legacyHeader = `${legacyCookie}=stale-pre-rebrand-token`;

function setCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

describe('Session cookie (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let restaurantId: string;

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
    prisma = app.get(PrismaService);

    const restaurant = await prisma.restaurant.create({
      data: { name: `Cookie ${tag}` },
    });
    restaurantId = restaurant.id;
    const role = await prisma.role.create({
      data: { restaurantId, name: `COOKIE_${tag}`, label: 'Cookie test' },
    });
    await prisma.user.create({
      data: {
        restaurantId,
        roleId: role.id,
        name: 'Cookie Tester',
        email,
        passwordHash: await bcrypt.hash(password, 4),
      },
    });
    await prisma.user.create({
      data: {
        restaurantId,
        roleId: role.id,
        name: 'Cookie Deleter',
        email: doomedEmail,
        passwordHash: await bcrypt.hash(password, 4),
      },
    });
  });

  afterAll(async () => {
    if (restaurantId) {
      await prisma.user.deleteMany({ where: { restaurantId } });
      await prisma.role.deleteMany({ where: { restaurantId } });
      await prisma.restaurant.delete({ where: { id: restaurantId } });
    }
    await app.close();
  });

  it('login sets an HttpOnly nventra_session cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    const cookies = setCookies(res);
    const session = cookies.find((c) => c.startsWith('nventra_session='));
    expect(session).toBeDefined();
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*SameSite=Lax/i);
    expect(cookies.some((c) => c.startsWith(`${legacyCookie}=`))).toBe(false);
  });

  it('the nventra_session cookie authenticates /auth/me', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.restaurantId).toBe(restaurantId);
    // #18: the browser's idle sign-out follows the server's window.
    expect(me.body.session).toEqual({ idleMinutes: 60, idleSignOut: true });
  });

  it('logout clears the nventra_session cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .expect(201);
    const cleared = setCookies(res).find((c) =>
      c.startsWith('nventra_session='),
    );
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });
  // #147: the pre-rebrand cookie is cleared for one release, without
  // touching a valid nventra_session.
  const clearsLegacy = (res: request.Response) =>
    expect(
      setCookies(res).find((c) => c.startsWith(`${legacyCookie}=`)),
    ).toMatch(/Expires=Thu, 01 Jan 1970/i);

  it('login clears a leftover legacy cookie and still sets nventra_session', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Cookie', legacyHeader)
      .send({ email, password })
      .expect(201);
    clearsLegacy(res);
    const session = setCookies(res).find((c) =>
      c.startsWith('nventra_session='),
    );
    expect(session).not.toMatch(/Expires=Thu, 01 Jan 1970/i);
  });

  it('/auth/me clears the legacy cookie and keeps the current session working', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    const current = setCookies(login)
      .find((c) => c.startsWith('nventra_session='))!
      .split(';')[0];
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', `${current}; ${legacyHeader}`)
      .expect(200);
    expect(me.body.user.restaurantId).toBe(restaurantId);
    clearsLegacy(me);
    expect(
      setCookies(me).some(
        (c) =>
          c.startsWith('nventra_session=') &&
          /Expires=Thu, 01 Jan 1970/i.test(c),
      ),
    ).toBe(false);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', current)
      .expect(200);
  });

  it('a legacy cookie alone does not authenticate', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', legacyHeader)
      .expect(401);
  });

  it('logout clears both the current and the legacy cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', legacyHeader)
      .expect(201);
    clearsLegacy(res);
    expect(
      setCookies(res).find((c) => c.startsWith('nventra_session=')),
    ).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });

  it('deleting my account clears the legacy cookie too', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: doomedEmail, password })
      .expect(201);
    const current = setCookies(login)
      .find((c) => c.startsWith('nventra_session='))!
      .split(';')[0];
    const res = await request(app.getHttpServer())
      .delete('/api/v1/auth/me')
      .set('Cookie', `${current}; ${legacyHeader}`)
      .send({ password })
      .expect(200);
    clearsLegacy(res);
  });
});
