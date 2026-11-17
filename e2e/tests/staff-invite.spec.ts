import { expect, test, type Page } from "@playwright/test";
import { LOGGED_OUT } from "./helpers";

// Staff invites (#223): the public accept-invite page and the invite actions
// in staff management, at phone and desktop widths. The QA stack has no SMTP,
// so a real invite cannot be emailed: the page is checked against the real
// server for bad links, and the happy path with the two endpoints stubbed.
const WIDTHS = [375, 1440];
const FAKE = `ckfakeinvite0000.${"B".repeat(43)}`;

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const width of WIDTHS) {
  test.describe(`accept-invite at ${width}px`, () => {
    test.use({ storageState: LOGGED_OUT, viewport: { width, height: 900 } });

    test("without a link, or with a bad one, it says so", async ({ page }) => {
      await page.goto("/accept-invite");
      await expect(page.getByRole("main").getByRole("alert")).toContainText("invalid, already used or expired");
      // A hash-only change is a same-document jump: load the link fresh.
      await page.goto("about:blank");
      await page.goto(`/accept-invite#token=${FAKE}`);
      await expect(page.getByRole("main").getByRole("alert")).toContainText("invalid, already used or expired");
      expect(new URL(page.url()).hash).toBe("");
      await noSideScroll(page);
    });

    test("greets the invitee, checks the policy and activates", async ({ page }) => {
      await page.route("**/api/v1/auth/invite/inspect", (r) =>
        r.fulfill({ json: { name: "Ravi", restaurantName: "Spice Garden", roleLabel: "Waiter" } }),
      );
      let accepted: unknown;
      await page.route("**/api/v1/auth/invite/accept", (r) => {
        accepted = r.request().postDataJSON();
        return r.fulfill({ json: { ok: true } });
      });
      await page.goto(`/accept-invite#token=${FAKE}`);
      await expect(page.getByText("Hi Ravi, set a password to join Spice Garden as Waiter.")).toBeVisible();

      await page.getByLabel("New password", { exact: true }).fill("short");
      await page.getByLabel("Confirm new password").fill("short");
      await page.getByRole("button", { name: "Set password and join" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("8 to 200 characters");

      await page.getByLabel("New password", { exact: true }).fill("InvitedPass9");
      await page.getByLabel("Confirm new password").fill("InvitedPass9");
      await page.getByRole("button", { name: "Set password and join" }).click();
      await expect(page.getByRole("main").getByRole("status")).toContainText("You're all set");
      expect(accepted).toEqual({ token: FAKE, password: "InvitedPass9" });
      await noSideScroll(page);
    });
  });

  test.describe(`staff management at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("shows a pending invite with resend and revoke", async ({ page }) => {
      const future = new Date(Date.now() + 72 * 3600_000).toISOString();
      await page.route("**/api/v1/users", async (r) => {
        if (r.request().method() !== "GET") return r.fallback();
        const res = await r.fetch();
        const list = (await res.json()) as Record<string, unknown>[];
        const pending = {
          ...list[0],
          id: "pending-invitee",
          name: "Pending Invitee",
          email: "pending@example.com",
          isActive: false,
          invitePendingUntil: future,
          role: { id: "x", name: "WAITER", label: "Waiter" },
        };
        return r.fulfill({ response: res, json: [...list, pending] });
      });
      await page.route("**/api/v1/users/pending-invitee/invite", (r) =>
        r.fulfill({ status: 201, json: { sent: true } }),
      );
      await page.goto("/settings/staff");
      const row = page.getByRole("row").filter({ hasText: "Pending Invitee" });
      await expect(row.getByText("Invite pending")).toBeVisible();
      await expect(row.getByRole("button", { name: "Revoke invite" })).toBeVisible();
      // This app shows no success popups (lib/toast.ts): check the call itself.
      const resend = page.waitForRequest(
        (req) => req.url().endsWith("/users/pending-invitee/invite") && req.method() === "POST",
      );
      await row.getByRole("button", { name: "Resend invite" }).click();
      await resend;
      // Active accounts get no invite actions.
      const active = page.getByRole("row").filter({ hasText: "Demo Cashier" });
      await expect(active.getByRole("button", { name: /invite/i })).toHaveCount(0);
      // The list refetches after the resend; let that in-flight route go.
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });
  });
}

test("accept-invite page is translated into Hindi", async ({ browser }) => {
  const context = await browser.newContext({ storageState: LOGGED_OUT });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("nodedr-locale", "hi"));
  await page.goto("/accept-invite");
  await expect(page.getByRole("heading", { name: "अपनी टीम से जुड़ें" })).toBeVisible();
  await context.close();
});
