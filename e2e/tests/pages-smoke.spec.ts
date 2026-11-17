import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers";

// Every staff page must render without an error boundary or console error.
const PAGES = [
  "/dashboard", "/pos", "/orders", "/tables", "/reservations", "/menu", "/kds",
  "/customers", "/gift-cards", "/inventory", "/inventory/procurement", "/delivery", "/team",
  "/attendance", "/accounting", "/reports", "/marketing", "/operations",
  "/settings", "/settings/roles", "/settings/security", "/settings/audit-log",
  "/settings/backup", "/settings/email-templates",
];

test("all staff pages render without console errors", async ({ page }) => {
  // 23 pages x (navigation + settle) legitimately exceeds the 45 s default.
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // The email preview frame is deliberately sandboxed without allow-scripts; the browser
  // logs a (benign) notice when the test harness's own injected script is blocked there.
  const SANDBOX_NOTICE = /^Blocked script execution in 'about:srcdoc'/;
  page.on("console", (m) => m.type() === "error" && !SANDBOX_NOTICE.test(m.text()) && errors.push(`console: ${m.text()}`));

  // The delivery map loads OSM tiles; answer with a blank PNG so the smoke run
  // does not depend on (or hit) the public tile server.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  await page.route("https://tile.openstreetmap.org/**", (r) => r.fulfill({ contentType: "image/png", body: png }));

  await openDashboard(page);
  for (const path of PAGES) {
    await page.goto(path);
    // Realtime sockets can keep the network busy; a missed idle is not a failure.
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await expect(page.locator("body"), path).not.toContainText(/Application error|Something went wrong/i);
  }
  expect(errors, errors.join("\n")).toEqual([]);
});
