import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  PASSWORD_RESET_TTL_MS,
  PasswordResetService,
  RESET_PER_ACCOUNT_LIMIT,
  RESET_PER_IP_LIMIT,
} from './password-reset.service';
import { emailAccountQuery } from './account-lookup';

const USER = {
  id: 'u1',
  restaurantId: 'r1',
  name: 'Ravi',
  email: 'ravi@example.com',
};
const TOKEN = 'tokid12345.secretsecretsecretsecret';

interface Opts {
  user?: typeof USER | null;
  smtp?: boolean;
  publicUrl?: string | undefined;
  redeemOk?: boolean;
  activeOnRedeem?: boolean;
}

function setup(opts: Opts = {}) {
  const {
    user = USER,
    smtp = true,
    redeemOk = true,
    activeOnRedeem = true,
  } = opts;
  const publicUrl =
    'publicUrl' in opts ? opts.publicUrl : 'https://pos.example.com';
  const tx = {
    user: {
      findFirst: jest
        .fn()
        .mockResolvedValue(activeOnRedeem ? { id: USER.id } : null),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    user: {
      findFirst: jest.fn().mockResolvedValue(user),
      findMany: jest.fn().mockResolvedValue(user ? [user] : []),
    },
    userBranch: { findFirst: jest.fn().mockResolvedValue({ branchId: 'b1' }) },
    branch: { findFirst: jest.fn().mockResolvedValue({ id: 'b0' }) },
  };
  const tokens = {
    issue: jest.fn().mockResolvedValue({ token: TOKEN, expiresAt: new Date() }),
    redeem: jest.fn(
      async (
        _t: string,
        _p: string,
        apply: (tx: unknown, c: unknown) => Promise<unknown>,
      ) =>
        redeemOk
          ? apply(tx, { userId: USER.id, restaurantId: USER.restaurantId })
          : null,
    ),
  };
  const compose = jest.fn((values: Record<string, string>) => ({
    subject: 'Reset your password',
    html: `<a href="${values['reset.url']}">x</a>`,
    text: values['reset.url'],
  }));
  const templates = { forBranchAlways: jest.fn().mockResolvedValue(compose) };
  const email = {
    isConfigured: jest.fn().mockReturnValue(smtp),
    send: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn((k: string) => (k === 'PUBLIC_URL' ? publicUrl : undefined)),
  };
  const sessions = {
    revokeAll: jest.fn().mockResolvedValue(1),
    disconnect: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new PasswordResetService(
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
    templates,
    compose,
    email,
    sessions,
    audit,
  };
}

describe('PasswordResetService', () => {
  let logSpies: jest.SpyInstance[];
  beforeEach(() => {
    logSpies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (m) => jest.spyOn(Logger.prototype, m).mockImplementation(() => {}),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  const logged = () =>
    JSON.stringify(logSpies.flatMap((s) => s.mock.calls as unknown[]));

  describe('isAvailable', () => {
    it('needs SMTP and a valid PUBLIC_URL', () => {
      expect(setup().svc.isAvailable()).toBe(true);
      expect(setup({ smtp: false }).svc.isAvailable()).toBe(false);
      expect(setup({ publicUrl: undefined }).svc.isAvailable()).toBe(false);
      expect(setup({ publicUrl: 'not a url' }).svc.isAvailable()).toBe(false);
    });
  });

  describe('request', () => {
    it('emails a 30-minute link built from PUBLIC_URL, never the request', async () => {
      const t = setup();
      const res = await t.svc.request('Ravi@Example.com ', '1.1.1.1');
      await t.svc.idle();
      expect(res).toEqual({ ok: true });
      expect(t.prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining(emailAccountQuery('Ravi@Example.com ')),
      );
      expect(t.tokens.issue).toHaveBeenCalledWith({
        userId: 'u1',
        restaurantId: 'r1',
        purpose: 'PASSWORD_RESET',
        ttlMs: PASSWORD_RESET_TTL_MS,
      });
      expect(PASSWORD_RESET_TTL_MS).toBe(30 * 60_000);
      expect(t.templates.forBranchAlways).toHaveBeenCalledWith(
        'b1',
        'PASSWORD_RESET',
      );
      expect(t.compose).toHaveBeenCalledWith({
        'user.name': 'Ravi',
        'reset.url': `https://pos.example.com/reset-password#token=${TOKEN}`,
        'reset.expiresIn': '30 minutes',
      });
      expect(t.email.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'ravi@example.com' }),
      );
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          action: 'auth.password_reset.requested',
        }),
      );
    });

    it('resets exactly the one account login resolves (same resolver), naming its restaurant', async () => {
      const t = setup();
      await t.svc.request('ravi@EXAMPLE.com', 'ip');
      await t.svc.idle();
      expect(t.prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining(emailAccountQuery('ravi@example.com')),
      );
      expect(t.prisma.user.findMany).not.toHaveBeenCalled();
      expect(t.tokens.issue).toHaveBeenCalledTimes(1);
      // The branch decides the restaurant named in the email.
      expect(t.templates.forBranchAlways.mock.calls).toEqual([
        ['b1', 'PASSWORD_RESET'],
      ]);
      expect(t.email.send).toHaveBeenCalledTimes(1);
    });

    it('falls back to the restaurant’s first branch for the template', async () => {
      const t = setup();
      t.prisma.userBranch.findFirst.mockResolvedValue(null);
      await t.svc.request(USER.email, 'ip');
      await t.svc.idle();
      expect(t.templates.forBranchAlways).toHaveBeenCalledWith(
        'b0',
        'PASSWORD_RESET',
      );
    });

    it('gives the same answer for an unknown email and sends nothing', async () => {
      const known = setup();
      const unknown = setup({ user: null });
      const a = await known.svc.request(USER.email, 'ip1');
      const b = await unknown.svc.request('nobody@example.com', 'ip2');
      await unknown.svc.idle();
      expect(b).toEqual(a);
      expect(unknown.tokens.issue).not.toHaveBeenCalled();
      expect(unknown.email.send).not.toHaveBeenCalled();
    });

    it('answers before any lookup or SMTP work, so timing does not leak', async () => {
      const t = setup();
      let release!: () => void;
      t.prisma.user.findFirst.mockReturnValue(
        new Promise((r) => {
          release = () => r(USER);
        }),
      );
      await expect(t.svc.request(USER.email, 'ip')).resolves.toEqual({
        ok: true,
      });
      expect(t.email.send).not.toHaveBeenCalled();
      release();
      await t.svc.idle();
      expect(t.email.send).toHaveBeenCalledTimes(1);
    });

    it('gives the same answer when email is not configured, and sends nothing', async () => {
      for (const t of [setup({ smtp: false }), setup({ publicUrl: '' })]) {
        await expect(t.svc.request(USER.email, 'ip')).resolves.toEqual({
          ok: true,
        });
        await t.svc.idle();
        expect(t.prisma.user.findFirst).not.toHaveBeenCalled();
        expect(t.email.send).not.toHaveBeenCalled();
      }
    });

    it('limits per IP with a 429', async () => {
      const t = setup({ user: null });
      for (let i = 0; i < RESET_PER_IP_LIMIT; i++) {
        await t.svc.request(`n${i}@example.com`, '9.9.9.9');
      }
      await expect(
        t.svc.request('another@example.com', '9.9.9.9'),
      ).rejects.toBeInstanceOf(HttpException);
      // Another address is not affected.
      await expect(
        t.svc.request('another@example.com', '8.8.8.8'),
      ).resolves.toEqual({ ok: true });
    });

    it('limits per account silently: same answer, no more emails', async () => {
      const t = setup();
      for (let i = 0; i < RESET_PER_ACCOUNT_LIMIT + 2; i++) {
        await expect(
          t.svc.request(USER.email.toUpperCase(), `10.0.0.${i}`),
        ).resolves.toEqual({ ok: true });
      }
      await t.svc.idle();
      expect(t.email.send).toHaveBeenCalledTimes(RESET_PER_ACCOUNT_LIMIT);
    });

    it('never logs the token, link or recipient, even when SMTP fails', async () => {
      const t = setup();
      t.email.send.mockRejectedValue(
        Object.assign(new Error(`550 rejected ${USER.email}`), {
          name: 'SmtpError',
        }),
      );
      await t.svc.request(USER.email, 'ip');
      await t.svc.idle();
      const out = logged();
      expect(out).toContain('SmtpError');
      expect(out).not.toContain(USER.email);
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain('reset-password');
    });
  });

  describe('confirm', () => {
    it('sets the password, kills every session and audits', async () => {
      const t = setup();
      await expect(t.svc.confirm(TOKEN, 'NewPassword9')).resolves.toEqual({
        ok: true,
      });
      expect(t.tokens.redeem).toHaveBeenCalledWith(
        TOKEN,
        'PASSWORD_RESET',
        expect.any(Function),
      );
      const { data } = t.tx.user.update.mock.calls[0][0] as {
        data: { passwordHash: string };
      };
      expect(await bcrypt.compare('NewPassword9', data.passwordHash)).toBe(
        true,
      );
      // 2FA is kept: an emailed link must not remove the second factor.
      expect(data).not.toHaveProperty('twoFactorEnabled');
      // Sessions end in the SAME transaction as the password change and the
      // token claim; only the live-socket drop happens after the commit.
      expect(data).toHaveProperty('tokenVersion', { increment: 1 });
      expect(t.sessions.revokeAll).not.toHaveBeenCalled();
      expect(t.sessions.disconnect).toHaveBeenCalledWith('u1');
      expect(t.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          action: 'auth.password_reset.completed',
        }),
      );
    });

    it('if the transaction fails, nothing is half-done', async () => {
      const t = setup();
      t.tx.user.update.mockRejectedValue(new Error('pool timeout'));
      await expect(t.svc.confirm(TOKEN, 'NewPassword9')).rejects.toThrow(
        'pool timeout',
      );
      expect(t.sessions.disconnect).not.toHaveBeenCalled();
      expect(t.audit.record).not.toHaveBeenCalled();
    });

    it('rejects an invalid, used or expired token with one generic error', async () => {
      const t = setup({ redeemOk: false });
      await expect(t.svc.confirm(TOKEN, 'NewPassword9')).rejects.toThrow(
        BadRequestException,
      );
      expect(t.sessions.disconnect).not.toHaveBeenCalled();
    });

    it('rejects a deactivated account', async () => {
      const t = setup({ activeOnRedeem: false });
      await expect(t.svc.confirm(TOKEN, 'NewPassword9')).rejects.toThrow(
        BadRequestException,
      );
      expect(t.tx.user.update).not.toHaveBeenCalled();
      expect(t.sessions.disconnect).not.toHaveBeenCalled();
    });

    it('enforces the password policy', async () => {
      const t = setup();
      await expect(t.svc.confirm(TOKEN, 'short')).rejects.toThrow(
        BadRequestException,
      );
      expect(t.tokens.redeem).not.toHaveBeenCalled();
    });
  });
});
