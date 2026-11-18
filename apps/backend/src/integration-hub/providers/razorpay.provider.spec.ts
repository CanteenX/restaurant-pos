import { GatewayError } from '../payments/payment-gateway';
import type { ProviderContext } from './provider';
import {
  RAZORPAY_DEFAULT_BASE,
  RazorpayGateway,
  razorpayBaseUrl,
  type HttpRequest,
  type HttpResponse,
} from './razorpay.provider';

const KEY_ID = 'rzp_test_AbCdEf123456';
const KEY_SECRET = 'very-secret-key-do-not-leak';
const ctx: ProviderContext = {
  restaurantId: 'r1',
  externalAccountId: null,
  credentials: { keyId: KEY_ID, keySecret: KEY_SECRET },
};
const UPI =
  'upi://pay?ver=01&mode=15&pa=rpy.qrnventra@icici&pn=Nventra&am=250.50&cu=INR';

const intent = (over: Partial<{ minor: number; method: string }> = {}) => ({
  attemptId: 'att_1',
  idempotencyKey: 'idem-key-1',
  amountMinor: over.minor ?? 25_050,
  currency: 'INR',
  method: (over.method ?? 'UPI') as 'UPI',
  description: 'Order #12',
});

/** A scripted HTTP layer: records every request, answers from a queue. */
function fakeHttp(...answers: (HttpResponse | Error)[]) {
  const calls: HttpRequest[] = [];
  const client = (req: HttpRequest) => {
    calls.push(req);
    const a = answers.shift();
    if (!a) return Promise.reject(new Error('unexpected request'));
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  return { calls, client };
}
const json = (status: number, body: unknown): HttpResponse => ({
  status,
  body: JSON.stringify(body),
});
const qr = (over: Record<string, unknown> = {}) => ({
  id: 'qr_HMsVL8HOpbMcjU',
  entity: 'qr_code',
  type: 'upi_qr',
  status: 'active',
  usage: 'single_use',
  fixed_amount: true,
  payment_amount: 25_050,
  payments_amount_received: 0,
  image_url: 'https://rzp.io/i/BWcUVrLp',
  image_content: UPI,
  ...over,
});

async function caught(p: Promise<unknown>): Promise<GatewayError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GatewayError);
    return e as GatewayError;
  }
  throw new Error('expected a GatewayError');
}

describe('RazorpayGateway metadata', () => {
  const gw = new RazorpayGateway();

  it('is a PAYMENT provider with key id, encrypted key secret, no webhooks yet', () => {
    expect(gw.key).toBe('razorpay');
    expect(gw.category).toBe('PAYMENT');
    expect(gw.capabilities.webhooks).toBe(false);
    const fields = Object.fromEntries(
      gw.credentialFields.map((f) => [f.key, f.secret]),
    );
    expect(fields).toEqual({ keyId: false, keySecret: true });
  });

  it('uses the live API by default; RAZORPAY_API_BASE only outside production', () => {
    expect(razorpayBaseUrl({})).toBe(RAZORPAY_DEFAULT_BASE);
    expect(
      razorpayBaseUrl({ RAZORPAY_API_BASE: 'http://localhost:4010/' }),
    ).toBe('http://localhost:4010');
    expect(
      razorpayBaseUrl({
        NODE_ENV: 'production',
        RAZORPAY_API_BASE: 'http://evil.example',
      }),
    ).toBe(RAZORPAY_DEFAULT_BASE);
    expect(razorpayBaseUrl({ RAZORPAY_API_BASE: 'not a url' })).toBe(
      RAZORPAY_DEFAULT_BASE,
    );
  });
});

