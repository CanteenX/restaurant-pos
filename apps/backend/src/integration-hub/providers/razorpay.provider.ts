// Razorpay payment gateway adapter: dynamic, amount-locked UPI QR codes via
// the Razorpay QR Codes API (POST/GET /v1/payments/qr_codes). See
// docs/PAYMENTS.md for the contract every gateway follows.
//
// - The HTTP layer is injected, so tests and the local mock server
//   (e2e/mocks/razorpay-mock.mjs) never reach Razorpay.
// - Credentials are used only to build the Authorization header of one
//   request. They are never logged, stored on errors or returned.
// - Vendor error text is dropped: it is mapped to a stable GatewayError code.
// - Webhooks (signature verification) and refunds are follow-up issues; until
//   then every webhook is unproven and refunds are refused.

import {
  GatewayError,
  type CreatePaymentInput,
  type CreatedPayment,
  type PaymentGateway,
  type PaymentStatusResult,
} from '../payments/payment-gateway';
import {
  NO_CAPABILITIES,
  type CredentialField,
  type IntegrationProvider,
  type ProviderCapabilities,
  type ProviderContext,
  type TestResult,
} from './provider';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  body: string;
}
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

const TIMEOUT_MS = 10_000;

export const fetchHttpClient: HttpClient = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, body: await res.text() };
};

export const RAZORPAY_DEFAULT_BASE = 'https://api.razorpay.com';

/**
 * API base URL. RAZORPAY_API_BASE (the local mock server) is honoured only
 * outside production, so a production install always talks to Razorpay.
 */
export function razorpayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RAZORPAY_API_BASE?.trim();
  if (!override || env.NODE_ENV === 'production') return RAZORPAY_DEFAULT_BASE;
  try {
    const u = new URL(override);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return RAZORPAY_DEFAULT_BASE;
    }
    return override.replace(/\/+$/, '');
  } catch {
    return RAZORPAY_DEFAULT_BASE;
  }
}

/** How long a guest has to scan before the QR closes. */
const QR_LIFETIME_MS = 15 * 60_000;
const QR_ID = /^qr_[A-Za-z0-9]{1,40}$/;

interface RazorpayQr {
  id?: unknown;
  status?: unknown;
  payment_amount?: unknown;
  payments_amount_received?: unknown;
  image_content?: unknown;
}

function errorFor(status: number): GatewayError {
  if (status === 400 || status === 422) {
    return new GatewayError(
      'INVALID_REQUEST',
      'Razorpay rejected the request',
      false,
    );
  }
  if (status === 401 || status === 403) {
    return new GatewayError(
      'AUTH',
      'Razorpay rejected the API keys - check them under Integrations',
      false,
    );
  }
  if (status === 404) {
    return new GatewayError('NOT_FOUND', 'Razorpay has no such QR code', false);
  }
  if (status === 429 || status >= 500) {
    return new GatewayError(
      'NETWORK',
      'Razorpay is unavailable right now - try again',
      true,
    );
  }
  return new GatewayError(
    'UNKNOWN',
    'Razorpay returned an unexpected response',
    false,
  );
}

const unexpected = () =>
  new GatewayError(
    'UNKNOWN',
    'Razorpay returned an unexpected response',
    false,
  );

