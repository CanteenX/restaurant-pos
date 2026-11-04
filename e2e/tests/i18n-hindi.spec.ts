import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers";

// The nav badge ("Needs attention") joins the link name, so match the prefix.
// The locale is a per-browser preference; make sure other specs keep English.
test.afterEach(async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem("nodedr-locale"));
});

test("switching to Hindi changes the chrome, persists, and renders Devanagari", async ({ page }) => {
  await openDashboard(page);
  const nav = page.getByRole("navigation").first();
  await expect(nav.getByRole("link", { name: /^Orders\b/ })).toBeVisible();

  await page.getByRole("combobox", { name: "Language" }).click();
  await page.getByRole("option", { name: "हिन्दी" }).click();

  const orders = nav.getByRole("link", { name: /^ऑर्डर/ });
  await expect(orders).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "hi");

  // Devanagari glyphs actually get a font: real width, and the Devanagari
  // face is in the computed stack.
  const box = await orders.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(20);
  const family = await orders.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family).toMatch(/devanagari/i);

  await page.reload();
  await expect(nav.getByRole("link", { name: /^ऑर्डर/ })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "भाषा" })).toBeVisible();
  await page.screenshot({ path: "test-results/i18n-hindi-dashboard.png" });
});
