/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { HttpException, HttpStatus } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { AuditService } from '../audit/audit.service';
import {
  AuthService,
  PIN_MAX_FAILURES,
  PIN_IP_MAX_FAILURES,
} from './auth.service';
import { FailureLockout } from './failure-lockout';

// Real bcrypt, but cheap rounds (the dummy hash is cost 12) and a spy-able compare.
jest.mock('bcrypt', () => {
  const real = jest.requireActual<typeof import('bcrypt')>('bcrypt');
  return {
    ...real,
    hash: (data: string, rounds: number) =>
      real.hash(data, Math.min(rounds, 4)),
    compare: jest.fn((a: string, b: string) => real.compare(a, b)),
  };
});

const PIN = '4821';
let pinHash: string;

beforeAll(async () => {
  pinHash = await bcrypt.hash(PIN, 4);
});

function makeUser(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    restaurantId: 'r1',
    name: 'Asha',
    roleId: 'role1',
    isActive: true,
    pinHash,
    twoFactorEnabled: false,
    role: { name: 'WAITER', permissions: [] },
    permissionOverrides: [],
    ...over,
  };
}

function setup(user: ReturnType<typeof makeUser> | null = makeUser()) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('token-1') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new AuthService(
    prisma as never,
    jwt as never,
    {} as never,
    audit as unknown as AuditService,
  );
  return { svc, prisma, jwt, audit };
}

function statusOf(err: unknown): number | undefined {
  return err instanceof HttpException ? err.getStatus() : undefined;
}

async function attempt(
  svc: AuthService,
  pin: string,
  ip = '10.0.0.1',
  userId = 'u1',
) {
  try {
    return { ok: await svc.pinLogin({ userId, pin }, ip) };
  } catch (err) {
    return { err, status: statusOf(err) };
  }
}

describe('AuthService.pinLogin', () => {
  it('issues a session for the right PIN and audits the success', async () => {
    const { svc, audit } = setup();
    const res = await attempt(svc, PIN);
    expect(res.ok?.token).toBe('token-1');
    expect(res.ok?.user.id).toBe('u1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'auth.pin_login.success',
        entity: 'User',
        entityId: 'u1',
      }),
    );
  });

  it('rejects a wrong PIN with 401 and audits the failure without the PIN', async () => {
    const { svc, audit } = setup();
    const res = await attempt(svc, '0000');
    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    const call = audit.record.mock.calls[0][0];
    expect(call.action).toBe('auth.pin_login.failure');
    expect(call.userId).toBe('u1');
    const dumped = JSON.stringify(audit.record.mock.calls);
    expect(dumped).not.toContain('0000');
    expect(dumped).not.toContain(pinHash);
  });

  it(`locks the user (423) after ${PIN_MAX_FAILURES} bad PINs, even for the right PIN`, async () => {
    const { svc, audit } = setup();
    for (let i = 0; i < PIN_MAX_FAILURES; i++) {
      // Different IPs, so only the per-user lock can be what stops it.
      expect((await attempt(svc, '0000', `10.0.1.${i}`)).status).toBe(401);
    }
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.pin_login.locked',
        userId: 'u1',
      }),
    );
    const locked = await attempt(svc, PIN, '10.0.2.1');
    expect(locked.status).toBe(HttpStatus.LOCKED);
    expect(locked.ok).toBeUndefined();
  });

  it('a lock expires after the lock window', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-03T12:00:00Z') });
    try {
      const { svc } = setup();
      for (let i = 0; i < PIN_MAX_FAILURES; i++) await attempt(svc, '0000');
      expect((await attempt(svc, PIN, '10.0.3.1')).status).toBe(423);
      jest.setSystemTime(new Date('2026-11-03T12:16:00Z'));
      expect((await attempt(svc, PIN, '10.0.3.1')).ok?.token).toBe('token-1');
    } finally {
      jest.useRealTimers();
    }
  });

  it('resets the failure count on success', async () => {
    const { svc } = setup();
    for (let i = 0; i < PIN_MAX_FAILURES - 1; i++) await attempt(svc, '0000');
    expect((await attempt(svc, PIN)).ok).toBeDefined();
    for (let i = 0; i < PIN_MAX_FAILURES - 1; i++) {
      expect((await attempt(svc, '0000')).status).toBe(401);
    }
    expect((await attempt(svc, PIN)).ok).toBeDefined();
  });

  it('treats an unknown user like a wrong PIN: same 401 and message, still bcrypt-compares', async () => {
    const known = setup();
    const wrong = await attempt(known.svc, '0000');
    const unknown = setup(null);
    const compare = bcrypt.compare as unknown as jest.Mock;
    compare.mockClear();
    const res = await attempt(unknown.svc, '0000', '10.0.0.1', 'nobody');
    expect(compare).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(401);
    expect((res.err as Error).message).toBe((wrong.err as Error).message);
    expect(unknown.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.pin_login.failure',
        userId: null,
      }),
    );
  });

  it('gives inactive and PIN-less users the same generic 401', async () => {
    const wrong = await attempt(setup().svc, '0000');
    for (const u of [
      makeUser({ isActive: false }),
      makeUser({ pinHash: null }),
    ]) {
      const res = await attempt(setup(u).svc, PIN);
      expect(res.status).toBe(401);
      expect((res.err as Error).message).toBe((wrong.err as Error).message);
    }
  });

  it('locks unknown user IDs too, so lockout does not reveal which IDs exist', async () => {
    const { svc } = setup(null);
    for (let i = 0; i < PIN_MAX_FAILURES; i++) {
      await attempt(svc, '0000', `10.0.4.${i}`, 'ghost');
    }
    expect((await attempt(svc, '0000', '10.0.5.1', 'ghost')).status).toBe(423);
  });

  it(`blocks an IP (429) after ${PIN_IP_MAX_FAILURES} failures across many users`, async () => {
    const { svc } = setup(null);
    for (let i = 0; i < PIN_IP_MAX_FAILURES; i++) {
      await attempt(svc, '0000', '10.9.9.9', `user-${i}`);
    }
    const res = await attempt(svc, PIN, '10.9.9.9', 'fresh-user');
    expect(res.status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // Another address is unaffected.
    expect((await attempt(svc, '0000', '10.9.9.8', 'fresh-user')).status).toBe(
      401,
    );
  });

  it('only reveals the two-factor block once the PIN is right', async () => {
    const u = makeUser({ twoFactorEnabled: true });
    const bad = await attempt(setup(u).svc, '0000');
    expect((bad.err as Error).message).not.toMatch(/two-factor/i);
    const good = await attempt(setup(u).svc, PIN);
    expect(good.status).toBe(401);
    expect((good.err as Error).message).toMatch(/two-factor/i);
    expect(good.ok).toBeUndefined();
  });
});

describe('FailureLockout', () => {
  it('locks at max failures and reports seconds left', () => {
    const l = new FailureLockout(3, 60_000);
    expect(l.fail('k', 0)).toBe(false);
    expect(l.fail('k', 1)).toBe(false);
    expect(l.fail('k', 2)).toBe(true);
    expect(l.lockedFor('k', 1_000)).toBe(60);
    expect(l.lockedFor('k', 60_002)).toBe(0);
  });

  it('forgets old failures outside the window', () => {
    const l = new FailureLockout(3, 60_000);
    l.fail('k', 0);
    l.fail('k', 1);
    expect(l.fail('k', 70_000)).toBe(false);
    expect(l.lockedFor('k', 70_001)).toBe(0);
  });
});
