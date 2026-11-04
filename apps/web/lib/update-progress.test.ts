import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createTranslator, type Dictionary } from "./i18n/translate.ts";
import { describeProgress } from "./update-progress.ts";

const load = (locale: string): Dictionary =>
  JSON.parse(readFileSync(new URL(`./i18n/dictionaries/${locale}.json`, import.meta.url), "utf8"));
const t = createTranslator({ en: load("en"), es: load("es") }, "en");

test("pulling and restarting keep waiting", () => {
  assert.equal(describeProgress({ state: "pulling" }, t).kind, "wait");
  assert.equal(describeProgress({ state: "restarting", step: "checking x" }, t).kind, "wait");
});

test("done reloads", () => {
  assert.equal(describeProgress({ state: "done" }, t).kind, "done");
});

test("error reuses settings.updates.failed: the old version is still running", () => {
  const p = describeProgress({ state: "error", error: "pull failed: no internet" }, t);
  assert.equal(p.kind, "failed");
  assert.equal(p.message, "Update failed: pull failed: no internet. The old version is still running.");
  assert.match(describeProgress({ state: "error" }, t).message ?? "", /unknown error/);
});

test("rolled_back names both versions and the reason", () => {
  const p = describeProgress(
    {
      state: "rolled_back",
      version: "1.0.2",
      rolledBackTo: "1.0.1",
      error: "nventra-pos-web failed its health check (unhealthy)",
    },
    t,
  );
  assert.equal(p.kind, "rolled_back");
  assert.equal(
    p.message,
    "Update to 1.0.2 failed and was rolled back automatically — 1.0.1 is running. Reason: nventra-pos-web failed its health check (unhealthy)",
  );
});

test("rolled_back without details still reads well", () => {
  const p = describeProgress({ state: "rolled_back" }, t);
  assert.equal(p.message, "Update failed and was rolled back automatically — the previous version is running.");
});

test("idle / unknown / unavailable are idle", () => {
  for (const state of ["idle", "unknown", "unavailable"]) assert.equal(describeProgress({ state }, t).kind, "idle");
});

test("rollback_failed does not claim the old version is running and asks for manual action", () => {
  const p = describeProgress(
    {
      state: "rollback_failed",
      version: "1.0.2",
      error: "nventra-pos-web failed its health check (unhealthy); rollback failed: restored nventra-pos-backend failed its health check (unhealthy)",
    },
    t,
  );
  assert.equal(p.kind, "rollback_failed");
  assert.doesNotMatch(p.message ?? "", /still running|is running/);
  assert.match(p.message ?? "", /could not be rolled back/);
  assert.match(p.message ?? "", /docker compose up -d/);
  assert.match(p.message ?? "", /restore from a backup/);
  assert.match(p.message ?? "", /restored nventra-pos-backend failed/);
});

test("messages come from the active locale's dictionary", () => {
  const es = createTranslator({ en: load("en"), es: load("es") }, "es");
  const p = describeProgress({ state: "rolled_back", version: "1.0.2", rolledBackTo: "1.0.1" }, es);
  assert.equal(p.message, es("settings.updates.rolledBack", { version: "1.0.2", previous: "1.0.1" }));
  assert.notEqual(p.message, describeProgress({ state: "rolled_back", version: "1.0.2", rolledBackTo: "1.0.1" }, t).message);
});
