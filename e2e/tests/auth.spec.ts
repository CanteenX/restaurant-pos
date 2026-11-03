import { expect, test } from "@playwright/test";
import { LOGGED_OUT, login, openDashboard } from "./helpers";

test.describe("auth (logged out)", () => {
  test.use({ storageState: LOGGED_OUT });

  test("wrong password shows an error and stays on /login", async ({ page }) => {
    await login(page, "owner@demo.local", "definitely-wrong-1");
    await expect(page.getByText("Invalid login ID or password")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("protected pages redirect to /login", async ({ page }) => {
    await page.goto("/pos");
    await expect(page).toHaveURL(/\/login/);
  });

  test("owner can sign in and sign out", async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/\/dashboard/);
    await page.getByRole("button", { name: "Demo Owner" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/pos");
    await expect(page).toHaveURL(/\/login/);
  });

  test("sign-up is closed once a restaurant exists", async ({ page }) => {
    await page.goto("/signup");
    await page.getByPlaceholder("e.g. Spice Route").fill("Probe Cafe");
    await page.getByPlaceholder("e.g. Priya Sharma").fill("Probe User");
    await page.getByPlaceholder("you@restaurant.com").fill(`probe-${Date.now()}@test.local`);
    await page.getByPlaceholder("At least 8 characters").fill("ProbePass123!");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(/Sign-up is closed on this server/)).toBeVisible();
  });
});

test("session cookie is HttpOnly + SameSite=Lax and hidden from JS", async ({ page, context }) => {
  await openDashboard(page);
  const session = (await context.cookies()).find((c) => c.name.endsWith("_session"));
  expect(session, "session cookie present").toBeTruthy();
  expect(session!.httpOnly).toBe(true);
  expect(session!.sameSite).toBe("Lax");
  expect(await page.evaluate(() => document.cookie)).not.toContain(session!.name);
});
