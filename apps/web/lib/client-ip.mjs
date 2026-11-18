// Client address for everything behind the web container (#19).
//
// The backend is reachable only through this server's /api and /socket.io
// rewrites, so its TCP peer is always this container. Next's proxy forwards
// an incoming X-Forwarded-For untouched (and only fills it in when absent),
// which would let any LAN client pick the address the login throttler sees.
// This module rewrites the header on every incoming request to the single
// address this server resolved: the TCP peer, or, when WEB_TRUST_PROXY hops
// (e.g. a Cloudflare Tunnel) sit in front, the entry that many hops to the
// left of it. The backend trusts exactly one hop (TRUST_PROXY=1) and so
// reads that address and nothing a client wrote.
//
// Plain JS (no build step): loaded with `node --import` by the Docker image.

export const MAX_HOPS = 5;

/** WEB_TRUST_PROXY: whole number of proxy hops in front of this server, 0-5. */
export function parseHops(value) {
  if (value === undefined || value.trim() === "") return 0;
  if (!/^\d+$/.test(value.trim()) || Number(value) > MAX_HOPS) {
    throw new Error(
      `WEB_TRUST_PROXY must be a whole number of proxy hops (0-${MAX_HOPS}), not "${value}".`,
    );
  }
  return Number(value);
}

/**
 * @param {string | string[] | undefined} forwardedFor incoming X-Forwarded-For
 * @param {string | undefined} peer the TCP peer address
 * @param {number} hops trusted proxies in front of this server
 */
export function resolveClientIp(forwardedFor, peer, hops) {
  const joined = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor ?? "";
  const chain = joined
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  chain.push(peer ?? "");
  return chain[Math.max(0, chain.length - 1 - hops)];
}

const HOOKED = Symbol.for("nventra.clientIpHook");

/** Patches `ServerClass.prototype.emit` so request/upgrade handlers see the rewritten header. */
export function installClientIpHook(ServerClass, hops) {
  const proto = ServerClass.prototype;
  if (proto[HOOKED]) return;
  const emit = proto.emit;
  proto.emit = function (event, req, ...rest) {
    if ((event === "request" || event === "upgrade") && req?.headers) {
      const ip = resolveClientIp(req.headers["x-forwarded-for"], req.socket?.remoteAddress, hops);
      if (ip) req.headers["x-forwarded-for"] = ip;
      else delete req.headers["x-forwarded-for"];
    }
    return emit.call(this, event, req, ...rest);
  };
  proto[HOOKED] = true;
}