const isPaise = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export class RazorpayGateway implements IntegrationProvider, PaymentGateway {
  readonly key = 'razorpay';
  readonly name = 'Razorpay';
  readonly category = 'PAYMENT' as const;
  readonly description =
    'Dynamic UPI QR codes locked to the exact bill amount, created through your Razorpay account.';
  readonly requirements =
    'Needs a Razorpay account with QR Codes enabled. Use test-mode keys to try it without moving money. Payment confirmation by webhook is coming; until then the till checks the status.';
  readonly capabilities: ProviderCapabilities = { ...NO_CAPABILITIES };
  readonly credentialFields: CredentialField[] = [
    {
      key: 'keyId',
      label: 'Key ID',
      secret: false,
      required: true,
      help: 'Dashboard → Account & Settings → API Keys (starts with rzp_).',
    },
    {
      key: 'keySecret',
      label: 'Key secret',
      secret: true,
      required: true,
    },
  ];

  private readonly http: HttpClient;
  private readonly baseUrl: string | undefined;
  private readonly now: () => Date;

  constructor(
    opts: { http?: HttpClient; baseUrl?: string; now?: () => Date } = {},
  ) {
    this.http = opts.http ?? fetchHttpClient;
    // Unset: read per call, so the env is honoured whenever it is set.
    this.baseUrl = opts.baseUrl?.replace(/\/+$/, '');
    this.now = opts.now ?? (() => new Date());
  }

  private auth(ctx: ProviderContext): string {
    const id = ctx.credentials.keyId?.trim();
    const secret = ctx.credentials.keySecret?.trim();
    if (!id || !secret) {
      throw new GatewayError(
        'AUTH',
        'Razorpay API keys are not set - add them under Integrations',
        false,
      );
    }
    return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  }

  /** One API call; returns the parsed 2xx body or throws a GatewayError. */
  private async call(
    ctx: ProviderContext,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: this.auth(ctx),
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: HttpResponse;
    try {
      res = await this.http({
        method,
        url: `${this.baseUrl ?? razorpayBaseUrl()}${path}`,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // Deliberately not chained: a transport error can echo the request.
      throw new GatewayError('NETWORK', 'Razorpay could not be reached', true);
    }
    if (res.status < 200 || res.status >= 300) throw errorFor(res.status);
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw unexpected();
    }
  }

  async testConnection(ctx: ProviderContext): Promise<TestResult> {
    if (!ctx.credentials.keyId?.trim() || !ctx.credentials.keySecret?.trim()) {
      return {
        ok: false,
        status: 'PENDING_CONFIGURATION',
        message: 'Enter your Razorpay Key ID and Key secret.',
      };
    }
    try {
      await this.call(ctx, 'GET', '/v1/payments/qr_codes?count=1');
      return {
        ok: true,
        status: 'CONNECTED',
        message: 'Razorpay accepted the API keys.',
      };
    } catch (e) {
      const g = e instanceof GatewayError ? e : unexpected();
      return {
        ok: false,
        status: g.code === 'AUTH' ? 'AUTH_EXPIRED' : 'SYNC_ERROR',
        message: g.message,
      };
    }
  }

  async createPayment(
    ctx: ProviderContext,
    input: CreatePaymentInput,
  ): Promise<CreatedPayment> {
    if (input.method !== 'UPI') {
      throw new GatewayError(
        'INVALID_REQUEST',
        'Razorpay is set up for UPI QR payments only',
        false,
      );
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new GatewayError(
        'INVALID_REQUEST',
        'Amount must be a positive whole number of paise',
        false,
      );
    }
    // Razorpay's QR API takes no idempotency key. The service makes exactly
    // one create call per attempt (one attempt per key), and the key is kept
    // in notes so a payment can always be traced back to its attempt.
    const closeBy = Math.floor((this.now().getTime() + QR_LIFETIME_MS) / 1000);
    const qr = (await this.call(ctx, 'POST', '/v1/payments/qr_codes', {
      type: 'upi_qr',
      name: 'Nventra POS',
      usage: 'single_use',
      fixed_amount: true,
      payment_amount: input.amountMinor,
      description: input.description.slice(0, 255),
      close_by: closeBy,
      notes: {
        attempt_id: input.attemptId,
        idempotency_key: input.idempotencyKey,
      },
    })) as RazorpayQr;
    if (
      typeof qr?.id !== 'string' ||
      !QR_ID.test(qr.id) ||
      !isPaise(qr.payment_amount) ||
      typeof qr.image_content !== 'string' ||
      !qr.image_content.startsWith('upi://')
    ) {
      throw unexpected();
    }
    return {
      externalId: qr.id,
      status: 'PENDING',
      amountMinor: qr.payment_amount,
      action: { type: 'UPI_INTENT', value: qr.image_content },
    };
  }

  async fetchStatus(
    ctx: ProviderContext,
    externalId: string,
  ): Promise<PaymentStatusResult> {
    if (!QR_ID.test(externalId)) {
      throw new GatewayError(
        'NOT_FOUND',
        'Razorpay has no such QR code',
        false,
      );
    }
    const qr = (await this.call(
      ctx,
      'GET',
      `/v1/payments/qr_codes/${externalId}`,
    )) as RazorpayQr;
    if (!isPaise(qr?.payment_amount) || !isPaise(qr.payments_amount_received)) {
      throw unexpected();
    }
    const received = qr.payments_amount_received;
    if (received > 0) {
      // Any money in is reported as received; a short or over payment is
      // flagged by the service's amount check rather than settled.
      return { externalId, status: 'SUCCEEDED', amountMinor: received };
    }
    return {
      externalId,
      status: qr.status === 'closed' ? 'EXPIRED' : 'PENDING',
      amountMinor: qr.payment_amount,
    };
  }

  readonly verifyWebhook: PaymentGateway['verifyWebhook'] = () =>
    Promise.reject(
      new GatewayError(
        'INVALID_SIGNATURE',
        'Razorpay webhooks are not enabled yet',
        false,
      ),
    );

  readonly refund: PaymentGateway['refund'] = () =>
    Promise.reject(
      new GatewayError(
        'INVALID_REQUEST',
        'Refunds through Razorpay are not available yet - refund from the Razorpay dashboard',
        false,
      ),
    );
}
