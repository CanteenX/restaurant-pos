import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeReferralCode, referralStatusLabel, isPlausibleReferralCode } from "./referrals.ts";

test("normalizeReferralCode trims and uppercases", () => {
  assert.equal(normalizeReferralCode("  ab3dk9z "), "AB3DK9Z");
});

test("isPlausibleReferralCode matches 6-12 alphanumerics", () => {
  assert.equal(isPlausibleReferralCode("AB3DK9Z"), true);
  assert.equal(isPlausibleReferralCode("abc"), false);
  assert.equal(isPlausibleReferralCode("AB-DK9Z1"), false);
});

test("referralStatusLabel", () => {
  assert.equal(referralStatusLabel("PENDING"), "Waiting for first order");
  assert.equal(referralStatusLabel("REWARDED"), "Rewarded");
  assert.equal(referralStatusLabel("OTHER"), "OTHER");
});
