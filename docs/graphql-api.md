# GraphQL API

`POST /api/v1/graphql` offers a GraphQL endpoint for integrators alongside
the REST [Integration API](integrations-api.md), with the same credentials
and the same tenant isolation. This page covers the transport, auth and
limits; the menu/orders/customers fields arrive in follow-up releases.

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

## Limits

| Limit | Default | Env var |
|---|---|---|
| Requests per minute, per key / staff member | 120 | `GRAPHQL_LIMIT_PER_MIN` |
| Selection depth | 8 | `GRAPHQL_MAX_DEPTH` |
| Query cost | 1000 | `GRAPHQL_MAX_COST` |
| Parser tokens | 5000 | `GRAPHQL_MAX_TOKENS` |
| Query text | 50 000 chars | — |

**Cost:** each field costs 1. A field with a `first`, `last`, `limit` or
`take` argument multiplies the cost of its sub-selection by that value.
Aliases and repeated fragment spreads are charged every time they appear.
`__typename` is free.

A request over a limit, or with invalid syntax or fields, gets `400` with
`{"errors": [...]}` and nothing runs. Over the rate limit you get `429` with
`Retry-After`. Errors raised while fields run are returned with
`extensions.code` (`FORBIDDEN`, `NOT_FOUND`, …); unexpected server errors are
logged and returned as `Internal server error`.

**Introspection** is disabled when `NODE_ENV=production`. Use the SDL in
this repository, or a development instance, for tooling.
