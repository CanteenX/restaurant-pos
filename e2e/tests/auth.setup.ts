import { expect, test as setup } from "@playwright/test";
import { login } from "./helpers";

// Log in ONCE and share the session with every spec. The login endpoint is
// throttled to 5 attempts/minute (and, behind the web proxy, all clients share
// one bucket), so per-test logins would make the suite flaky.
export const OWNER_STATE = "playwright/.auth/owner.json";

setup("authenticate as demo owner", async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.context().storageState({ path: OWNER_STATE });
});
