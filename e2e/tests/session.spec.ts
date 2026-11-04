import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { DEMO_OWNER, LOGGED_OUT, openDashboard } from "./helpers";

// Idle warning and "Log out of all devices" (issue #18, backend in #17).
// Revocation runs against the seeded demo CASHIER, never the owner: the owner
// session is shared by every spec (auth.setup.ts). Login is throttled to
// 5/min, so this file signs in through the API only three times and waits
// for the throttle window if an earlier spec used it up.
const CASHIER = { email: "cashier@demo.local", password: DEMO_OWNER.password };

/** A fresh browser context signed in as the demo cashier (one "device"). */
async function cashierDevice(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: LOGGED_OUT });
  const page = await context.newPage();
  // Earlier specs may have used up this minute's login budget: wait it out.
  let res = await page.request.post("/api/v1/auth/login", { data: CASHIER });
  for (let i = 0; res.status() === 429 && i < 7; i++) {
    await page.waitForTimeout(10_000);
    res = await page.request.post("/api/v1/auth/login", { data: CASHIER });
  }
  expect(res.ok(), `cashier login: ${res.status()}`).toBe(true);
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: "Demo Cashier" })).toBeVisible();
  return { context, page };
}

async function isSignedIn(page: Page): Promise<boolean> {
  return (await page.request.get("/api/v1/auth/me")).ok();
}

test("log out of all devices signs out a second browser context", async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await cashierDevice(browser);
  const b = await cashierDevice(browser);
  try {
    a.page.once("dialog", (d) => void d.accept());
    await a.page.getByRole("button", { name: "Demo Cashier" }).click();
    await a.page.getByRole("menuitem", { name: "Log out of all devices" }).click();
    await expect(a.page).toHaveURL(/\/login/);

    // The other device leaves on its own: the server drops its socket and
    // the app re-checks the session — no reload needed.
    await expect(b.page).toHaveURL(/\/login/, { timeout: 15_000 });
    expect(await isSignedIn(b.page)).toBe(false);
    await b.page.goto("/pos");
    await expect(b.page).toHaveURL(/\/login/);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("an admin can sign a staff member out on every device", async ({ browser, page }) => {
  test.setTimeout(120_000);
  const staff = await cashierDevice(browser);
  try {
    await page.goto("/settings/staff");
    const row = page.getByRole("row").filter({ hasText: "Demo Cashier" });
    page.once("dialog", (d) => void d.accept());
    // Success is silent in this app (errors only toast): check the call itself.
    const revoked = page.waitForResponse(
      (r) => /\/api\/v1\/auth\/sessions\/revoke\/[^/]+$/.test(r.url()) && r.request().method() === "POST",
    );
    await row.getByRole("button", { name: "Sign out everywhere" }).click();
    expect((await revoked).ok()).toBe(true);
    await page.screenshot({ path: "test-results/staff-sign-out-everywhere.png" });

    await expect(staff.page).toHaveURL(/\/login/, { timeout: 15_000 });
    expect(await isSignedIn(staff.page)).toBe(false);
    // The admin's own session is untouched.
    expect(await isSignedIn(page)).toBe(true);
  } finally {
    await staff.context.close();
  }
});

test.describe("idle sign-out", () => {
  test("warns before signing out and 'Stay signed in' keeps the session", async ({ page }) => {
    await page.clock.install();
    await openDashboard(page);

    await page.clock.fastForward("59:05");
    const dialog = page.getByRole("dialog").filter({ hasText: "Still there?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/signed out in \d+ seconds/);
    await expect(dialog.getByRole("button", { name: "Stay signed in" })).toBeFocused();
    await page.screenshot({ path: "test-results/idle-warning.png" });
    await dialog.getByRole("button", { name: "Stay signed in" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/dashboard/);

    // Left alone for the whole window: signed out of this tab.
    await page.clock.fastForward("59:05");
    await expect(dialog).toBeVisible();
    await page.clock.fastForward("01:00");
    await expect(page).toHaveURL(/\/login/);
  });
});
