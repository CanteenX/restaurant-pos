// How many proxy hops in front of this process may set X-Forwarded-*.
// A number only: `true` or an address list would let any client choose the
// address the per-IP throttler sees. docker-compose.yml defaults it to 1
// because the backend is only reachable through the web container, which
// rewrites X-Forwarded-For to the one client address it resolved
// (apps/web/lib/client-ip.mjs). Unset = ignore forwarded headers.
export const MAX_TRUST_PROXY_HOPS = 5;

export function parseTrustProxy(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const hops = Number(value);
  if (!/^\d+$/.test(value.trim()) || hops > MAX_TRUST_PROXY_HOPS) {
    throw new Error(
      `TRUST_PROXY must be a whole number of proxy hops (0-${MAX_TRUST_PROXY_HOPS}), not "true" or an address list.`,
    );
  }
  return hops;
}

export function applyTrustProxy(
  app: { set(setting: string, value: unknown): unknown },
  value: string | undefined,
): void {
  const hops = parseTrustProxy(value);
  if (hops !== undefined) app.set('trust proxy', hops);
}
