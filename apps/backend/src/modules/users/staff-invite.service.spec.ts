import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  INVITE_RESENDS_PER_USER,
  INVITE_TTL_MS,
  StaffInviteService,
} from './staff-invite.service';

const TOKEN = 'invtok123456.secretsecretsecretsecret';
const role = (name: string, keys: string[]) => ({
  name,
  label: name === 'WAITER' ? 'Waiter' : name,
  permissions: keys.map((key) => ({ permission: { key } })),
});
const target = (over: Record<string, unknown> = {}) => ({
  id: 'u2',
  restaurantId: 'r1',
  name: 'Ravi',
  email: 'ravi@example.com',
  isActive: false,
  role: role('WAITER', ['orders.create']),
  permissionOverrides: [],
  branches: [{ branchId: 'b1' }],
  ...over,
});
const MANAGER = {
  id: 'mgr',
  restaurantId: 'r1',
  roleName: 'MANAGER',
  permissions: ['users.manage', 'orders.create'],
};

function setup(
  opts: {
    found?: unknown;
    smtp?: boolean;
    publicUrl?: string;
    actorKeys?: string[];
    actorActive?: boolean;
  } = {},
) {
  const found = 'found' in opts ? opts.found : target();
  const tx = {
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: 'u2' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  // The acting manager as stored (#229 re-reads the actor, never trusts the
  // session's permission list); any other id is the invite target.
  const managerRow = {
    id: 'mgr',
    isActive: opts.actorActive ?? true,
    role: role('MANAGER', opts.actorKeys ?? MANAGER.permissions),
    permissionOverrides: [],
  };
  const prisma = {
    user: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === 'mgr' ? managerRow : found),
      ),
    },
    restaurant: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Spice Garden' }),
    },
    branch: { findFirst: jest.fn().mockResolvedValue({ id: 'b0' }) },
  };
  const tokens = {
    issue: jest.fn().mockResolvedValue({ token: TOKEN, expiresAt: new Date() }),
    revokeOutstanding: jest.fn().mockResolvedValue(1),
    peek: jest.fn().mockResolvedValue({
      userId: 'u2',
      restaurantId: 'r1',
      expiresAt: new Date(),
      createdById: 'mgr',
    }),
    redeem: jest.fn(
      async (
        _t: string,
        _p: string,
        apply: (tx: unknown, c: unknown) => Promise<unknown>,
      ) => apply(tx, { userId: 'u2', restaurantId: 'r1' }),
    ),
  };
  const compose = jest.fn((v: Record<string, string>) => ({
    subject: 'Invite',
    html: v['invite.url'],
    text: v['invite.url'],
  }));
  const templates = { forBranchAlways: jest.fn().mockResolvedValue(compose) };
  const email = {
    isConfigured: jest.fn().mockReturnValue(opts.smtp ?? true),
    send: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn((k: string) =>
      k === 'PUBLIC_URL'
        ? 'publicUrl' in opts
          ? opts.publicUrl
          : 'https://pos.example.com'
        : undefined,
    ),
  };
  const sessions = {
    revokeAll: jest.fn().mockResolvedValue(1),
    disconnect: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new StaffInviteService(
    prisma as never,
    tokens as never,
    templates as never,
    email as never,
    config as never,
    sessions as never,
    audit as never,
  );
  return {
    svc,
    prisma,
    tx,
    tokens,
    compose,
    templates,
    email,
    sessions,
    audit,
  };
}

