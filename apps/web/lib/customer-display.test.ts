import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDisplaySender,
  generatePairCode,
  joinDisplayRoom,
  normalizePairCode,
  parsePairingParams,
  parseDisplayState,
  type DisplayState,
} from "./customer-display.ts";

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
  joinDisplayRoom(socket, "ABC234", (ok) => joined.push(ok), (fn) => { timers.push(fn); return () => {}; });
  while (timers.length) timers.shift()!();
  assert.equal(sent.length, 3);
  assert.deepEqual(joined, [false, false, true]);
});

test("display join stops retrying once the socket is gone", () => {
  const timers: (() => void)[] = [];
  const socket = { connected: true, emit: (_e: string, _b: unknown, ack: (r: { ok: boolean }) => void) => ack({ ok: false }) };
  let calls = 0;
  joinDisplayRoom(socket, "ABC234", () => calls++, (fn) => { timers.push(fn); return () => {}; });
  socket.connected = false;
  while (timers.length) timers.shift()!();
  assert.equal(calls, 1);
});

test("cancelling a join stops its pending retry", () => {
  const timers: (() => void)[] = [];
  let sent = 0;
  const socket = { connected: true, emit: (_e: string, _b: unknown, ack: (r: { ok: boolean }) => void) => { sent++; ack({ ok: false }); } };
  const cancel = joinDisplayRoom(socket, "ABC234", () => {}, (fn) => {
    timers.push(fn);
    return () => timers.splice(timers.indexOf(fn), 1);
  });
  cancel();
  while (timers.length) timers.shift()!();
  assert.equal(sent, 1);
});

// Fake clock: schedule(fn, ms) queues fn at now+ms; run() drains in order.
function fakeClock() {
  let now = 0;
  let q: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  return {
    schedule(fn: () => void, ms: number) {
      const t = { at: now + ms, fn, id: ++id };
      q.push(t);
      return () => { q = q.filter((x) => x.id !== t.id); };
    },
    run() {
      while (q.length) {
        q.sort((a, b) => a.at - b.at);
        const t = q.shift()!;
        now = t.at;
        t.fn();
      }
    },
  };
}
const cart = (n: number): DisplayState => ({ kind: "cart", lines: [], subtotal: n });

test("a burst of till states coalesces and ends on the latest", () => {
  const clock = fakeClock();
  const sent: DisplayState[] = [];
  const sender = createDisplaySender((s, ack) => { sent.push(s); ack({ ok: true }); }, clock.schedule);
  for (let i = 1; i <= 100; i++) sender.push(cart(i));
  clock.run();
  assert.deepEqual(sent, [cart(100)]);
});

test("a rate-limited state is re-sent until it lands, unless a newer one replaced it", () => {
  const clock = fakeClock();
  const sent: DisplayState[] = [];
  const replies = [{ ok: false, error: "rate-limited" }, { ok: false, error: "rate-limited" }];
  const sender = createDisplaySender((s, ack) => { sent.push(s); ack(replies.shift() ?? { ok: true }); }, clock.schedule);
  sender.push(cart(1));
  clock.run();
  assert.deepEqual(sent, [cart(1), cart(1), cart(1)]);
});

test("other rejections are not retried; flushNow sends immediately", () => {
  const clock = fakeClock();
  const sent: DisplayState[] = [];
  const sender = createDisplaySender((s, ack) => { sent.push(s); ack({ ok: false, error: "forbidden" }); }, clock.schedule);
  sender.flushNow(cart(7));
  assert.deepEqual(sent, [cart(7)]);
  clock.run();
  assert.equal(sent.length, 1);
});
