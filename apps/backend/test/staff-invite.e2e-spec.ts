// Staff invites (#223): invite, accept, login; expired, reused and revoked
// links rejected; tenant isolation; privilege ceiling; rate-limited resend;
// password-create flow unchanged. Runs against any migrated Postgres;
// creates and removes its own two throw-away restaurants. Email goes to an
// in-memory mock transport.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- staff-invite
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  EmailService,
  type OutgoingEmail,
} from './../src/modules/email/email.service';
import { PrismaService } from './../src/prisma/prisma.service';

const tag = randomUUID().slice(0, 8);
const password = 'Password123!';
const NEW_PASSWORD = 'InvitedPass9';
const PUBLIC_URL = 'https://pos.invite.example';

interface Tenant {
  restaurantId: string;
  branchId: string;
  waiterRoleId: string;
  ownerRoleId: string;
  manager: ReturnType<typeof request.agent>;
}

describe('Staff invites (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const sent: OutgoingEmail[] = [];
  const restaurantIds: string[] = [];
  let A: Tenant;
  let B: Tenant;
  const savedUrl = process.env.PUBLIC_URL;

  const http = () => request(app.getHttpServer());
  const tokenFrom = (mail: OutgoingEmail) => {
    const m = /#token=([A-Za-z0-9_.%-]+)/.exec(mail.text);
    if (!m) throw new Error('no invite link in mail');
    return decodeURIComponent(m[1]);
  };
  const invite = async (t: Tenant, name: string, roleId = t.waiterRoleId) => {
    sent.length = 0;
    const email = `${name}-${tag}@example.com`;
    const res = await t.manager
      .post('/api/v1/users')
      .send({ name, email, invite: true, roleId, branchIds: [t.branchId] })
      .expect(201);
    return {
      id: (res.body as { id: string }).id,
      email,
      body: res.body as { inviteSent: boolean; isActive: boolean },
      token: sent.length ? tokenFrom(sent[0]) : '',
    };
  };

  const makeTenant = async (label: string): Promise<Tenant> => {
    const restaurant = await prisma.restaurant.create({
      data: { name: `${label} Diner ${tag}` },
    });
    restaurantIds.push(restaurant.id);
    const branch = await prisma.branch.create({
      data: { restaurantId: restaurant.id, name: 'Main' },
    });
    const perm = (key: string) =>
      prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, label: key, category: 'Admin' },
      });
    const [manage, orders] = [
      await perm('users.manage'),
      await perm('orders.create'),
    ];
    const mkRole = (name: string, ids: string[]) =>
      prisma.role.create({
        data: {
          restaurantId: restaurant.id,
          name,
          label: name.split('_')[0],
          permissions: {
            create: ids.map((permissionId) => ({ permissionId })),
          },
        },
      });
    const mgrRole = await mkRole(`MANAGER_${tag}`, [manage.id, orders.id]);
    const waiterRole = await mkRole(`WAITER_${tag}`, [orders.id]);
    const ownerRole = await prisma.role.create({
      data: { restaurantId: restaurant.id, name: 'OWNER', label: 'Owner' },
    });
    const email = `mgr-${label.toLowerCase()}-${tag}@example.com`;
    await prisma.user.create({
      data: {
        restaurantId: restaurant.id,
        roleId: mgrRole.id,
        name: 'Manager',
        email,
        passwordHash: await bcrypt.hash(password, 4),
        branches: { create: { branchId: branch.id } },
      },
    });
    const manager = request.agent(app.getHttpServer());
    await manager
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    return {
      restaurantId: restaurant.id,
      branchId: branch.id,
      waiterRoleId: waiterRole.id,
      ownerRoleId: ownerRole.id,
      manager,
    };
  };

  beforeAll(async () => {
    process.env.PUBLIC_URL = PUBLIC_URL;
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
    A = await makeTenant('Alpha');
    B = await makeTenant('Beta');
  });

  afterAll(async () => {
    process.env.PUBLIC_URL = savedUrl;
    for (const id of restaurantIds) {
      await prisma.auditLog.deleteMany({
        where: { user: { restaurantId: id } },
      });
      await prisma.user.deleteMany({ where: { restaurantId: id } });
      await prisma.role.deleteMany({ where: { restaurantId: id } });
      await prisma.restaurant.delete({ where: { id } });
    }
    await app.close();
  });

  it('invite -> accept -> login; the link works once', async () => {
    const inv = await invite(A, 'ravi');
    expect(inv.body).toEqual(
      expect.objectContaining({ inviteSent: true, isActive: false }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(inv.email);
    expect(sent[0].text).toContain(`${PUBLIC_URL}/accept-invite#token=`);

    // Not active yet: no login with any password.
    await http()
      .post('/api/v1/auth/login')
      .send({ email: inv.email, password: NEW_PASSWORD })
      .expect(401);

    // The staff list shows the pending invite.
    const list = await A.manager.get('/api/v1/users').expect(200);
    const row = (
      list.body as { id: string; invitePendingUntil: string | null }[]
    ).find((u) => u.id === inv.id);
    expect(row?.invitePendingUntil).toBeTruthy();

    const info = await http()
      .post('/api/v1/auth/invite/inspect')
      .send({ token: inv.token })
      .expect(200);
    expect(info.body).toEqual({
      name: 'ravi',
      restaurantName: `Alpha Diner ${tag}`,
      roleLabel: 'WAITER',
    });

    await http()
      .post('/api/v1/auth/invite/accept')
      .send({ token: inv.token, password: 'short' })
      .expect(400);
    await http()
      .post('/api/v1/auth/invite/accept')
      .send({ token: inv.token, password: NEW_PASSWORD })
      .expect(200);
    await http()
      .post('/api/v1/auth/login')
      .send({ email: inv.email, password: NEW_PASSWORD })
      .expect(201);

    // Reuse is rejected, for inspect and accept.
    await http()
      .post('/api/v1/auth/invite/inspect')
      .send({ token: inv.token })
      .expect(400);
    await http()
      .post('/api/v1/auth/invite/accept')
      .send({ token: inv.token, password: 'Another999' })
      .expect(400);

    const actions = await prisma.auditLog.findMany({
      where: { entityId: inv.id, action: { startsWith: 'staff.' } },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual([
      'staff.created',
      'staff.invite.accepted',
      'staff.invite.sent',
    ]);
  });

  it('rejects an expired invite', async () => {
    const inv = await invite(A, 'expired');
    await prisma.authToken.updateMany({
      where: { userId: inv.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await http()
      .post('/api/v1/auth/invite/accept')
      .send({ token: inv.token, password: NEW_PASSWORD })
      .expect(400);
  });

  it('resend replaces the link; revoke kills it; resend is rate-limited', async () => {
    const inv = await invite(A, 'resend');
    sent.length = 0;
    await A.manager.post(`/api/v1/users/${inv.id}/invite`).expect(201);
    const fresh = tokenFrom(sent[0]);
    await http()
      .post('/api/v1/auth/invite/inspect')
      .send({ token: inv.token })
      .expect(400);

    await A.manager.delete(`/api/v1/users/${inv.id}/invite`).expect(200);
    await http()
      .post('/api/v1/auth/invite/accept')
      .send({ token: fresh, password: NEW_PASSWORD })
      .expect(400);

    // 3 emails per staff member per hour: the create + 1 resend used 2.
    await A.manager.post(`/api/v1/users/${inv.id}/invite`).expect(201);
    await A.manager.post(`/api/v1/users/${inv.id}/invite`).expect(429);
  });

  it('keeps tenants apart', async () => {
    const inv = await invite(A, 'tenant');
    await B.manager.post(`/api/v1/users/${inv.id}/invite`).expect(404);
    await B.manager.delete(`/api/v1/users/${inv.id}/invite`).expect(404);
    // The A link still works after B's attempts.
    await http()
      .post('/api/v1/auth/invite/inspect')
      .send({ token: inv.token })
      .expect(200);
  });

  it('applies the privilege ceiling (#229)', async () => {
    await A.manager
      .post('/api/v1/users')
      .send({
        name: 'boss',
        email: `boss-${tag}@example.com`,
        invite: true,
        roleId: A.ownerRoleId,
        branchIds: [A.branchId],
      })
      .expect(403);
    const owner = await prisma.user.create({
      data: {
        restaurantId: A.restaurantId,
        roleId: A.ownerRoleId,
        name: 'Pending owner',
        email: `pending-owner-${tag}@example.com`,
        passwordHash: 'x',
        isActive: false,
      },
    });
    await A.manager.post(`/api/v1/users/${owner.id}/invite`).expect(403);
    await A.manager.delete(`/api/v1/users/${owner.id}/invite`).expect(403);
  });

  it('needs an email to invite; the password flow is unchanged', async () => {
    await A.manager
      .post('/api/v1/users')
      .send({
        name: 'nomail',
        invite: true,
        roleId: A.waiterRoleId,
        branchIds: [A.branchId],
      })
      .expect(400);
    sent.length = 0;
    const res = await A.manager
      .post('/api/v1/users')
      .send({
        name: 'pin-only',
        password: 'Password123!',
        roleId: A.waiterRoleId,
        branchIds: [A.branchId],
      })
      .expect(201);
    expect((res.body as { isActive: boolean }).isActive).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