describe('StaffInviteService', () => {
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    logs = (['log', 'warn', 'error'] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => {}),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  describe('send', () => {
    it('emails a 72-hour link from PUBLIC_URL and audits without the address', async () => {
      const t = setup();
      await expect(t.svc.send('r1', MANAGER, 'u2')).resolves.toEqual({
        sent: true,
      });
      expect(t.prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u2', restaurantId: 'r1' } }),
      );
      expect(INVITE_TTL_MS).toBe(72 * 60 * 60_000);
      expect(t.tokens.issue).toHaveBeenCalledWith({
        userId: 'u2',
        restaurantId: 'r1',
        purpose: 'STAFF_INVITE',
        ttlMs: INVITE_TTL_MS,
        createdById: 'mgr',
      });
      expect(t.templates.forBranchAlways).toHaveBeenCalledWith(
        'b1',
        'STAFF_INVITE',
      );
      expect(t.compose).toHaveBeenCalledWith({
        'staff.name': 'Ravi',
        'invite.role': 'Waiter',
        'invite.url': `https://pos.example.com/accept-invite#token=${TOKEN}`,
      });
      expect(t.email.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'ravi@example.com' }),
      );
      const auditCall = t.audit.record.mock.calls[0][0] as {
        action: string;
        userId: string;
      };
      expect(auditCall).toEqual(
        expect.objectContaining({ userId: 'mgr', action: 'staff.invite.sent' }),
      );
      expect(JSON.stringify(t.audit.record.mock.calls)).not.toContain(
        'ravi@example.com',
      );
    });

    it('is a 404 for another restaurant’s staff', async () => {
      const t = setup({ found: null });
      await expect(t.svc.send('r1', MANAGER, 'u9')).rejects.toThrow(
        NotFoundException,
      );
      expect(t.tokens.issue).not.toHaveBeenCalled();
    });

    it('enforces the privilege ceiling (#229)', async () => {
      for (const found of [
        target({ role: role('OWNER', []) }),
        target({ role: role('ADMIN', ['settings.manage']) }),
      ]) {
        const t = setup({ found });
        await expect(t.svc.send('r1', MANAGER, 'u2')).rejects.toThrow(
          ForbiddenException,
        );
        expect(t.tokens.issue).not.toHaveBeenCalled();
      }
    });

    it('judges the actor by their stored access, not the session (#229)', async () => {
      // Session still claims orders.create, but the stored role lost it.
      const lost = setup({ actorKeys: ['users.manage'] });
      await expect(lost.svc.send('r1', MANAGER, 'u2')).rejects.toThrow(
        ForbiddenException,
      );
      const disabled = setup({ actorActive: false });
      await expect(disabled.svc.revoke('r1', MANAGER, 'u2')).rejects.toThrow(
        ForbiddenException,
      );
      expect(lost.tokens.issue).not.toHaveBeenCalled();
      expect(disabled.tokens.revokeOutstanding).not.toHaveBeenCalled();
    });

    it('refuses active accounts and accounts without email', async () => {
      await expect(
        setup({ found: target({ isActive: true }) }).svc.send(
          'r1',
          MANAGER,
          'u2',
        ),
      ).rejects.toThrow(ConflictException);
      await expect(
        setup({ found: target({ email: null }) }).svc.send('r1', MANAGER, 'u2'),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses when email or PUBLIC_URL is not set up', async () => {
      for (const t of [setup({ smtp: false }), setup({ publicUrl: '' })]) {
        await expect(t.svc.send('r1', MANAGER, 'u2')).rejects.toThrow(
          BadRequestException,
        );
        expect(t.tokens.issue).not.toHaveBeenCalled();
      }
    });

    it('rate-limits resends per staff member', async () => {
      const t = setup();
      for (let i = 0; i < INVITE_RESENDS_PER_USER; i++) {
        await t.svc.send('r1', MANAGER, 'u2');
      }
      await expect(t.svc.send('r1', MANAGER, 'u2')).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(t.email.send).toHaveBeenCalledTimes(INVITE_RESENDS_PER_USER);
    });

    it('never logs the token, link or address when SMTP fails', async () => {
      const t = setup();
      t.email.send.mockRejectedValue(
        Object.assign(new Error('550 ravi@example.com'), { name: 'SmtpError' }),
      );
      await expect(t.svc.send('r1', MANAGER, 'u2')).rejects.toThrow(
        BadRequestException,
      );
      const out = JSON.stringify(
        logs.flatMap((s) => s.mock.calls as unknown[]),
      );
      expect(out).toContain('SmtpError');
      expect(out).not.toContain('ravi@example.com');
      expect(out).not.toContain(TOKEN);
      // The unsent token must not stay usable.
      expect(t.tokens.revokeOutstanding).toHaveBeenCalledWith(
        'u2',
        'STAFF_INVITE',
      );
    });
  });

  describe('revoke', () => {
    it('drops outstanding invites, within the ceiling, and audits', async () => {
      const t = setup();
      await expect(t.svc.revoke('r1', MANAGER, 'u2')).resolves.toEqual({
        revoked: 1,
      });
      expect(t.tokens.revokeOutstanding).toHaveBeenCalledWith(
        'u2',
        'STAFF_INVITE',
      );
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'staff.invite.revoked' }),
      );
      const owner = setup({ found: target({ role: role('OWNER', []) }) });
      await expect(owner.svc.revoke('r1', MANAGER, 'u2')).rejects.toThrow(
        ForbiddenException,
      );
      expect(owner.tokens.revokeOutstanding).not.toHaveBeenCalled();
    });
  });

  describe('inspect', () => {
    it('shows name, restaurant and role for a valid link only', async () => {
      const t = setup();
      await expect(t.svc.inspect(TOKEN)).resolves.toEqual({
        name: 'Ravi',
        restaurantName: 'Spice Garden',
        roleLabel: 'Waiter',
      });
      t.tokens.peek.mockResolvedValue(null);
      await expect(t.svc.inspect(TOKEN)).rejects.toThrow(BadRequestException);
    });
  });

  describe('accept', () => {
    it('sets the password, activates, ends old sessions and audits', async () => {
      const t = setup();
      await expect(t.svc.accept(TOKEN, 'NewPassword9')).resolves.toEqual({
        ok: true,
      });
      const { data } = t.tx.user.update.mock.calls[0][0] as {
        data: { passwordHash: string; isActive: boolean };
      };
      expect(data.isActive).toBe(true);
      expect(await bcrypt.compare('NewPassword9', data.passwordHash)).toBe(
        true,
      );
      // tokenVersion in the same transaction as password + claim (#244 review).
      expect(data).toHaveProperty('tokenVersion', { increment: 1 });
      expect(t.sessions.revokeAll).not.toHaveBeenCalled();
      expect(t.sessions.disconnect).toHaveBeenCalledWith('u2');
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u2',
          action: 'staff.invite.accepted',
        }),
      );
    });

    it('rejects a bad, used or expired link and a weak password', async () => {
      const t = setup();
      t.tokens.redeem.mockResolvedValue(null);
      await expect(t.svc.accept(TOKEN, 'NewPassword9')).rejects.toThrow(
        BadRequestException,
      );
      await expect(t.svc.accept(TOKEN, 'short')).rejects.toThrow(
        BadRequestException,
      );
      expect(t.sessions.disconnect).not.toHaveBeenCalled();
    });
  });
});
