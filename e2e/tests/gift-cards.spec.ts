import { expect, test } from "@playwright/test";

test("issue a gift card and see it listed with its balance", async ({ page }) => {
  await page.goto("/gift-cards");
  await expect(page.getByRole("heading", { name: "Gift cards" })).toBeVisible();
  await page.getByRole("button", { name: "Issue gift card" }).click();
  await page.getByLabel("Amount").fill("777");
  await page.getByRole("button", { name: "Issue card" }).click();
  await expect(page.getByText(/Gift card [0-9A-F]{12} issued/)).toBeVisible();
  await expect(page.getByTestId("gift-card-row").filter({ hasText: "777" }).first()).toContainText("Active");
});
