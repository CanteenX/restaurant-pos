import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PIN_MAX,
  addToRoster,
  canSubmitPin,
  landingPathFor,
  parseRoster,
  pinFailure,
  pressKey,
  removeFromRoster,
  ROSTER_MAX,
} from "./pin-keypad.ts";

test("digits append, back removes the last one, clear empties", () => {
  let pin = "";
  for (const k of ["1", "2", "3"]) pin = pressKey(pin, k);
  assert.equal(pin, "123");
  assert.equal(pressKey(pin, "back"), "12");
  assert.equal(pressKey(pin, "clear"), "");
  assert.equal(pressKey("", "back"), "");
});

test("non-digit keys are ignored and the PIN stops at the maximum length", () => {
  assert.equal(pressKey("12", "a"), "12");
  assert.equal(pressKey("12", "11"), "12");
  const full = "1".repeat(PIN_MAX);
  assert.equal(pressKey(full, "9"), full);
});

test("a PIN can be submitted only with 4 to 8 digits", () => {
  assert.equal(canSubmitPin("123"), false);
  assert.equal(canSubmitPin("1234"), true);
  assert.equal(canSubmitPin("12345678"), true);
  assert.equal(canSubmitPin("12a4"), false);
});

test("a wrong PIN keeps the server's generic message", () => {
  const f = pinFailure(401, "Incorrect PIN or PIN login not available for this user");
  assert.equal(f.kind, "wrong");
  assert.match(f.message, /Incorrect PIN/);
});

test("lockout and per-device limits are shown as lockouts", () => {
  const locked = pinFailure(423, "Too many incorrect PINs. PIN login is locked for 15 minutes — sign in with your password.");
  assert.equal(locked.kind, "locked");
  assert.match(locked.message, /locked for 15 minutes/);
  const device = pinFailure(429, "Too many incorrect PINs from this device. Try again in 15 minutes.");
  assert.equal(device.kind, "locked");
  assert.match(device.message, /from this device/);
});

test("the route throttle gets a readable message instead of the framework text", () => {
  const f = pinFailure(429, "ThrottlerException: Too Many Requests");
  assert.equal(f.kind, "locked");
  assert.doesNotMatch(f.message, /Throttler/);
  assert.match(f.message, /wait a minute/i);
});

test("server and network failures are not called a wrong PIN", () => {
  assert.equal(pinFailure(500, "boom").kind, "server");
  assert.equal(pinFailure(undefined).kind, "offline");
});

test("the device roster puts the latest user first, without duplicates, capped", () => {
  let list = addToRoster([], { id: "a", name: "Asha" });
  list = addToRoster(list, { id: "b", name: "Bilal" });
  list = addToRoster(list, { id: "a", name: "Asha K" });
  assert.deepEqual(list.map((u) => u.id), ["a", "b"]);
  assert.equal(list[0].name, "Asha K");
  for (let i = 0; i < ROSTER_MAX + 5; i++) list = addToRoster(list, { id: `u${i}`, name: `U${i}` });
  assert.equal(list.length, ROSTER_MAX);
  assert.deepEqual(removeFromRoster([{ id: "a", name: "A" }, { id: "b", name: "B" }], "a").map((u) => u.id), ["b"]);
});

test("a corrupt or foreign roster value reads as empty and drops bad rows", () => {
  assert.deepEqual(parseRoster(null), []);
  assert.deepEqual(parseRoster("not json"), []);
  assert.deepEqual(parseRoster('{"id":"a"}'), []);
  assert.deepEqual(parseRoster('[{"id":"a","name":"A","roleName":"CASHIER"},{"id":1},{"name":"x"}]'), [
    { id: "a", name: "A", roleName: "CASHIER" },
  ]);
});

test("the roster keeps only id, name and role — never permissions or other fields", () => {
  const list = addToRoster([], { id: "a", name: "A", roleName: "OWNER", permissions: ["*"] } as never);
  assert.deepEqual(list, [{ id: "a", name: "A", roleName: "OWNER" }]);
});

test("a delivery rider lands on their deliveries, everyone else on the dashboard", () => {
  assert.equal(landingPathFor({ roleName: "DELIVERY_STAFF", permissions: ["delivery.rider"] }), "/my-deliveries");
  assert.equal(landingPathFor({ roleName: "CASHIER", permissions: ["orders.create"] }), "/dashboard");
});
