import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { DEMO_OWNER, LOGGED_OUT, openDashboard } from "./helpers";

// Idle warning and "Log out of all devices" (issue #18, backend in #17).
// Revocation runs against the seeded demo CASHIER, never the owner: the owner
// session is shared by every spec (auth.setup.ts). Login is throttled to
// 5/min, so this file signs in through the API only three times.
const CASHIER = { email: "cashier@demo.local", password: DEMO_OWNER.password };

/** A fresh browser context signed in as the demo cashier (one "device"). */
async function cashierDevice(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: LOGGED_OUT });
  const page = await context.newPage();
  const res = await page.request.post("/api/v1/auth/login", {
    data: { email: CASHIER.email, password: CASHIER.password },
  });
  expect(res.ok(), `cashier login: ${res.status()}`).toBe(true);
  await page.goto("/pos");
  await expect(page.getByRole("button", { name: "Demo Cashier" })).toBeVisible();
  return { context, page };
}

async function isSignedIn(page: Page): Promise<boolean> {
  return (await page.request.get("/api/v1/auth/me")).ok();
}

test("log out of all devices signs out a second browser context", async ({ browser }) => {
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
  const staff = await cashierDevice(browser);
  try {
    await page.goto("/settings/staff");
    const row = page.getByRole("row").filter({ hasText: "Demo Cashier" });
    page.once("dialog", (d) => void d.accept());
    await row.getByRole("button", { name: "Sign out everywhere" }).click();
    await expect(page.getByText("Demo Cashier was signed out on every device")).toBeVisible();

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
