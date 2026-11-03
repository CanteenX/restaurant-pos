import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const load = (locale: string): Record<string, string> =>
  JSON.parse(
    readFileSync(new URL(`./dictionaries/${locale}.json`, import.meta.url), "utf8"),
  ) as Record<string, string>;

const en = load("en");
const enKeys = Object.keys(en).sort();

// Values that are legitimately identical in French: brand names, and words
// that are also correct French ("Tables", "Marketing", "Total").
const SAME_IN_FRENCH = new Set(["Nventra POS", "QR", "Priya", "Tables", "Marketing", "Total",
  "Table {number}", "KOT / PDF", "KOT (Bluetooth)", "coupon {code}", "{count} pts", "Tare (g)", "Portion"]);

for (const locale of ["es", "fr"]) {
  test(`${locale} dictionary has exactly the same keys as en`, () => {
    const dict = load(locale);
    const keys = Object.keys(dict).sort();
    const missing = enKeys.filter((k) => !(k in dict));
    const extra = keys.filter((k) => !(k in en));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  });

  test(`${locale} dictionary has no empty values`, () => {
    const dict = load(locale);
    const empty = Object.entries(dict)
      .filter(([, v]) => typeof v !== "string" || v.trim() === "")
      .map(([k]) => k);
    assert.deepEqual(empty, []);
  });
}

test("fr dictionary has no English values left (except brand names)", () => {
  const fr = load("fr");
  const untranslated = Object.keys(en).filter(
    (k) => k in fr && fr[k] === en[k] && !SAME_IN_FRENCH.has(en[k]),
  );
  assert.deepEqual(untranslated, []);
});

// hi is filled area by area (docs/I18N.md): it may lack keys (they fall back
// to en), but it must never invent keys, hold empty values, or miss the
// app chrome (nav + common), which the language switch is judged by.
test("hi dictionary is a non-empty subset of en covering the chrome", () => {
  const hi = load("hi");
  const extra = Object.keys(hi).filter((k) => !(k in en));
  const empty = Object.entries(hi).filter(([, v]) => v.trim() === "").map(([k]) => k);
  const chrome = enKeys.filter((k) => /^(nav|common)\./.test(k) && !(k in hi));
  assert.deepEqual({ extra, empty, chrome }, { extra: [], empty: [], chrome: [] });
});

test("hi chrome strings are written in Devanagari", () => {
  const hi = load("hi");
  const latinOnly = Object.entries(hi).filter(([, v]) => !/[\u0900-\u097F]/.test(v)).map(([k]) => k);
  assert.deepEqual(latinOnly, []);
});
