import { needsRefresh, sessionIdleSeconds } from './session';

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
