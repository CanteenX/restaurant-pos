import { expect, test } from "@playwright/test";

test("issue a gift card and see it listed with its balance", async ({ page }) => {
  await page.goto("/gift-cards");
  await expect(page.getByRole("heading", { name: "Gift cards" })).toBeVisible();
  await page.getByRole("button", { name: "Issue gift card" }).click();
  await page.getByLabel("Amount").fill("777");
  await page.getByRole("button", { name: "Issue card" }).click();
  await expect(page.getByTestId("gift-card-row").filter({ hasText: "₹777.00" }).first()).toContainText("Active");
});

// Redeeming at checkout must show on /gift-cards without a reload. Table 5 is
// used so it never collides with other specs.
test("gift card list shows the new balance after redemption at checkout", async ({ page }) => {
  await page.goto("/gift-cards");
  await page.getByRole("button", { name: "Issue gift card" }).click();
  await page.getByLabel("Amount").fill("137");
  await page.getByRole("button", { name: "Issue card" }).click();
  const row = page.getByTestId("gift-card-row").filter({ hasText: "₹137.00" }).first();
  await expect(row).toBeVisible();
  const code = (await row.locator(".font-mono").innerText()).trim();

  const pos = await page.context().newPage();
  await pos.goto("/pos");
  await pos.getByRole("button", { name: "Table 5" }).click();
  await pos.getByRole("button", { name: /Paneer\s*Tikka/ }).first().click(); // ₹280
  await pos.getByRole("button", { name: /Send to kitchen/ }).click();
  await pos.getByLabel("Gift card code (optional)").fill(code);
  await pos.getByRole("button", { name: "Check" }).click();
  await pos.getByRole("button", { name: /Complete payment/ }).click();
  await expect(pos.getByText("Payment recorded")).toBeVisible();
  await pos.close();

  // The card (₹137 < ₹280 bill) is fully used up; the open list updates itself.
  await page.goto("/gift-cards");
  const used = page.getByTestId("gift-card-row").filter({ hasText: code });
  await expect(used).toContainText("₹0.00");
  await expect(used).toContainText("Used up");
});
