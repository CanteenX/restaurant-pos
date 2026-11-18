import { expect, test } from "@playwright/test";

test("petty cash: top-up, payout and reconcile hint", async ({ page }) => {
  const reason = `Float ${Date.now()}`;
  await page.goto("/accounting");
  await page.getByRole("button", { name: "Petty cash" }).click();
  const balance = page.getByTestId("petty-balance");
  await expect(balance).toBeVisible();

  await page.getByRole("button", { name: "Add top-up" }).click();
  await page.getByLabel("Amount").fill("500");
  await page.getByLabel("Reason").fill(reason);
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByTestId("petty-entries")).toContainText(reason);

  await page.getByRole("button", { name: "Add payout" }).click();
  await page.getByLabel("Amount").fill("120");
  await page.getByLabel("Reason").fill(`Milk ${reason}`);
  await page.getByLabel("Expense category").fill("Supplies");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByTestId("petty-entries")).toContainText("−₹120.00");

  await page.getByTestId("petty-reconcile").getByLabel("Counted cash").fill("1");
  await expect(page.getByTestId("petty-hint")).toContainText("short of the balance");
  await page.screenshot({ path: "test-results/petty-cash.png", fullPage: true });
});
