# Online payments: the gateway contract

Nventra POS takes card/UPI payments through a **payment gateway adapter**. An
adapter is an integration-hub provider in the `PAYMENT` category, so it is
connected, tested and disabled like every other integration (credentials are
encrypted at rest and never returned). Checkout code never talks to a vendor
API directly; adding a gateway means writing one adapter and registering it.

Code: `apps/backend/src/integration-hub/payments/`

| File | Role |
|---|---|
| `payment-gateway.ts` | The `PaymentGateway` interface, `GatewayError`, money helpers, status rules |
| `mock-gateway.ts` | Deterministic in-memory gateway for tests and demos |
| `payment-gateway.service.ts` | Attempts, webhooks/polling, settlement into the order |
| `payment-gateway.controller.ts` | REST endpoints |

## The adapter interface

```ts
interface PaymentGateway {
  createPayment(ctx, { attemptId, idempotencyKey, amountMinor, currency, method, description })
    : Promise<{ externalId, status, amountMinor, action }>;
  fetchStatus(ctx, externalId): Promise<{ externalId, status, amountMinor, failureCode?, failureMessage? }>;
  verifyWebhook(ctx, headers, rawBody): Promise<same as fetchStatus>;
  refund(ctx, { externalId, amountMinor, idempotencyKey }): Promise<{ externalRefundId, status, amountMinor }>;
}
```

Rules every adapter must follow:

1. **Money is integer minor units (paise)** at this boundary. The service
   converts from the database `Decimal` with `toMinorUnits` (which refuses
   zero, negatives and sub-paisa values) and never uses float rupees.
2. **Idempotency.** `createPayment` and `refund` receive an idempotency key.
   The same key must name the same payment/refund at the gateway, never a
   second charge. Reusing a key with a different amount is
   `IDEMPOTENCY_CONFLICT`.
3. **Errors are `GatewayError`s** with a stable code: `DECLINED`, `NETWORK`
   (retryable), `AUTH`, `INVALID_REQUEST`, `IDEMPOTENCY_CONFLICT`,
   `NOT_FOUND`, `INVALID_SIGNATURE`, `UNKNOWN`. Anything else an adapter throws
   is mapped by `mapGatewayError`: socket/timeout errors become `NETWORK`,
   the rest `UNKNOWN` with a generic message (vendor text is not stored, as
   it can carry keys or internals).
4. **Webhooks are verified over the exact raw bytes.** Anything unproven is
   `INVALID_SIGNATURE`, which the API answers with a plain 401.
5. **Adapters never touch orders or payments.** Only the service settles.
6. `action` tells the till what to show: `UPI_INTENT` (a `upi://` link to
   render as a QR), `REDIRECT` (hosted page URL) or `NONE`.

## Attempts (`gateway_payments` table)

One row per attempt to collect money online for an order:
`CREATED → PENDING → SUCCEEDED | FAILED | EXPIRED`.

- The amount is **computed by the server** from the bill's balance due
  (`OrdersService.previewBill`). A till may ask for less (split bill), never
  more. The bill is charged as it stands: manual discounts/tips must already
  be locked on the order (by an earlier payment) - adding them to an online
  payment is a follow-up.
- `(orderId, idempotencyKey)` is unique: a retried "Pay online" tap returns
  the same attempt.
- `(provider, externalId)` is unique: a gateway payment maps to one attempt.
- Status changes go through `nextAttemptStatus`: `SUCCEEDED` is final, a
  repeat changes nothing, and a success reported after a failure/expiry is
  still accepted (the guest's money was captured). Updates are
  compare-and-set on the status that was read.

## Settlement (how a confirmed payment becomes an order payment)

When an attempt is `SUCCEEDED` and not yet settled, the service calls the
normal `OrdersService.checkout` with one payment line
(`method`, `amount`, `reference = "<provider>:<externalId>"`), `allowPartial`
and **`requestId = "gw_<attemptId>"`**. That gives exactly-once settlement
for free:

- Checkout stores the requestId on the payment (`payments.clientRequestId`,
  unique per order). A repeat webhook, a poll racing a webhook, or a retry
  after a crash is answered as a replay and records nothing new.
- Everything a cash checkout does (stock deduction, loyalty, table release,
  VERI*FACTU record, realtime events, `order.paid` webhook) happens the same
  way, in the same transaction.
- After checkout, the payment row with that requestId is looked up and linked
  (`gateway_payments.paymentId`), so a concurrent settle that lost the race
  still links the winner's row instead of reporting an error.

If the money arrived but the order can no longer take it (closed with cash
meanwhile, or the gateway confirmed a different amount), the attempt keeps
`SUCCEEDED`, gets a `settlementError`, and an audit entry
`payment.gateway_unsettled` is written. **That money must be refunded or
reconciled by a person**; refunds through the adapter are a follow-up issue.

## API

All under `/api/v1/payment-gateway`; staff endpoints need `bills.print`
(the same permission as checkout).

| Method | Path | |
|---|---|---|
| POST | `/orders/:orderId/attempts?branchId=` | `{ provider, method?, idempotencyKey, amount? }` (`createGatewayPaymentSchema`) |
| GET | `/attempts/:id` | Attempt view |
| POST | `/attempts/:id/refresh` | Poll the gateway, settle if it succeeded |
| POST | `/webhook/:restaurantId/:provider` | Public; adapter-verified signature |

## Mock gateway

`mock-gateway` is registered only when `NODE_ENV !== 'production'` or
`PAYMENT_GATEWAY_MOCK=1`, and is not shown in the web Integrations page. It
never moves money. Payment ids are derived from the idempotency key.
Webhooks are `{"externalId","status"}` signed with
`X-Mock-Signature: sha256=HMAC_SHA256(webhookSecret, rawBody)`. Magic
amounts: ₹999.51 is declined, ₹999.52 fails with a network error.

Tests: `src/integration-hub/payment-gateway.spec.ts` (unit) and
`test/payment-gateway.e2e-spec.ts` (HTTP + Postgres).
