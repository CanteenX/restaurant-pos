import assert from "node:assert/strict";
import { test } from "node:test";
import { giftCardBadgeVariant, giftCardStatus, issueAmountHint, issueAmountHintCode, parseIssueAmount } from "./gift-card-format.ts";

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

test("issueAmountHint is empty for blank or valid input, explains invalid input", () => {
  assert.equal(issueAmountHint(""), null);
  assert.equal(issueAmountHint("  "), null);
  assert.equal(issueAmountHint("500"), null);
  assert.match(issueAmountHint("abc") ?? "", /number/i);
  assert.match(issueAmountHint("0") ?? "", /greater than 0/i);
  assert.match(issueAmountHint("-5") ?? "", /greater than 0/i);
});

test("giftCardBadgeVariant differs per status", () => {
  assert.equal(giftCardBadgeVariant("Active"), "default");
  assert.equal(giftCardBadgeVariant("Used up"), "secondary");
  assert.equal(giftCardBadgeVariant("Disabled"), "destructive");
});

test("issueAmountHintCode returns a translatable code", () => {
  assert.equal(issueAmountHintCode(""), null);
  assert.equal(issueAmountHintCode("500"), null);
  assert.equal(issueAmountHintCode("abc"), "number");
  assert.equal(issueAmountHintCode("0"), "positive");
});
