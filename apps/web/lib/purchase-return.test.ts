import assert from "node:assert/strict";
import { test } from "node:test";
import { returnableQuantities, validateReturnQuantities } from "./purchase-return.ts";

const grnItems = [
  { id: "a", quantity: "10" },
  { id: "b", quantity: "2.5" },
];

test("returnable = received minus earlier returns", () => {
  const prior = [
    { goodsReceiptId: "g1", items: [{ goodsReceiptItemId: "a", quantity: "3" }] },
    { goodsReceiptId: "g1", items: [{ goodsReceiptItemId: "a", quantity: "1.5" }] },
  ];
  assert.deepEqual(returnableQuantities(grnItems, prior), { a: 5.5, b: 2.5 });
});

test("returnable never goes below zero and ignores unknown items", () => {
  const prior = [{ goodsReceiptId: "g1", items: [{ goodsReceiptItemId: "b", quantity: "9" }, { goodsReceiptItemId: "zz", quantity: "1" }] }];
  assert.deepEqual(returnableQuantities(grnItems, prior), { a: 10, b: 0 });
});

test("validate: blank/zero lines are skipped, valid lines pass", () => {
  const r = validateReturnQuantities({ a: "4", b: "" }, { a: 5.5, b: 2.5 });
  assert.deepEqual(r, { ok: true, lines: [{ goodsReceiptItemId: "a", quantity: 4 }], errors: {} });
});

test("validate: over-limit, negative and NaN are errors", () => {
  const r = validateReturnQuantities({ a: "6", b: "-1" }, { a: 5.5, b: 2.5 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, { a: "max", b: "invalid" });
});

test("validate: nothing entered is not ok", () => {
  assert.equal(validateReturnQuantities({ a: "0" }, { a: 5 }).ok, false);
});
