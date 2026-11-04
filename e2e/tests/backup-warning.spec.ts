import { expect, test, type Page } from "@playwright/test";

// Backup endpoints are mocked so the spec is independent of real backup state.
async function mockBackups(page: Page, hoursAgo: number | null) {
  const at = hoursAgo === null ? null : new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  await page.route("**/api/v1/backups", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: at ? [{ id: "b1", status: "VERIFIED", createdAt: at, verifiedAt: at }] : [],
        })
      : route.continue(),
  );
  await page.route("**/api/v1/backups/local/status", (route) =>
    route.fulfill({
      json: { enabled: false, lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null },
    }),
  );
}

test("dashboard warns when the last good backup is stale", async ({ page }) => {
  await mockBackups(page, 72);
  await page.goto("/dashboard");
  const banner = page.getByTestId("backup-warning");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("more than 48 hours");
  await expect(banner.getByRole("link", { name: "Open backup settings" })).toHaveAttribute(
    "href",
    "/settings/backup",
  );
});

test("dashboard hides the warning when a backup is fresh", async ({ page }) => {
  await mockBackups(page, 3);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Tables" })).toBeVisible();
  await expect(page.getByTestId("backup-warning")).toHaveCount(0);
});