describe('RazorpayGateway.createPayment (dynamic UPI QR)', () => {
  it('creates a single-use, amount-locked UPI QR with the amount in paise', async () => {
    const http = fakeHttp(json(200, qr()));
    const gw = new RazorpayGateway({
      http: http.client,
      baseUrl: 'http://mock',
      now: () => new Date('2026-11-03T10:00:00Z'),
    });
    const created = await gw.createPayment(ctx, intent());

    expect(http.calls).toHaveLength(1);
    const req = http.calls[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('http://mock/v1/payments/qr_codes');
    expect(req.headers.authorization).toBe(
      `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`,
    );
    expect(req.headers['content-type']).toBe('application/json');
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: 'upi_qr',
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: 25_050,
      description: 'Order #12',
      notes: { attempt_id: 'att_1', idempotency_key: 'idem-key-1' },
    });
    expect(Number.isInteger(body.payment_amount)).toBe(true);
    // close_by is Unix seconds, 15 minutes out.
    expect(body.close_by).toBe(
      Math.floor(Date.parse('2026-11-03T10:15:00Z') / 1000),
    );

    expect(created).toEqual({
      externalId: 'qr_HMsVL8HOpbMcjU',
      status: 'PENDING',
      amountMinor: 25_050,
      action: { type: 'UPI_INTENT', value: UPI },
    });
  });

  it('reports the amount Razorpay locked, so the service can refuse a mismatch', async () => {
    const http = fakeHttp(json(200, qr({ payment_amount: 25_000 })));
    const gw = new RazorpayGateway({ http: http.client });
    expect((await gw.createPayment(ctx, intent())).amountMinor).toBe(25_000);
  });

  it('refuses methods other than UPI without calling Razorpay', async () => {
    const http = fakeHttp();
    const gw = new RazorpayGateway({ http: http.client });
    const err = await caught(gw.createPayment(ctx, intent({ method: 'CARD' })));
    expect(err.code).toBe('INVALID_REQUEST');
    expect(http.calls).toHaveLength(0);
  });

  it('refuses a non-integer or non-positive paise amount', async () => {
    const gw = new RazorpayGateway({ http: fakeHttp().client });
    expect(
      (await caught(gw.createPayment(ctx, intent({ minor: 10.5 })))).code,
    ).toBe('INVALID_REQUEST');
    expect(
      (await caught(gw.createPayment(ctx, intent({ minor: 0 })))).code,
    ).toBe('INVALID_REQUEST');
  });

  it('is AUTH without credentials and never calls out', async () => {
    const http = fakeHttp();
    const gw = new RazorpayGateway({ http: http.client });
    const err = await caught(
      gw.createPayment({ ...ctx, credentials: { keyId: KEY_ID } }, intent()),
    );
    expect(err.code).toBe('AUTH');
    expect(http.calls).toHaveLength(0);
  });

  it('rejects a response without a UPI payload', async () => {
    const gw = new RazorpayGateway({
      http: fakeHttp(json(200, qr({ image_content: 'https://x' }))).client,
    });
    expect((await caught(gw.createPayment(ctx, intent()))).code).toBe(
      'UNKNOWN',
    );
  });

  it.each([
    [400, 'INVALID_REQUEST', false],
    [401, 'AUTH', false],
    [404, 'NOT_FOUND', false],
    [429, 'NETWORK', true],
    [500, 'NETWORK', true],
    [503, 'NETWORK', true],
    [418, 'UNKNOWN', false],
  ] as const)(
    'maps HTTP %i to %s without keeping vendor text',
    async (status, code, retryable) => {
      const vendor = {
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: `leaky vendor text ${KEY_SECRET}`,
        },
      };
      const gw = new RazorpayGateway({
        http: fakeHttp(json(status, vendor)).client,
      });
      const err = await caught(gw.createPayment(ctx, intent()));
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
      expect(err.message).not.toContain('leaky');
    },
  );

  it('maps a transport failure to a retryable NETWORK error', async () => {
    const gw = new RazorpayGateway({
      http: fakeHttp(new Error('socket hang up')).client,
    });
    const err = await caught(gw.createPayment(ctx, intent()));
    expect(err.code).toBe('NETWORK');
    expect(err.retryable).toBe(true);
  });

  it('never puts credentials into an error', async () => {
    for (const status of [400, 401, 500]) {
      const gw = new RazorpayGateway({
        http: fakeHttp(json(status, { error: {} })).client,
      });
      const err = await caught(gw.createPayment(ctx, intent()));
      const dump = `${err.message} ${err.stack ?? ''} ${JSON.stringify(err)}`;
      expect(dump).not.toContain(KEY_SECRET);
      expect(dump).not.toContain(
        Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64'),
      );
    }
  });
});

