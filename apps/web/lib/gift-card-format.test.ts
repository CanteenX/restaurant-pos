import assert from "node:assert/strict";
import { test } from "node:test";
import { giftCardStatus, parseIssueAmount } from "./gift-card-format.ts";

test("inactive card is Disabled, zero balance is Used up, else Active", () => {
  assert.equal(giftCardStatus({ isActive: false, balance: "50.00" }), "Disabled");
  assert.equal(giftCardStatus({ isActive: true, balance: "0.00" }), "Used up");
  assert.equal(giftCardStatus({ isActive: true, balance: "25.50" }), "Active");
});

test("parseIssueAmount accepts positive amounts rounded to 2 dp", () => {
  assert.equal(parseIssueAmount("500"), 500);
  assert.equal(parseIssueAmount(" 12.345 "), 12.35);
});

test("parseIssueAmount rejects empty, zero, negative and non-numeric", () => {
  for (const v of ["", "0", "-5", "abc", "NaN"]) assert.equal(parseIssueAmount(v), null);
});
