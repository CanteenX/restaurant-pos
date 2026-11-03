// Counts failed attempts per key and locks the key for `lockMs` once it
// reaches `max` failures inside one `lockMs` window. In-memory, like the
// throttler and TwoFactorService: this is a single-process self-hosted
// backend. A restart clears it, which an attacker cannot trigger remotely.
export class FailureLockout {
  private readonly entries = new Map<
    string,
    { count: number; first: number; lockedUntil: number }
  >();

  constructor(
    private readonly max: number,
    private readonly lockMs: number,
  ) {}

  /** Seconds left on the lock, or 0 when the key may try again. */
  lockedFor(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    if (!e || e.lockedUntil <= now) return 0;
    return Math.max(1, Math.ceil((e.lockedUntil - now) / 1000));
  }

  /** Records a failure; returns true when this failure locked the key. */
  fail(key: string, now = Date.now()): boolean {
    if (this.entries.size > 10_000) this.sweep(now);
    let e = this.entries.get(key);
    if (!e || (e.lockedUntil <= now && now - e.first >= this.lockMs)) {
      e = { count: 0, first: now, lockedUntil: 0 };
      this.entries.set(key, e);
    }
    e.count += 1;
    if (e.count >= this.max && e.lockedUntil <= now) {
      e.lockedUntil = now + this.lockMs;
      e.count = 0;
      e.first = now;
      return true;
    }
    return false;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private sweep(now: number) {
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= now && now - e.first >= this.lockMs) {
        this.entries.delete(k);
      }
    }
  }
}
