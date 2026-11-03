import { expect, test, type Page } from "@playwright/test";
import { openDashboard } from "./helpers";

// Shared-till quick switch (issue #11). Runs on a tablet-sized touch viewport.
// The seeded demo cashier (apps/backend/prisma/seed.ts) has PIN 2468.
// pin-login is throttled to 5/min per address: this file makes 2 real calls.
// "Switch user" signs the current user out first, so the keypad runs with no session.
const CASHIER_PIN = "2468";
const ROSTER_KEY = "nventra.pinRoster";
const BRANCH_KEY = "nodedr_branch_id";

test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

/**
 * The tiles come from staff who signed in on this device before. Put the demo
 * cashier on this device's list (as if they had signed in here earlier).
 */
async function cashierHasUsedThisTill(page: Page): Promise<void> {
  const res = await page.request.get("/api/v1/users");
  expect(res.ok()).toBe(true);
  const users = (await res.json()) as { id: string; name: string }[];
  const cashier = users.find((u) => u.name === "Demo Cashier");
  expect(cashier, "seeded demo cashier").toBeTruthy();
  await page.evaluate(
    ([key, entry]) => {
      const list = JSON.parse(localStorage.getItem(key) ?? "[]") as { id: string }[];
      localStorage.setItem(key, JSON.stringify([entry, ...list.filter((u) => u.id !== entry.id)]));
    },
    [ROSTER_KEY, { id: cashier!.id, name: cashier!.name, roleName: "CASHIER" }] as const,
  );
}

async function enterPin(page: Page, pin: string): Promise<void> {
  for (const d of pin) await page.getByRole("button", { name: d, exact: true }).click();
}

test.describe("PIN quick switch", () => {
  test.beforeEach(async ({ page }) => {
    await openDashboard(page);
    await cashierHasUsedThisTill(page);
  });

  test("wrong PIN shows an error and stays on the keypad", async ({ page }) => {
    await page.goto("/switch-user");
    await page.getByRole("button", { name: /Demo Cashier/ }).click();
    await enterPin(page, "0000");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Incorrect PIN" })).toBeVisible();
    await expect(page).toHaveURL(/\/switch-user/);
    await expect(page.getByRole("button", { name: "Unlock" })).toBeDisabled();
  });

  test("a locked-out PIN shows the lockout message", async ({ page }) => {
    // The real lockout (5 bad PINs -> 423) is covered by the backend e2e
    // (apps/backend/test/pin-login.e2e-spec.ts); tripping it here would lock
    // the demo cashier for 15 minutes for every later spec.
    await page.route("**/api/v1/auth/pin-login", (route) =>
      route.fulfill({
        status: 423,
        contentType: "application/json",
        body: JSON.stringify({
          message: "Too many incorrect PINs. PIN login is locked for 15 minutes — sign in with your password.",
        }),
      }),
    );
    await page.goto("/switch-user");
    await page.getByRole("button", { name: /Demo Cashier/ }).click();
    await enterPin(page, "1111");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "locked for 15 minutes" })).toBeVisible();
    await page.screenshot({ path: "test-results/pin-switch-locked-tablet.png" });
  });

  test("switch user signs the owner out before showing the tiles", async ({ page }) => {
    await page.getByRole("button", { name: "Demo Owner" }).click();
    await page.getByRole("menuitem", { name: "Switch user" }).click();
    await expect(page).toHaveURL(/\/switch-user/);
    await expect(page.getByRole("button", { name: /Demo Cashier/ })).toBeVisible();

    const me = await page.request.get("/api/v1/auth/me");
    expect(me.status()).toBe(401);

    await page.goBack();
    await expect(page).toHaveURL(/\/(login|switch-user)/);
    await expect(page.getByText("Today's Revenue")).toHaveCount(0);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/(login|switch-user)/);
    await expect(page.getByText("Today's Revenue")).toHaveCount(0);
  });

  test("owner switches to the cashier by PIN and sees none of the owner's state", async ({ page }) => {
    await page.evaluate((key) => localStorage.setItem(key, "owner-picked-branch"), BRANCH_KEY);
    await page.getByRole("button", { name: "Demo Owner" }).click();
    await page.getByRole("menuitem", { name: "Switch user" }).click();
    await expect(page).toHaveURL(/\/switch-user/);
    await expect(page.getByRole("button", { name: /Demo Owner/ })).toBeVisible();
    await page.screenshot({ path: "test-results/pin-switch-tiles-tablet.png" });

    await page.getByRole("button", { name: /Demo Cashier/ }).click();
    await enterPin(page, CASHIER_PIN);
    await expect(page.getByTestId("pin-dots")).toHaveAttribute("aria-label", /^4 of/);
    await page.screenshot({ path: "test-results/pin-switch-keypad-tablet.png" });

    const branchesRefetched = page.waitForRequest((r) => r.url().endsWith("/api/v1/branches"));
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await branchesRefetched; // cache was dropped: the cashier's own branch list is loaded

    await expect(page.getByRole("button", { name: "Demo Cashier" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Demo Owner" })).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), BRANCH_KEY)).toBeNull();
    const me = await page.request.get("/api/v1/auth/me");
    expect(((await me.json()) as { user: { name: string } }).user.name).toBe("Demo Cashier");
    await page.screenshot({ path: "test-results/pin-switch-after-tablet.png" });
    // The owner's Team screen is not reachable for the cashier.
    await page.goto("/team");
    await expect(page).not.toHaveURL(/\/team/);
  });
});

test.describe("PIN quick switch (logged out)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the login page links to the quick-switch screen", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Switch user with PIN" }).click();
    await expect(page).toHaveURL(/\/switch-user/);
    await expect(page.getByText("No one has signed in on this device yet")).toBeVisible();
  });
});
