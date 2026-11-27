import assert from "node:assert/strict";
import { test } from "node:test";
import { findBarcodeMatch } from "./barcode-scan.ts";

const items = [
  { id: "a", sku: "001", barcode: "001", isActive: true },
  { id: "b", sku: "B", barcode: "002", isActive: true },
  { id: "c", sku: "inactive", barcode: null, isActive: false },
];

test("exact matches retain leading zeroes and deduplicate one item", () => {
  assert.equal(findBarcodeMatch("001", items).kind, "match");
  assert.equal(findBarcodeMatch("1", items).kind, "missing");
  assert.equal(findBarcodeMatch("b", items).kind, "missing");
});

test("distinct cross-field matches block and inactive items never match", () => {
  assert.equal(findBarcodeMatch("001", [...items, { id: "d", sku: "001", barcode: null, isActive: true }]).kind, "duplicate");
  assert.equal(findBarcodeMatch("001", [...items, { id: "d", sku: "001", barcode: null, isActive: false }]).kind, "duplicate");
  assert.equal(findBarcodeMatch("inactive", items).kind, "missing");
});

test("empty, oversized and control-character scans are rejected", () => {
  for (const code of ["", "x".repeat(129), "a\nb"]) assert.equal(findBarcodeMatch(code, items).kind, "invalid");
});
