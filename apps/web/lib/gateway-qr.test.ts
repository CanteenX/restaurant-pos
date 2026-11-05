import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayHold, gatewayQrBlocksManualUpi, gatewayQrIsLive, gatewayQrPhase, gatewayQrUri, type GatewayAttemptView } from "./gateway-qr.ts";

const attempt = (over: Partial<GatewayAttemptView> = {}): GatewayAttemptView => ({
  id: "att_1",
  provider: "razorpay",
  status: "PENDING",
  amount: "250.50",
  action: { type: "UPI_INTENT", value: "upi://pay?pa=rpy.x@icici&am=250.50&cu=INR" },
  settled: false,
  settlementError: null,
  failureCode: null,
  failureMessage: null,
  ...over,
});

test("a pending attempt with a UPI link is waiting for the guest", () => {
  assert.equal(gatewayQrPhase(attempt()), "waiting");
  assert.equal(gatewayQrPhase(attempt({ status: "CREATED" })), "waiting");
  assert.equal(gatewayQrPhase(undefined), "starting");
});

test("only a settled success counts as paid", () => {
  assert.equal(gatewayQrPhase(attempt({ status: "SUCCEEDED", settled: true })), "paid");
  // Money in but not on the bill yet (settling, or flagged for a person).
  assert.equal(gatewayQrPhase(attempt({ status: "SUCCEEDED" })), "waiting");
  assert.equal(gatewayQrPhase(attempt({ status: "SUCCEEDED", settlementError: "x" })), "review");
  assert.equal(gatewayQrPhase(attempt({ settlementError: "different amount" })), "review");
});

test("failed and expired attempts stop polling", () => {
  assert.equal(gatewayQrPhase(attempt({ status: "FAILED", failureCode: "NETWORK" })), "failed");
  assert.equal(gatewayQrPhase(attempt({ status: "EXPIRED" })), "expired");
});

test("the QR shows only a upi:// intent, never another URL", () => {
  assert.equal(gatewayQrUri(attempt()), "upi://pay?pa=rpy.x@icici&am=250.50&cu=INR");
  assert.equal(gatewayQrUri(attempt({ action: { type: "REDIRECT", value: "https://x" } })), null);
  assert.equal(gatewayQrUri(attempt({ action: { type: "UPI_INTENT", value: "javascript:alert(1)" } })), null);
  assert.equal(gatewayQrUri(attempt({ action: null })), null);
  assert.equal(gatewayQrUri(undefined), null);
});

test("a pending attempt without a usable link is a failure, not a blank QR", () => {
  assert.equal(gatewayQrPhase(attempt({ action: null })), "failed");
});

test("a waiting QR goes stale once the amount to collect no longer matches it", () => {
  // Same amount (to the paisa) keeps it live.
  assert.equal(gatewayQrPhase(attempt(), 250.5), "waiting");
  assert.equal(gatewayQrPhase(attempt({ amount: "0.30" }), 0.1 + 0.2), "waiting");
  // Discount, tip, split or an edited "Amount to pay now": stop showing it.
  assert.equal(gatewayQrPhase(attempt(), 200), "stale");
  assert.equal(gatewayQrPhase(attempt({ status: "CREATED" }), 251), "stale");
  // Money already in, or a terminal state: the amount change does not hide it.
  assert.equal(gatewayQrPhase(attempt({ status: "SUCCEEDED", settled: true }), 0), "paid");
  assert.equal(gatewayQrPhase(attempt({ status: "SUCCEEDED" }), 100), "waiting");
  assert.equal(gatewayQrPhase(attempt({ status: "EXPIRED" }), 100), "expired");
  // Without an amount to compare (legacy callers) nothing changes.
  assert.equal(gatewayQrPhase(attempt()), "waiting");
});

test("the manual UPI Complete is held while a gateway QR can still be paid", () => {
  assert.equal(gatewayQrBlocksManualUpi("waiting"), true);
  assert.equal(gatewayQrBlocksManualUpi("stale"), true);
  for (const p of [null, "starting", "paid", "failed", "expired", "review"] as const) {
    assert.equal(gatewayQrBlocksManualUpi(p), false, String(p));
  }
});

test("a QR the server still holds open blocks manual payment with nothing on screen", () => {
  // After a reload or a switch to Cash the till has no local phase.
  assert.equal(gatewayQrIsLive(null, attempt()), true);
  assert.equal(gatewayQrIsLive(null, attempt({ status: "CREATED" })), true);
  assert.equal(gatewayQrIsLive(null, null), false);
  assert.equal(gatewayQrIsLive(null, undefined), false);
  assert.equal(gatewayQrIsLive(null, attempt({ status: "EXPIRED" })), false);
  assert.equal(gatewayQrIsLive(null, attempt({ status: "SUCCEEDED", settled: true })), false);
  assert.equal(gatewayQrIsLive(null, attempt({ settlementError: "x" })), false);
  // The QR on screen counts until the server catches up.
  assert.equal(gatewayQrIsLive("waiting", null), true);
  assert.equal(gatewayQrIsLive("paid", null), false);
});

const rzp = { key: "razorpay", name: "Razorpay" };

test("an open server QR holds the bill even when no gateway is available any more", () => {
  // Razorpay switched off (or its keys stopped working) while a QR is open.
  const h = gatewayHold({ gateway: null, localPhase: null, serverOpen: attempt(), overridden: false, method: "CASH" });
  assert.deepEqual(h, { live: true, held: true, showOverride: true, gatewayName: "Razorpay" });
  // On UPI there is no gateway QR to show, so the override is offered there too.
  assert.equal(gatewayHold({ gateway: null, localPhase: null, serverOpen: attempt(), overridden: false, method: "UPI" }).showOverride, true);
});

test("the override releases the hold", () => {
  const h = gatewayHold({ gateway: null, localPhase: null, serverOpen: attempt(), overridden: true, method: "CASH" });
  assert.equal(h.live, true);
  assert.equal(h.held, false);
  assert.equal(h.showOverride, false);
});

test("nothing is held once the server reports no open QR", () => {
  const h = gatewayHold({ gateway: null, localPhase: null, serverOpen: null, overridden: false, method: "CASH" });
  assert.deepEqual(h, { live: false, held: false, showOverride: false, gatewayName: null });
});

test("a stale on-screen phase does not hold the bill once the gateway is gone", () => {
  const h = gatewayHold({ gateway: null, localPhase: "waiting", serverOpen: null, overridden: false, method: "CASH" });
  assert.equal(h.held, false);
});

test("with a gateway, the on-screen QR holds and the override is offered off UPI only", () => {
  const onUpi = gatewayHold({ gateway: rzp, localPhase: "waiting", serverOpen: null, overridden: false, method: "UPI" });
  assert.deepEqual(onUpi, { live: true, held: true, showOverride: false, gatewayName: "Razorpay" });
  const onCash = gatewayHold({ gateway: rzp, localPhase: "waiting", serverOpen: null, overridden: false, method: "CASH" });
  assert.equal(onCash.showOverride, true);
});

test("an unknown provider key is still named", () => {
  const h = gatewayHold({ gateway: null, localPhase: null, serverOpen: attempt({ provider: "cashfree" }), overridden: false, method: "CASH" });
  assert.equal(h.gatewayName, "Cashfree");
});
