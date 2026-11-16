// Privilege ceiling (#229): nobody may create, edit, assign, delete or reset an
// account or role holding more access than they do, and only an OWNER may
// touch an OWNER. Runs against any migrated Postgres; builds and removes its
// own throw-away restaurant.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- privilege-ceiling
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
const password = 'Password123!';
const email = (who: string) => `ceil-${who}-${tag}@example.com`;

type Agent = ReturnType<typeof request.agent>;

// role name -> permission keys it grants
const ROLE_PERMS: Record<string, string[]> = {
  OWNER: ['users.manage', 'roles.manage', 'orders.create', 'reports.access'],
  // "Only manage staff": the escalation-prone role from the issue.
  STAFF_MGR: ['users.manage'],
  // "Only manage roles" (+ users so the override endpoint is reachable).
  ROLE_MGR: ['roles.manage', 'users.manage'],
  // A manager with full staff permissions, but no reports.
  FULL_MGR: ['users.manage', 'roles.manage', 'orders.create'],
  WAITER: ['orders.create'],
  // Strictly more than STAFF_MGR.
  HIGH: ['users.manage', 'reports.access'],
};

describe('Privilege ceiling (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let restaurantId = '';
  let branchId = '';
  const roleId: Record<string, string> = {};
  const userId: Record<string, string> = {};
  const as: Record<string, Agent> = {};

  const login = async (who: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email: email(who), password })
      .expect(201);
    return agent;
  };

  const roleName = (r: string) => (r === 'OWNER' ? 'OWNER' : `${r}_${tag}`);

  const makeUser = async (who: string, role: string) => {
    const u = await prisma.user.create({
      data: {
        restaurantId,
        roleId: roleId[role],
        name: who,
        email: email(who),
        passwordHash: await bcrypt.hash(password, 4),
        branches: { create: [{ branchId }] },
      },
    });
    userId[who] = u.id;
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

    const restaurant = await prisma.restaurant.create({
      data: { name: `Ceiling ${tag}` },
    });
    restaurantId = restaurant.id;
    branchId = (
      await prisma.branch.create({ data: { restaurantId, name: 'Main' } })
    ).id;

    const perms = await prisma.permission.findMany({
      where: { key: { in: [...new Set(Object.values(ROLE_PERMS).flat())] } },
    });
    const permId = new Map(perms.map((p) => [p.key, p.id]));
    for (const [r, keys] of Object.entries(ROLE_PERMS)) {
      const role = await prisma.role.create({
        data: {
          restaurantId,
          name: roleName(r),
          label: r,
          isSystem: r === 'OWNER',
        },
      });
      await prisma.rolePermission.createMany({
        data: keys.map((k) => ({
          roleId: role.id,
          permissionId: permId.get(k)!,
        })),
      });
      roleId[r] = role.id;
    }

    await makeUser('owner', 'OWNER');
    await makeUser('staffmgr', 'STAFF_MGR');
    await makeUser('peer', 'STAFF_MGR');
    await makeUser('rolemgr', 'ROLE_MGR');
    await makeUser('fullmgr', 'FULL_MGR');
    await makeUser('waiter', 'WAITER');
    await makeUser('high', 'HIGH');

    for (const who of ['owner', 'staffmgr', 'rolemgr', 'fullmgr']) {
      as[who] = await login(who);
    }
  });

  afterAll(async () => {
    if (restaurantId) {
      const ids = (
        await prisma.user.findMany({
          where: { restaurantId },
          select: { id: true },
        })
      ).map((u) => u.id);
      await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { restaurantId } });
      await prisma.role.deleteMany({ where: { restaurantId } });
      await prisma.restaurant.delete({ where: { id: restaurantId } });
    }
    await app.close();
  });

  const newStaff = (who: string, role: string) => ({
    name: who,
    email: email(`${who}-${randomUUID().slice(0, 4)}`),
    password,
    roleId: roleId[role],
    branchIds: [branchId],
  });

  describe('(a) promotion / assignment', () => {
    it('a staff manager cannot promote themselves to OWNER', async () => {
      await as.staffmgr
        .patch(`/api/v1/users/${userId.staffmgr}`)
        .send({ roleId: roleId.OWNER })
        .expect(403);
    });

    it('a staff manager cannot move themselves to a higher role', async () => {
      await as.staffmgr
        .patch(`/api/v1/users/${userId.staffmgr}`)
        .send({ roleId: roleId.HIGH })
        .expect(403);
    });

    it('a staff manager cannot promote a peer to OWNER or a higher role', async () => {
      await as.staffmgr
        .patch(`/api/v1/users/${userId.peer}`)
        .send({ roleId: roleId.OWNER })
        .expect(403);
      await as.staffmgr
        .patch(`/api/v1/users/${userId.peer}`)
        .send({ roleId: roleId.HIGH })
        .expect(403);
    });

    it('a staff manager cannot create an OWNER or higher account', async () => {
      await as.staffmgr
        .post('/api/v1/users')
        .send(newStaff('x', 'OWNER'))
        .expect(403);
      await as.staffmgr
        .post('/api/v1/users')
        .send(newStaff('x', 'HIGH'))
        .expect(403);
    });

    it('a full manager cannot create an OWNER account', async () => {
      await as.fullmgr
        .post('/api/v1/users')
        .send(newStaff('x', 'OWNER'))
        .expect(403);
    });
  });

  describe('(b) editing / deleting higher accounts', () => {
    it('a staff manager cannot edit or delete the OWNER', async () => {
      await as.staffmgr
        .patch(`/api/v1/users/${userId.owner}`)
        .send({ name: 'pwned' })
        .expect(403);
      await as.staffmgr.delete(`/api/v1/users/${userId.owner}`).expect(403);
    });

    it('a staff manager cannot disable or delete a higher user', async () => {
      await as.staffmgr
        .patch(`/api/v1/users/${userId.high}`)
        .send({ isActive: false })
        .expect(403);
      await as.staffmgr.delete(`/api/v1/users/${userId.high}`).expect(403);
    });

    it('a full manager cannot edit the OWNER', async () => {
      await as.fullmgr
        .patch(`/api/v1/users/${userId.owner}`)
        .send({ name: 'pwned' })
        .expect(403);
    });

    it('per-user overrides cannot be set on a higher user', async () => {
      await as.rolemgr
        .put(`/api/v1/users/${userId.high}/permission-overrides`)
        .send({
          overrides: [{ permissionKey: 'reports.access', effect: 'DENY' }],
        })
        .expect(403);
    });
  });

  describe('(c) password / 2FA / session resets', () => {
    it("a staff manager cannot reset the owner's password", async () => {
      await as.staffmgr
        .patch(`/api/v1/users/${userId.owner}`)
        .send({ password: 'Hijacked123!' })
        .expect(403);
    });

    it("a staff manager cannot reset a higher user's password", async () => {
      await as.staffmgr
        .patch(`/api/v1/users/${userId.high}`)
        .send({ password: 'Hijacked123!' })
        .expect(403);
    });

    it("a staff manager cannot reset the owner's or a higher user's 2FA", async () => {
      await as.staffmgr
        .post(`/api/v1/auth/2fa/reset/${userId.owner}`)
        .expect(403);
      await as.staffmgr
        .post(`/api/v1/auth/2fa/reset/${userId.high}`)
        .expect(403);
    });

    it('a staff manager cannot sign the owner out everywhere', async () => {
      await as.staffmgr
        .post(`/api/v1/auth/sessions/revoke/${userId.owner}`)
        .expect(403);
    });

    it('the owner can still sign in with the original password', async () => {
      await login('owner');
    });
  });

  describe('(d) custom roles', () => {
    it('a roles manager cannot create a role with permissions they lack', async () => {
      await as.rolemgr
        .post('/api/v1/roles')
        .send({
          name: `ESC_${tag}`,
          label: 'Escalated',
          permissionKeys: ['roles.manage', 'reports.access'],
        })
        .expect(403);
    });

    it('a roles manager cannot add permissions to their own role', async () => {
      await as.rolemgr
        .patch(`/api/v1/roles/${roleId.ROLE_MGR}`)
        .send({ permissionKeys: [...ROLE_PERMS.ROLE_MGR, 'reports.access'] })
        .expect(403);
    });

    it('a roles manager cannot edit the OWNER role or a higher role', async () => {
      await as.rolemgr
        .patch(`/api/v1/roles/${roleId.OWNER}`)
        .send({ permissionKeys: [] })
        .expect(403);
      await as.rolemgr
        .patch(`/api/v1/roles/${roleId.HIGH}`)
        .send({ label: 'renamed' })
        .expect(403);
    });

    it('a roles manager cannot delete a higher role', async () => {
      const r = await prisma.role.create({
        data: {
          restaurantId,
          name: `TMP_HIGH_${tag}`,
          label: 'tmp',
          isSystem: false,
        },
      });
      const reports = await prisma.permission.findUniqueOrThrow({
        where: { key: 'reports.access' },
      });
      await prisma.rolePermission.create({
        data: { roleId: r.id, permissionId: reports.id },
      });
      await as.rolemgr.delete(`/api/v1/roles/${r.id}`).expect(403);
    });
  });

  describe('role picker', () => {
    it('hides OWNER and higher roles from a staff manager', async () => {
      const res = await as.staffmgr.get('/api/v1/users/roles').expect(200);
      const ids = (res.body as { id: string }[]).map((r) => r.id);
      expect(ids).toContain(roleId.STAFF_MGR);
      expect(ids).not.toContain(roleId.OWNER);
      expect(ids).not.toContain(roleId.HIGH);
    });

    it('shows every role to the owner', async () => {
      const res = await as.owner.get('/api/v1/users/roles').expect(200);
      const ids = (res.body as { id: string }[]).map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining(Object.values(roleId)));
    });
  });

  describe('allowed flows keep working', () => {
    it('a staff manager can edit their own name and a same-level peer', async () => {
      await as.staffmgr
        .patch(`/api/v1/users/${userId.staffmgr}`)
        .send({ name: 'Me' })
        .expect(200);
      await as.staffmgr
        .patch(`/api/v1/users/${userId.peer}`)
        .send({ password: 'NewPassword123!' })
        .expect(200);
    });

    it('a full manager creates, edits, resets and deletes a waiter', async () => {
      const created = await as.fullmgr
        .post('/api/v1/users')
        .send(newStaff('w2', 'WAITER'))
        .expect(201);
      const id = (created.body as { id: string }).id;
      await as.fullmgr
        .patch(`/api/v1/users/${id}`)
        .send({ password: 'Another123!', name: 'W2' })
        .expect(200);
      await as.fullmgr.post(`/api/v1/auth/2fa/reset/${id}`).expect(201);
      await as.fullmgr.post(`/api/v1/auth/sessions/revoke/${id}`).expect(201);
      await as.fullmgr.delete(`/api/v1/users/${id}`).expect(200);
    });

    it('a full manager can create a role within their own permissions', async () => {
      const r = await as.fullmgr
        .post('/api/v1/roles')
        .send({
          name: `OK_${tag}`,
          label: 'Ok',
          permissionKeys: ['orders.create'],
        })
        .expect(201);
      await as.fullmgr
        .delete(`/api/v1/roles/${(r.body as { id: string }).id}`)
        .expect(200);
    });

    it('the owner manages everyone, including higher users and the OWNER role', async () => {
      await as.owner
        .patch(`/api/v1/users/${userId.high}`)
        .send({ name: 'High' })
        .expect(200);
      await as.owner
        .patch(`/api/v1/users/${userId.fullmgr}`)
        .send({ roleId: roleId.HIGH })
        .expect(200);
      await as.owner
        .patch(`/api/v1/users/${userId.fullmgr}`)
        .send({ roleId: roleId.FULL_MGR })
        .expect(200);
      await as.owner.post(`/api/v1/auth/2fa/reset/${userId.high}`).expect(201);
      await as.owner
        .patch(`/api/v1/roles/${roleId.OWNER}`)
        .send({ label: 'Owner' })
        .expect(200);
      const created = await as.owner
        .post('/api/v1/users')
        .send(newStaff('o2', 'OWNER'))
        .expect(201);
      await as.owner
        .delete(`/api/v1/users/${(created.body as { id: string }).id}`)
        .expect(200);
    });
  });
});
