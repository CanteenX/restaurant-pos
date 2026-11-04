import assert from "node:assert/strict";
import { test } from "node:test";
import { convertPreview, enterableUnits } from "./unit-preview.ts";

test("global units convert without pack sizes", () => {
  assert.equal(convertPreview(500, "G", "KG", []), 0.5);
  assert.equal(convertPreview(2, "KG", "G", []), 2000);
  assert.equal(convertPreview(1.5, "L", "ML", []), 1500);
  assert.equal(convertPreview(2, "DOZEN", "PIECE", []), 24);
});

test("same unit is identity", () => {
  assert.equal(convertPreview(3.25, "KG", "KG", []), 3.25);
});

test("pack sizes convert via factor", () => {
  assert.equal(convertPreview(2, "PACK", "KG", [{ unit: "PACK", factor: 25 }]), 50);
});

test("rounds half-up to 3dp", () => {
  assert.equal(convertPreview(1, "G", "KG", []), 0.001);
  assert.equal(convertPreview(1, "PIECE", "DOZEN", []), 0.083);
});

test("unconvertible or too-small quantity yields null", () => {
  assert.equal(convertPreview(1, "PACK", "KG", []), null);
  assert.equal(convertPreview(0.0001, "G", "KG", []), null);
  assert.equal(convertPreview(Number.NaN, "G", "KG", []), null);
});

test("enterableUnits lists base, compatible globals and pack sizes", () => {
  assert.deepEqual(enterableUnits("KG", []), ["KG", "G"]);
  assert.deepEqual(enterableUnits("KG", [{ unit: "PACK", factor: 25 }]), ["KG", "G", "PACK"]);
  assert.deepEqual(enterableUnits("PIECE", []), ["PIECE", "DOZEN"]);
  assert.deepEqual(enterableUnits("BOX", []), ["BOX"]);
});
