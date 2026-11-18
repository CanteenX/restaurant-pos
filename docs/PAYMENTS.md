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
| `../providers/razorpay.provider.ts` | Razorpay adapter: dynamic UPI QR (QR Codes API) |
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

A confirmation for a different amount than the attempt is never settled: the
attempt keeps its open status and gets the `settlementError`, and a flagged
attempt is never settled by any later report, even one with the right amount.
A repeat of the same bad report is not flagged or audited again.

A signed webhook for a payment we have no attempt for (for example a create
that timed out at the gateway but still went through) is acknowledged with
`{ ok: true, ignored: true }` and logged as a warning.

Known gap: a second attempt can be started for the same balance while the
first is still `PENDING`. If the guest pays both, one settles and the other is
flagged and needs a manual refund.

## API

All under `/api/v1/payment-gateway`; staff endpoints need `bills.print`
(the same permission as checkout).

| Method | Path | |
|---|---|---|
| POST | `/orders/:orderId/attempts?branchId=` | `{ provider, method?, idempotencyKey, amount? }` (`createGatewayPaymentSchema`) |
| GET | `/attempts/:id` | Attempt view |
| GET | `/orders/:orderId/attempts/open?branchId=` | `{ attempt }`: the bill's still-payable QR (checked with the gateway first), or `null` |
| GET | `/available` | Connected gateways the till may offer: `[{ key, name }]` (enabled, keys saved, last test passed) |
| POST | `/attempts/:id/refresh` | Poll the gateway, settle if it succeeded |
| POST | `/webhook/:restaurantId/:provider` | Public; adapter-verified signature |

## Razorpay (dynamic UPI QR)

`razorpay` is a real adapter, connected under Settings → Integrations with
the **Key ID** and **Key secret** (encrypted at rest; never returned or
logged). Use test-mode keys (`rzp_test_…`) to try it without moving money.

- **Create:** `POST /v1/payments/qr_codes` with `type: upi_qr`,
  `usage: single_use`, `fixed_amount: true`, `payment_amount` in paise and
  `close_by` 15 minutes out; `notes` carry `attempt_id` and
  `idempotency_key`. The QR's `image_content` (a `upi://` link) becomes the
  `UPI_INTENT` action the till draws. Only `method: UPI` is accepted.
  Razorpay's QR API has no idempotency key; the service makes exactly one
  create call per attempt, and attempts are idempotent per key.
- **Status:** `GET /v1/payments/qr_codes/:id`. Money received → `SUCCEEDED`
  with the amount actually received (a short/over payment is then flagged by
  the service, never settled); closed unpaid → `EXPIRED`; else `PENDING`.
- **Errors:** HTTP 400/422 → `INVALID_REQUEST`, 401/403 → `AUTH`, 404 →
  `NOT_FOUND`, 429/5xx/transport → `NETWORK` (retryable), anything else
  `UNKNOWN`. Razorpay's error text is never kept.
- **Not yet:** webhooks (every Razorpay webhook is `INVALID_SIGNATURE` until
  signature verification lands) and refunds (refused; refund from the
  Razorpay dashboard). Until webhooks land, the till polls
  `/attempts/:id/refresh` every 3 s while the QR is shown.
- **One live QR per bill (server-enforced):** before creating an attempt
  the service checks every open (CREATED/PENDING) attempt of the order with
  the gateway. One still payable for the same amount is returned as is (a
  reloaded till sends a new key and gets the same QR back); one for a
  different amount → `409` until it is paid or expires. `orders.checkout`
  also refuses (`409`) while such a QR is open, unless the request sets
  `overrideOpenGatewayQr: true` (the cashier confirmed the guest pays another
  way; audited as `payment.gateway_qr_overridden`). If that QR is paid
  anyway, settlement fails on the closed bill and it is flagged for review.
  The override audit row is written inside the checkout transaction, so a
  checkout that fails leaves none.
- **Gateway switched off or keys broken with a QR open:** the attempt is
  still reported open (it may be payable) and holds checkout, but only until
  its close time: 15 min QR lifetime + 2 min grace from the attempt's
  `createdAt` (`gatewayQrPastClose` in `payment-gateway.ts`). After that a
  single-use QR cannot collect, so neither `attempts/open` nor
  `orders.checkout` treats it as live, even if the gateway cannot be asked.
  The row is not rewritten: if the gateway later reports it paid, the
  success is still taken and flagged on the closed bill.
- **Till:** when a gateway is available, choosing UPI at checkout offers
  "Show Razorpay UPI QR"; the QR shows the server-locked amount and the bill
  closes by itself once paid. On load the till asks for the bill's open
  QR and resumes it, so a reload, table switch or method switch never loses
  it; manual payment stays held (with a "Guest is paying another way"
  override) until it is paid or expires. The till asks for the open QR
  whether or not a gateway is still available, so the hold and the override
  also show when Razorpay was switched off with a QR open (the static UPI QR
  is hidden while that hold stands). With no connected gateway the till keeps the
  static UPI QR from Settings → Restaurant.
- **Mock server:** `apps/backend/test/razorpay-mock-server.ts`
  (`pnpm exec ts-node test/razorpay-mock-server.ts`, port 4010) implements
  the endpoints above plus `POST /__mock/qr_codes/:id/pay`. Point the backend
  at it with `RAZORPAY_API_BASE=http://127.0.0.1:4010`; that variable is
  **ignored when `NODE_ENV=production`**. `scripts/agent/qa-native.sh`
  starts it for browser QA.

Tests: `src/integration-hub/providers/razorpay.provider.spec.ts` (unit,
scripted HTTP layer), `test/razorpay-upi.e2e-spec.ts` (HTTP + Postgres +
mock server), `e2e/tests/upi-qr.spec.ts` (browser).

## Mock gateway

`mock-gateway` is registered only when `NODE_ENV !== 'production'` or
`PAYMENT_GATEWAY_MOCK=1`, and is not shown in the web Integrations page. It
never moves money. Payment ids are derived from the idempotency key.
Webhooks are `{"externalId","status"}` signed with
`X-Mock-Signature: sha256=HMAC_SHA256(webhookSecret, rawBody)`. Magic
amounts: ₹999.51 is declined, ₹999.52 fails with a network error.

Tests: `src/integration-hub/payment-gateway.spec.ts` (unit) and
`test/payment-gateway.e2e-spec.ts` (HTTP + Postgres).
