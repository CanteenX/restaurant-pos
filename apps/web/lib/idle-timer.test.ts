import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_IDLE_MINUTES,
  idleConfig,
  idleState,
  latestActivity,
  shouldRecordActivity,
} from "./idle-timer.ts";

const MIN = 60_000;
const cfg = { idleMs: 60 * MIN, warnMs: MIN };

test("config defaults to the server's 60 minute idle window with a 1 minute warning", () => {
  assert.equal(DEFAULT_IDLE_MINUTES, 60);
  assert.deepEqual(idleConfig(undefined), cfg);
  assert.deepEqual(idleConfig(""), cfg);
  assert.deepEqual(idleConfig("abc"), cfg);
  assert.deepEqual(idleConfig("-5"), cfg);
  assert.deepEqual(idleConfig("0"), cfg);
});

test("config honours a custom window and keeps the warning inside it", () => {
  assert.deepEqual(idleConfig("15"), { idleMs: 15 * MIN, warnMs: MIN });
  // A 2-minute window warns for the last 30 s, not the whole time.
  assert.deepEqual(idleConfig("2"), { idleMs: 2 * MIN, warnMs: 30_000 });
});

test("active until the warning window, then counts down, then expires", () => {
  const last = 1_000_000;
  assert.deepEqual(idleState(last, last, cfg), { phase: "active" });
  assert.deepEqual(idleState(last, last + 58 * MIN, cfg), { phase: "active" });
  assert.deepEqual(idleState(last, last + 59 * MIN, cfg), { phase: "warning", remainingMs: MIN });
  assert.deepEqual(idleState(last, last + 59 * MIN + 45_000, cfg), {
    phase: "warning",
    remainingMs: 15_000,
  });
  assert.deepEqual(idleState(last, last + 60 * MIN, cfg), { phase: "expired" });
  assert.deepEqual(idleState(last, last + 5 * 60 * MIN, cfg), { phase: "expired" });
});

test("a clock that moved backwards counts as fresh activity, never as expired", () => {
  assert.deepEqual(idleState(10 * MIN, 0, cfg), { phase: "active" });
});

test("latest activity is shared across tabs via storage", () => {
  // Another tab was used more recently: that keeps this tab alive too.
  assert.equal(latestActivity(1_000, "5000", 10_000), 5_000);
  // This tab is the most recent.
  assert.equal(latestActivity(8_000, "5000", 10_000), 8_000);
  // Missing or garbage storage falls back to this tab's own activity.
  assert.equal(latestActivity(1_000, null, 10_000), 1_000);
  assert.equal(latestActivity(1_000, "nope", 10_000), 1_000);
  // A value from the future (tampered, or another device's clock) is ignored
  // so it cannot postpone the logout indefinitely.
  assert.equal(latestActivity(1_000, String(10_000 + 2 * MIN), 10_000), 1_000);
});

test("activity writes to storage are throttled", () => {
  assert.equal(shouldRecordActivity(0, 10_000), true);
  assert.equal(shouldRecordActivity(10_000, 12_000), false);
  assert.equal(shouldRecordActivity(10_000, 15_000), true);
});
