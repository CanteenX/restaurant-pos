# GraphQL API

`POST /api/v1/graphql` offers a GraphQL endpoint for integrators alongside
the REST [Integration API](integrations-api.md), with the same credentials
and the same tenant isolation. This page covers the transport, auth and
limits, the read fields for menu, orders and customers, and the
mutations. For copy-paste examples start with the developer guide,
[GRAPHQL.md](GRAPHQL.md).

## Decision: schema-first on plain `graphql-js`

The schema is written in SDL (`apps/backend/src/graphql/graphql.schema.ts`)
and executed with the reference `graphql` package from a normal Nest
controller. We deliberately did **not** add `@nestjs/graphql` + Apollo
Server (code-first):

- **Smaller attack surface.** One dependency, no landing page/playground,
  no GET or batched queries, no file uploads, no persisted-query cache.
- **Same auth path as REST.** A controller with an ordinary Nest guard, so
  integration keys are checked by the exact function the REST guard uses
  and staff sessions by the same JWT strategy as every `@Auth` route.
- **Explicit limits.** Validation runs the spec rules, then our depth and
  cost rules, before anything executes.
- SDL is the artefact integrators read anyway; keeping it as the source of
  truth avoids a second, decorator-generated description of the API.

## Authentication

| Credential | How to send it | Tenant |
|---|---|---|
| Integration API key | `Authorization: Bearer ordr_ext_…` | the key's restaurant; also its location if the key is location-locked |
| Staff session | the session cookie (browser) | the staff member's restaurant |

Any other bearer token (including personal `ordr_staff_` keys) is refused
with `401`. Revoked or expired keys get `401`. Requests must be
`Content-Type: application/json`; anything else is `415` (a cross-site form
cannot reach the endpoint with the session cookie). `GET` is `405`.

The tenant comes **only** from the credential. A `restaurantId` sent in a
header, variable or argument is never used to choose the tenant. Fields are
gated per credential: an integration key needs the field's scope (for
example `menu:read`), a staff session needs the matching permission.

```bash
curl -X POST https://your-domain/api/v1/graphql \
  -H "Authorization: Bearer ordr_ext_..." \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { kind restaurantId branchId grants } }"}'
```

## Read fields

The schema source of truth is `apps/backend/src/graphql/graphql.schema.ts`.

| Query field | Integration key scope | Staff permission | Notes |
|---|---|---|---|
| `menuCategories(branchId, first = 50, after)` | `menu:read` | `menu.view` | by `sortOrder`; keys see only active, shown-on-website categories |
| `menuItems(branchId, categoryId, first = 50, after)` | `menu:read` | `menu.view` | keys see active items in visible categories, at the **website price** (Settings online price change applied, as REST) |
| `orders(branchId, status, first = 10, after)` / `order(id)` | `orders:read` | `orders.create` | newest first; a key sees **only the orders it placed** |
| `customers(branchId, search, first = 20, after)` / `customer(id)` | `customers:read` | `customers.manage` | newest first; `search` matches name, mobile, email |

Restricted fields (the rest of the object still loads; the field is `null`
and `errors[]` carries `extensions.code: "FORBIDDEN"`):

| Field | Key needs | Staff needs |
|---|---|---|
| `Order.customer` (name, phone, email) | `orders:read_customer` | `customers.manage` |
| `MenuItem.costPrice` | never available to keys | `menu.manage` |

`branchId` is optional: leave it out for every branch of your restaurant.
A location-locked key always reads its own location, and asking for another
is `FORBIDDEN`; so is a branch of another restaurant. Asking for an id that
does not exist or is not yours returns `null`. Customer rows are an explicit
allow-list (`id branchId name phone email loyaltyPoints createdAt`): notes,
allergies, birthdays and wallet balances are never exposed.

**Pagination** is cursor-based. Every list returns
`{ nodes, pageInfo { hasNextPage endCursor } }`; pass `endCursor` back as
`after` for the next page. Cursors are opaque; a malformed one is
`BAD_USER_INPUT`. Page sizes are clamped server-side (menu 200, orders and
customers 100; `Order.items` default 10, `OrderItem.modifiers` default 5).
Nested pages multiply in the cost rule below, so ask for small pages when
you nest (`orders(first: 10) { nodes { items(first: 5) { name } } }`).

Related rows (`MenuItem.category`, `Order.items`, `Order.customer`) are
batched per request, so a page costs one database query per field, not one
per row.

