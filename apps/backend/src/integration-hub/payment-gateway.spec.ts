import { Prisma } from '@prisma/client';
import {
  GatewayError,
  fromMinorUnits,
  mapGatewayError,
  nextAttemptStatus,
  settlementRequest,
  toMinorUnits,
} from './payments/payment-gateway';
import {
  MOCK_DECLINE_PAISE,
  MOCK_NETWORK_ERROR_PAISE,
  MockPaymentGateway,
  signMockWebhook,
} from './payments/mock-gateway';
import type { ProviderContext } from './providers/provider';

const SECRET = 'mock_secret_0123456789';
const ctx: ProviderContext = {
  restaurantId: 'r1',
  externalAccountId: null,
  credentials: { webhookSecret: SECRET },
};
const intent = (over: Partial<{ key: string; minor: number }> = {}) => ({
  attemptId: 'att_1',
  idempotencyKey: over.key ?? 'idem-key-1',
  amountMinor: over.minor ?? 25_050,
  currency: 'INR',
  method: 'UPI' as const,
  description: 'Order #12',
});

describe('money at the gateway boundary', () => {
  it('converts Decimal rupees to integer paise and back without float drift', () => {
    expect(toMinorUnits(new Prisma.Decimal('250.50'))).toBe(25_050);
    expect(toMinorUnits(new Prisma.Decimal('0.29'))).toBe(29); // 0.29*100 = 28.999… as a float
    expect(fromMinorUnits(25_050).toString()).toBe('250.5');
    expect(fromMinorUnits(29).equals(new Prisma.Decimal('0.29'))).toBe(true);
  });

  it('refuses zero, negative and sub-paisa amounts', () => {
    expect(() => toMinorUnits(new Prisma.Decimal(0))).toThrow(GatewayError);
    expect(() => toMinorUnits(new Prisma.Decimal(-1))).toThrow(GatewayError);
    expect(() => toMinorUnits(new Prisma.Decimal('1.005'))).toThrow(
      GatewayError,
    );
    expect(() => fromMinorUnits(1.5)).toThrow(GatewayError);
  });
});

