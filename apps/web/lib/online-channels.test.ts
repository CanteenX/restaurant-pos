import assert from "node:assert/strict";
import { test } from "node:test";
import { channelHealth, itemMapPatch, type ChannelConnectionLike } from "./online-channels.ts";

const base: ChannelConnectionLike = {
  enabled: true,
  status: "CONNECTED",
  lastError: null,
  lastOrderAt: "2026-11-05T08:00:00.000Z",
  outbox: { pending: 0, dead: 0 },
};

test("not set up is off", () => {
  assert.deepEqual(channelHealth(null), {
    health: "off",
    tone: "muted",
    labelKey: "settings.integrations.health.off",
    retriesPending: 0,
    failed: 0,
    lastOrderAt: null,
  });
});

test("connected with nothing wrong is live and carries the last order", () => {
  const h = channelHealth(base);
  assert.equal(h.health, "live");
  assert.equal(h.tone, "success");
  assert.equal(h.labelKey, "settings.integrations.health.live");
  assert.equal(h.lastOrderAt, base.lastOrderAt);
});

test("switched off wins over everything else", () => {
  const h = channelHealth({ ...base, enabled: false, status: "DISABLED", outbox: { pending: 2, dead: 3 } });
  assert.equal(h.health, "disabled");
  assert.equal(h.tone, "muted");
  // Queue counts are still reported so the owner sees what is stuck.
  assert.equal(h.retriesPending, 2);
  assert.equal(h.failed, 3);
});

test("auth or sync errors are errors", () => {
  assert.equal(channelHealth({ ...base, status: "AUTH_EXPIRED" }).health, "error");
  const h = channelHealth({ ...base, status: "SYNC_ERROR" });
  assert.equal(h.health, "error");
  assert.equal(h.tone, "danger");
});

test("failed platform updates or a failed order need attention", () => {
  const dead = channelHealth({ ...base, outbox: { pending: 1, dead: 2 } });
  assert.equal(dead.health, "attention");
  assert.equal(dead.tone, "warning");
  assert.equal(dead.retriesPending, 1);
  assert.equal(dead.failed, 2);
  assert.equal(channelHealth({ ...base, lastError: "Items not found on the menu: X" }).health, "attention");
});

test("pending retries alone do not raise an alarm", () => {
  const h = channelHealth({ ...base, outbox: { pending: 4, dead: 0 } });
  assert.equal(h.health, "live");
  assert.equal(h.retriesPending, 4);
});

test("saved but never heard from is waiting", () => {
  const h = channelHealth({ ...base, status: "PENDING_CONFIGURATION", lastOrderAt: null, lastError: "Waiting" });
  assert.equal(h.health, "waiting");
  assert.equal(h.tone, "warning");
});

test("missing optional fields from an older server are tolerated", () => {
  const h = channelHealth({ enabled: true, status: "CONNECTED", lastError: null });
  assert.equal(h.health, "live");
  assert.equal(h.lastOrderAt, null);
  assert.equal(h.retriesPending, 0);
});

test("itemMapPatch sends only what changed", () => {
  const stored = { a: "Z-1", b: "Z-2", c: "Z-3" };
  assert.deepEqual(itemMapPatch(stored, { a: "Z-1", b: " Z-20 ", c: "  ", d: "Z-4", e: "" }), {
    set: { b: "Z-20", d: "Z-4" },
    remove: ["c"],
  });
});

test("itemMapPatch never removes dishes the form did not show", () => {
  // `x` is mapped on the server but not in this form (another branch): untouched.
  assert.deepEqual(itemMapPatch({ a: "Z-1", x: "Z-9" }, { a: "Z-1" }), null);
});

test("itemMapPatch returns null when nothing changed", () => {
  assert.equal(itemMapPatch({}, { a: "" }), null);
});
