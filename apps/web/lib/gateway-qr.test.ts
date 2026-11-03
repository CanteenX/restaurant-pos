import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayQrPhase, gatewayQrUri, type GatewayAttemptView } from "./gateway-qr.ts";

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
