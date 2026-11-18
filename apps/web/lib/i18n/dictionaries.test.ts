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
  "Table {number}", "KOT / PDF", "KOT (Bluetooth)", "coupon {code}", "{count} pts", "Tare (g)", "Portion",
  "Budget", "Budgets", "GST", "Tally", "Date", "Description", "yourshop@okbank", "https://s3.example.com", "auto",
  "https://example.com/pos-hook", "{count} exception", "{count} exceptions", "Total {amount}",
  "WhatsApp", "~{minutes} min", "Menu", "Photo",
  "Documents", "Excel", "Excel (.xlsx)", "PDF", "CSV", "owner@cafe.com, accountant@firm.com"]);

for (const locale of ["es", "fr", "hi"]) {
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

// Hindi keeps brand names, URLs and examples in Latin script; everything
// else must be written in Devanagari.
test("hi chrome strings are written in Devanagari", () => {
  const hi = load("hi");
  const latinOnly = Object.entries(hi)
    .filter(([k, v]) => /^(nav|common)\./.test(k) && !/[\u0900-\u097F]/.test(v))
    .map(([k]) => k);
  assert.deepEqual(latinOnly, []);
});

test("hi keeps every {placeholder} from en", () => {
  const hi = load("hi");
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
  const bad = enKeys.filter((k) => ph(en[k]) !== ph(hi[k]));
  assert.deepEqual(bad, []);
});
