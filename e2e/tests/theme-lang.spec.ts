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
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  test("changing the locale sets document.documentElement.lang", async ({ page }) => {
    await openDashboard(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await page.getByRole("combobox", { name: "Language" }).click();
    await page.getByRole("option", { name: "Français" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");

    // Restore the default so later specs see English.
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});
