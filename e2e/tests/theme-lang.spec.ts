import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers";

// The OS is dark, and the app is on its default "system" theme. The first
// toggle click must flip to light (it used to do nothing).
test.describe("theme toggle and html lang", () => {
  test.use({ colorScheme: "dark" });

  test("one click switches a dark-OS system theme to light", async ({ page }) => {
    await openDashboard(page);
    await page.evaluate(() => localStorage.removeItem("theme"));
    await page.reload();
    await expect(page.getByText("Today's Revenue")).toBeVisible();

    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({ path: "test-results/theme-lang-dark.png" });
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.screenshot({ path: "test-results/theme-lang-light.png" });
  });

  test("changing the locale sets document.documentElement.lang", async ({ page }) => {
    await openDashboard(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await page.getByRole("combobox", { name: "Language" }).click();
    await page.getByRole("option", { name: "हिन्दी" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    await page.screenshot({ path: "test-results/theme-lang-hindi.png" });

    // The locale is a per-browser preference; restore English for later specs.
    await page.evaluate(() => localStorage.removeItem("nodedr-locale"));
  });
});
