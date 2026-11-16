import { isPrivateAddress, resolveWebhookTarget } from './net-guard';

const strict = { allowPrivate: false, allowInsecure: false };

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '203.0.113.9',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows public %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('refuses things that are not IPs', () =>
    expect(isPrivateAddress('example.com')).toBe(true));
});

describe('resolveWebhookTarget', () => {
  const publicDns = () =>
    Promise.resolve([{ address: '203.0.113.9', family: 4 }]);

  it('accepts an https URL on a public host and pins the address', async () => {
    const t = await resolveWebhookTarget(
      'https://hooks.example.com/in',
      strict,
      publicDns,
    );
    expect(t.address).toBe('203.0.113.9');
    expect(t.url.hostname).toBe('hooks.example.com');
  });

  it('rejects http unless explicitly allowed', async () => {
    await expect(
      resolveWebhookTarget('http://hooks.example.com', strict, publicDns),
    ).rejects.toThrow(/https/);
    await expect(
      resolveWebhookTarget(
        'http://hooks.example.com',
        { ...strict, allowInsecure: true },
        publicDns,
      ),
    ).resolves.toBeDefined();
  });

  it('rejects a hostname that resolves to an internal address (DNS-based SSRF)', async () => {
    const internal = () =>
      Promise.resolve([{ address: '169.254.169.254', family: 4 }]);
    await expect(
      resolveWebhookTarget('https://evil.example.com', strict, internal),
    ).rejects.toThrow(/private/);
  });

  it('rejects if ANY resolved address is internal', async () => {
    const mixed = () =>
      Promise.resolve([
        { address: '203.0.113.9', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);
    await expect(
      resolveWebhookTarget('https://x.example.com', strict, mixed),
    ).rejects.toThrow(/private/);
  });

  it('rejects literal internal IPs, bracketed IPv6, credentials and junk', async () => {
    await expect(
      resolveWebhookTarget('https://127.0.0.1/x', strict),
    ).rejects.toThrow(/private/);
    await expect(
      resolveWebhookTarget('https://[::1]/x', strict),
    ).rejects.toThrow(/private/);
    await expect(
      resolveWebhookTarget('https://u:p@hooks.example.com', strict, publicDns),
    ).rejects.toThrow(/credentials/);
    await expect(resolveWebhookTarget('not a url', strict)).rejects.toThrow(
      /valid URL/,
    );
    await expect(
      resolveWebhookTarget('ftp://hooks.example.com', strict, publicDns),
    ).rejects.toThrow(/https/);
  });

  it('allows private targets only when the operator opts in (self-hosted LAN)', async () => {
    await expect(
      resolveWebhookTarget('http://192.168.1.50:5678/hook', {
        allowPrivate: true,
        allowInsecure: true,
      }),
    ).resolves.toMatchObject({ address: '192.168.1.50' });
  });
});

describe('isPrivateAddress: IPv4-mapped and embedded IPv4 in IPv6', () => {
  const targets = {
    '127.0.0.1': ['7f00:1', '7f00:0001'],
    '10.0.0.1': ['a00:1', '0a00:0001'],
    '192.168.1.1': ['c0a8:101', 'c0a8:0101'],
    '169.254.169.254': ['a9fe:a9fe'],
    '0.0.0.0': ['0:0', '0000:0000'],
  };
  const forms: string[] = [];
  for (const [dotted, hexes] of Object.entries(targets)) {
    forms.push(`::ffff:${dotted}`, `0:0:0:0:0:ffff:${dotted}`);
    for (const h of hexes) {
      forms.push(
        `::ffff:${h}`,
        `::FFFF:${h.toUpperCase()}`,
        `[::ffff:${h}]`,
        `0:0:0:0:0:ffff:${h}`,
        `0000:0000:0000:0000:0000:ffff:${h}`,
        `::0:ffff:${h}`,
      );
    }
  }
  it.each(forms)('blocks mapped form %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each([
    '::7f00:1',
    '::a00:1',
    '::c0a8:101',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
  ])('blocks IPv4-compatible / NAT64 form of a private address %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(true),
  );

  it.each([
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '[::ffff:808:808]',
    '0:0:0:0:0:ffff:0808:0808',
    '::ffff:101:101',
  ])('allows public mapped form %s', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );

  it('still allows an ordinary public IPv6 address', () =>
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false));

  it('blocks a URL host that uses a hex mapped loopback', async () => {
    await expect(
      resolveWebhookTarget('https://[::ffff:7f00:1]/hook', strict, () =>
        Promise.resolve([{ address: '1.1.1.1', family: 4 }]),
      ),
    ).rejects.toThrow(/private/);
  });

  it('blocks a DNS answer that is a hex mapped metadata address', async () => {
    await expect(
      resolveWebhookTarget('https://hook.example.com/', strict, () =>
        Promise.resolve([{ address: '::ffff:a9fe:a9fe', family: 6 }]),
      ),
    ).rejects.toThrow(/private/);
  });
});
