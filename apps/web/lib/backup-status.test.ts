import assert from "node:assert/strict";
import { test } from "node:test";
import { backupWarning } from "./backup-status.ts";

const now = new Date("2026-11-04T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

test("fresh verified backup -> no warning", () => {
  assert.equal(backupWarning({ backups: [{ status: "VERIFIED", createdAt: hoursAgo(5) }] }, now), null);
});

test("fresh local backup -> no warning", () => {
  assert.equal(backupWarning({ localLastSuccessAt: hoursAgo(2) }, now), null);
});

test("newest of several sources counts", () => {
  const w = backupWarning(
    { backups: [{ status: "VERIFIED", createdAt: hoursAgo(100) }], localLastSuccessAt: hoursAgo(1) },
    now,
  );
  assert.equal(w, null);
});

test("stale good backup -> stale warning with last good time", () => {
  const w = backupWarning({ backups: [{ status: "VERIFIED", createdAt: hoursAgo(60) }] }, now);
  assert.equal(w?.kind, "stale");
  assert.equal(w?.lastGoodAt, hoursAgo(60));
});

test("never backed up -> none warning", () => {
  const w = backupWarning({ backups: [] }, now);
  assert.equal(w?.kind, "none");
  assert.equal(w?.lastGoodAt, null);
});

test("latest run failed warns even if last good is recent", () => {
  const w = backupWarning(
    {
      backups: [
        { status: "FAILED", createdAt: hoursAgo(1) },
        { status: "VERIFIED", createdAt: hoursAgo(10) },
      ],
    },
    now,
  );
  assert.equal(w?.kind, "failed");
  assert.equal(w?.lastGoodAt, hoursAgo(10));
});

test("local failure newer than local success warns", () => {
  const w = backupWarning({ localLastSuccessAt: hoursAgo(10), localLastFailureAt: hoursAgo(2) }, now);
  assert.equal(w?.kind, "failed");
});

test("old failure superseded by newer success -> no warning", () => {
  assert.equal(backupWarning({ localLastSuccessAt: hoursAgo(1), localLastFailureAt: hoursAgo(9) }, now), null);
});

test("pending newest backup is ignored for failure", () => {
  assert.equal(
    backupWarning(
      { backups: [{ status: "PENDING", createdAt: hoursAgo(0.1) }, { status: "VERIFIED", createdAt: hoursAgo(3) }] },
      now,
    ),
    null,
  );
});

test("custom threshold", () => {
  const w = backupWarning({ backups: [{ status: "VERIFIED", createdAt: hoursAgo(10) }] }, now, 6);
  assert.equal(w?.kind, "stale");
});
