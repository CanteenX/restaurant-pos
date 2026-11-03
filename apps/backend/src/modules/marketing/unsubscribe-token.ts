import { createHmac, timingSafeEqual } from 'crypto';

/** Unsubscribe links stay valid for a year. */
export const UNSUBSCRIBE_TTL_MS = 365 * 86_400_000;

const mac = (body: string, secret: string) =>
  createHmac('sha256', `unsubscribe:${secret}`)
    .update(body)
    .digest('base64url');

/** `<base64url(customerId:expiryMs)>.<hmac>` — stateless, per recipient. */
export function signUnsubscribeToken(
  customerId: string,
  secret: string,
  now = Date.now(),
): string {
  const body = Buffer.from(
    `${customerId}:${now + UNSUBSCRIBE_TTL_MS}`,
  ).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

/** Returns the customer id, or null when the token is forged, malformed or expired. */
export function verifyUnsubscribeToken(
  token: string,
  secret: string,
  now = Date.now(),
): string | null {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  const expected = Buffer.from(mac(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return null;
  const decoded = Buffer.from(body, 'base64url').toString();
  const i = decoded.lastIndexOf(':');
  if (i < 1) return null;
  const expiry = Number(decoded.slice(i + 1));
  if (!Number.isFinite(expiry) || expiry < now) return null;
  return decoded.slice(0, i);
}

export function buildUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
