import { expect, test, type Page } from "@playwright/test";
import { LOGGED_OUT } from "./helpers";

// Hindi smoke pass (#55): each key screen renders Devanagari, shows no raw
// translation keys, does not overflow horizontally and sets <html lang="hi">.
const SIZES = [
  { width: 375, height: 812 },
  { width: 1440, height: 900 },
];
type PageDef = { name: string; path: string; auth: boolean; devanagari: boolean; main?: boolean };
const PAGES: PageDef[] = [
  // The login page is not localised yet (hardcoded English, not part of #55).
  { name: "login", path: "/login", auth: false, devanagari: false },
  { name: "dashboard", path: "/dashboard", auth: true, devanagari: true },
  { name: "pos", path: "/pos", auth: true, devanagari: true },
  { name: "orders", path: "/orders", auth: true, devanagari: true, main: true },
  { name: "settings", path: "/settings", auth: true, devanagari: true },
  { name: "inventory", path: "/inventory", auth: true, devanagari: true },
  // #252: pages whose main content used to be hard-coded English.
  { name: "customers", path: "/customers", auth: true, devanagari: true, main: true },
  { name: "marketing", path: "/marketing", auth: true, devanagari: true, main: true },
  { name: "delivery", path: "/delivery", auth: true, devanagari: true, main: true },
  { name: "labels", path: "/labels", auth: true, devanagari: true, main: true },
  { name: "attendance", path: "/attendance", auth: true, devanagari: true, main: true },
  { name: "my-deliveries", path: "/my-deliveries", auth: true, devanagari: true, main: true },
  { name: "menu", path: "/menu", auth: true, devanagari: true, main: true },
];
const DEVANAGARI = /[\u0900-\u097F]/;
// Dictionary keys look like "pos.page.weigh"; match the known namespaces only.
const RAW_KEY = /\b(?:nav|common|order|kiosk|pos|kds|inv|acct|settings|team|tables|reservations|giftCards|inventory|menu|session|theme|dashboard|reports|operations)\.[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+\b/;

async function expectHindi(page: Page, name: string, width: number, devanagari: boolean, main = false) {
  await expect(page.locator("html")).toHaveAttribute("lang", "hi");
  // The sidebar/header were already Hindi, so check the page's own content.
  if (main) await expect(page.locator("main")).toContainText(DEVANAGARI);
  if (devanagari) await expect(page.locator("body")).toContainText(DEVANAGARI);
  const text = await page.locator("body").innerText();
  expect(text.match(RAW_KEY)?.[0] ?? null, "raw translation key visible").toBeNull();
  const over = await page.evaluate(() => {
    const el = document.querySelector("main") ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(over, "horizontal overflow").toBeLessThanOrEqual(1);
  await page.screenshot({ path: `test-results/hindi-${name}-${width}.png`, fullPage: false });
}

for (const p of PAGES) {
  for (const size of SIZES) {
    test.describe(`${p.name} @${size.width}`, () => {
      test.use({ viewport: size, ...(p.auth ? {} : { storageState: LOGGED_OUT }) });
      test("renders in Hindi", async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("nodedr-locale", "hi"));
        await page.goto(p.path);
        await page.waitForLoadState("networkidle");
        await expectHindi(page, p.name, size.width, p.devanagari, p.main);
      });
    });
  }
}

// D2 (#252): the mobile bottom-nav "More" label is translated.
test.describe("bottom nav @375", () => {
  test.use({ viewport: SIZES[0] });
  test("More label is Hindi", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("nodedr-locale", "hi"));
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    const nav = page.locator("nav").filter({ hasText: /More|और/ }).last();
    await expect(nav).toContainText(DEVANAGARI);
    await expect(nav).not.toContainText("More");
  });
});

test.describe("menu import @375", () => {
  test.use({ viewport: SIZES[0] });
  test("Import CSV button is Hindi", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("nodedr-locale", "hi"));
    await page.goto("/menu");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("main")).not.toContainText("Import CSV");
  });
});
