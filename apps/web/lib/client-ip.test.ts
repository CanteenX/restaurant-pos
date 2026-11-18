import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { installClientIpHook, parseHops, resolveClientIp } from "./client-ip.mjs";

test("with no trusted hops the TCP peer wins and a client's header is dropped", () => {
  assert.equal(resolveClientIp(undefined, "192.168.1.20", 0), "192.168.1.20");
  assert.equal(resolveClientIp("1.2.3.4", "192.168.1.20", 0), "192.168.1.20");
  assert.equal(resolveClientIp("1.2.3.4, 5.6.7.8", "192.168.1.20", 0), "192.168.1.20");
});

test("one trusted hop (tunnel) takes the right-most forwarded entry only", () => {
  // cloudflared is the peer; Cloudflare appended the visitor on the right.
  assert.equal(resolveClientIp("203.0.113.9", "172.18.0.5", 1), "203.0.113.9");
  assert.equal(resolveClientIp("6.6.6.6, 203.0.113.9", "172.18.0.5", 1), "203.0.113.9");
  // Nothing forwarded: the peer is all we know.
  assert.equal(resolveClientIp(undefined, "172.18.0.5", 1), "172.18.0.5");
  assert.equal(resolveClientIp(" , ", "172.18.0.5", 2), "172.18.0.5");
});

test("repeated headers are joined in order", () => {
  assert.equal(resolveClientIp(["6.6.6.6", "203.0.113.9"], "172.18.0.5", 1), "203.0.113.9");
});

test("hops must be a whole number 0-5", () => {
  assert.equal(parseHops(undefined), 0);
  assert.equal(parseHops(""), 0);
  assert.equal(parseHops("2"), 2);
  for (const bad of ["true", "-1", "6", "1.5", "10.0.0.0/8"]) {
    assert.throws(() => parseHops(bad), /WEB_TRUST_PROXY/);
  }
});

test("the hook rewrites X-Forwarded-For on request and upgrade events", () => {
  class FakeServer extends EventEmitter {}
  installClientIpHook(FakeServer, 0);
  installClientIpHook(FakeServer, 0); // idempotent
  const server = new FakeServer();
  const seen: (string | string[] | undefined)[] = [];
  server.on("request", (req) => seen.push(req.headers["x-forwarded-for"]));
  server.on("upgrade", (req) => seen.push(req.headers["x-forwarded-for"]));
  const req = () => ({
    headers: { "x-forwarded-for": "6.6.6.6" } as Record<string, string | string[] | undefined>,
    socket: { remoteAddress: "192.168.1.20" },
  });
  server.emit("request", req(), {});
  server.emit("upgrade", req(), {}, Buffer.alloc(0));
  server.emit("other", req());
  assert.deepEqual(seen, ["192.168.1.20", "192.168.1.20"]);
});
