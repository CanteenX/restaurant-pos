import assert from "node:assert/strict";
import { test } from "node:test";
import { benefitSummary, expiryLabel, upgradeTiers } from "./membership-format.ts";

const none = { tierId: null, tierName: null, discountPercent: 0, pointsMultiplier: 1, expiresAt: null };
const gold = { tierId: "g", tierName: "Gold", discountPercent: 10, pointsMultiplier: 2, expiresAt: null };

test("benefitSummary is empty without a tier", () => {
  assert.equal(benefitSummary(none), "");
});

test("benefitSummary lists discount and points multiplier, skipping neutral values", () => {
  assert.equal(benefitSummary(gold), "10% off · 2× points");
  assert.equal(benefitSummary({ ...gold, pointsMultiplier: 1 }), "10% off");
  assert.equal(benefitSummary({ ...gold, discountPercent: 0 }), "2× points");
  assert.equal(benefitSummary({ ...gold, discountPercent: 7.5, pointsMultiplier: 1.5 }), "7.5% off · 1.5× points");
});

test("expiryLabel handles no expiry, future and past dates", () => {
  const now = new Date("2026-01-10T00:00:00Z");
  assert.equal(expiryLabel(null, now), "No expiry");
  assert.equal(expiryLabel("2026-01-10T12:00:00Z", now), "Expires today");
  assert.equal(expiryLabel("2026-01-15T00:00:00Z", now), "Expires in 5 days");
  assert.equal(expiryLabel("2026-01-11T00:00:00Z", now), "Expires in 1 day");
  assert.equal(expiryLabel("2026-01-01T00:00:00Z", now), "Expired");
});

test("upgradeTiers keeps only active tiers ranked above the current one, best last", () => {
  const tiers = [
    { id: "a", name: "A", rank: 1, active: true },
    { id: "b", name: "B", rank: 2, active: true },
    { id: "c", name: "C", rank: 3, active: false },
    { id: "d", name: "D", rank: 4, active: true },
  ];
  assert.deepEqual(upgradeTiers(tiers, 1).map((t) => t.id), ["b", "d"]);
  assert.deepEqual(upgradeTiers(tiers, null).map((t) => t.id), ["a", "b", "d"]);
});
