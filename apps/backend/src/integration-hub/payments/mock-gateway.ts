import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  NO_CAPABILITIES,
  type CredentialField,
  type ProviderCapabilities,
  type ProviderContext,
  type TestResult,
} from '../providers/provider';
import {
  GatewayError,
  type CreatePaymentInput,
  type CreatedPayment,
  type GatewayStatus,
  type GatewayWebhookEvent,
  type PaymentGatewayProvider,
  type PaymentStatusResult,
  type RefundInput,
  type RefundResult,
} from './payment-gateway';

/** ₹999.51: the mock declines this amount, like a gateway's test card. */
export const MOCK_DECLINE_PAISE = 99_951;
/** ₹999.52: the mock fails this amount with a network error. */
export const MOCK_NETWORK_ERROR_PAISE = 99_952;

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

export function signMockWebhook(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

const webhookSchema = z.object({
  externalId: z.string().min(1).max(80),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED']),
  amountMinor: z.number().int().positive().optional(),
});

interface MockPayment {
  idempotencyKey: string;
  amountMinor: number;
  status: GatewayStatus;
  refundedMinor: number;
}

const header = (
  h: Record<string, string | string[] | undefined>,
  k: string,
) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * A deterministic, in-memory gateway for tests and demos. It never moves real
 * money and is only registered outside production (or with
 * PAYMENT_GATEWAY_MOCK=1). Payment ids are derived from the idempotency key,
 * so the same key always names the same payment.
 */
export class MockPaymentGateway implements PaymentGatewayProvider {
  readonly key = 'mock-gateway';
  readonly name = 'Mock payment gateway (testing only)';
  readonly category = 'PAYMENT' as const;
  readonly description =
    'Simulated online payments for testing checkout. Never charges anyone.';
  readonly requirements =
    'For development and automated tests only. Not available in production.';
  readonly capabilities: ProviderCapabilities = {
    ...NO_CAPABILITIES,
    webhooks: true,
  };
  readonly credentialFields: CredentialField[] = [
    {
      key: 'webhookSecret',
      label: 'Webhook signing secret',
      secret: true,
      required: true,
      help: 'Any random string of 16+ characters; signs simulated webhooks.',
    },
  ];

  private readonly payments = new Map<string, MockPayment>();
  private readonly refunds = new Map<string, RefundResult>();

  externalIdFor(idempotencyKey: string): string {
    const h = createHash('sha256').update(idempotencyKey).digest('hex');
    return `mock_pay_${h.slice(0, 16)}`;
  }

  testConnection(ctx: ProviderContext): Promise<TestResult> {
    const ok = (ctx.credentials.webhookSecret ?? '').length >= 16;
    return Promise.resolve({
      ok,
      status: ok ? 'CONNECTED' : 'PENDING_CONFIGURATION',
      message: ok
        ? 'Mock gateway ready (no real money moves).'
        : 'Set a webhook signing secret of at least 16 characters.',
    });
  }

  createPayment(
    _ctx: ProviderContext,
    input: CreatePaymentInput,
  ): Promise<CreatedPayment> {
    const externalId = this.externalIdFor(input.idempotencyKey);
    const existing = this.payments.get(externalId);
    if (existing && existing.amountMinor !== input.amountMinor) {
      return Promise.reject(
        new GatewayError(
          'IDEMPOTENCY_CONFLICT',
          'This idempotency key was already used for a different amount',
          false,
        ),
      );
    }
    if (!existing) {
      if (input.amountMinor === MOCK_DECLINE_PAISE) {
        return Promise.reject(
          new GatewayError('DECLINED', 'The payment was declined', false),
        );
      }
      if (input.amountMinor === MOCK_NETWORK_ERROR_PAISE) {
        return Promise.reject(
          new GatewayError('NETWORK', 'Mock gateway timed out', true),
        );
      }
      this.payments.set(externalId, {
        idempotencyKey: input.idempotencyKey,
        amountMinor: input.amountMinor,
        status: 'PENDING',
        refundedMinor: 0,
      });
    }
    const p = this.payments.get(externalId)!;
    const rupees = (input.amountMinor / 100).toFixed(2);
    return Promise.resolve({
      externalId,
      status: p.status,
      amountMinor: p.amountMinor,
      action: {
        type: 'UPI_INTENT',
        value: `upi://pay?pa=mock@nventra&pn=Nventra%20POS&am=${rupees}&cu=${input.currency}&tr=${externalId}`,
      },
    });
  }

  fetchStatus(
    _ctx: ProviderContext,
    externalId: string,
  ): Promise<PaymentStatusResult> {
    const p = this.payments.get(externalId);
    if (!p) {
      return Promise.reject(
        new GatewayError('NOT_FOUND', 'No such payment', false),
      );
    }
    return Promise.resolve({
      externalId,
      status: p.status,
      amountMinor: p.amountMinor,
    });
  }

  /** Test hook: what the guest's bank/app would do. */
  simulate(externalId: string, status: GatewayStatus): void {
    const p = this.payments.get(externalId);
    if (!p) throw new GatewayError('NOT_FOUND', 'No such payment', false);
    p.status = status;
  }

  verifyWebhook(
    ctx: ProviderContext,
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<GatewayWebhookEvent> {
    const deny = () =>
      Promise.reject(
        new GatewayError(
          'INVALID_SIGNATURE',
          'Invalid webhook signature',
          false,
        ),
      );
    const secret = ctx.credentials.webhookSecret;
    const got = header(headers, MOCK_SIGNATURE_HEADER) ?? '';
    if (!secret) return deny();
    const want = signMockWebhook(secret, rawBody);
    if (
      got.length !== want.length ||
      !timingSafeEqual(Buffer.from(got), Buffer.from(want))
    ) {
      return deny();
    }
    let body: z.infer<typeof webhookSchema>;
    try {
      body = webhookSchema.parse(JSON.parse(rawBody));
    } catch {
      return Promise.reject(
        new GatewayError('INVALID_REQUEST', 'Malformed webhook', false),
      );
    }
    const p = this.payments.get(body.externalId);
    const amountMinor = body.amountMinor ?? p?.amountMinor;
    if (!amountMinor) {
      return Promise.reject(
        new GatewayError('NOT_FOUND', 'No such payment', false),
      );
    }
    if (p) p.status = body.status;
    return Promise.resolve({
      externalId: body.externalId,
      status: body.status,
      amountMinor,
    });
  }

  refund(_ctx: ProviderContext, input: RefundInput): Promise<RefundResult> {
    const done = this.refunds.get(input.idempotencyKey);
    if (done) return Promise.resolve(done);
    const p = this.payments.get(input.externalId);
    if (!p) {
      return Promise.reject(
        new GatewayError('NOT_FOUND', 'No such payment', false),
      );
    }
    if (p.status !== 'SUCCEEDED') {
      return Promise.reject(
        new GatewayError(
          'INVALID_REQUEST',
          'Only a completed payment can be refunded',
          false,
        ),
      );
    }
    if (p.refundedMinor + input.amountMinor > p.amountMinor) {
      return Promise.reject(
        new GatewayError(
          'INVALID_REQUEST',
          'Refund exceeds the amount paid',
          false,
        ),
      );
    }
    p.refundedMinor += input.amountMinor;
    const h = createHash('sha256').update(input.idempotencyKey).digest('hex');
    const result: RefundResult = {
      externalRefundId: `mock_rfnd_${h.slice(0, 16)}`,
      status: 'SUCCEEDED',
      amountMinor: input.amountMinor,
    };
    this.refunds.set(input.idempotencyKey, result);
    return Promise.resolve(result);
  }
}
