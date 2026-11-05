import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPurchaseRequest, parseEditedQuantity, type ReorderGroup } from "./reorder.ts";

const group: ReorderGroup = {
  supplierId: "s1",
  supplierName: "Metro",
  suggestions: [
    { ingredientId: "i1", name: "Onion", unit: "kg", suggestedQuantity: 12 },
    { ingredientId: "i2", name: "Oil", unit: "l", suggestedQuantity: 5.5 },
  ],
};

test("parseEditedQuantity accepts positive numbers and rejects junk", () => {
  assert.equal(parseEditedQuantity("7"), 7);
  assert.equal(parseEditedQuantity(" 2.5 "), 2.5);
  assert.equal(parseEditedQuantity("0"), null);
  assert.equal(parseEditedQuantity("-3"), null);
  assert.equal(parseEditedQuantity(""), null);
  assert.equal(parseEditedQuantity("abc"), null);
  assert.equal(parseEditedQuantity("Infinity"), null);
});

test("buildPurchaseRequest uses suggested quantities when nothing is edited", () => {
  assert.deepEqual(buildPurchaseRequest(group, {}), {
    items: [
      { ingredientId: "i1", quantityRequested: 12 },
      { ingredientId: "i2", quantityRequested: 5.5 },
    ],
  });
});

test("buildPurchaseRequest applies edits and drops lines with 0 or invalid quantity", () => {
  assert.deepEqual(buildPurchaseRequest(group, { i1: "20", i2: "0" }), {
    items: [{ ingredientId: "i1", quantityRequested: 20 }],
  });
  assert.deepEqual(buildPurchaseRequest(group, { i1: "x", i2: "" }), { items: [] });
});
