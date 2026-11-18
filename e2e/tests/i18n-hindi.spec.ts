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
  // Prefix match: the link's name gains " Needs attention" when an earlier
  // spec leaves pending orders behind (nav dot).
  await expect(nav.getByRole("link", { name: /^Orders\b/ })).toBeVisible();
  await page.screenshot({ path: "test-results/i18n-english-dashboard.png" });

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
  // The self-hosted (#187) Devanagari face really downloaded from our origin.
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts].some((f) => /devanagari/i.test(f.family) && f.status === "loaded"),
      ),
    )
    .toBe(true);

  await page.reload();
  await expect(nav.getByRole("link", { name: /^ऑर्डर/ })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "भाषा" })).toBeVisible();
  await page.screenshot({ path: "test-results/i18n-hindi-dashboard.png" });
});

// POS, KDS and tables in Hindi: Devanagari renders and nothing overflows the
// viewport horizontally (truncated or clipped layouts show up as scroll).
for (const [name, path] of [["pos", "/pos"], ["kds", "/kds"], ["tables", "/tables"]] as const) {
  test(`${name} screen in Hindi has Devanagari text and no horizontal overflow`, async ({ page }) => {
    await page.goto("/dashboard");
    await page.evaluate(() => localStorage.setItem("nodedr-locale", "hi"));
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    await expect(page.getByRole("navigation").first().getByRole("link", { name: /^ऑर्डर/ })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/i18n-hindi-${name}.png` });
  });
}
