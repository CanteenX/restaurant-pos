// The contract every integration adapter implements. A provider declares what
// it can do (`capabilities`) and implements only that; the hub checks
// `capabilities` before calling an optional method, so an unsupported
// operation is reported plainly instead of failing obscurely or being faked.
//
// Writing a new adapter: implement IntegrationProvider, then add it to
// providers/registry.ts. Nothing in POS, KDS or order management changes.

import type {
  CanonicalMenu,
  PlatformAvailabilityItem,
} from '../aggregator-menu';

export type IntegrationCategory =
  | 'FOOD_DELIVERY'
  | 'PAYMENT'
  | 'ACCOUNTING'
  | 'MARKETING'
  | 'MESSAGING'
  | 'AUTOMATION';

export interface ProviderCapabilities {
  /** The platform can push or serve new orders to us. */
  receiveOrders: boolean;
  /** We can tell the platform an order was accepted / rejected / is ready. */
  updateOrderStatus: boolean;
  /** We can pass on a cancellation. */
  cancelOrders: boolean;
  /** The platform sends us webhooks. */
  webhooks: boolean;
  /** The platform can be linked with OAuth instead of pasted keys. */
  oauth: boolean;
  /** We can switch a menu item on/off on the platform (#59). */
  itemAvailability: boolean;
  /** We can publish the menu to the platform (#59). */
  menuSync: boolean;
}

/** Order states we report back to a platform (docs/AGGREGATORS.md 4.1). */
export const PLATFORM_ORDER_STATUSES = [
  'ACCEPTED',
  'REJECTED',
  'READY',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
] as const;
export type PlatformOrderStatus = (typeof PLATFORM_ORDER_STATUSES)[number];

/**
 * Thrown by outbound calls. `retryable` decides whether the outbox tries
 * again later (network, timeout, 408, 429, 5xx) or gives up (other 4xx).
 */
export class OutboundError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'OutboundError';
  }
}

export interface CredentialField {
  key: string;
  label: string;
  /** Secret fields are encrypted at rest, masked in the UI and never returned. */
  secret: boolean;
  required: boolean;
  help?: string;
}

export interface ProviderContext {
  restaurantId: string;
  externalAccountId: string | null;
  /** Decrypted only for the duration of one call. */
  credentials: Record<string, string>;
}

export interface TestResult {
  ok: boolean;
  /** Hub status this result maps to. */
  status: 'CONNECTED' | 'PENDING_CONFIGURATION' | 'AUTH_EXPIRED' | 'SYNC_ERROR';
  message: string;
}

export interface IntegrationProvider {
  readonly key: string;
  readonly name: string;
  readonly category: IntegrationCategory;
  readonly description: string;
  readonly capabilities: ProviderCapabilities;
  readonly credentialFields: CredentialField[];
  /** Label for the account id on the other platform, e.g. "Merchant ID". */
  readonly accountIdLabel?: string;
  /** When true the account id may be left blank. */
  readonly accountIdOptional?: boolean;
  /** Honest note about what must exist outside OrderRestro before this works. */
  readonly requirements?: string;

  /** Check the saved credentials against the platform. Must never claim success it did not observe. */
  testConnection(ctx: ProviderContext): Promise<TestResult>;

  // Optional: only called when the matching capability is true.
  /** Throws OutboundError on failure. `idempotencyKey` is stable across retries. */
  updateOrderStatus?(
    ctx: ProviderContext,
    externalOrderId: string,
    status: PlatformOrderStatus,
    opts: { reason?: string; idempotencyKey: string; at: string },
  ): Promise<void>;
  /** Turn a partner's own payload into the canonical event JSON (default: identity). */
  normalizeWebhook?(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): unknown;
  processWebhook?(
    ctx: ProviderContext,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<{ externalOrderId?: string }>;
  refreshCredentials?(ctx: ProviderContext): Promise<Record<string, string>>;
  /** Switch items on/off on the platform (#59). Throws OutboundError. */
  setItemAvailability?(
    ctx: ProviderContext,
    items: PlatformAvailabilityItem[],
    opts: { idempotencyKey: string },
  ): Promise<void>;
  /** Publish the whole menu to the platform (#59). Throws OutboundError. */
  pushMenu?(
    ctx: ProviderContext,
    menu: CanonicalMenu,
    opts: { idempotencyKey: string },
  ): Promise<void>;
}

export const NO_CAPABILITIES: ProviderCapabilities = {
  receiveOrders: false,
  updateOrderStatus: false,
  cancelOrders: false,
  webhooks: false,
  oauth: false,
  itemAvailability: false,
  menuSync: false,
};
