import {
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
  clearLegacySessionCookie,
  clientSessionConfig,
  isPastMaxLifetime,
  needsRefresh,
  sessionIdleSeconds,
  sessionMaxSeconds,
  sessionStartedAt,
} from './session';

const cfg = (v?: string) => ({ get: () => v }) as never;

describe('sessionIdleSeconds', () => {
  it('defaults to 60 minutes', () => {
    expect(sessionIdleSeconds(cfg())).toBe(3600);
  });
  it('reads SESSION_IDLE_MINUTES', () => {
    expect(sessionIdleSeconds(cfg('15'))).toBe(900);
  });
  it('falls back to the default on junk or non-positive values', () => {
    expect(sessionIdleSeconds(cfg('abc'))).toBe(3600);
    expect(sessionIdleSeconds(cfg('0'))).toBe(3600);
  });
});

describe('needsRefresh', () => {
  const idle = 3600;
  it('is false while more than half the idle window remains', () => {
    expect(needsRefresh(10_000, 10_000 - 3000, idle)).toBe(false);
  });
  it('is true once less than half the idle window remains', () => {
    expect(needsRefresh(10_000, 10_000 - 1000, idle)).toBe(true);
  });
  it('is false when the token has no exp', () => {
    expect(needsRefresh(undefined, 0, idle)).toBe(false);
  });
});

describe('sessionMaxSeconds', () => {
  it('defaults to 12 hours', () => {
    expect(sessionMaxSeconds(cfg())).toBe(12 * 3600);
  });
  it('reads SESSION_MAX_HOURS', () => {
    expect(sessionMaxSeconds(cfg('8'))).toBe(8 * 3600);
  });
  it('falls back to the default on junk or non-positive values', () => {
    expect(sessionMaxSeconds(cfg('x'))).toBe(12 * 3600);
    expect(sessionMaxSeconds(cfg('-1'))).toBe(12 * 3600);
  });
});

describe('sessionStartedAt / isPastMaxLifetime', () => {
  const max = 12 * 3600;
  it('prefers auth_time and falls back to iat for pre-rollout tokens', () => {
    expect(sessionStartedAt({ sub: 'u', auth_time: 100, iat: 500 })).toBe(100);
    expect(sessionStartedAt({ sub: 'u', iat: 500 })).toBe(500);
    expect(sessionStartedAt({ sub: 'u' })).toBeUndefined();
  });
  it('is false inside the cap and true past it', () => {
    const now = 1_000_000;
    expect(
      isPastMaxLifetime({ sub: 'u', auth_time: now - 3600 }, now, max),
    ).toBe(false);
    expect(
      isPastMaxLifetime({ sub: 'u', auth_time: now - 13 * 3600 }, now, max),
    ).toBe(true);
    expect(
      isPastMaxLifetime({ sub: 'u', iat: now - 13 * 3600 }, now, max),
    ).toBe(true);
  });
  it('is false when the token carries no start time (exp still bounds it)', () => {
    expect(isPastMaxLifetime({ sub: 'u' }, 1_000_000, max)).toBe(false);
  });
});

describe('clearLegacySessionCookie (#147)', () => {
  it('is the pre-rebrand name, distinct from the current cookie', () => {
    expect(LEGACY_SESSION_COOKIE).toBe(['nodedr', 'session'].join('_'));
    expect(LEGACY_SESSION_COOKIE).not.toBe(SESSION_COOKIE);
  });

  it('expires the legacy cookie when the request carries it', () => {
    const res = { clearCookie: jest.fn() };
    clearLegacySessionCookie(
      { cookies: { [LEGACY_SESSION_COOKIE]: 'old', [SESSION_COOKIE]: 'cur' } },
      res,
    );
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
    expect(res.clearCookie).toHaveBeenCalledWith(
      LEGACY_SESSION_COOKIE,
      expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
    );
  });

  it('does nothing without the legacy cookie (no extra Set-Cookie)', () => {
    const res = { clearCookie: jest.fn() };
    clearLegacySessionCookie({ cookies: { [SESSION_COOKIE]: 'cur' } }, res);
    clearLegacySessionCookie({}, res);
    expect(res.clearCookie).not.toHaveBeenCalled();
  });
});

describe('clientSessionConfig', () => {
  const env = (vars: Record<string, string>) =>
    ({ get: (k: string) => vars[k] }) as never;
  it('tells the browser the server idle window, signing out by default', () => {
    expect(clientSessionConfig(env({}))).toEqual({
      idleMinutes: 60,
      idleSignOut: true,
    });
    expect(
      clientSessionConfig(env({ SESSION_IDLE_MINUTES: '240' })).idleMinutes,
    ).toBe(240);
  });
  it('lets the operator turn the browser idle sign-out off', () => {
    for (const v of ['false', 'off', '0', 'NO']) {
      expect(
        clientSessionConfig(env({ SESSION_IDLE_SIGNOUT: v })).idleSignOut,
      ).toBe(false);
    }
    expect(
      clientSessionConfig(env({ SESSION_IDLE_SIGNOUT: 'true' })).idleSignOut,
    ).toBe(true);
  });
});
