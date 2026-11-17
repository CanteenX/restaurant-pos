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
import { PasswordResetService } from './../src/auth/password-reset.service';
import { AuthTokensService } from './../src/auth/tokens/auth-tokens.service';
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

  it.each([
    ['email', { email: 'corrected-invite@example.com' }],
    ['password', { password: NEW_PASSWORD }],
    ['activation', { isActive: true }],
    ['disable', { isActive: false }],
  ])(
    'rejects old invite and reset links after administrator %s change',
    async (label, change) => {
      const inv = await invite(A, 'changed-' + label);
      const tokens = app.get(AuthTokensService);
      const reset = await tokens.issue({
        userId: inv.id,
        restaurantId: A.restaurantId,
        purpose: 'PASSWORD_RESET',
        ttlMs: 60_000,
      });
      await A.manager
        .patch('/api/v1/users/' + inv.id)
        .send(change)
        .expect(200);
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: inv.id },
      });
      expect(await tokens.peek(inv.token, 'STAFF_INVITE')).toBeNull();
      expect(await tokens.peek(reset.token, 'PASSWORD_RESET')).toBeNull();
      await http()
        .post('/api/v1/auth/invite/inspect')
        .send({ token: inv.token })
        .expect(400);
      await http()
        .post('/api/v1/auth/invite/accept')
        .send({ token: inv.token, password: 'UnwantedChange9' })
        .expect(400);
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: inv.id },
      });
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(after.isActive).toBe(before.isActive);
      expect(after.email).toBe(before.email);
    },
  );

  it('rejects acceptance when the account was activated without revoking its link', async () => {
    const inv = await invite(A, 'already-active');
    await prisma.user.update({
      where: { id: inv.id },
      data: { isActive: true },
    });
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: inv.id },
    });
    await http()
      .post('/api/v1/auth/invite/accept')
      .send({ token: inv.token, password: NEW_PASSWORD })
      .expect(400);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: inv.id },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it('does not issue a link to a stale address when an administrator corrects it during send', async () => {
    const inv = await invite(A, 'stale-address');
    sent.length = 0;
    const tokens = app.get(AuthTokensService);
    const original = tokens.issue.bind(tokens);
    let release!: () => void;
    let arrived!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const spy = jest
      .spyOn(tokens, 'issue')
      .mockImplementationOnce(async (input) => {
        arrived();
        await paused;
        return original(input);
      });
    const sending = A.manager
      .post('/api/v1/users/' + inv.id + '/invite')
      .then((response) => response);
    try {
      await reached;
      await A.manager
        .patch('/api/v1/users/' + inv.id)
        .send({ email: 'new-recipient-' + tag + '@example.com' })
        .expect(200);
      release();
      expect((await sending).status).toBe(400);
      expect(sent).toHaveLength(0);
      expect(
        await prisma.authToken.count({
          where: { userId: inv.id, usedAt: null },
        }),
      ).toBe(0);
    } finally {
      release();
      await sending;
      spy.mockRestore();
    }
  });

  it('audits explicit reactivation when an administrator re-invites disabled staff', async () => {
    const inv = await invite(A, 'reactivated');
    await http()
      .post('/api/v1/auth/invite/accept')
      .send({ token: inv.token, password: NEW_PASSWORD })
      .expect(200);
    await A.manager
      .patch('/api/v1/users/' + inv.id)
      .send({ isActive: false })
      .expect(200);
    sent.length = 0;
    await A.manager.post('/api/v1/users/' + inv.id + '/invite').expect(201);
    await http()
      .post('/api/v1/auth/invite/accept')
      .send({ token: tokenFrom(sent[0]), password: NEW_PASSWORD })
      .expect(200);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: inv.id, action: 'staff.invite.accepted' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.metadata).toEqual({ isActive: true });
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

  it('allows initial onboarding at equal access while existing-account sends stay stricter', async () => {
    const managerRole = await prisma.role.findFirstOrThrow({
      where: { restaurantId: A.restaurantId, name: 'MANAGER_' + tag },
    });
    const inv = await invite(A, 'new-equal-peer', managerRole.id);
    expect(inv.body.inviteSent).toBe(true);
    await http()
      .post('/api/v1/auth/invite/accept')
      .send({ token: inv.token, password: NEW_PASSWORD })
      .expect(200);
  });

  it('serializes an accepting invite with an administrator credential change', async () => {
    const inv = await invite(A, 'concurrent-admin');
    const tokens = app.get(AuthTokensService);
    const original = tokens.redeem.bind(tokens);
    let release!: () => void;
    let arrived!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const spy = jest
      .spyOn(tokens, 'redeem')
      .mockImplementationOnce((token, purpose, apply) =>
        original(token, purpose, async (tx, claim) => {
          arrived();
          await paused;
          return apply(tx, claim);
        }),
      );
    const accepting = http()
      .post('/api/v1/auth/invite/accept')
      .send({ token: inv.token, password: NEW_PASSWORD })
      .then((response) => response);
    let changing: Promise<request.Response> | undefined;
    try {
      await reached;
      changing = A.manager
        .patch('/api/v1/users/' + inv.id)
        .send({ password: 'AdminControlled9', isActive: false })
        .then((response) => response);
      let blocked = false;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const waiting = await prisma.$queryRaw<{ count: bigint }[]>`
          SELECT count(*) AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query ILIKE '%users%'
        `;
        if (Number(waiting[0].count) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      release();
      expect((await accepting).status).toBe(200);
      expect((await changing).status).toBe(200);
      const final = await prisma.user.findUniqueOrThrow({
        where: { id: inv.id },
      });
      expect(final.isActive).toBe(false);
      expect(await bcrypt.compare('AdminControlled9', final.passwordHash)).toBe(
        true,
      );
      expect(
        await prisma.authToken.count({
          where: { userId: inv.id, usedAt: null },
        }),
      ).toBe(0);
    } finally {
      release();
      await accepting;
      if (changing) await changing;
      spy.mockRestore();
    }
  }, 15_000);

  it('cannot reset an equal-access peer by disabling, changing email and re-inviting', async () => {
    const managerRole = await prisma.role.findFirstOrThrow({
      where: { restaurantId: A.restaurantId, name: 'MANAGER_' + tag },
    });
    const response = await A.manager
      .post('/api/v1/users')
      .send({
        name: 'Equal access peer',
        email: 'peer-' + tag + '@example.com',
        password: NEW_PASSWORD,
        roleId: managerRole.id,
        branchIds: [A.branchId],
      })
      .expect(201);
    const id = (response.body as { id: string }).id;
    await A.manager
      .patch('/api/v1/users/' + id)
      .send({ isActive: false })
      .expect(200);
    await A.manager
      .patch('/api/v1/users/' + id)
      .send({ email: 'replacement-peer-' + tag + '@example.com' })
      .expect(403);
    sent.length = 0;
    await A.manager.post('/api/v1/users/' + id + '/invite').expect(403);
    expect(sent).toHaveLength(0);
    expect(
      await prisma.authToken.count({ where: { userId: id, usedAt: null } }),
    ).toBe(0);
  });

  it('blocks peer email takeover through the password-reset channel (#250)', async () => {
    const managerRole = await prisma.role.findFirstOrThrow({
      where: { restaurantId: A.restaurantId, name: 'MANAGER_' + tag },
    });
    const email = 'email-peer-' + tag + '@example.com';
    const attackerEmail = 'redirected-peer-' + tag + '@example.com';
    const response = await A.manager
      .post('/api/v1/users')
      .send({
        name: 'Email peer',
        email,
        password: NEW_PASSWORD,
        roleId: managerRole.id,
        branchIds: [A.branchId],
      })
      .expect(201);
    const id = (response.body as { id: string }).id;
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    await A.manager
      .patch('/api/v1/users/' + id)
      .send({ name: 'Harmless name edit', email })
      .expect(200);
    await A.manager
      .patch('/api/v1/users/' + id)
      .send({ email: attackerEmail })
      .expect(403);
    sent.length = 0;
    await http()
      .post('/api/v1/auth/password-reset/request')
      .send({ email: attackerEmail })
      .expect(202);
    await app.get(PasswordResetService).idle();
    expect(sent).toHaveLength(0);
    const after = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(after.email).toBe(email);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.name).toBe('Harmless name edit');
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
