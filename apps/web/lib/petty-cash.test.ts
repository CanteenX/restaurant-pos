import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMovement, reconcileHint, buildEntryPayload } from "./petty-cash.ts";

test("formatMovement signs and formats amounts", () => {
  assert.equal(formatMovement(500), "+₹500.00");
  assert.equal(formatMovement("-120.5"), "−₹120.50");
  assert.equal(formatMovement(0), "₹0.00");
});

test("reconcileHint compares the count with the expected balance", () => {
  assert.deepEqual(reconcileHint(1000, 1000), { variance: 0, status: "match" });
  assert.deepEqual(reconcileHint(1000, 950.5), { variance: -49.5, status: "short" });
  assert.deepEqual(reconcileHint(1000, 1010), { variance: 10, status: "over" });
});

test("reconcileHint avoids floating point noise", () => {
  assert.deepEqual(reconcileHint(0.3, 0.1 + 0.2), { variance: 0, status: "match" });
});

test("buildEntryPayload shapes each kind for the API", () => {
  const base = { businessDate: "2026-11-05", reason: " Milk ", receiptRef: "", amount: "40" };
  assert.deepEqual(buildEntryPayload({ ...base, kind: "TOP_UP", fromTill: true, category: "" }), {
    kind: "TOP_UP", businessDate: "2026-11-05", reason: "Milk", amount: 40, fromTill: true,
  });
  assert.deepEqual(buildEntryPayload({ ...base, kind: "PAYOUT", fromTill: false, category: " Supplies ", receiptRef: "R1" }), {
    kind: "PAYOUT", businessDate: "2026-11-05", reason: "Milk", amount: 40, category: "Supplies", receiptRef: "R1",
  });
});
