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
  { name: "login", path: "/login", auth: false, devanagari: true, main: true },
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
        if (p.name === "customers") {
          await expect(page.getByRole("button", { name: "नया ग्राहक" })).toBeVisible();
        }
        if (p.name === "labels") {
          await expect(page.locator("#label-title")).toHaveValue("नमूना वस्तु");
        }
        if (p.name === "login") {
          await expect(page.getByRole("region", { name: /सूचनाएं/ })).toBeAttached();
        }
        if (p.name === "login") {
          await expect(page.getByRole("button", { name: "साइन इन करें", exact: true })).toBeVisible();
          await expect(page.getByLabel("ईमेल या फ़ोन नंबर")).toBeVisible();
          await expect(page.getByLabel("पासवर्ड", { exact: true })).toBeVisible();
        }
      });
    });
  }
}

test.describe("login form feedback in Hindi", () => {
  test.use({ storageState: LOGGED_OUT });

  test("translates validation and the two-factor prompt", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("nodedr-locale", "hi"));
    await page.route("**/api/v1/auth/login", async (route) => {
      const body = route.request().postDataJSON();
      await route.fulfill({
        status: 401,
        json: { message: body.totp ? "Invalid verification code" : "TWO_FACTOR_REQUIRED" },
      });
    });
    await page.goto("/login");

    const submit = page.getByRole("button", { name: "साइन इन करें", exact: true });
    await submit.click();
    await expect(page.getByText("अपना ईमेल या फ़ोन नंबर डालें।")).toBeVisible();
    await expect(page.getByText("अपना पासवर्ड डालें।")).toBeVisible();
    await page.getByLabel("ईमेल या फ़ोन नंबर").fill("fixture@example.test");
    await page.getByLabel("पासवर्ड", { exact: true }).fill("fixture-placeholder");
    await page.getByRole("button", { name: "पासवर्ड दिखाएँ" }).click();
    await expect(page.getByLabel("पासवर्ड", { exact: true })).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "पासवर्ड छिपाएँ" }).click();

    await submit.click();
    const code = page.getByLabel("सत्यापन कोड", { exact: true });
    await code.fill("111111");
    await submit.click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("सत्यापन कोड गलत है।");
  });
});

test.describe("login language switch", () => {
  test.use({ storageState: LOGGED_OUT, locale: "en-IN" });
  test("applies Hindi before authentication and persists it after reload", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Language" }).click();
    await page.getByRole("option", { name: "हिन्दी" }).click();
    await expect(page.getByRole("button", { name: "साइन इन करें", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    await expect(page.getByRole("button", { name: "साइन इन करें", exact: true })).toBeVisible();
  });
});

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