```graphql
query RecentOrders($after: String) {
  orders(first: 10, after: $after, status: PAID) {
    nodes {
      id
      orderNumber
      createdAt
      totals { subtotal tax discount tip deliveryFee total }
      items(first: 5) { name quantity lineTotal }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

`totals.total` is what the guest owes: subtotal - discount + tip + delivery fee
(prices are tax-inclusive, so `tax` is informational). For a settled order it
equals the bill and the payments.

## Mutations

| Mutation | Integration key scope | Staff permission | Notes |
|---|---|---|---|
| `createOrder(branchId, input, idempotencyKey)` | `orders:write` | — (staff use the POS) | the REST order path: server-priced, website price, minimum order, `acceptance: PENDING` |
| `setMenuItemAvailability(id, available)` | `menu:availability` | `menu.manage` | sets `isActive`; audited, and pushed to connected delivery platforms |

- **One mutation field per request.** A document with two (aliases and
  fragments count) is refused with `400` before anything runs, so every
  write gets its own response and is charged once to the write limit.
- **Write limit.** A mutation sent with an integration key spends the
  **same** per-key write budget as a REST write
  (`INTEGRATION_WRITE_LIMIT_PER_MIN`, default 30/min), on top of the
  request limit. REST and GraphQL writes from one key are counted together.
  Over it the request gets `429`, `Retry-After`, and an error with
  `extensions.code: "RATE_LIMITED"`; nothing runs. Staff sessions are not
  charged, as on REST.
- **Validation.** After GraphQL's type checks, arguments are parsed with the
  shared Zod schemas (`graphqlCreateOrderArgsSchema`,
  `graphqlSetMenuItemAvailabilityArgsSchema` in `packages/types`). The order
  body is the REST `createIntegrationOrderSchema`, minus `referralCode`,
  `sharedItemId` and `redeemPoints`. Explicit `null` means "not sent".
  Failures are `BAD_USER_INPUT` with `extensions.field`.
- **Idempotency.** `idempotencyKey` is the REST `Idempotency-Key`, in the
  same per-key namespace: a retry with the same key and input (over either
  transport) returns the original order; the same key with different input
  is `BAD_USER_INPUT`. Payment mutations are out of scope.
- **Error codes** from the services: `FORBIDDEN` (scope, permission, another
  location), `NOT_FOUND` (an id that is not yours), `BAD_USER_INPUT`
  (validation and business rules, for example a dish that is unavailable).
  **Changed in #79:** a `400` from a service now maps to `BAD_USER_INPUT`
  on every field, reads included; before #79 read fields returned
  `BAD_REQUEST` for it. Other 4xx codes still map to `BAD_REQUEST`.

## Limits

| Limit | Default | Env var |
|---|---|---|
| Requests per minute, per key / staff member | 120 | `GRAPHQL_LIMIT_PER_MIN` |
| Writes (mutations) per minute, per integration key, shared with REST writes | 30 | `INTEGRATION_WRITE_LIMIT_PER_MIN` |
| Selection depth | 8 | `GRAPHQL_MAX_DEPTH` |
| Query cost | 1000 | `GRAPHQL_MAX_COST` |
| Parser tokens | 5000 | `GRAPHQL_MAX_TOKENS` |
| Query text | 50 000 chars | — |

**Cost:** a field without a page argument costs 1 plus the cost of its
sub-selection. A field with a `first`, `last`, `limit` or `take` argument
(a paged list) costs `1 + page × max(1, cost of its sub-selection)`, so it is
always charged at least one per row it asks for: a leaf list such as
`tags(first: 100)` costs 101, and `items(first: 100) { __typename }` costs
101 too. The page value is the one the resolver will use: a literal, a
variable, the variable's default in the operation, or the schema's default
when the argument is left out or passed as `null` (with no schema default,
1). Aliases and repeated fragment spreads are charged every time they appear.
`__typename` itself costs nothing, but it does not make a page free.

**For resolver authors:** every list field must take a page argument (a
list without one is charged as a single item), and the resolver must pass
it through `clampPage(value, { defaultSize, max })` from
`apps/backend/src/graphql/graphql-limits.ts`. That treats an omitted or
`null` argument as the default page, never as "no limit", and clamps every
value to a server-side maximum. Keep `defaultSize` equal to the schema's
argument default so the cost rule charges what the resolver loads. The cost
rule is one cap, not the only one.

A request over a limit, or with invalid syntax or fields, gets `400` with
`{"errors": [...]}` and nothing runs. Over a rate limit (requests or writes) you get
`429` with `Retry-After`. Errors raised while fields run are returned with
`extensions.code` (`FORBIDDEN`, `NOT_FOUND`, …); unexpected server errors are
logged and returned as `Internal server error`.

**Introspection** is disabled when `NODE_ENV=production`. Use the SDL in
this repository, or a development instance, for tooling.