describe('RazorpayGateway.fetchStatus', () => {
  it('asks for the QR by id and maps active/unpaid to PENDING', async () => {
    const http = fakeHttp(json(200, qr()));
    const gw = new RazorpayGateway({ http: http.client, baseUrl: 'http://m' });
    const r = await gw.fetchStatus(ctx, 'qr_HMsVL8HOpbMcjU');
    expect(http.calls[0].method).toBe('GET');
    expect(http.calls[0].url).toBe(
      'http://m/v1/payments/qr_codes/qr_HMsVL8HOpbMcjU',
    );
    expect(r).toEqual({
      externalId: 'qr_HMsVL8HOpbMcjU',
      status: 'PENDING',
      amountMinor: 25_050,
    });
  });

  it('is SUCCEEDED with the amount actually received once paid', async () => {
    const gw = new RazorpayGateway({
      http: fakeHttp(
        json(200, qr({ status: 'closed', payments_amount_received: 25_050 })),
      ).client,
    });
    expect(await gw.fetchStatus(ctx, 'qr_HMsVL8HOpbMcjU')).toEqual({
      externalId: 'qr_HMsVL8HOpbMcjU',
      status: 'SUCCEEDED',
      amountMinor: 25_050,
    });
  });

  it('reports a short payment as SUCCEEDED with the short amount (service flags it)', async () => {
    const gw = new RazorpayGateway({
      http: fakeHttp(json(200, qr({ payments_amount_received: 100 }))).client,
    });
    const r = await gw.fetchStatus(ctx, 'qr_HMsVL8HOpbMcjU');
    expect(r.status).toBe('SUCCEEDED');
    expect(r.amountMinor).toBe(100);
  });

  it('is EXPIRED when the QR closed unpaid', async () => {
    const gw = new RazorpayGateway({
      http: fakeHttp(
        json(200, qr({ status: 'closed', close_reason: 'on_demand' })),
      ).client,
    });
    expect((await gw.fetchStatus(ctx, 'qr_HMsVL8HOpbMcjU')).status).toBe(
      'EXPIRED',
    );
  });

  it('refuses an id that is not a Razorpay QR id without calling out', async () => {
    const http = fakeHttp();
    const gw = new RazorpayGateway({ http: http.client });
    const err = await caught(gw.fetchStatus(ctx, '../payments/pay_1'));
    expect(err.code).toBe('NOT_FOUND');
    expect(http.calls).toHaveLength(0);
  });
});

describe('RazorpayGateway.testConnection', () => {
  it('is CONNECTED when Razorpay accepts the keys', async () => {
    const http = fakeHttp(json(200, { entity: 'collection', items: [] }));
    const gw = new RazorpayGateway({ http: http.client, baseUrl: 'http://m' });
    const r = await gw.testConnection(ctx);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('CONNECTED');
    expect(http.calls[0].url).toBe('http://m/v1/payments/qr_codes?count=1');
  });

  it('is AUTH_EXPIRED on 401, PENDING_CONFIGURATION without keys, SYNC_ERROR offline', async () => {
    const bad = new RazorpayGateway({ http: fakeHttp(json(401, {})).client });
    expect((await bad.testConnection(ctx)).status).toBe('AUTH_EXPIRED');
    const none = new RazorpayGateway({ http: fakeHttp().client });
    expect(
      (await none.testConnection({ ...ctx, credentials: {} })).status,
    ).toBe('PENDING_CONFIGURATION');
    const off = new RazorpayGateway({
      http: fakeHttp(new Error('ECONNREFUSED')).client,
    });
    const r = await off.testConnection(ctx);
    expect(r.status).toBe('SYNC_ERROR');
    expect(r.message).not.toContain(KEY_SECRET);
  });
});

describe('RazorpayGateway: not yet supported (follow-up issues)', () => {
  it('treats every webhook as unproven until signature checks land', async () => {
    const gw = new RazorpayGateway({ http: fakeHttp().client });
    expect((await caught(gw.verifyWebhook(ctx, {}, '{}'))).code).toBe(
      'INVALID_SIGNATURE',
    );
  });

  it('refuses refunds plainly', async () => {
    const gw = new RazorpayGateway({ http: fakeHttp().client });
    const err = await caught(
      gw.refund(ctx, {
        externalId: 'qr_1',
        amountMinor: 1,
        idempotencyKey: 'k',
      }),
    );
    expect(err.code).toBe('INVALID_REQUEST');
  });
});
