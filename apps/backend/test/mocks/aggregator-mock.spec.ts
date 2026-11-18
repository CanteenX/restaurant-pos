import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { signAggregatorBody } from '../../src/integration-hub/aggregator-orders.service';
import { AggregatorMock, signBody } from './aggregator-mock';

const API_KEY = 'key_test';
const SECRET = 'whsec_0123456789abcdef';

describe('AggregatorMock', () => {
  let mock: AggregatorMock;
  let base: string;

  beforeEach(async () => {
    mock = new AggregatorMock({ apiKey: API_KEY, webhookSecret: SECRET });
    base = await mock.start();
  });
  afterEach(() => mock.stop());

  const call = (
    method: string,
    path: string,
    body?: unknown,
    o: {
      key?: string | null;
      secret?: string;
      idem?: string;
      ts?: string;
    } = {},
  ) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = o.ts ?? String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-OrderRestro-Timestamp': ts,
      'X-OrderRestro-Signature': signAggregatorBody(
        o.secret ?? SECRET,
        ts,
        raw,
      ),
    };
    if (o.key !== null) headers.Authorization = `Bearer ${o.key ?? API_KEY}`;
    if (o.idem) headers['Idempotency-Key'] = o.idem;
    return fetch(base + path, {
      method,
      headers,
      body: raw || undefined,
      signal: AbortSignal.timeout(2000),
    });
  };

  it('signs exactly like the POS (signAggregatorBody)', () => {
    expect(signBody('s', '1700000000', '{"a":1}')).toBe(
      signAggregatorBody('s', '1700000000', '{"a":1}'),
    );
  });

  it('GET /v1/ping answers 200 with the key and 401 without', async () => {
    expect((await call('GET', '/v1/ping')).status).toBe(200);
    expect(
      (await call('GET', '/v1/ping', undefined, { key: 'bad' })).status,
    ).toBe(401);
    expect(
      (await call('GET', '/v1/ping', undefined, { key: null })).status,
    ).toBe(401);
  });

  it('accepts accept/reject/ready/status calls and records them', async () => {
    for (const status of ['ACCEPTED', 'READY', 'DELIVERED']) {
      const res = await call('POST', '/v1/orders/zc-1/status', {
        status,
        at: new Date().toISOString(),
      });
      expect(res.status).toBe(200);
    }
    const rej = await call('POST', '/v1/orders/zc-2/status', {
      status: 'REJECTED',
      reason: 'Closed',
    });
    expect(rej.status).toBe(200);
    expect(mock.orderStatuses('zc-1')).toEqual([
      'ACCEPTED',
      'READY',
      'DELIVERED',
    ]);
    expect(mock.orderStatuses('zc-2')).toEqual(['REJECTED']);
    expect(mock.calls.every((c) => c.signatureValid)).toBe(true);
  });

  it('rejects an unknown status and a bad signature', async () => {
    const bad = await call('POST', '/v1/orders/x/status', { status: 'NOPE' });
    expect(bad.status).toBe(400);
    const sig = await call(
      'POST',
      '/v1/orders/x/status',
      { status: 'READY' },
      { secret: 'wrong-secret-wrong-secret' },
    );
    expect(sig.status).toBe(401);
    expect(mock.orderStatuses('x')).toEqual([]);
  });

  it('replays an Idempotency-Key without applying it twice', async () => {
    const body = { status: 'ACCEPTED' };
    await call('POST', '/v1/orders/zc-9/status', body, { idem: 'k1' });
    const again = await call('POST', '/v1/orders/zc-9/status', body, {
      idem: 'k1',
    });
    expect(again.status).toBe(200);
    expect(mock.orderStatuses('zc-9')).toEqual(['ACCEPTED']);
    expect(mock.calls[1].replayed).toBe(true);
  });

  it('serves a menu endpoint with item availability toggles', async () => {
    const menu = {
      categories: [{ name: 'Mains' }],
      items: [{ externalItemId: 'i1' }],
    };
    expect((await call('PUT', '/v1/menu', menu)).status).toBe(200);
    expect(mock.menu).toEqual(menu);
    const res = await call('POST', '/v1/items/availability', {
      items: [
        { externalItemId: 'i1', available: false },
        { externalItemId: 'i2', available: true },
      ],
    });
    expect(res.status).toBe(200);
    expect(mock.availability).toEqual({ i1: false, i2: true });
    expect(
      (await call('POST', '/v1/items/availability', { items: 'x' })).status,
    ).toBe(400);
  });

  it('simulates failures: 500, 401, 429 (with Retry-After), then recovers', async () => {
    mock.failNext('500');
    expect((await call('GET', '/v1/ping')).status).toBe(500);
    mock.failNext('401');
    expect((await call('GET', '/v1/ping')).status).toBe(401);
    mock.failNext('429');
    const r = await call('GET', '/v1/ping');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('1');
    expect((await call('GET', '/v1/ping')).status).toBe(200);
  });

  it('failNext can be limited to a path and a count', async () => {
    mock.failNext('500', { times: 2, path: '/v1/menu' });
    expect((await call('GET', '/v1/ping')).status).toBe(200);
    expect((await call('PUT', '/v1/menu', {})).status).toBe(500);
    expect((await call('PUT', '/v1/menu', {})).status).toBe(500);
    expect((await call('PUT', '/v1/menu', {})).status).toBe(200);
  });

  it('simulates a timeout by never answering', async () => {
    mock.failNext('timeout');
    await expect(call('GET', '/v1/ping')).rejects.toBeDefined();
    expect((await call('GET', '/v1/ping')).status).toBe(200);
  });

  describe('pushing signed webhooks to the POS', () => {
    let pos: Server;
    let url: string;
    const got: { headers: Record<string, unknown>; body: string }[] = [];
    let respond = 200;

    beforeEach(async () => {
      got.length = 0;
      respond = 200;
      pos = createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          got.push({ headers: req.headers, body });
          res.statusCode = respond;
          res.end('{}');
        });
      });
      await new Promise<void>((r) => pos.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${(pos.address() as AddressInfo).port}/hook`;
    });
    afterEach(() => new Promise((r) => pos.close(() => r(undefined))));

    const order = (id: string) => ({
      event: 'order.created' as const,
      orderId: id,
      customer: { name: 'Asha', phone: '9876500011' },
      items: [{ name: 'Paneer', quantity: 1 }],
    });

    it('delivers a ping and an order with a valid POS signature', async () => {
      await mock.push(url, { event: 'ping' }, { secret: SECRET });
      const [r] = await mock.push(url, order('A1'), { secret: SECRET });
      expect(r.status).toBe(200);
      expect(got).toHaveLength(2);
      const ts = String(got[1].headers['x-orderrestro-timestamp']);
      expect(got[1].headers['x-orderrestro-signature']).toBe(
        signAggregatorBody(SECRET, ts, got[1].body),
      );
      expect((JSON.parse(got[1].body) as { orderId: string }).orderId).toBe(
        'A1',
      );
    });

    it('can deliver the same event twice (duplicate delivery)', async () => {
      const res = await mock.push(url, order('A2'), {
        secret: SECRET,
        times: 2,
      });
      expect(res).toHaveLength(2);
      expect(got.map((g) => g.body)).toEqual([got[0].body, got[0].body]);
    });

    it('can deliver out of order (cancel before create)', async () => {
      await mock.pushSequence(
        url,
        [order('A3'), { event: 'order.cancelled', orderId: 'A3' }],
        { secret: SECRET, reverse: true },
      );
      expect(
        got.map((g) => (JSON.parse(g.body) as { event: string }).event),
      ).toEqual(['order.cancelled', 'order.created']);
    });

    it('can send a bad signature or a stale timestamp, and reports POS refusals', async () => {
      respond = 401;
      const [bad] = await mock.push(url, order('A4'), {
        secret: SECRET,
        badSignature: true,
      });
      expect(bad.status).toBe(401);
      const ts = String(got[0].headers['x-orderrestro-timestamp']);
      expect(got[0].headers['x-orderrestro-signature']).not.toBe(
        signAggregatorBody(SECRET, ts, got[0].body),
      );
      await mock.push(url, order('A5'), { secret: SECRET, ageSeconds: 3600 });
      const old = Number(got[1].headers['x-orderrestro-timestamp']);
      expect(Date.now() / 1000 - old).toBeGreaterThan(3000);
    });
  });
});
