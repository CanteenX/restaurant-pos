import { expect, test } from "@playwright/test";

// The demo owner both records and approves, and the API forbids deciding an
// expense you recorded, so this covers: threshold -> PENDING badge -> queue ->
// the self-approval refusal. Approval itself is covered by the backend e2e.
test("expense above the threshold waits for approval", async ({ page }) => {
  const category = `Approval ${Date.now()}`;
  await page.goto("/accounting");

  await page.getByLabel("Approval threshold").fill("100");
  await page.getByRole("button", { name: "Save threshold" }).click();
  await expect(page.getByText("Approval threshold saved")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss message" }).click();

  await page.getByPlaceholder("Category (Rent, Supplies…)").fill(category);
  await page.getByPlaceholder("Amount").fill("250");
  await page.getByRole("button", { name: "Add expense" }).click();
  
  const row = page.locator("div", { hasText: category }).filter({ has: page.getByTestId("expense-status") }).last();
  await expect(row.getByTestId("expense-status")).toHaveText("Pending");

  const queue = page.getByTestId("pending-expenses");
  const queued = queue.locator("div", { hasText: category }).last();
  await expect(queued).toBeVisible();
  await queued.getByRole("button", { name: "Approve" }).click();
  await expect(queue.getByRole("alert")).toContainText("cannot approve or reject an expense you recorded");

  // Turn approvals off again so other specs are unaffected.
  await page.getByLabel("Approval threshold").fill("");
  await page.getByRole("button", { name: "Save threshold" }).click();
  await expect(page.getByText("Approval threshold saved")).toBeVisible();
});
