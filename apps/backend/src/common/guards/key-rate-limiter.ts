// Fixed-window counter keyed by API key id. The app-wide ThrottlerGuard keys
// on the caller's IP, but behind the web container / a Cloudflare Tunnel every
// website request arrives from the same address, so that limit can't tell one
// key (or one visitor) from another. In-memory, like the throttler's default
// storage: this is a single-process self-hosted backend.
export class KeyRateLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  constructor(private readonly windowMs = 60_000) {}

  /** Records a hit; returns seconds to wait when over `limit`, else 0. */
  hit(bucket: string, limit: number, now = Date.now()): number {
    if (this.windows.size > 5_000) this.sweep(now);
    const w = this.windows.get(bucket);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(bucket, { start: now, count: 1 });
      return 0;
    }
    w.count += 1;
    return w.count > limit
      ? Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000))
      : 0;
  }

  private sweep(now: number) {
    for (const [k, w] of this.windows) {
      if (now - w.start >= this.windowMs) this.windows.delete(k);
    }
  }
}

export function envLimit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ONE write budget per integration key, shared by every transport that can
// place orders or bookings with it: the REST guard (any non-GET route) and
// GraphQL mutations. Separate limiters would let a key multiply its write
// rate by switching transports. The limit is read per call so it always
// matches the env the process runs with.
const integrationWrites = new KeyRateLimiter();

/** Charges one write to `keyId`; returns seconds to wait when over, else 0. */
export function hitIntegrationWrite(keyId: string, now = Date.now()): number {
  return integrationWrites.hit(
    `${keyId}:w`,
    envLimit('INTEGRATION_WRITE_LIMIT_PER_MIN', 30),
    now,
  );
}
