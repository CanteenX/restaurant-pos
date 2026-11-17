import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Single-use emailed link tokens (#224 password reset, #223 staff invite).
 *
 * A link carries `<id>.<secret>`: the row id selects the row and the secret
 * (32 random bytes) is checked against the stored SHA-256 hash in constant
 * time. Only the hash is stored, so a database leak gives no usable links.
 */
export const AUTH_TOKEN_SECRET_BYTES = 32;

export type AuthTokenPurpose = 'PASSWORD_RESET' | 'STAFF_INVITE';

const PART = /^[A-Za-z0-9_-]+$/;

export function newTokenSecret(): string {
  return randomBytes(AUTH_TOKEN_SECRET_BYTES).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function toLinkToken(id: string, secret: string): string {
  return `${id}.${secret}`;
}

export function parseLinkToken(
  token: string,
): { id: string; secret: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [id, secret] = parts;
  if (!PART.test(id) || !PART.test(secret)) return null;
  return { id, secret };
}

/** Constant-time check of `secret` against a stored hex SHA-256 hash. */
export function secretMatches(secret: string, storedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  // Both are fixed-length digests; a length mismatch means a corrupt row.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(actual, expected);
}
