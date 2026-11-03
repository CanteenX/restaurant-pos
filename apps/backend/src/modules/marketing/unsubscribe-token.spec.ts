import {
  buildUnsubscribeHeaders,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from './unsubscribe-token';

const secret = 'test-secret-test-secret';
const now = Date.UTC(2026, 10, 3);

describe('unsubscribe token', () => {
  it('round-trips the customer id', () => {
    const t = signUnsubscribeToken('cust-1', secret, now);
    expect(verifyUnsubscribeToken(t, secret, now + 1000)).toBe('cust-1');
  });

  it('rejects a forged signature', () => {
    const t = signUnsubscribeToken('cust-1', secret, now);
    const [body] = t.split('.');
    expect(verifyUnsubscribeToken(`${body}.AAAA`, secret, now)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    const t = signUnsubscribeToken('cust-1', 'other-secret-other-secret', now);
    expect(verifyUnsubscribeToken(t, secret, now)).toBeNull();
  });

  it('rejects a tampered customer id', () => {
    const t = signUnsubscribeToken('cust-1', secret, now);
    const forged = signUnsubscribeToken('cust-2', 'x', now).split('.')[0];
    expect(
      verifyUnsubscribeToken(`${forged}.${t.split('.')[1]}`, secret, now),
    ).toBeNull();
  });

  it('rejects an expired token', () => {
    const t = signUnsubscribeToken('cust-1', secret, now);
    const later = now + 400 * 86_400_000;
    expect(verifyUnsubscribeToken(t, secret, later)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyUnsubscribeToken('', secret, now)).toBeNull();
    expect(verifyUnsubscribeToken('abc', secret, now)).toBeNull();
    expect(verifyUnsubscribeToken('a.b.c', secret, now)).toBeNull();
  });
});

describe('buildUnsubscribeHeaders', () => {
  it('builds RFC 8058 headers', () => {
    const h = buildUnsubscribeHeaders(
      'http://x.test/api/v1/public/unsubscribe/tok',
    );
    expect(h['List-Unsubscribe']).toBe(
      '<http://x.test/api/v1/public/unsubscribe/tok>',
    );
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});
