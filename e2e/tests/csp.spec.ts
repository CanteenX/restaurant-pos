import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers";

// #255: HTML responses carry a Content-Security-Policy, and the logged-in app
// (all frames, incl. the sandboxed email preview srcdoc iframe) runs without
// a single securitypolicyviolation.
const PAGES = [
  "/dashboard", "/pos", "/kds", "/orders", "/menu", "/reports", "/tables", "/inventory",
  "/customers", "/delivery", "/reservations", "/settings", "/settings/security",
  "/settings/backup", "/settings/email-templates", "/customer-display?code=BAD&branch=x",
];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("logged-in pages ship a CSP and run without violations", async ({ page }) => {
  test.setTimeout(240_000);
  const violations: string[] = [];
  await page.exposeFunction("__reportCsp", (m: string) => violations.push(m));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      void (window as unknown as { __reportCsp: (m: string) => void }).__reportCsp(
        `${location.pathname}: ${e.violatedDirective} blocked ${e.blockedURI}`,
      );
    });
  });
  const consoleCsp: string[] = [];
  page.on("console", (m) => /Content.Security.Policy/i.test(m.text()) && consoleCsp.push(m.text()));
  // Allowed by img-src; a violation would still be reported by the browser.
  await page.route("https://tile.openstreetmap.org/**", (r) => r.fulfill({ contentType: "image/png", body: PNG }));

  const res = await page.goto("/dashboard");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'self'");
  await openDashboard(page);

  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  }

  // Email template preview renders in a sandboxed srcdoc iframe.
  await page.goto("/settings/email-templates");
  await page.waitForTimeout(1500);
  expect(await page.locator("iframe").count(), "email preview iframe present").toBeGreaterThan(0);

  // next/image optimizer and the uploads proxy stay reachable.
  expect((await page.request.get("/_next/image?url=%2Flogo.png&w=64&q=75")).status()).toBe(200);
  expect((await page.request.get("/api/uploads/does-not-exist.png")).status()).not.toBe(500);

  expect(violations, violations.join("\n")).toEqual([]);
  expect(consoleCsp, consoleCsp.join("\n")).toEqual([]);
});
