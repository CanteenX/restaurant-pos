import assert from "node:assert/strict";
import { test } from "node:test";
import { expenseStatusInfo, normalizeThreshold, pendingTotal } from "./expense-status.ts";

test("each status maps to a label key and a tone", () => {
  assert.deepEqual(expenseStatusInfo("PENDING"), { labelKey: "acct.exp.status.pending", tone: "warning" });
  assert.deepEqual(expenseStatusInfo("APPROVED"), { labelKey: "acct.exp.status.approved", tone: "success" });
  assert.deepEqual(expenseStatusInfo("REJECTED"), { labelKey: "acct.exp.status.rejected", tone: "danger" });
});

test("rows from before approvals existed (no status) count as approved", () => {
  assert.equal(expenseStatusInfo(undefined).tone, "success");
});

test("pendingTotal sums only pending amounts", () => {
  const rows = [
    { amount: "100.50", status: "PENDING" as const },
    { amount: "40", status: "APPROVED" as const },
    { amount: "20", status: "PENDING" as const },
    { amount: "9", status: "REJECTED" as const },
  ];
  assert.equal(pendingTotal(rows), 120.5);
});

test("blank threshold turns approvals off, numbers are kept", () => {
  assert.equal(normalizeThreshold(""), null);
  assert.equal(normalizeThreshold("  "), null);
  assert.equal(normalizeThreshold("5000"), 5000);
  assert.equal(normalizeThreshold("0"), 0);
});

test("invalid or negative thresholds are rejected as NaN", () => {
  assert.ok(Number.isNaN(normalizeThreshold("abc")));
  assert.ok(Number.isNaN(normalizeThreshold("-5")));
});
