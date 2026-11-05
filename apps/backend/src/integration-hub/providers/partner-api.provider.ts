import http from 'node:http';
import https from 'node:https';
import {
  netOptionsFromEnv,
  resolveWebhookTarget,
  type ResolvedTarget,
  type WebhookNetOptions,
} from '../../modules/webhooks/net-guard';
import type {
  CanonicalMenu,
  PlatformAvailabilityItem,
} from '../aggregator-menu';
import { signAggregatorBody } from '../aggregator-signing';
import {
  NO_CAPABILITIES,
  OutboundError,
  type CredentialField,
  type IntegrationProvider,
  type PlatformCallOptions,
  type PlatformOrderStatus,
  type ProviderCapabilities,
  type ProviderContext,
  type TestResult,
} from './provider';

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * A channel manager / aggregator partner with an HTTP API (UrbanPiper,
 * Petpooja, Dotpe-style). Speaks the canonical contract in
 * docs/AGGREGATORS.md 4.2, which the local mock (test/mocks) implements.
 * Inbound orders use the same signed webhook as the plain providers; this
 * adapter adds the outbound calls that tell the platform what happened.
 */
const outletField = (o: PlatformCallOptions) => ({
  ...(o.branchId ? { branchId: o.branchId } : {}),
  ...(o.outletId ? { outletId: o.outletId } : {}),
});

export class PartnerApiProvider implements IntegrationProvider {
  readonly key = 'partner-api';
  readonly name = 'Channel manager (partner API)';
  readonly category = 'FOOD_DELIVERY' as const;
  readonly description =
    'Receive Zomato / Swiggy orders through your channel manager and send accept, reject, ready and delivery updates back to it.';
  readonly requirements =
    'Needs an API key and base URL from your channel manager. Zomato and Swiggy have no public order API; the partner relays orders and statuses.';
  readonly accountIdLabel = 'Partner merchant ID';
  readonly accountIdOptional = true;
  readonly capabilities: ProviderCapabilities = {
    ...NO_CAPABILITIES,
    receiveOrders: true,
    updateOrderStatus: true,
    cancelOrders: true,
    webhooks: true,
    itemAvailability: true,
    menuSync: true,
  };
  readonly credentialFields: CredentialField[] = [
    {
      key: 'baseUrl',
      label: 'Partner API base URL',
      secret: false,
      required: true,
      help: 'For example https://api.partner.example - must be https.',
    },
    { key: 'apiKey', label: 'API key', secret: true, required: true },
    {
      key: 'webhookSecret',
      label: 'Webhook signing secret',
      secret: true,
      required: true,
      help: 'Any long random string (16+ characters), shared with the partner. Signs orders in both directions.',
    },
  ];

  constructor(
    private readonly opts: { timeoutMs?: number; net?: WebhookNetOptions } = {},
  ) {}

  async testConnection(ctx: ProviderContext): Promise<TestResult> {
    try {
      await this.call(ctx, 'GET', '/v1/ping', '', undefined);
      return {
        ok: true,
        status: 'CONNECTED',
        message: 'The partner API answered with these credentials.',
      };
    } catch (e) {
      const err = e as OutboundError;
      if (err.httpStatus === 401 || err.httpStatus === 403) {
        return {
          ok: false,
          status: 'AUTH_EXPIRED',
          message: 'The partner refused the API key. Check it and save again.',
        };
      }
      return {
        ok: false,
        status: 'SYNC_ERROR',
        message: `The partner API could not be reached: ${err.message}`,
      };
    }
  }

  async updateOrderStatus(
    ctx: ProviderContext,
    externalOrderId: string,
    status: PlatformOrderStatus,
    o: { reason?: string; idempotencyKey: string; at: string },
  ): Promise<void> {
    const body = JSON.stringify({
      status,
      ...(o.reason ? { reason: o.reason } : {}),
      at: o.at,
    });
    await this.call(
      ctx,
      'POST',
      `/v1/orders/${encodeURIComponent(externalOrderId)}/status`,
      body,
      o.idempotencyKey,
    );
  }

  async setItemAvailability(
    ctx: ProviderContext,
    items: PlatformAvailabilityItem[],
    o: PlatformCallOptions,
  ): Promise<void> {
    await this.call(
      ctx,
      'POST',
      '/v1/items/availability',
      JSON.stringify({ ...outletField(o), items }),
      o.idempotencyKey,
    );
  }

  async pushMenu(
    ctx: ProviderContext,
    menu: CanonicalMenu,
    o: PlatformCallOptions,
  ): Promise<void> {
    await this.call(
      ctx,
      'PUT',
      '/v1/menu',
      JSON.stringify({ ...menu, ...outletField(o) }),
      o.idempotencyKey,
    );
  }

  /** One signed request. Resolves on 2xx; otherwise throws OutboundError. */
  private async call(
    ctx: ProviderContext,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: string,
    idempotencyKey: string | undefined,
  ): Promise<void> {
    const { baseUrl, apiKey, webhookSecret } = ctx.credentials;
    if (!baseUrl || !apiKey || !webhookSecret) {
      throw new OutboundError('Partner credentials are incomplete', false);
    }
    let target: ResolvedTarget;
    try {
      target = await resolveWebhookTarget(
        `${baseUrl.replace(/\/+$/, '')}${path}`,
        this.opts.net ?? netOptionsFromEnv(),
      );
    } catch (e) {
      const msg = (e as Error).message;
      throw new OutboundError(msg, /resolve/i.test(msg));
    }
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'NventraPOS-Integrations/1',
      'X-OrderRestro-Timestamp': ts,
      'X-OrderRestro-Signature': signAggregatorBody(webhookSecret, ts, body),
      ...(ctx.externalAccountId
        ? { 'X-Partner-Merchant-Id': ctx.externalAccountId }
        : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...(body
        ? {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
          }
        : {}),
    };
    const status = await this.send(target, method, headers, body);
    if (status >= 200 && status < 300) return;
    const retryable = status === 408 || status === 429 || status >= 500;
    throw new OutboundError(
      `Partner answered HTTP ${status}`,
      retryable,
      status,
    );
  }

  private send(
    target: ResolvedTarget,
    method: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<number> {
    const { url, address, family } = target;
    const client = url.protocol === 'https:' ? https : http;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const req = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method,
          timeout: timeoutMs,
          headers,
          // Connect to the vetted address; TLS still checks the real hostname.
          lookup: (_h, _o, cb) => cb(null, address, family),
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('timeout', () =>
        req.destroy(new Error(`Timed out after ${timeoutMs} ms`)),
      );
      req.on('error', (e) => reject(new OutboundError(e.message, true)));
      req.end(body || undefined);
    });
  }
}
