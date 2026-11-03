import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePairCode, normalizePairCode, parseDisplayState } from "./customer-display.ts";

test("generated pairing codes are 6 readable characters", () => {
  for (let i = 0; i < 50; i++) assert.match(generatePairCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
});

test("pairing input is trimmed and upper-cased, bad input rejected", () => {
  assert.equal(normalizePairCode("  abc234 "), "ABC234");
  assert.equal(normalizePairCode("abc"), null);
  assert.equal(normalizePairCode("ABC0O1"), null);
});

test("display messages are validated", () => {
  assert.deepEqual(parseDisplayState({ kind: "idle" }), { kind: "idle" });
  assert.equal(parseDisplayState({ kind: "cart", lines: "x" }), null);
  assert.equal(parseDisplayState(null), null);
});
