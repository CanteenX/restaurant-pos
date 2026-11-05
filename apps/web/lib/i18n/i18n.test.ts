import assert from "node:assert/strict";
import { test } from "node:test";
import { findHardcodedStrings, areaOf } from "./audit.ts";
import { formatCurrency, formatDate, formatNumber, intlLocale } from "./format.ts";
import { DEFAULT_LOCALE, LOCALES, LOCALE_LABELS, isLocale } from "./locales.ts";
import { createTranslator, interpolate } from "./translate.ts";

const DICTS = {
  en: {
    "nav.orders": "Orders",
    "order.thankYouName": "Thank you, {name}!",
    "cart.items.one": "{count} item",
    "cart.items.other": "{count} items",
    "common.only.en": "Only in English",
  },
  hi: {
    "nav.orders": "ऑर्डर",
    "cart.items.one": "{count} आइटम",
    "cart.items.other": "{count} आइटम",
  },
};

test("hi is a supported locale with a Devanagari label; en stays the default", () => {
  assert.ok(LOCALES.includes("hi"));
  assert.ok(isLocale("hi"));
  assert.equal(LOCALE_LABELS.hi, "हिन्दी");
  assert.equal(DEFAULT_LOCALE, "en");
});

test("translates from the active locale", () => {
  const t = createTranslator(DICTS, "hi");
  assert.equal(t("nav.orders"), "ऑर्डर");
});

test("falls back to en per missing key and reports it once", () => {
  const missing: string[] = [];
  const t = createTranslator(DICTS, "hi", { onMissing: (key, locale) => missing.push(`${locale}:${key}`) });
  assert.equal(t("common.only.en"), "Only in English");
  assert.equal(t("common.only.en"), "Only in English");
  assert.deepEqual(missing, ["hi:common.only.en"]);
});

test("a key missing everywhere returns the key itself and is reported", () => {
  const missing: string[] = [];
  const t = createTranslator(DICTS, "en", { onMissing: (key, locale) => missing.push(`${locale}:${key}`) });
  assert.equal(t("does.not.exist"), "does.not.exist");
  assert.deepEqual(missing, ["en:does.not.exist"]);
});

test("en never reports keys it has", () => {
  const missing: string[] = [];
  const t = createTranslator(DICTS, "en", { onMissing: (key) => missing.push(key) });
  t("nav.orders");
  assert.deepEqual(missing, []);
});

test("interpolates every occurrence and leaves unknown placeholders", () => {
  assert.equal(interpolate("{a} and {a} but {b}", { a: 1 }), "1 and 1 but {b}");
  const t = createTranslator(DICTS, "hi");
  assert.equal(t("order.thankYouName", { name: "Priya" }), "Thank you, Priya!");
});

test("plurals pick .one/.other by Intl.PluralRules and inject count", () => {
  const en = createTranslator(DICTS, "en");
  assert.equal(en.plural("cart.items", 1), "1 item");
  assert.equal(en.plural("cart.items", 3), "3 items");
  const hi = createTranslator(DICTS, "hi");
  // Hindi treats 0 and 1 as "one".
  assert.equal(hi.plural("cart.items", 0), "0 आइटम");
  assert.equal(hi.plural("cart.items", 1500), "1,500 आइटम");
});

test("maps UI locales to Intl tags (India region for en/hi)", () => {
  assert.equal(intlLocale("en"), "en-IN");
  assert.equal(intlLocale("hi"), "hi-IN");
  assert.equal(intlLocale("fr"), "fr-FR");
  assert.equal(intlLocale("es"), "es-ES");
});

test("numbers use lakh/crore grouping for en and hi", () => {
  assert.equal(formatNumber(12345678.5, "en"), "1,23,45,678.5");
  assert.equal(formatNumber(1234567, "hi"), "12,34,567");
});

test("currency formatting is per locale, INR by default, string input allowed", () => {
  assert.equal(formatCurrency("150000", "en"), "₹1,50,000.00");
  assert.equal(formatCurrency(150000, "hi"), "₹1,50,000.00");
  assert.match(formatCurrency(1234.5, "fr"), /1\s?234,50\s?₹/);
  assert.equal(formatCurrency(10, "en", "USD"), "$10.00");
});

test("dates format per locale", () => {
  const d = new Date(Date.UTC(2026, 10, 3, 12));
  const opts = { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" } as const;
  assert.equal(formatDate(d, "en", opts), "3 November 2026");
  assert.equal(formatDate(d, "hi", opts), "3 नवंबर 2026");
});

test("audit finds hardcoded JSX text and literal UI props, ignores t() calls", () => {
  const src = `
    export function X() {
      return (
        <div className="p-2" aria-label="Close dialog">
          <h1>Purchase orders</h1>
          <p>{t("nav.orders")}</p>
          <Input placeholder="Search items" />
          <span>{count}</span>
          <span>·</span>
        </div>
      );
    }`;
  const hits = findHardcodedStrings(src).map((h) => h.text);
  assert.deepEqual(hits, ["Close dialog", "Purchase orders", "Search items"]);
});

test("audit does not mistake the arrow of an arrow function for JSX text", () => {
  const src = `const q = useQuery({ queryFn: () => api.get<Thing>("/x"), select: (d) => d.items.map<Row>(toRow) });`;
  assert.deepEqual(findHardcodedStrings(src), []);
});

test("audit ignores code fragments between tags", () => {
  const src = `<A />
    ) : !ready ? (
    <B />
    <C>{api.get}</C> <D>api.get</D>`;
  assert.deepEqual(findHardcodedStrings(src), []);
});

test("audit groups files into areas", () => {
  assert.equal(areaOf("app/(dashboard)/inventory/waste/page.tsx"), "inventory");
  assert.equal(areaOf("components/inventory/create-po-dialog.tsx"), "inventory");
  assert.equal(areaOf("components/layout/app-shell.tsx"), "layout");
  assert.equal(areaOf("app/login/page.tsx"), "login");
  assert.equal(areaOf("app/order/[qrToken]/page.tsx"), "order");
});
