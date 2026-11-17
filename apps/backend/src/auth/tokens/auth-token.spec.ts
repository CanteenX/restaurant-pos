import { createHash } from 'crypto';
import {
  AUTH_TOKEN_SECRET_BYTES,
  hashSecret,
  newTokenSecret,
  parseLinkToken,
  secretMatches,
  toLinkToken,
} from './auth-token';

describe('auth-token helpers', () => {
  it('makes a 32-byte random secret, base64url encoded', () => {
    const a = newTokenSecret();
    const b = newTokenSecret();
    expect(AUTH_TOKEN_SECRET_BYTES).toBe(32);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('stores only a SHA-256 hex hash of the secret', () => {
    const secret = newTokenSecret();
    const hash = hashSecret(secret);
    expect(hash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(hash).not.toContain(secret);
  });

  it('round-trips <id>.<secret> and rejects malformed tokens', () => {
    expect(parseLinkToken(toLinkToken('ckabc123', 'S3cr_et-'))).toEqual({
      id: 'ckabc123',
      secret: 'S3cr_et-',
    });
    for (const bad of ['', 'nodot', '.secret', 'id.', 'a.b.c', 'id.sec ret']) {
      expect(parseLinkToken(bad)).toBeNull();
    }
  });

  it('compares hashes in constant time and fails safely on bad input', () => {
    const secret = newTokenSecret();
    const hash = hashSecret(secret);
    expect(secretMatches(secret, hash)).toBe(true);
    expect(secretMatches(newTokenSecret(), hash)).toBe(false);
    expect(secretMatches(secret, 'short')).toBe(false);
    expect(secretMatches(secret, '')).toBe(false);
  });
});
