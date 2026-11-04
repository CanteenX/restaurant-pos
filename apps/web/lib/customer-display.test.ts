import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePairCode, normalizePairCode, parsePairingParams, parseDisplayState } from "./customer-display.ts";

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

test("pairing params: none, valid, or invalid", () => {
  assert.deepEqual(parsePairingParams(""), { kind: "none" });
  assert.deepEqual(parsePairingParams("?code=abc234&branch=b1"), { kind: "ok", code: "ABC234", branchId: "b1" });
  assert.deepEqual(parsePairingParams("?code=ZZ"), { kind: "invalid" });
  assert.deepEqual(parsePairingParams("?code=ABC234"), { kind: "invalid" });
  assert.deepEqual(parsePairingParams("?branch=b1"), { kind: "invalid" });
  assert.deepEqual(parsePairingParams("?code=ABC0O1&branch=b1"), { kind: "invalid" });
});
