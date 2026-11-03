import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers";

// Every staff page must render without an error boundary or console error.
const PAGES = [
  "/dashboard", "/pos", "/orders", "/tables", "/reservations", "/menu", "/kds",
  "/customers", "/gift-cards", "/inventory", "/inventory/procurement", "/delivery", "/team",
  "/attendance", "/accounting", "/reports", "/marketing", "/operations",
  "/settings", "/settings/roles", "/settings/security", "/settings/audit-log",
  "/settings/backup",
];

test("all staff pages render without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

  await openDashboard(page);
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body"), path).not.toContainText(/Application error|Something went wrong/i);
  }
  expect(errors, errors.join("\n")).toEqual([]);
});
