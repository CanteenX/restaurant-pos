import { expect, test, type Page } from "@playwright/test";
import { LOGGED_OUT } from "./helpers";

// Forgot / reset password pages (#224) at phone and desktop widths. The QA
// stack has no SMTP, so the real server reports reset as unavailable: the
// login link is hidden and the forgot page says so. The request form itself
// is exercised with the two reset endpoints stubbed. The reset page talks to
// the real server, which rejects a made-up token.
test.use({ storageState: LOGGED_OUT });

const WIDTHS = [375, 1440];

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("login hides 'Forgot password?' when email is not set up", async ({ page }) => {
      const enabled = page.waitForResponse((r) => r.url().includes("/auth/password-reset/enabled"));
      await page.goto("/login");
      const res = await enabled;
      expect(await res.json()).toEqual({ enabled: false });
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveCount(0);
      await noSideScroll(page);
    });

    test("login shows the link when reset is available", async ({ page }) => {
      await page.route("**/api/v1/auth/password-reset/enabled", (r) =>
        r.fulfill({ json: { enabled: true } }),
      );
      await page.goto("/login");
      await page.getByRole("link", { name: "Forgot password?" }).click();
      await expect(page).toHaveURL(/\/forgot-password$/);
      await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
    });

    test("forgot page says reset is unavailable on this server", async ({ page }) => {
      await page.goto("/forgot-password");
      await expect(page.getByRole("main").getByRole("alert")).toContainText("isn't available on this server");
      await expect(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();
      await noSideScroll(page);
    });

    test("forgot form gives the same neutral answer", async ({ page }) => {
      await page.route("**/api/v1/auth/password-reset/enabled", (r) =>
        r.fulfill({ json: { enabled: true } }),
      );
      let body: unknown;
      await page.route("**/api/v1/auth/password-reset/request", (r) => {
        body = r.request().postDataJSON();
        return r.fulfill({ status: 202, json: { ok: true } });
      });
      await page.goto("/forgot-password");
      await page.getByRole("button", { name: "Send reset link" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("valid email");
      await page.getByLabel("Email").fill("Someone@Example.com");
      await page.getByRole("button", { name: "Send reset link" }).click();
      await expect(page.getByRole("main").getByRole("status")).toContainText("If an account uses that email");
      expect(body).toEqual({ email: "someone@example.com" });
      await noSideScroll(page);
    });

    test("reset page without a link explains what to do", async ({ page }) => {
      await page.goto("/reset-password");
      await expect(page.getByRole("main").getByRole("alert")).toContainText("needs the link from your reset email");
      await expect(page.getByRole("link", { name: "Send me a new link" })).toBeVisible();
      await noSideScroll(page);
    });

    test("reset page checks the policy, hides the token and rejects a bad link", async ({ page }) => {
      const fake = `ckfaketokenid000.${"A".repeat(43)}`;
      await page.goto(`/reset-password#token=${fake}`);
      await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
      // The secret is removed from the address bar once read.
      expect(new URL(page.url()).hash).toBe("");

      await page.getByLabel("New password", { exact: true }).fill("short");
      await page.getByLabel("Confirm new password").fill("short");
      await page.getByRole("button", { name: "Save new password" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("8 to 200 characters");

      await page.getByLabel("New password", { exact: true }).fill("LongEnough9");
      await page.getByLabel("Confirm new password").fill("Different9");
      await page.getByRole("button", { name: "Save new password" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("don't match");

      await page.getByLabel("Confirm new password").fill("LongEnough9");
      await page.getByRole("button", { name: "Save new password" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("invalid, already used or expired");
      await noSideScroll(page);
    });
  });
}

test("reset page is translated into Hindi", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("nodedr-locale", "hi"));
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "नया पासवर्ड बनाएँ" })).toBeVisible();
});
