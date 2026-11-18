import assert from "node:assert/strict";
import { test } from "node:test";
import { labelsFromIngredients, labelsFromMenuItems } from "./label-batch.ts";

test("menu labels use the server price and skip inactive items", () => {
  const out = labelsFromMenuItems([
    { id: "a", name: "Masala Chai", price: "120.00", isActive: true },
    { id: "b", name: "Old", price: "10", isActive: false },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Masala Chai");
  assert.ok(out[0].price?.includes("120"));
});

test("menu label titles are clipped to 40 chars", () => {
  const out = labelsFromMenuItems([{ id: "a", name: "x".repeat(60), price: "1", isActive: true }]);
  assert.equal(out[0].title.length, 40);
});

test("ingredient labels map name and printable sku to title and barcode", () => {
  const out = labelsFromIngredients([
    { id: "a", name: "Flour", sku: "FL-01", isActive: true },
    { id: "b", name: "Salt", sku: null, isActive: true },
    { id: "c", name: "Bad", sku: "é€", isActive: true },
  ]);
  assert.deepEqual(out, [{ title: "Flour", barcode: "FL-01" }, { title: "Salt" }, { title: "Bad" }]);
});
