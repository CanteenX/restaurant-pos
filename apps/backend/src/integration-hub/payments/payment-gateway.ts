// The contract every online payment gateway adapter implements (Razorpay and
// later others). A gateway is an integration-hub provider in the PAYMENT
// category, so it is connected, tested and disabled exactly like any other
// integration; on top of that it implements the four operations below.
//
// Rules every adapter follows (see docs/PAYMENTS.md):
// - Money crosses this boundary as integer minor units (paise). Nothing here
//   ever carries a float rupee amount; the service converts from Decimal.
// - Every failure is thrown as a GatewayError with one of the stable codes, so
//   checkout code never parses a vendor's error text.
// - Adapters never touch orders or payments. Settlement belongs to
//   PaymentGatewayService, which settles through the normal checkout once.

import { Prisma } from '@prisma/client';
import type {
  IntegrationProvider,
  ProviderContext,
} from '../providers/provider';

export type GatewayMethod = 'UPI' | 'CARD' | 'WALLET' | 'BANK_TRANSFER';

/** Lifecycle of one attempt; mirrors the GatewayPaymentStatus DB enum. */
export type AttemptStatus =
  'CREATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

/** What a gateway may report about a payment. */
export type GatewayStatus = Exclude<AttemptStatus, 'CREATED'>;

export type GatewayErrorCode =
  | 'DECLINED'
  | 'NETWORK'
  | 'AUTH'
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND'
  | 'INVALID_SIGNATURE'
  | 'UNKNOWN';

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    /** True when the same request may succeed if simply tried again. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface CreatePaymentInput {
  /** Our attempt id, for the gateway's notes/receipt field. */
  attemptId: string;
  /** Same key → same payment at the gateway, never a second charge. */
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  method: GatewayMethod;
  description: string;
}

/** What the till shows the guest to pay: a UPI link/QR or a hosted page. */
export interface GatewayAction {
  type: 'UPI_INTENT' | 'REDIRECT' | 'NONE';
  value: string | null;
}

export interface CreatedPayment {
  externalId: string;
  status: GatewayStatus;
  amountMinor: number;
  action: GatewayAction;
}

export interface PaymentStatusResult {
  externalId: string;
  status: GatewayStatus;
  amountMinor: number;
  failureCode?: string;
  failureMessage?: string;
}

/** A verified webhook about one payment. */
export type GatewayWebhookEvent = PaymentStatusResult;

export interface RefundInput {
  externalId: string;
  amountMinor: number;
  idempotencyKey: string;
}

export interface RefundResult {
  externalRefundId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  amountMinor: number;
}

export interface PaymentGateway {
  createPayment(
    ctx: ProviderContext,
    input: CreatePaymentInput,
  ): Promise<CreatedPayment>;
  fetchStatus(
    ctx: ProviderContext,
    externalId: string,
  ): Promise<PaymentStatusResult>;
  /** Throws GatewayError('INVALID_SIGNATURE') for anything not provably from the gateway. */
  verifyWebhook(
    ctx: ProviderContext,
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<GatewayWebhookEvent>;
  refund(ctx: ProviderContext, input: RefundInput): Promise<RefundResult>;
}

export type PaymentGatewayProvider = IntegrationProvider & PaymentGateway;

export function isPaymentGateway(
  p: IntegrationProvider | undefined,
): p is PaymentGatewayProvider {
  return (
    !!p &&
    p.category === 'PAYMENT' &&
    typeof (p as Partial<PaymentGateway>).createPayment === 'function'
  );
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Normalises anything an adapter threw. Unknown errors keep no vendor text. */
export function mapGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) {
    return new GatewayError(
      'NETWORK',
      'The payment gateway could not be reached',
      true,
    );
  }
  return new GatewayError(
    'UNKNOWN',
    'The payment gateway returned an unexpected error',
    false,
  );
}

/** Decimal rupees → integer paise. Refuses ≤ 0 and anything finer than a paisa. */
export function toMinorUnits(amount: Prisma.Decimal): number {
  const minor = amount.mul(100);
  if (!minor.isInteger() || minor.lte(0)) {
    throw new GatewayError(
      'INVALID_REQUEST',
      'Amount must be positive with at most 2 decimals',
      false,
    );
  }
  return minor.toNumber();
}

export function fromMinorUnits(minor: number): Prisma.Decimal {
  if (!Number.isSafeInteger(minor)) {
    throw new GatewayError(
      'INVALID_REQUEST',
      'Gateway amount is not a whole number of paise',
      false,
    );
  }
  return new Prisma.Decimal(minor).div(100);
}

const OPEN: AttemptStatus[] = ['CREATED', 'PENDING'];

/** How long a guest has to scan a gateway QR before the gateway closes it. */
export const GATEWAY_QR_LIFETIME_MS = 15 * 60_000;
/**
 * Slack on top of the lifetime: the gateway's close time is taken a moment
 * after the attempt row is created (network round trip, clock skew).
 */
export const GATEWAY_QR_CLOSE_GRACE_MS = 2 * 60_000;
const QR_BOUND_MS = GATEWAY_QR_LIFETIME_MS + GATEWAY_QR_CLOSE_GRACE_MS;

/**
 * Whether a QR created at `createdAt` is closed at the gateway by `now`, so it
 * can no longer collect money. Used when the gateway cannot be asked (it was
 * switched off, or its keys stopped working): a closed single-use QR must not
 * hold the bill forever. The row itself is left as it is, so a late success
 * report is still taken and flagged if the bill was closed another way.
 */
export function gatewayQrPastClose(createdAt: Date, now = new Date()): boolean {
  return now.getTime() - createdAt.getTime() > QR_BOUND_MS;
}

/** The earliest `createdAt` of a QR that may still be payable at `now`. */
export function gatewayQrOpenSince(now = new Date()): Date {
  return new Date(now.getTime() - QR_BOUND_MS);
}

/**
 * The status an attempt moves to when the gateway reports `incoming`, or null
 * when the report changes nothing. SUCCEEDED is final. A success reported
 * after a failure/expiry is still taken: the guest's money was captured.
 */
export function nextAttemptStatus(
  current: AttemptStatus,
  incoming: GatewayStatus,
): AttemptStatus | null {
  if (current === incoming || current === 'SUCCEEDED') return null;
  if (OPEN.includes(current)) return incoming;
  return incoming === 'SUCCEEDED' ? 'SUCCEEDED' : null;
}

/**
 * The checkout request that turns a succeeded attempt into an order payment.
 * The requestId is derived from the attempt, so running it again (webhook
 * retry, poll racing a webhook, crash recovery) is answered as a replay by
 * OrdersService.checkout and never records a second payment.
 */
export function settlementRequest(attempt: {
  id: string;
  provider: string;
  method: GatewayMethod;
  amount: Prisma.Decimal;
  externalId: string | null;
}) {
  return {
    requestId: `gw_${attempt.id}`,
    allowPartial: true,
    payments: [
      {
        method: attempt.method,
        // Exact: a 2-decimal Decimal fits a double; checkout re-rounds to 2dp.
        amount: attempt.amount.toDecimalPlaces(2).toNumber(),
        reference: `${attempt.provider}:${attempt.externalId ?? attempt.id}`,
      },
    ],
  };
}