describe('MockPaymentGateway lifecycle', () => {
  let gw: MockPaymentGateway;
  beforeEach(() => {
    gw = new MockPaymentGateway();
  });

  it('declares itself a PAYMENT provider with a webhook secret', () => {
    expect(gw.category).toBe('PAYMENT');
    expect(gw.capabilities.webhooks).toBe(true);
    expect(gw.credentialFields.map((f) => f.key)).toEqual(['webhookSecret']);
  });

  it('creates a pending payment, then reports it succeeded once confirmed', async () => {
    const created = await gw.createPayment(ctx, intent());
    expect(created.status).toBe('PENDING');
    expect(created.externalId).toMatch(/^mock_pay_[0-9a-f]{16}$/);
    expect(created.amountMinor).toBe(25_050);
    expect(created.action.type).toBe('UPI_INTENT');
    expect(created.action.value).toContain('am=250.50');

    expect((await gw.fetchStatus(ctx, created.externalId)).status).toBe(
      'PENDING',
    );
    gw.simulate(created.externalId, 'SUCCEEDED');
    const s = await gw.fetchStatus(ctx, created.externalId);
    expect(s).toMatchObject({ status: 'SUCCEEDED', amountMinor: 25_050 });
  });

  it('is deterministic: the same idempotency key gives the same payment', async () => {
    const a = await gw.createPayment(ctx, intent());
    const b = await gw.createPayment(ctx, intent());
    expect(b.externalId).toBe(a.externalId);
    expect(new MockPaymentGateway().externalIdFor('idem-key-1')).toBe(
      a.externalId,
    );
    const c = await gw.createPayment(ctx, intent({ key: 'idem-key-2' }));
    expect(c.externalId).not.toBe(a.externalId);
  });

  it('refuses reusing an idempotency key for a different amount', async () => {
    await gw.createPayment(ctx, intent());
    await expect(
      gw.createPayment(ctx, intent({ minor: 100 })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
  });

  it('maps a declined and a network failure to stable codes', async () => {
    await expect(
      gw.createPayment(
        ctx,
        intent({ key: 'decline-1', minor: MOCK_DECLINE_PAISE }),
      ),
    ).rejects.toMatchObject({ code: 'DECLINED', retryable: false });
    await expect(
      gw.createPayment(
        ctx,
        intent({ key: 'net-1', minor: MOCK_NETWORK_ERROR_PAISE }),
      ),
    ).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
    await expect(gw.fetchStatus(ctx, 'mock_pay_unknown')).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });

  it('verifies a signed webhook and rejects a forged or tampered one', async () => {
    const p = await gw.createPayment(ctx, intent());
    const raw = JSON.stringify({
      externalId: p.externalId,
      status: 'SUCCEEDED',
    });
    const ev = await gw.verifyWebhook(
      ctx,
      { 'x-mock-signature': signMockWebhook(SECRET, raw) },
      raw,
    );
    expect(ev).toEqual({
      externalId: p.externalId,
      status: 'SUCCEEDED',
      amountMinor: 25_050,
    });
    await expect(
      gw.verifyWebhook(ctx, { 'x-mock-signature': 'sha256=00' }, raw),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(
      gw.verifyWebhook(
        ctx,
        { 'x-mock-signature': signMockWebhook(SECRET, raw) },
        raw.replace('SUCCEEDED', 'FAILED'),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(
      gw.verifyWebhook({ ...ctx, credentials: {} }, {}, raw),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('refunds only a succeeded payment and never more than was paid', async () => {
    const p = await gw.createPayment(ctx, intent());
    await expect(
      gw.refund(ctx, {
        externalId: p.externalId,
        amountMinor: 100,
        idempotencyKey: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    gw.simulate(p.externalId, 'SUCCEEDED');
    await expect(
      gw.refund(ctx, {
        externalId: p.externalId,
        amountMinor: 25_051,
        idempotencyKey: 'r2',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const r = await gw.refund(ctx, {
      externalId: p.externalId,
      amountMinor: 5_000,
      idempotencyKey: 'r3',
    });
    expect(r).toMatchObject({ status: 'SUCCEEDED', amountMinor: 5_000 });
    // A retried refund with the same key is the same refund, not a second one.
    const again = await gw.refund(ctx, {
      externalId: p.externalId,
      amountMinor: 5_000,
      idempotencyKey: 'r3',
    });
    expect(again.externalRefundId).toBe(r.externalRefundId);
    await expect(
      gw.refund(ctx, {
        externalId: p.externalId,
        amountMinor: 20_051,
        idempotencyKey: 'r4',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('mapGatewayError', () => {
  it('passes a GatewayError through unchanged', () => {
    const e = new GatewayError('DECLINED', 'Card declined', false);
    expect(mapGatewayError(e)).toBe(e);
  });

  it('treats socket and timeout errors as retryable network failures', () => {
    for (const code of [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'EAI_AGAIN',
    ]) {
      const err = Object.assign(new Error('boom'), { code });
      expect(mapGatewayError(err)).toMatchObject({
        code: 'NETWORK',
        retryable: true,
      });
    }
  });

  it('maps anything else to UNKNOWN without leaking its message', () => {
    const mapped = mapGatewayError(new Error('secret=abc internal stack'));
    expect(mapped).toMatchObject({ code: 'UNKNOWN', retryable: false });
    expect(mapped.message).not.toContain('secret');
    expect(mapGatewayError('weird')).toMatchObject({ code: 'UNKNOWN' });
  });
});

describe('nextAttemptStatus', () => {
  it('moves forward from an open attempt', () => {
    expect(nextAttemptStatus('CREATED', 'PENDING')).toBe('PENDING');
    expect(nextAttemptStatus('PENDING', 'SUCCEEDED')).toBe('SUCCEEDED');
    expect(nextAttemptStatus('PENDING', 'FAILED')).toBe('FAILED');
  });

  it('never leaves SUCCEEDED and ignores a repeat', () => {
    expect(nextAttemptStatus('SUCCEEDED', 'SUCCEEDED')).toBeNull();
    expect(nextAttemptStatus('SUCCEEDED', 'FAILED')).toBeNull();
    expect(nextAttemptStatus('SUCCEEDED', 'PENDING')).toBeNull();
  });

  it('accepts a late success after a failure (the money was taken)', () => {
    expect(nextAttemptStatus('FAILED', 'SUCCEEDED')).toBe('SUCCEEDED');
    expect(nextAttemptStatus('EXPIRED', 'SUCCEEDED')).toBe('SUCCEEDED');
    expect(nextAttemptStatus('FAILED', 'PENDING')).toBeNull();
  });
});

describe('settlementRequest', () => {
  it('builds one checkout payment keyed on the attempt, so settling twice is a replay', () => {
    const req = settlementRequest({
      id: 'clx123attempt',
      provider: 'mock-gateway',
      method: 'UPI',
      amount: new Prisma.Decimal('250.50'),
      externalId: 'mock_pay_abc',
    });
    expect(req).toEqual({
      requestId: 'gw_clx123attempt',
      allowPartial: true,
      payments: [
        {
          method: 'UPI',
          amount: 250.5,
          reference: 'mock-gateway:mock_pay_abc',
        },
      ],
    });
  });
});
