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
const SAME_IN_FRENCH = new Set(["Nventra POS", "Nodedr", "QR", "Priya", "Tables", "Marketing", "Total"]);

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
