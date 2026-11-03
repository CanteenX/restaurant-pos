import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDeposit, parseDepositInput } from "./reservation-deposit.ts";

test("parseDepositInput treats blank as no deposit", () => {
  assert.deepEqual(parseDepositInput(""), { ok: true, value: undefined });
  assert.deepEqual(parseDepositInput("   "), { ok: true, value: undefined });
});

test("parseDepositInput accepts non-negative decimals", () => {
  assert.deepEqual(parseDepositInput("0"), { ok: true, value: 0 });
  assert.deepEqual(parseDepositInput("250.50"), { ok: true, value: 250.5 });
});

test("parseDepositInput rejects negatives and non-numbers", () => {
  assert.equal(parseDepositInput("-1").ok, false);
  assert.equal(parseDepositInput("abc").ok, false);
  assert.equal(parseDepositInput("1e999").ok, false);
});

test("formatDeposit hides empty/zero deposits and formats others", () => {
  assert.equal(formatDeposit(null), null);
  assert.equal(formatDeposit("0"), null);
  assert.equal(formatDeposit("0.00"), null);
  assert.match(formatDeposit("250.5") ?? "", /250\.50/);
});
