import assert from "node:assert/strict";
import { test } from "node:test";
import { previewLayout } from "./label-preview.ts";

test("lays out title, price, meta and barcode top to bottom", () => {
  const items = previewLayout(
    { title: "Tea", price: "₹10", barcode: "123", expiry: "2027-01-02" },
    30,
  );
  assert.deepEqual(
    items.map((i) => [i.kind, i.text, i.y, i.h]),
    [
      ["text", "Tea", 16, 32],
      ["text", "₹10", 56, 40],
      ["text", "EXP:2027-01-02", 104, 24],
      ["barcode", "123", 136, 64],
    ],
  );
});

test("omits optional rows", () => {
  assert.equal(previewLayout({ title: "Only" }, 30).length, 1);
});
