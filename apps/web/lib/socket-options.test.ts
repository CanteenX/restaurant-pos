import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSocketTransports, socketOptions } from "./socket-options.ts";

test("unset or blank keeps socket.io's default (polling then websocket upgrade)", () => {
  for (const raw of [undefined, "", "   ", ","]) {
    assert.deepEqual(parseSocketTransports(raw), { transports: ["polling", "websocket"], upgrade: true });
  }
});

test("polling only disables the websocket upgrade", () => {
  assert.deepEqual(parseSocketTransports("polling"), { transports: ["polling"], upgrade: false });
});

test("a comma list is trimmed, lower-cased and de-duplicated, order kept", () => {
  assert.deepEqual(parseSocketTransports(" WebSocket , polling,polling"), {
    transports: ["websocket", "polling"],
    upgrade: true,
  });
});

test("websocket only", () => {
  assert.deepEqual(parseSocketTransports("websocket"), { transports: ["websocket"], upgrade: true });
});

test("invalid values fall back to the default", () => {
  for (const raw of ["webtransport", "polling,carrier-pigeon", "xhr", "true"]) {
    assert.deepEqual(parseSocketTransports(raw), { transports: ["polling", "websocket"], upgrade: true }, raw);
  }
});

test("socketOptions adds the branch query and credentials", () => {
  const opts = socketOptions("b1", "polling");
  assert.deepEqual(opts.query, { branchId: "b1" });
  assert.equal(opts.withCredentials, true);
  assert.deepEqual(opts.transports, ["polling"]);
  assert.equal(opts.upgrade, false);
});
