// Session revocation and idle expiry (#17). Runs against any migrated
// Postgres; creates and removes its own throw-away restaurant and logins.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- session-revoke
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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
const adminEmail = `revoke-admin-${tag}@example.com`;
const staffEmail = `revoke-staff-${tag}@example.com`;
const password = 'Password123!';

function sessionCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown;
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  return list.find((c) => c.startsWith('nventra_session='));
}

describe('Session revoke and idle expiry (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwt: JwtService;
  let restaurantId: string;
  let staffId: string;

  const login = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    return agent;
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
    app.setGlobalPrefix('api', { exclude: [] });
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService, { strict: false });

    const restaurant = await prisma.restaurant.create({
      data: { name: `Revoke ${tag}` },
    });
    restaurantId = restaurant.id;
    const perm = await prisma.permission.upsert({
      where: { key: 'users.manage' },
      update: {},
      create: { key: 'users.manage', label: 'Manage Users', category: 'Admin' },
    });
    const adminRole = await prisma.role.create({
      data: { restaurantId, name: `ADMIN_${tag}`, label: 'Admin' },
    });
    await prisma.rolePermission.create({
      data: { roleId: adminRole.id, permissionId: perm.id },
    });
    const staffRole = await prisma.role.create({
      data: { restaurantId, name: `STAFF_${tag}`, label: 'Staff' },
    });
    const passwordHash = await bcrypt.hash(password, 4);
    await prisma.user.create({
      data: {
        restaurantId,
        roleId: adminRole.id,
        name: 'Admin',
        email: adminEmail,
        passwordHash,
      },
    });
    const staff = await prisma.user.create({
      data: {
        restaurantId,
        roleId: staffRole.id,
        name: 'Staff',
        email: staffEmail,
        passwordHash,
      },
    });
    staffId = staff.id;
  });

  afterAll(async () => {
    if (restaurantId) {
      await prisma.auditLog.deleteMany({ where: { entityId: staffId } });
      await prisma.user.deleteMany({ where: { restaurantId } });
      await prisma.role.deleteMany({ where: { restaurantId } });
      await prisma.restaurant.delete({ where: { id: restaurantId } });
    }
    await app.close();
  });

  it('"log out of all devices" ends the session on every client', async () => {
    const a = await login(staffEmail);
    const b = await login(staffEmail);
    await a.get('/api/v1/auth/me').expect(200);
    await b.get('/api/v1/auth/me').expect(200);

    await a.post('/api/v1/auth/sessions/revoke').expect(201);

    await a.get('/api/v1/auth/me').expect(401);
    await b.get('/api/v1/auth/me').expect(401);
    // A fresh login works again.
    const c = await login(staffEmail);
    await c.get('/api/v1/auth/me').expect(200);
  });

  it('an admin can sign a staff member out everywhere', async () => {
    const staff = await login(staffEmail);
    const admin = await login(adminEmail);
    await staff.get('/api/v1/auth/me').expect(200);

    await admin.post(`/api/v1/auth/sessions/revoke/${staffId}`).expect(201);

    await staff.get('/api/v1/auth/me').expect(401);
    await admin.get('/api/v1/auth/me').expect(200);
  });

  it('a staff member without users.manage cannot revoke others', async () => {
    const staff = await login(staffEmail);
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: adminEmail },
    });
    await staff.post(`/api/v1/auth/sessions/revoke/${admin.id}`).expect(403);
  });

  it('an admin password reset ends the old sessions', async () => {
    const staff = await login(staffEmail);
    const admin = await login(adminEmail);
    await staff.get('/api/v1/auth/me').expect(200);
    // Same password value: the reset itself is what must revoke.
    const res = await admin
      .patch(`/api/v1/users/${staffId}`)
      .send({ password });
    expect([200, 201]).toContain(res.status);
    await staff.get('/api/v1/auth/me').expect(401);
  });

  it('pre-rollout tokens without a tv claim still work at version 0', async () => {
    const fresh = await prisma.user.create({
      data: {
        restaurantId,
        roleId: (
          await prisma.role.findFirstOrThrow({ where: { restaurantId } })
        ).id,
        name: 'Legacy',
        email: `legacy-${tag}@example.com`,
        passwordHash: 'x',
      },
    });
    const token = jwt.sign({ sub: fresh.id });
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', `nventra_session=${token}`)
      .expect(200);
  });

  it('an idle (expired) token is rejected', async () => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: staffId },
    });
    const token = jwt.sign(
      { sub: staffId, tv: user.tokenVersion },
      { expiresIn: -10 },
    );
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', `nventra_session=${token}`)
      .expect(401);
  });

  it('activity in the second half of the idle window slides the session', async () => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: staffId },
    });
    const nearlyIdle = jwt.sign(
      { sub: staffId, tv: user.tokenVersion },
      { expiresIn: 300 },
    );
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', `nventra_session=${nearlyIdle}`)
      .expect(200);
    const renewed = sessionCookie(res);
    expect(renewed).toBeDefined();
    expect(renewed).toMatch(/Max-Age=3600/);

    const freshToken = jwt.sign({ sub: staffId, tv: user.tokenVersion });
    const res2 = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', `nventra_session=${freshToken}`)
      .expect(200);
    expect(sessionCookie(res2)).toBeUndefined();
  });
});
