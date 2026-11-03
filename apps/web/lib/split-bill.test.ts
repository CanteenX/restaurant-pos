import assert from "node:assert/strict";
import { test } from "node:test";
import { apportion, guestShares, splitEqually, unassignedLines, type SplitLine } from "./split-bill.ts";

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

test("equal split always adds up to the bill; the remainder paisa goes to the first guests", () => {
  assert.deepEqual(splitEqually(100, 3), [33.34, 33.33, 33.33]);
  assert.deepEqual(splitEqually(0.02, 3), [0.01, 0.01, 0]);
  assert.equal(sum(splitEqually(1234.57, 7)), 1234.57);
  assert.deepEqual(splitEqually(50, 1), [50]);
});

test("apportion splits an amount by weight and never loses a paisa", () => {
  const parts = apportion(100, [1, 1, 1]);
  assert.equal(sum(parts), 100);
  assert.deepEqual(parts, [33.34, 33.33, 33.33]);
  assert.deepEqual(apportion(10, [3, 1]), [7.5, 2.5]);
  assert.deepEqual(apportion(10, [0, 0]), [10, 0]);
});

const LINES: SplitLine[] = [
  { id: "a", total: 120 },
  { id: "b", total: 80 },
  { id: "c", total: 50 },
];

test("whole lines assigned to guests; discount/tax/tip spread in proportion", () => {
  // Bill: subtotal 250, 10% off, 5% tax already inside, tip 10 -> total 235
  const shares = guestShares({
    guests: 2,
    lines: LINES,
    assignments: { a: [1, 0], b: [0, 1], c: [0, 1] },
    bill: { subtotal: 250, taxAmount: 12, totalDue: 235 },
  });
  assert.equal(shares.length, 2);
  assert.equal(sum(shares.map((s) => s.total)), 235);
  assert.equal(sum(shares.map((s) => s.tax)), 12);
  assert.equal(sum(shares.map((s) => s.subtotal)), 250);
  assert.equal(shares[0].subtotal, 120);
  assert.equal(shares[1].subtotal, 130);
  assert.equal(shares[0].total, 112.8); // 235 * 120/250
});

test("a line can be shared by fractions between guests", () => {
  const shares = guestShares({
    guests: 3,
    lines: [{ id: "x", total: 100 }],
    assignments: { x: [1, 1, 1] },
    bill: { subtotal: 100, taxAmount: 5, totalDue: 100 },
  });
  assert.deepEqual(shares.map((s) => s.total), [33.34, 33.33, 33.33]);
  assert.equal(sum(shares.map((s) => s.tax)), 5);
});

test("unassigned lines are shared equally and shares still add up to the bill", () => {
  const shares = guestShares({
    guests: 2,
    lines: LINES,
    assignments: { a: [1, 0] },
    bill: { subtotal: 250, taxAmount: 0, totalDue: 250 },
  });
  assert.equal(sum(shares.map((s) => s.total)), 250);
  assert.deepEqual(shares.map((s) => s.subtotal), [185, 65]);
  assert.deepEqual(unassignedLines(LINES, { a: [1, 0] }), ["b", "c"]);
});

test("nothing assigned falls back to an equal split", () => {
  const shares = guestShares({
    guests: 3,
    lines: LINES,
    assignments: {},
    bill: { subtotal: 250, taxAmount: 10, totalDue: 250 },
  });
  assert.deepEqual(shares.map((s) => s.total), [83.34, 83.33, 83.33]);
  assert.equal(sum(shares.map((s) => s.tax)), 10);
});

test("is deterministic for equal inputs", () => {
  const input = {
    guests: 3, lines: LINES, assignments: { a: [1, 1, 1], b: [1, 1, 0], c: [0, 0, 1] },
    bill: { subtotal: 250, taxAmount: 11.9, totalDue: 247.77 },
  };
  assert.deepEqual(guestShares(input), guestShares(input));
  assert.equal(sum(guestShares(input).map((s) => s.total)), 247.77);
});
