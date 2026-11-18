# GraphQL developer guide

Nventra POS has a GraphQL endpoint at `POST /api/v1/graphql`. Integrators can
read the menu, orders and customers, place orders and mark dishes sold out.
It uses the same API keys and the same rules as the REST
[Integration API](integrations-api.md).

This page is a walk-through with examples you can copy. The reference covers
auth, every field, the limits and error codes: [graphql-api.md](graphql-api.md).
The schema source of truth is `apps/backend/src/graphql/graphql.schema.ts`.

Every `graphql` block on this page is checked against the live schema by
`apps/backend/src/graphql/graphql-docs.spec.ts`, so the examples cannot drift.

## 1. Get a key

In the staff app go to **Settings > API Keys > Integration API keys > New key** and create a key
with only the scopes you need:

| You want to | Scope |
|---|---|
| read the menu | `menu:read` |
| place orders | `orders:write` |
| read orders you placed | `orders:read` (add `orders:read_customer` for name, phone, email) |
| mark dishes sold out / back on | `menu:availability` |
| read customer profiles | `customers:read` (personal data) |

The token (`ordr_ext_…`) is shown once. Keep it on your server, never in
browser code. Lock the key to one location if it serves one outlet.

## 2. Send a request

Requests are `POST` with `Content-Type: application/json` and a body of
`{ "query": "...", "variables": { ... } }`.

```bash
export NVENTRA=https://your-domain
export KEY=ordr_ext_...

curl -sS -X POST "$NVENTRA/api/v1/graphql" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { kind restaurantId branchId grants } }"}'
```

The response is `{ "data": ..., "errors": [...] }`. Check `errors` even on
HTTP 200: a field you are not allowed to see is `null`, and its error carries
`extensions.code` (`FORBIDDEN`, `NOT_FOUND`, `BAD_USER_INPUT`, …).

## 3. Read the menu

```graphql
query Menu($branchId: ID, $after: String) {
  menuItems(branchId: $branchId, first: 50, after: $after) {
    nodes {
      id
      name
      price
      isVeg
      isActive
      category { id name }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

`price` is tax-inclusive and, for keys, the website price (the online price
change from Settings is applied). Pass `pageInfo.endCursor` back as `after`
until `hasNextPage` is `false`.

## 4. Place an order

Scope `orders:write`. The server prices the order from the live menu. There
is no amount field to send, and none would be trusted. The order arrives on
the POS waiting for staff to accept it (`acceptance: PENDING`).

```graphql
mutation PlaceOrder(
  $branchId: ID!
  $input: CreateOrderInput!
  $idempotencyKey: String
) {
  createOrder(
    branchId: $branchId
    input: $input
    idempotencyKey: $idempotencyKey
  ) {
    id
    orderNumber
    status
    acceptance
    totals { subtotal tax deliveryFee total }
    items { name quantity unitPrice lineTotal }
  }
}
```

Variables for a takeaway order:

```json
{
  "branchId": "demo-branch",
  "idempotencyKey": "web-order-7f3a9c21",
  "input": {
    "customerName": "Asha Rao",
    "customerPhone": "+91 98765 43210",
    "notes": "Less spicy please",
    "items": [
      { "menuItemId": "demo-item-cola", "quantity": 2 },
      { "menuItemId": "<menu item id>", "quantity": 1, "modifierIds": ["<modifier id>"] }
    ]
  }
}
```

For delivery, set `"type": "DELIVERY"` and add
`"delivery": { "address": "12 MG Road, Flat 4B", "pincode": "700001" }`
(optional `phone`, `lat` + `lng`, `place`). For a pre-order, add
`"scheduledFor"` as an ISO time at least 10 minutes ahead.

**Retries.** Generate one `idempotencyKey` per checkout (8 to 64 characters of
`A-Z a-z 0-9 _ -`) and resend it if the request times out. The same key with
the same input returns the original order instead of a second one. The same
key with different input is refused with `BAD_USER_INPUT`. The key is shared
with the REST `Idempotency-Key` header, so a retry may switch transports.

Loyalty redemption and referral codes are REST only for now
(`POST /api/v1/integrations/locations/:branchId/orders`). There are no payment
mutations.

## 5. Track the order

Scope `orders:read`. A key only ever sees orders it placed.

```graphql
query TrackOrder($id: ID!) {
  order(id: $id) {
    orderNumber
    status
    acceptance
    totals { total }
  }
}
```

## 6. Mark a dish sold out

Scope `menu:availability` (staff: `menu.manage`). `available: false` marks the
dish inactive, so it drops off the website menu; `true` brings it back. Connected
delivery platforms are updated, and the change appears in the audit log
under the key.

```graphql
mutation SoldOut($id: ID!) {
  setMenuItemAvailability(id: $id, available: false) {
    id
    name
    isActive
  }
}
```

## 7. Errors you will see

| `extensions.code` | Meaning | What to do |
|---|---|---|
| `FORBIDDEN` | the key lacks the scope, or the location is not the key's | add the scope or use the right key |
| `NOT_FOUND` | the id does not exist or is not yours | check the id |
| `BAD_USER_INPUT` | validation or a business rule (unknown dish, below the minimum order, idempotency key reused with other input); `extensions.field` names the input | fix the input; do not retry unchanged |
| `RATE_LIMITED` | the key spent its write budget (HTTP `429`) | wait `Retry-After` seconds, then retry with the same idempotency key |
| `INTERNAL_SERVER_ERROR` | server fault (details are logged, never returned) | retry later with the same idempotency key |

HTTP-level failures: `400` (invalid document, over a limit, or more than one
mutation field in a request), `401` (missing, revoked or expired key), `415`
(not JSON), `429` (rate limit; honour `Retry-After`).

Rate limits: 120 requests/min per key, and for writes the key's REST write
budget, `INTEGRATION_WRITE_LIMIT_PER_MIN` (default **30**/min). REST orders
and GraphQL mutations from one key share that budget. Over it you get `429`
with `Retry-After` and `extensions.code: "RATE_LIMITED"`; nothing runs.

Send **one mutation per request**. Two mutation fields in one document are
refused with `400` and nothing runs.
