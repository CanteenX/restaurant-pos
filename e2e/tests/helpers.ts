import { expect, type Page } from "@playwright/test";

export const DEMO_OWNER = {
  email: "owner@demo.local",
  // Seeded demo password from apps/backend/prisma/seed.ts — test-only.
  password: "Password123!",
};

/** Fill and submit the login form. Each call counts against the 5/min throttle. */
export async function login(page: Page, email = DEMO_OWNER.email, password = DEMO_OWNER.password): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("you@restaurant.com or phone number").fill(email);
  await page.getByPlaceholder("Your password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** With the shared owner session (from auth.setup.ts), land on the dashboard. */
export async function openDashboard(page: Page): Promise<void> {
  await page.goto("/dashboard");
  await expect(page.getByText("Today's Revenue")).toBeVisible();
}

export const LOGGED_OUT = { cookies: [], origins: [] };
