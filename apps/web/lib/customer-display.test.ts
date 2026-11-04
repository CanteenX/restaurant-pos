import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePairCode, joinDisplayRoom, normalizePairCode, parsePairingParams, parseDisplayState } from "./customer-display.ts";

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

test("a display only renders upi:// pay links as a QR", () => {
  const upi = { kind: "upi", total: 10, payee: "Cafe", uri: "upi://pay?pa=cafe@okicici&am=10.00&cu=INR" };
  assert.deepEqual(parseDisplayState(upi), upi);
  assert.equal(parseDisplayState({ ...upi, uri: "https://evil.example/pay" }), null);
});

test("display join retries until the till has issued the code", () => {
  const acks = [false, false, true];
  const sent: unknown[] = [];
  const timers: (() => void)[] = [];
  const socket = {
    connected: true,
    emit: (_e: string, body: unknown, ack: (r: { ok: boolean }) => void) => {
      sent.push(body);
      ack({ ok: acks.shift() ?? true });
    },
  };
  const joined: boolean[] = [];
  joinDisplayRoom(socket, "ABC234", (ok) => joined.push(ok), (fn) => void timers.push(fn));
  while (timers.length) timers.shift()!();
  assert.equal(sent.length, 3);
  assert.deepEqual(joined, [false, false, true]);
});

test("display join stops retrying once the socket is gone", () => {
  const timers: (() => void)[] = [];
  const socket = { connected: true, emit: (_e: string, _b: unknown, ack: (r: { ok: boolean }) => void) => ack({ ok: false }) };
  let calls = 0;
  joinDisplayRoom(socket, "ABC234", () => calls++, (fn) => void timers.push(fn));
  socket.connected = false;
  while (timers.length) timers.shift()!();
  assert.equal(calls, 1);
});
