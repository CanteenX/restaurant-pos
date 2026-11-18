import assert from "node:assert/strict";
import { test } from "node:test";
import { binDayHour, cellColor, contrastRatio, intensity, legendSteps, rankTables, DAY_LABELS } from "./heatmap.ts";

const rows: (string | number | null)[][] = [
  ["Mon", "09:00", 4, 100],
  ["Mon", "09:00", 2, 50.5],
  ["Fri", "20:00", 10, 900],
  ["Bogus", "20:00", 1, 1],
  ["Sun", "xx", 1, 1],
];

test("binDayHour builds a 7x24 grid, merges duplicates, ignores bad rows", () => {
  const g = binDayHour(rows, "orders");
  assert.equal(g.cells.length, 7);
  assert.equal(g.cells[0].length, 24);
  assert.equal(g.cells[1][9], 6); // Mon 09:00
  assert.equal(g.cells[5][20], 10); // Fri 20:00
  assert.equal(g.max, 10);
  assert.equal(binDayHour(rows, "sales").cells[1][9], 150.5);
});

test("DAY_LABELS starts Sunday to match the backend", () => {
  assert.equal(DAY_LABELS[0], "Sun");
});

test("intensity is clamped 0..1 and safe when max is 0", () => {
  assert.equal(intensity(5, 10), 0.5);
  assert.equal(intensity(20, 10), 1);
  assert.equal(intensity(0, 0), 0);
});

test("every colour step keeps readable text (contrast >= 4.5)", () => {
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const { background, color } = cellColor(t);
    assert.ok(contrastRatio(background, color) >= 4.5, `step ${t}`);
  }
});

test("legendSteps returns ascending labelled steps", () => {
  const s = legendSteps(100, 5);
  assert.equal(s.length, 5);
  assert.equal(s[0].label, "0");
  assert.equal(s[4].label, "100");
});

test("rankTables sorts by orders desc and computes share of the busiest", () => {
  const r = rankTables([["T2", 3, 20], ["T1", 9, 30], ["T3", 0, 0]]);
  assert.deepEqual(r.map((x) => x.name), ["T1", "T2", "T3"]);
  assert.equal(r[0].t, 1);
  assert.equal(r[1].t, 3 / 9);
});
