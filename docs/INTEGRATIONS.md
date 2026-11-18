# Integrations hub

Settings → Integrations lets a restaurant connect Nventra POS to outside
platforms **using its own accounts and credentials**. Nothing routes through a
central vendor server; the credentials belong to the restaurant and are stored
on its own installation, encrypted.

## What works today

| Piece | State |
|---|---|
| Hub: connect, configure, test, enable/disable, disconnect, activity log | Working, tested |
| Encrypted credential storage (AES-256-GCM, bound to restaurant + provider) | Working, tested |
| Outgoing webhooks (HMAC-signed, retries, delivery history) | Working (Settings → Webhooks) |
| Incoming orders / API access (scoped, expiring, rotatable keys) | Working (Settings → API Keys; `/api/v1/integrations/*`) |
| **Zomato, Swiggy, other aggregators** | **Working: signed inbound webhook** (see below) |
| **Channel manager (partner API)** | **Working: inbound orders + accept / reject / ready / dispatched / delivered / cancelled sent back, with retries** (see below) |

## Zomato, Swiggy and aggregators

Zomato and Swiggy have no public order API: restaurants receive their orders
through the platform's merchant webhook or an aggregator / channel manager
(UrbanPiper, Petpooja, Dotpe and similar) that the restaurant has an account
with. Nventra POS therefore exposes one signed endpoint per restaurant and
provider (`zomato`, `swiggy`, `aggregator`, `partner-api`); Settings -> Integrations shows the
exact URL and a secret generator.

    POST /api/v1/integration-hub/webhook/<restaurantId>/<provider>
    X-OrderRestro-Timestamp: <unix seconds>
    X-OrderRestro-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>

Events (JSON body):

| `event` | Effect |
|---|---|
| `ping` | Proves the secret works; marks the card **Connected**. |
| `order.created` | Creates an ONLINE order awaiting acceptance (`externalSource` = provider, `externalOrderId` = `orderId`). `customer{name,phone,email?,ref?}`, `delivery{address,pincode?}` (required for `type: DELIVERY`, the default), `items[{name or menuItemId, quantity, kitchenNote?, modifiers?[{name or modifierId}]}]` (add-ons must belong to that dish, else 422), optional `branchId` or `outletId` (the platform outlet, mapped to a branch with the connection's `outlets` setting; one of them is required when the restaurant has several branches), `notes`, `paymentMode` (`PREPAID` / `COD`, written into the order note), and `platformTotal` / `packagingCharge` / `platformDiscount` (recorded in the note only; a `platformTotal` more than 1.00 off our total logs a `price_mismatch` warning). |
| `order.cancelled` | Declines the order if it is still waiting for acceptance; if staff already accepted it, an activity-log warning asks a person to decide. |

Guarantees: the signature covers the exact bytes received and is compared in
constant time; deliveries more than 5 minutes off are refused (replay bound); a
repeated `orderId` returns the existing order instead of a second one; every
refusal is a plain 401 so the endpoint reveals nothing about which restaurants
exist. Prices, tax and fees are **never** read from the payload - they are
recomputed from your live menu. An unknown dish refuses the whole order (422,
visible in the activity log) rather than silently dropping a line. Items in a
category hidden from the website are refused too.

The card turns **Connected** only after a correctly signed delivery really
arrived; saving the secret or pressing *Check status* never does. The plain
`zomato` / `swiggy` / `aggregator` providers are inbound only.

### Sending statuses back (`partner-api`)

The **Channel manager (partner API)** provider (`partner-api`) also tells the
partner what happened, using the canonical calls in
[AGGREGATORS.md](AGGREGATORS.md#42-new-provider-partnerapiprovider)
(`POST {baseUrl}/v1/orders/{orderId}/status`, signed like inbound deliveries,
`Authorization: Bearer <apiKey>`, `Idempotency-Key`). Credentials: `baseUrl`,
`apiKey`, `webhookSecret` (all stored encrypted). *Check status* calls
`GET /v1/ping`.

| In POS | Sent |
|---|---|
| Accept | `ACCEPTED` |
| Decline | `REJECTED` (with the reason) |
| Cancel after accepting | `CANCELLED` |
| Last kitchen ticket ready | `READY` |
| Own rider picked up / delivered | `DISPATCHED` / `DELIVERED` |
| Platform cancelled it (`order.cancelled`) | nothing (no echo) |

Each status is queued in `integration_outbox` in the same transaction as the
change, at most once per order and status, and sent by a 10 s worker. For one
order, statuses leave in the order they happened. Network errors, timeouts,
408, 429 and 5xx are retried after 1m, 5m, 30m, 2h and 12h; other 4xx give up
at once. A call that gives up sets the card to **Sync error** (or **Auth
expired** for 401/403), writes an ERROR activity line and notifies everyone
with `settings.manage`. `GET /api/v1/integration-hub` shows
`connection.outbox: { pending, dead }`; `POST
/api/v1/integration-hub/partner-api/outbox/retry` re-queues the failed calls.
The outlet map is saved with `PUT /api/v1/integration-hub/partner-api`
(`{ "outlets": { "<outletId>": "<branchId>" } }`). Partner URLs go through the
same SSRF guard as outgoing webhooks (https, no private addresses).

The audit of what is missing and the chosen design for the outbound side
(status loop, retries, item on/off, menu sync) is in
[AGGREGATORS.md](AGGREGATORS.md).

## Statuses

`NOT_CONNECTED`, `PENDING_CONFIGURATION`, `CONNECTED`, `SYNC_ERROR`,
`AUTH_EXPIRED`, `DISABLED`. Only an adapter's own `testConnection` can set
`CONNECTED`; saving credentials never does.

## Writing an adapter

1. Implement `IntegrationProvider` (`src/integration-hub/providers/provider.ts`):
   `key`, `name`, `category`, `capabilities`, `credentialFields`, and
   `testConnection`. Implement the optional methods (`updateOrderStatus`,
   `processWebhook`, `refreshCredentials`) only for capabilities you set to
   `true` — the hub never calls an operation the adapter did not declare.
2. Register it in `providers/registry.ts`.
3. Add tests next to `test/integration-hub.e2e-spec.ts`.

Nothing in POS, KDS or order management changes: an adapter that receives
orders should create them through the existing order service as an ONLINE order
requiring acceptance, setting `externalSource` + `externalOrderId` (unique per
branch, so a retried delivery cannot create a second order) and
`externalCustomerRef`. Those columns already exist on `Order`.

## Security rules for adapters

- Credentials arrive decrypted only inside `ProviderContext` for one call;
  never log them or put them in an error message.
- Only use the platform's official API with credentials issued to the
  restaurant. No scraping, private endpoints or browser automation.
- Validate any callback URL (see `modules/webhooks/net-guard.ts` for the SSRF
  guard) and verify webhook signatures with a constant-time comparison, a
  timestamp window and replay protection.

## Configuration

`INTEGRATION_SECRET_KEY` (16+ characters) is the encryption key. If unset, a
key is derived from `JWT_SECRET`, which means **rotating `JWT_SECRET` makes
saved credentials unreadable** (the hub then reports *Authentication expired*
and asks for them again). Set a dedicated key in production and back it up.

## Permissions

All hub routes need `settings.manage`. The restaurant is always taken from the
signed-in session, never from the request.
