import { authLink, publicBaseUrl } from './public-url';

describe('publicBaseUrl', () => {
  it('accepts an http(s) origin with an optional path, trimming slashes', () => {
    expect(publicBaseUrl('https://pos.mycafe.com/')).toBe(
      'https://pos.mycafe.com',
    );
    expect(publicBaseUrl(' http://10.0.0.5:1995 ')).toBe(
      'http://10.0.0.5:1995',
    );
    expect(publicBaseUrl('https://example.com/pos//')).toBe(
      'https://example.com/pos',
    );
  });

  it('is null when unset or not a plain http(s) URL', () => {
    for (const bad of [
      undefined,
      '',
      '   ',
      'pos.mycafe.com',
      'javascript:alert(1)',
      'ftp://x.com',
      'https://user:pw@x.com',
      'https://x.com/?q=1',
      'https://x.com/#frag',
    ]) {
      expect(publicBaseUrl(bad)).toBeNull();
    }
  });
});

describe('authLink', () => {
  it('puts the token in the fragment, so it never reaches server logs', () => {
    expect(authLink('https://pos.x.com', '/reset-password', 'abc.def')).toBe(
      'https://pos.x.com/reset-password#token=abc.def',
    );
  });
});
