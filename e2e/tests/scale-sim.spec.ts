import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers";

// Sell by weight using the software scale simulator.
test("weigh an item with tare and add the priced line to the cart", async ({ page }) => {
  await openDashboard(page);
  await page.goto("/pos");
  await page.getByRole("button", { name: "Table 4" }).click();
  await page.getByRole("button", { name: "Weigh item" }).click();

  await page.getByLabel("Item", { exact: true }).selectOption({ label: "Paneer Tikka" });
  await page.getByLabel("Price / kg").fill("280");
  await page.getByLabel("Tare (g)").fill("500");
  await page.getByLabel("Simulator (g)").fill("1500");

  // 1500 g gross - 500 g tare = 1.000 kg x ₹280
  await expect(page.getByTestId("scale-net")).toHaveText("1.000 kg");
  await expect(page.getByTestId("scale-price-total")).toHaveText("₹280.00");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByText("1.000 kg").first()).toBeVisible();
  await expect(page.getByText("₹280.00").first()).toBeVisible();
});
