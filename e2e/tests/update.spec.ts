import { expect, test } from "@playwright/test";

// #33: when an update fails its health check the updater rolls back by itself
// (proved end to end by scripts/update-rollback-drill.sh against real
// containers). Here: Settings > Updates tells the owner about it. The demo
// stack has no updater sidecar, so its reported status is stubbed.
const PROGRESS = "**/api/v1/system/update/progress";

test("Settings > Updates shows an automatic rollback with its reason", async ({ page }) => {
  await page.route(PROGRESS, (route) =>
    route.fulfill({
      json: {
        state: "rolled_back",
        version: "1.0.2",
        rolledBackTo: "1.0.1",
        error: "nventra-pos-web failed its health check (unhealthy)",
        step: null,
      },
    }),
  );
  await page.goto("/settings/updates");
  const alert = page.getByTestId("update-rolled-back");
  await expect(alert).toBeVisible();
  await expect(alert).toHaveText(
    "Update to 1.0.2 failed and was rolled back automatically — 1.0.1 is running. Reason: nventra-pos-web failed its health check (unhealthy)",
  );
  await page.screenshot({ path: "test-results/update-rolled-back.png", fullPage: true });
});

test("no rollback notice when the updater is idle or absent", async ({ page }) => {
  await page.goto("/settings/updates");
  await expect(page.getByRole("heading", { name: "Application Updates" })).toBeVisible();
  await expect(page.getByTestId("update-rolled-back")).toHaveCount(0);
});

test("a failed rollback asks for manual action instead of claiming N is running", async ({ page }) => {
  await page.route(PROGRESS, (route) =>
    route.fulfill({
      json: {
        state: "rollback_failed",
        version: "1.0.2",
        rolledBackTo: null,
        error:
          "nventra-pos-web failed its health check (unhealthy); rollback failed: restored nventra-pos-backend failed its health check (unhealthy)",
        step: null,
      },
    }),
  );
  await page.goto("/settings/updates");
  const alert = page.getByTestId("update-rollback-failed");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("could not be rolled back automatically");
  await expect(alert).toContainText("docker compose up -d");
  await expect(alert).not.toContainText("is running");
  await expect(page.getByTestId("update-rolled-back")).toHaveCount(0);
  await page.screenshot({ path: "test-results/update-rollback-failed.png", fullPage: true });
});
