import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTheme } from "./theme-toggle.ts";

test("a dark OS on the 'system' theme toggles to light on the first click", () => {
  assert.equal(nextTheme("dark"), "light");
});

test("a light OS on the 'system' theme toggles to dark on the first click", () => {
  assert.equal(nextTheme("light"), "dark");
});

test("before the resolved theme is known, the toggle falls back to dark", () => {
  assert.equal(nextTheme(undefined), "dark");
});
