// Counts failed attempts per key and locks the key for `lockMs` once it
// reaches `max` failures inside one `lockMs` window. In-memory, like the
// throttler and TwoFactorService: this is a single-process self-hosted
// backend. A restart clears it, which an attacker cannot trigger remotely.
//
// Memory is bounded (#147). Callers record failures for unknown keys too
// (a PIN attempt against a made-up userId must look exactly like one against
// a real user), so the key space is attacker-controlled. Entries expire after
// their window (dropped on read and swept when full), and past `maxEntries`
// the least recently failed key is evicted. Unlocked keys go first, so a
// flood of junk ids cannot push an active lock out of the map.

interface Entry {
  count: number;
  first: number;
  lockedUntil: number;
}

export const DEFAULT_LOCKOUT_MAX_ENTRIES = 10_000;

export class FailureLockout {
  // Map iteration follows insertion order; re-inserting on every failure
  // keeps the least recently failed key first (LRU order).
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly max: number,
    private readonly lockMs: number,
    private readonly maxEntries = DEFAULT_LOCKOUT_MAX_ENTRIES,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('FailureLockout maxEntries must be >= 1');
    }
  }

  /** Number of keys currently tracked. */
  get size(): number {
    return this.entries.size;
  }

  /** True while `key` has a live (unexpired) entry. */
  has(key: string, now = Date.now()): boolean {
    return this.live(key, now) !== undefined;
  }

  /** Seconds left on the lock, or 0 when the key may try again. */
  lockedFor(key: string, now = Date.now()): number {
    const e = this.live(key, now);
    if (!e || e.lockedUntil <= now) return 0;
    return Math.max(1, Math.ceil((e.lockedUntil - now) / 1000));
  }

  /** Records a failure; returns true when this failure locked the key. */
  fail(key: string, now = Date.now()): boolean {
    const prev = this.live(key, now);
    this.entries.delete(key);
    if (!prev) this.makeRoom(now);
    const e = this.next(prev, now);
    this.entries.set(key, e);
    // `next` only resets the count to 0 when this failure starts a lock.
    return e.count === 0;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /** The entry after one more failure; a new object, `prev` is not changed. */
  private next(prev: Entry | undefined, now: number): Entry {
    const base = prev ?? { count: 0, first: now, lockedUntil: 0 };
    const count = base.count + 1;
    if (count >= this.max && base.lockedUntil <= now) {
      return { count: 0, first: now, lockedUntil: now + this.lockMs };
    }
    return { ...base, count };
  }

  /** The entry for `key`, dropping it when its window has passed. */
  private live(key: string, now: number): Entry | undefined {
    const e = this.entries.get(key);
    if (e && this.expired(e, now)) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  private expired(e: Entry, now: number): boolean {
    return e.lockedUntil <= now && now - e.first >= this.lockMs;
  }

  /** Frees one slot for a new key once the map is full. */
  private makeRoom(now: number): void {
    if (this.entries.size < this.maxEntries) return;
    for (const [k, e] of this.entries) {
      if (this.expired(e, now)) this.entries.delete(k);
    }
    if (this.entries.size < this.maxEntries) return;
    this.entries.delete(this.evictionCandidate(now));
  }

  /** Least recently failed unlocked key, else the least recently failed one. */
  private evictionCandidate(now: number): string {
    let oldest: string | undefined;
    for (const [k, e] of this.entries) {
      oldest ??= k;
      if (e.lockedUntil <= now) return k;
    }
    return oldest as string;
  }
}
