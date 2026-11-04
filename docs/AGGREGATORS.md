# Delivery aggregators (Zomato, Swiggy, channel managers): audit and design

Status: design, agreed for issues #57 (mock), #58 (status loop) and #59
(menu / item on-off). What the inbound endpoint does today is documented in
[INTEGRATIONS.md](INTEGRATIONS.md#zomato-swiggy-and-aggregators).

## 1. Partner assumptions

- Zomato and Swiggy have **no public order API**. A restaurant gets orders
  either from the platform's merchant webhook (only for large chains, under a
  contract) or, much more commonly, through a **channel manager** it already
  pays for: UrbanPiper, Petpooja, Dotpe and similar. These partners expose an
  HTTP API with a merchant API key and an outlet / store id, push orders to a
  webhook, and accept outbound calls for order status, item availability and
  menu publishing.
- Each partner's payload and endpoint names differ, and their sandboxes need
  a signed partner agreement. We therefore build **one generic partner
  adapter** against a documented canonical contract and a local mock (#57).
  Mapping a specific partner's payload is a thin per-partner layer added only
  once a restaurant gives us sandbox credentials (that step is
  `agent:blocked` on credentials; nothing in #57-#59 needs them).
- We only call the partner's official API with credentials issued to the
  restaurant. No scraping, no private endpoints, no browser automation.

## 2. What exists today (audited on `staging`)

| Piece | Where | State |
|---|---|---|
| Provider contract with declared capabilities | `integration-hub/providers/provider.ts` | `receiveOrders`, `updateOrderStatus`, `cancelOrders`, `webhooks`, `oauth`; optional `updateOrderStatus()`, `processWebhook()`, `refreshCredentials()` - **declared but never called by the hub** |
| Registry: `zomato`, `swiggy`, `aggregator` | `providers/registry.ts` | All three are `WebhookOrderProvider` (inbound only, no outbound client); `sourceOf()` gives `externalSource` |
| Signed inbound endpoint | `integration-hub.webhook.controller.ts` -> `AggregatorOrdersService.receive` | `POST /api/v1/integration-hub/webhook/:restaurantId/:provider`, HMAC-SHA256 over `ts.rawBody` (`signAggregatorBody`), constant-time compare, 5 min window, throttled 120/min, every refusal a plain 401 |
| Events `ping`, `order.created`, `order.cancelled` | `aggregator-orders.service.ts` (`aggregatorEventSchema`) | `order.created` -> ONLINE order awaiting acceptance; prices recomputed server-side; unknown dish refuses the whole order (422); hidden-category items refused; `(externalSource, externalOrderId)` idempotent incl. P2002 race |
| Platform cancel | `AggregatorOrdersService.cancel` | Declines a PENDING order via `OrdersService.rejectOrder`; an accepted order only gets a WARN log (`cancel_needs_attention`) |
| Encrypted credentials, status, activity log | `integration-hub.service.ts`, `secret-box.ts`, `IntegrationConnection` / `IntegrationLog` | Working. CONNECTED only after a signed delivery really arrived |
| Accept / reject in POS | `OrdersService.acceptOrder` / `rejectOrder` (compare-and-set) | Working, but **nothing tells the platform** |
| Ready / served | `OrdersService.updateKotStatus` (per KOT) | Working, per ticket only; no order-level "ready" event |
| Picked up / delivered | `modules/delivery`, `modules/rider` (`DeliveryStatus`) | Working for own riders; platform riders are not modelled |
| Retry machinery to copy | `modules/webhooks/webhooks.service.ts` + `signing.ts` | `BACKOFF_MS` (1m, 5m, 30m, 2h, 12h), `MAX_ATTEMPTS`, 10 s cron with a claim lease |
| SSRF guard | `modules/webhooks/net-guard.ts` | Reuse for any partner base URL |
| Tests | `test/aggregator-webhook.e2e-spec.ts`, `test/integration-hub.e2e-spec.ts` | Inbound path only |

## 3. Gap list

1. **Accept / reject back to the platform** - no outbound client, no hook in
   `acceptOrder` / `rejectOrder`. (#58)
2. **Status updates** (ready, dispatched / picked up, delivered, cancelled by
   the restaurant) - no hook; "ready" exists only per KOT. (#58)
3. **Retry queue + dead letter** for outbound calls, with failure visible on
   the connection card. (#58)
4. **Modifiers / add-ons** - inbound lines are created with
   `modifierIds: []`; platform add-ons are dropped. (#58)
5. **Packaging, platform taxes, discounts** - not read (correct: money is
   server-authoritative), but the platform's own total is not compared, so a
   menu price drift goes unnoticed. (#58)
6. **Branch mapping by platform outlet id** - the payload must carry our
   internal `branchId`; partners only know their outlet id. (#58)
7. **Partner-specific payloads** - only the canonical payload is accepted;
   `processWebhook()` is never used. (#58 defines the hook; per-partner
   mappers wait for credentials)
8. **Item on/off** - there is no sold-out flag on `MenuItem` (only
   `isActive` and stock tracking), and nothing is pushed out. (#59)
9. **Menu sync** (categories, items, prices, taxes) and an item-id mapping
   table. (#59)
10. **Mock partner** to build and test against. (#57)
11. **Settings UI** for status, retries pending, item mapping. (#60)
12. Inbound signature headers still carry the upstream name
    (`X-OrderRestro-Timestamp` / `-Signature`). Keep them - partners are
    already configured with them - and additionally accept
    `X-Nventra-Timestamp` / `X-Nventra-Signature` when the rebrand touches
    this file. Not part of #57-#59.

## 4. Chosen design

### 4.1 Contract extensions (`providers/provider.ts`)

```ts
interface ProviderCapabilities {
  receiveOrders; updateOrderStatus; cancelOrders; webhooks; oauth; // existing
  itemAvailability: boolean; // #59: we can switch an item on/off
  menuSync: boolean;         // #59: we can publish the menu
}

type PlatformOrderStatus =
  | 'ACCEPTED' | 'REJECTED' | 'READY' | 'DISPATCHED' | 'DELIVERED' | 'CANCELLED';

interface IntegrationProvider {
  // existing members unchanged
  updateOrderStatus?(ctx, externalOrderId, status: PlatformOrderStatus,
                     reason?: string): Promise<void>;          // throws OutboundError
  /** Turn a partner's own payload into canonical events (default: identity). */
  normalizeWebhook?(headers, rawBody): AggregatorEvent;
  setItemAvailability?(ctx, items: { externalItemId: string; available: boolean }[]): Promise<void>; // #59
  pushMenu?(ctx, menu: CanonicalMenu): Promise<{ itemIds: Record<string, string> }>;               // #59
}

class OutboundError extends Error { retryable: boolean; httpStatus?: number }
```

`WebhookOrderProvider` keeps working unchanged (all new capabilities `false`),
so restaurants on the plain webhook lose nothing.

### 4.2 New provider: `PartnerApiProvider`

Registered as key `partner-api` ("Channel manager (partner API)"), category
`FOOD_DELIVERY`, all capabilities `true` except `oauth`. Credential fields:
`baseUrl` (not secret; validated with `net-guard.ts`, https only in
production), `apiKey` (secret), `webhookSecret` (secret, 16+ chars). Account
id = partner merchant id. `testConnection` calls `GET {baseUrl}/v1/ping` with
the key and maps 200 -> CONNECTED, 401/403 -> AUTH_EXPIRED, anything else ->
SYNC_ERROR. Outbound requests are signed the same way as inbound ones
(`signAggregatorBody` with `webhookSecret`) and carry `Idempotency-Key`.

The canonical outbound calls (what the mock in #57 implements):

| Call | Body |
|---|---|
| `POST /v1/orders/{externalOrderId}/status` | `{ status: PlatformOrderStatus, reason?, at }` |
| `POST /v1/items/availability` | `{ items: [{ externalItemId, available }] }` |
| `PUT /v1/menu` | `CanonicalMenu` (categories, items with tax-inclusive `price`, `taxRatePercent`, `isVeg`, modifiers) |
| `GET /v1/ping` | - |

### 4.3 Outbound queue (`IntegrationOutbox`, migration in #58)

```prisma
model IntegrationOutbox {
  id            String   @id @default(cuid())
  connectionId  String   // onDelete: Cascade
  kind          String   // order.status | item.availability | menu.push
  dedupeKey     String   // e.g. "<externalOrderId>:READY"
  payload       Json
  status        String   @default("PENDING") // PENDING | DONE | DEAD
  attempts      Int      @default(0)
  nextAttemptAt DateTime @default(now())
  lastError     String?
  createdAt     DateTime @default(now())
  doneAt        DateTime?
  @@unique([connectionId, dedupeKey])
  @@index([status, nextAttemptAt])
}
```

- `IntegrationOutboxService` lives in its own module that depends only on
  Prisma, so `OrdersService` can inject it without a cycle
  (`IntegrationHubModule` already imports `OrdersModule`).
- Enqueue **inside the same transaction** as the state change it reports
  (accept CAS, reject, KOT ready), so a status can never be lost or invented.
  Enqueue is a no-op unless the order has `externalSource` and the source's
  connection is enabled and `supports(provider, 'updateOrderStatus')`.
- `@@unique([connectionId, dedupeKey])` + `createMany({ skipDuplicates })`
  makes enqueue idempotent (double tap, retried webhook).
- Worker: `@Cron` every 10 s, claim with a lease exactly like
  `webhooks.service.ts`, reuse `BACKOFF_MS` / `MAX_ATTEMPTS`. Per order,
  entries are sent in creation order; a later status waits while an earlier
  one for the same order is PENDING, so the platform never sees READY before
  ACCEPTED.
- Non-retryable errors (4xx other than 408/429) go straight to DEAD. DEAD sets
  the connection to `SYNC_ERROR`, `lastError`, an ERROR log line, and a
  notification to `settings.manage` holders. A "Retry" action (settings.manage)
  re-queues DEAD rows. The hub `list()` view gains `outbox: { pending, dead }`
  for the #60 card.
- Credentials are decrypted per attempt (secret-box), never stored in the
  payload or logged.

### 4.4 Status hooks (#58)

| POS event | Platform status | Hook |
|---|---|---|
| Accept | `ACCEPTED` | `OrdersService.acceptOrder`, after the CAS flips |
| Decline by staff | `REJECTED` (with reason) | `rejectOrder` / `withdrawOrder` with `declineIncoming` |
| Cancel after accept | `CANCELLED` | `cancelOrder` |
| Last KOT of the order reaches READY | `READY` | `updateKotStatus` |
| Rider picked up (own fleet) | `DISPATCHED` | delivery / rider service on `PICKED_UP` |
| Delivered (own fleet) | `DELIVERED` | delivery / rider service on `DELIVERED` |

Loop guard: when the platform itself cancels (`order.cancelled` webhook),
`AggregatorOrdersService.cancel` passes `origin: 'platform'` and nothing is
enqueued. Platform-fleet orders skip DISPATCHED/DELIVERED (the platform owns
those).

### 4.5 Inbound mapping (#58)

Canonical `order.created` gains optional fields; nothing monetary is trusted:

- `outletId` - resolved to a branch via `IntegrationConnection.config.outlets`
  (`{ "<outletId>": "<branchId>" }`, edited in settings); `branchId` keeps
  working.
- `items[].modifiers[{ name | modifierId }]` - matched to the item's own
  modifier groups by id then case-insensitive name; an unknown add-on refuses
  the order (422), same rule as unknown dishes.
- `items[].externalItemId` - matched through the item map (4.6) first.
- `platformTotal`, `packagingCharge`, `platformDiscount` - **recorded only**:
  written into the order note and, if `platformTotal` differs from our
  recomputed total by more than 1.00, a WARN log `price_mismatch` so the owner
  fixes the menu. Packaging and platform discounts are settled by the platform,
  not on our bill.
- Providers with their own payload implement `normalizeWebhook` to produce
  this canonical event; signature checks stay in the hub.

### 4.6 Menu and availability (#59)

- `IntegrationItemMap { connectionId, menuItemId, externalItemId,
  lastAvailable Boolean?, syncedAt }` with unique `(connectionId, menuItemId)`
  and `(connectionId, externalItemId)`.
- "Off" means `isActive = false`, or stock tracking says zero sellable. No new
  sold-out column: #59 hooks `MenuService.updateItem` (isActive change) and
  the stock movement that crosses zero, and enqueues `item.availability` with
  dedupeKey `<menuItemId>:<available>:<minute>`; `lastAvailable` suppresses
  repeats.
- Menu push is on demand (settings action) and debounced on menu change
  (one `menu.push` per connection per minute via dedupeKey). Prices sent are
  the tax-inclusive `price` with `taxRatePercent`, straight from the menu.

## 5. Changes to follow-up issues

- **#57 (mock):** implement exactly the four calls in 4.2 plus pushing signed
  `order.created` / `order.cancelled` / `ping`; failure modes: 500, timeout,
  401, 429, duplicate delivery, out-of-order delivery. Records every call it
  received for assertions.
- **#58 (adapter):** owns 4.1 (status part), 4.2, 4.3 (migration), 4.4, 4.5.
  `itemAvailability` / `menuSync` capabilities are added as `false` there.
- **#59 (menu):** owns 4.6 and the `itemAvailability` / `menuSync`
  implementations; reuses the #58 outbox.
- **#60 (UI):** reads `outbox: { pending, dead }`, the outlet map and the item
  map; "Retry failed" button.
- Per-partner mappers (UrbanPiper, Petpooja, ...) are a new issue each, opened
  only once a restaurant supplies sandbox credentials.

## 6. Running the mock partner (#57)

`apps/backend/test/mocks/aggregator-mock.ts` is a dependency-free fake of a
partner API. It implements the four calls from 4.2 (`GET /v1/ping`,
`POST /v1/orders/{id}/status`, `POST /v1/items/availability`, `PUT /v1/menu`),
checks `Authorization: Bearer <apiKey>`, verifies the request signature
(same HMAC as `signAggregatorBody`), honours `Idempotency-Key`, and records
every call in `mock.calls`.

Start it standalone:

```bash
MOCK_API_KEY=mock_api_key MOCK_WEBHOOK_SECRET=mock_webhook_secret_123 \
  pnpm --filter ./apps/backend mock:aggregator      # http://127.0.0.1:4010
```

Use it from a test:

```ts
const mock = new AggregatorMock({ apiKey, webhookSecret });
const baseUrl = await mock.start();           // ephemeral port
await mock.push(webhookUrl, orderCreated, { secret: webhookSecret });
mock.failNext('429', { times: 2, path: '/v1/orders/zc-1/status' });
mock.orderStatuses('zc-1');                   // ['ACCEPTED', 'READY']
await mock.stop();
```

Simulated conditions: `failNext('500' | '401' | '429' | 'timeout')`
(optionally limited by `times` / `path`; 429 sends `Retry-After: 1`),
duplicate delivery (`push(..., { times: 2 })`), out-of-order delivery
(`pushSequence(..., { reverse: true })`), bad signature (`badSignature`) and
stale timestamp (`ageSeconds`). Its unit tests run with `pnpm test`.
