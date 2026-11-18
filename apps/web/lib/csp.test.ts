import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContentSecurityPolicy } from "./csp.ts";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values] as [string, string[]];
    }),
  );
}

test("production policy locks everything to self except what Next and the app need", () => {
  const d = directives(buildContentSecurityPolicy({ dev: false }));
  assert.deepEqual(d.get("default-src"), ["'self'"]);
  assert.deepEqual(d.get("script-src"), ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(d.get("style-src"), ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(d.get("connect-src"), ["'self'"]);
  assert.deepEqual(d.get("object-src"), ["'none'"]);
  assert.deepEqual(d.get("base-uri"), ["'self'"]);
  assert.deepEqual(d.get("form-action"), ["'self'"]);
  assert.deepEqual(d.get("frame-ancestors"), ["'self'"]);
  assert.ok(d.get("img-src")?.includes("data:") && d.get("img-src")?.includes("blob:"));
  assert.ok(d.get("img-src")?.includes("https://tile.openstreetmap.org"));
  assert.ok(!d.get("script-src")?.includes("'unsafe-eval'"));
});

test("dev policy additionally allows eval and the HMR websocket", () => {
  const d = directives(buildContentSecurityPolicy({ dev: true }));
  assert.ok(d.get("script-src")?.includes("'unsafe-eval'"));
  assert.ok(d.get("connect-src")?.includes("ws:"));
});

test("an explicit realtime origin is allowed in connect-src (http -> ws too)", () => {
  const d = directives(buildContentSecurityPolicy({ dev: false, wsUrl: "https://rt.example.com/path" }));
  assert.ok(d.get("connect-src")?.includes("https://rt.example.com"));
  assert.ok(d.get("connect-src")?.includes("wss://rt.example.com"));
});

test("a wss:// realtime url is allowed too (ws -> http)", () => {
  const d = directives(buildContentSecurityPolicy({ dev: false, wsUrl: "wss://rt.example.com" }));
  assert.ok(d.get("connect-src")?.includes("wss://rt.example.com"));
  assert.ok(d.get("connect-src")?.includes("https://rt.example.com"));
});

test("a non-web scheme realtime url is ignored", () => {
  const d = directives(buildContentSecurityPolicy({ dev: false, wsUrl: "ftp://rt.example.com" }));
  assert.deepEqual(d.get("connect-src"), ["'self'"]);
});

test("a malformed realtime url is ignored", () => {
  const d = directives(buildContentSecurityPolicy({ dev: false, wsUrl: "not a url" }));
  assert.deepEqual(d.get("connect-src"), ["'self'"]);
});
