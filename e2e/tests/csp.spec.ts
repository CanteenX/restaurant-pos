import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers";

// #255: HTML responses carry a Content-Security-Policy, and the app still
// hydrates and works under it (no securitypolicyviolation events).
test("admin HTML ships a CSP and the app runs without violations", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  const consoleCsp: string[] = [];
  page.on("console", (m) => /Content.Security.Policy/i.test(m.text()) && consoleCsp.push(m.text()));

  const res = await page.goto("/dashboard");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'self'");
  await openDashboard(page);

  for (const path of ["/pos", "/kds", "/menu", "/settings"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    expect(violations, `${path}: ${violations.join("; ")}`).toEqual([]);
  }

  // next/image optimizer and the uploads proxy are same-origin and unaffected.
  const img = await page.request.get("/_next/image?url=%2Flogo.png&w=64&q=75");
  expect(img.status()).toBe(200);
  expect(consoleCsp, consoleCsp.join("\n")).toEqual([]);
});
