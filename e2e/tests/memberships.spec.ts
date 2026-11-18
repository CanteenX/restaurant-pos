import { expect, test } from "@playwright/test";

test("create a tier, enrol a customer, and see the badge at POS", async ({ page }) => {
  const tier = `Gold ${Date.now()}`;
  await page.goto("/settings/memberships");
  await page.getByLabel("Tier name").fill(tier);
  await page.getByLabel("Discount %").fill("10");
  await page.getByRole("button", { name: "Add tier" }).click();
  await expect(page.getByTestId("tier-row").filter({ hasText: tier })).toBeVisible();

  const name = `Member ${Date.now()}`;
  await page.goto("/customers");
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Add customer" }).click();
  await page.getByRole("link", { name }).click();
  const card = page.getByTestId("membership-card");
  await expect(card).toBeVisible();
  await card.getByLabel("Tier").selectOption({ label: tier });
  await card.getByRole("button", { name: "Enrol" }).click();
  await expect(card).toContainText(`${tier}`);
  await expect(card).toContainText("10% off");
  await card.screenshot({ path: "test-results/memberships-profile.png" });

  await page.goto("/pos");
  await page.getByRole("button", { name: "Table 5" }).click();
  await page.getByRole("button", { name: /Paneer\s*Tikka/ }).first().click();
  await page.getByRole("button", { name: /Send to kitchen/ }).click();
  await page.getByPlaceholder("Attach customer (name or phone)…").fill(name);
  await page.getByRole("button", { name }).first().click();
  await expect(page.getByTestId("membership-badge")).toContainText(tier);
  await page.screenshot({ path: "test-results/memberships-pos.png" });
});
