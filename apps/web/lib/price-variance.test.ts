import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_VARIANCE_THRESHOLD, filterVarianceRows, isHighVariance, rowHasHighVariance } from "./price-variance.ts";

test("isHighVariance flags absolute variance at or above the threshold", () => {
  assert.equal(isHighVariance(10, 10), true);
  assert.equal(isHighVariance(-12.5, 10), true);
  assert.equal(isHighVariance(9.99, 10), false);
  assert.equal(isHighVariance(null, 10), false);
  assert.equal(isHighVariance(50, 0), false, "threshold 0 disables highlighting");
});

test("rowHasHighVariance checks both variance columns", () => {
  const row = ["Tomato", "Fresh", "kg", 3, 60, 55, 50, 60, 50, 20, 55, 9];
  assert.equal(rowHasHighVariance(row, DEFAULT_VARIANCE_THRESHOLD), true);
  assert.equal(rowHasHighVariance(["Tomato", "Fresh", "kg", 1, 5, 5, 5, 5, null, null, null, null], 10), false);
});

test("filterVarianceRows matches ingredient or supplier text, optionally only high variance", () => {
  const a = ["Tomato", "Fresh Farm", "kg", 2, 60, 55, 50, 60, 50, 20, null, null];
  const b = ["Onion", "Metro", "kg", 2, 30, 30, 30, 30, 30, 0, null, null];
  assert.deepEqual(filterVarianceRows([a, b], { query: "farm", onlyHigh: false, threshold: 10 }), [a]);
  assert.deepEqual(filterVarianceRows([a, b], { query: "", onlyHigh: false, threshold: 10 }), [a, b]);
  assert.deepEqual(filterVarianceRows([a, b], { query: "", onlyHigh: true, threshold: 10 }), [a]);
  assert.deepEqual(filterVarianceRows([a, b], { query: "ONION", onlyHigh: true, threshold: 10 }), []);
});
