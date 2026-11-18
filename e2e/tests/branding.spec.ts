import { expect, test, type Page } from "@playwright/test";
import { LOGGED_OUT, openDashboard } from "./helpers";

// Rebrand 3/4 (#5): staff see "Nventra POS" everywhere. The only allowed
// mention of the upstream name is the AGPL attribution line in Settings.
const OLD_NAME = /nodedr|orderrestro/i;

async function visibleText(page: Page): Promise<string> {
  return page.locator("body").innerText();
}

test.describe("logged out", () => {
  test.use({ storageState: LOGGED_OUT });

  test("login page shows Nventra POS and no upstream name", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Nventra POS" })).toBeVisible();
    await expect(page).toHaveTitle(/Nventra POS/);
    await expect(page.getByAltText("Nventra POS").first()).toBeVisible();
    expect(await visibleText(page)).not.toMatch(OLD_NAME);
  });

  test("web manifest is named Nventra POS", async ({ request }) => {
    const res = await request.get("/manifest.json");
    expect(res.ok()).toBe(true);
    const manifest = await res.json();
    expect(manifest.name).toBe("Nventra POS");
    expect(manifest.short_name).toMatch(/Nventra/);
  });
});

test("app shell, footer and POS show Nventra POS only", async ({ page }) => {
  await openDashboard(page);
  await expect(page).toHaveTitle(/Nventra POS/);
  await expect(page.getByRole("link", { name: "Nventra POS" })).toBeVisible();
  expect(await visibleText(page)).not.toMatch(OLD_NAME);

  await page.goto("/pos");
  await page.waitForLoadState("networkidle");
  expect(await visibleText(page)).not.toMatch(OLD_NAME);
});

test("settings source link points to CanteenX with upstream attribution", async ({ page }) => {
  await page.goto("/settings");
  const source = page.getByRole("link", { name: "github.com/CanteenX/restaurant-pos" });
  await expect(source).toHaveAttribute("href", "https://github.com/CanteenX/restaurant-pos");
  const upstream = page.getByRole("link", { name: "Nodedr OrderRestro" });
  await expect(upstream).toHaveAttribute("href", "https://github.com/Raktim94/nodedr-restaurant-pos");
});
