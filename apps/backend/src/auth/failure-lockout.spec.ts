import { FailureLockout } from './failure-lockout';

const WINDOW = 60_000;

describe('FailureLockout bounded memory (#147)', () => {
  it('never holds more than maxEntries keys, however many unknown ids fail', () => {
    const l = new FailureLockout(3, WINDOW, 100);
    for (let i = 0; i < 5_000; i++) l.fail(`u:unknown-${i}`, i);
    expect(l.size).toBeLessThanOrEqual(100);
  });

  it('evicts the least recently failed key first', () => {
    const l = new FailureLockout(3, WINDOW, 3);
    l.fail('a', 0);
    l.fail('b', 1);
    l.fail('c', 2);
    l.fail('a', 3); // touching `a` makes `b` the oldest
    l.fail('d', 4);
    expect(l.has('b', 5)).toBe(false);
    expect(l.has('a', 5)).toBe(true);
    expect(l.has('c', 5)).toBe(true);
    expect(l.has('d', 5)).toBe(true);
  });

  it('keeps a locked key while unlocked keys can be evicted instead', () => {
    const l = new FailureLockout(2, WINDOW, 3);
    l.fail('victim', 0);
    expect(l.fail('victim', 1)).toBe(true); // locked, and the oldest key
    for (let i = 0; i < 500; i++) l.fail(`flood-${i}`, 10 + i);
    expect(l.lockedFor('victim', 1_000)).toBeGreaterThan(0);
    expect(l.size).toBeLessThanOrEqual(3);
  });

  it('drops expired entries on read (TTL eviction)', () => {
    const l = new FailureLockout(3, WINDOW, 100);
    l.fail('k', 0);
    expect(l.has('k', 1)).toBe(true);
    expect(l.lockedFor('k', WINDOW + 1)).toBe(0);
    expect(l.has('k', WINDOW + 2)).toBe(false);
  });

  it('sweeps expired entries before evicting live ones when full', () => {
    const l = new FailureLockout(3, WINDOW, 3);
    l.fail('old-1', 0);
    l.fail('old-2', 1);
    l.fail('live', WINDOW);
    l.fail('new', WINDOW + 5); // old-1/old-2 have expired, live must stay
    expect(l.has('live', WINDOW + 6)).toBe(true);
    expect(l.has('new', WINDOW + 6)).toBe(true);
    expect(l.size).toBe(2);
  });

  it('keeps the lockout semantics: max failures lock for the window', () => {
    const l = new FailureLockout(3, WINDOW, 10);
    expect(l.fail('k', 0)).toBe(false);
    expect(l.fail('k', 1)).toBe(false);
    expect(l.fail('k', 2)).toBe(true);
    expect(l.lockedFor('k', 1_000)).toBe(60);
    expect(l.lockedFor('k', WINDOW + 2)).toBe(0);
    l.fail('j', 0);
    l.reset('j');
    expect(l.has('j', 1)).toBe(false);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new FailureLockout(3, WINDOW, 0)).toThrow();
  });
});
