import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRiderLocation, patchDriverLocation, deliveryPins, riderMarkers, STATUS_COLOR, type RiderMarker } from "./rider-map.ts";

const base = (o: Partial<RiderMarker> = {}): RiderMarker => ({
  id: "r1", name: "Asha", lat: 10, lng: 20, at: "2026-11-03T10:00:00.000Z", activeDeliveries: 1, ...o,
});

test("riderMarkers keeps only on-duty riders that have a position", () => {
  const out = riderMarkers([
    { id: "a", name: "A", phone: null, riderOnline: true, riderLat: 1, riderLng: 2, riderLocationAt: "t", activeDeliveries: 2 },
    { id: "b", name: "B", phone: null, riderOnline: false, riderLat: 1, riderLng: 2, riderLocationAt: "t", activeDeliveries: 0 },
    { id: "c", name: "C", phone: null, riderOnline: true, riderLat: null, riderLng: null, riderLocationAt: null, activeDeliveries: 0 },
  ]);
  assert.deepEqual(out.map((m) => m.id), ["a"]);
  assert.equal(out[0].activeDeliveries, 2);
});

test("applyRiderLocation moves an existing rider without touching others", () => {
  const next = applyRiderLocation([base(), base({ id: "r2", name: "Ben" })], { id: "r1", lat: 11, lng: 21, at: "2026-11-03T10:01:00.000Z" });
  assert.equal(next[0].lat, 11);
  assert.equal(next[0].lng, 21);
  assert.equal(next[1].lat, 10);
});

test("applyRiderLocation ignores unknown riders and stale or invalid updates", () => {
  const prev = [base()];
  assert.equal(applyRiderLocation(prev, { id: "zz", lat: 1, lng: 1, at: "2026-11-03T11:00:00.000Z" }), prev);
  assert.equal(applyRiderLocation(prev, { id: "r1", lat: 1, lng: 1, at: "2026-11-03T09:00:00.000Z" }), prev);
  assert.equal(applyRiderLocation(prev, { id: "r1", lat: 999, lng: 1, at: "2026-11-03T11:00:00.000Z" }), prev);
});

test("deliveryPins pins only active deliveries with coordinates, coloured by status", () => {
  const o = (id: string, s: string, lat: number | null) =>
    ({ id, orderNumber: id, deliveryStatus: s, deliveryLat: lat, deliveryLng: lat, deliveryAddress: "x", guestName: null }) as never;
  const pins = deliveryPins([o("1", "UNASSIGNED", 5), o("2", "PICKED_UP", 6), o("3", "DELIVERED", 7), o("4", "ASSIGNED", null)]);
  assert.deepEqual(pins.map((p) => p.id), ["1", "2"]);
  assert.equal(pins[0].color, STATUS_COLOR.UNASSIGNED);
  assert.notEqual(STATUS_COLOR.UNASSIGNED, STATUS_COLOR.PICKED_UP);
});

test("patchDriverLocation updates the cached driver and ignores older pushes", () => {
  const d = { id: "r1", name: "A", phone: null, riderOnline: true, riderLat: 1, riderLng: 2, riderLocationAt: "2026-11-03T10:00:00.000Z", activeDeliveries: 0 };
  const moved = patchDriverLocation([d], { id: "r1", lat: 3, lng: 4, at: "2026-11-03T10:05:00.000Z" })!;
  assert.equal(moved[0].riderLat, 3);
  const same = [d];
  assert.equal(patchDriverLocation(same, { id: "r1", lat: 3, lng: 4, at: "2026-11-03T09:00:00.000Z" }), same);
  assert.equal(patchDriverLocation(undefined, { id: "r1", lat: 3, lng: 4, at: "x" }), undefined);
});
