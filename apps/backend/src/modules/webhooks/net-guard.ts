// SSRF protection for webhook targets. A restaurant admin chooses the URL, so
// without this a malicious or compromised admin could make the server call
// internal services (cloud metadata, the database host, other containers).

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

/** Parses any valid IPv6 text form into 16 bytes, or null if malformed. */
function ipv6ToBytes(text: string): number[] | null {
  let addr = text.split('%')[0]; // drop zone id
  const groups: number[] = [];
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split('.').map(Number);
    addr = `${addr.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) groups.push(...head);
  else {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups.push(...head, ...new Array<number>(fill).fill(0), ...rest);
  }
  if (groups.length !== 8) return null;
  return groups.flatMap((g) => [g >> 8, g & 0xff]);
}

/**
 * Returns the dotted IPv4 embedded in ::ffff:0:0/96 (mapped), ::/96
 * (compatible) or 64:ff9b::/96 (NAT64), or null when there is none.
 * "::" and "::1" are not treated as embedded; they are blocked separately.
 */
function embeddedIpv4(b: number[]): string | null {
  const zero = (from: number, to: number) =>
    b.slice(from, to).every((x) => x === 0);
  const v4 = b.slice(12).join('.');
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4;
  if (
    zero(0, 12) &&
    b.slice(12).some((x) => x !== 0) &&
    !(zero(12, 15) && b[15] === 1)
  )
    return v4;
  if (
    b[0] === 0 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    zero(4, 12)
  )
    return v4;
  return null;
}

export function isPrivateAddress(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, ''); // tolerate URL-style [v6] literals
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
    });
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    // IPv4 embedded in IPv6 (mapped, compatible, NAT64) takes the IPv4 rules,
    // whatever textual form (dotted, hex, compressed or expanded) it uses.
    const bytes = ipv6ToBytes(lower);
    if (!bytes) return true; // unparseable: refuse
    const embedded = embeddedIpv4(bytes);
    if (embedded) return isPrivateAddress(embedded);
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^ff/.test(lower)) return true; // multicast
    return false;
  }
  return true; // not an IP at all: refuse
}

export interface WebhookNetOptions {
  allowPrivate: boolean;
  allowInsecure: boolean;
}

export function netOptionsFromEnv(env = process.env): WebhookNetOptions {
  return {
    allowPrivate: env.WEBHOOKS_ALLOW_PRIVATE === 'true',
    allowInsecure: env.WEBHOOKS_ALLOW_INSECURE === 'true',
  };
}

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/**
 * Parses and resolves a webhook URL, refusing non-HTTPS (unless allowed) and
 * any host that resolves to a private address. The returned address is what
 * the request must connect to, so DNS cannot change between this check and
 * the connection (DNS rebinding).
 */
export async function resolveWebhookTarget(
  raw: string,
  opts: WebhookNetOptions,
  resolve: (host: string) => Promise<{ address: string; family: number }[]> = (
    h,
  ) => lookup(h, { all: true }),
): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL');
  }
  if (
    url.protocol !== 'https:' &&
    !(opts.allowInsecure && url.protocol === 'http:')
  )
    throw new Error('Webhook URLs must use https');
  if (url.username || url.password)
    throw new Error('Put credentials in the signature secret, not the URL');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolve(host).catch(() => {
        throw new Error('Could not resolve that host');
      });
  if (addresses.length === 0) throw new Error('Could not resolve that host');
  if (!opts.allowPrivate && addresses.some((a) => isPrivateAddress(a.address)))
    throw new Error('That address points to a private or internal network');

  const first = addresses[0];
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}
