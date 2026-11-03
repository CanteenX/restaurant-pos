import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers";

// Core money path: dine-in order with a priced modifier -> kitchen -> paid
// with a discount. Uses Table 3 so it never collides with other specs.
test("dine-in order: modifier pricing, KDS ticket, discounted payment", async ({ page }) => {
  await openDashboard(page);
  await page.goto("/pos");
  await page.getByRole("button", { name: "Table 3" }).click();

  // 2 x Paneer Tikka (₹280) = ₹560
  const paneer = page.getByRole("button", { name: /Paneer\s*Tikka/ }).first();
  await paneer.click();
  await paneer.click();

  // Margherita (₹420) + Extra Cheese (+₹60) = ₹480
  await page.getByRole("button", { name: /Margherita/ }).first().click();
  await page.getByText("Extra Cheese").click();
  await page.getByRole("button", { name: "Add to cart" }).click();

  await expect(page.getByText("₹1,040.00").first()).toBeVisible();
  await page.getByRole("button", { name: /Send to kitchen/ }).click();

  // The ticket reaches the kitchen display.
  const kds = await page.context().newPage();
  await kds.goto("/kds");
  await expect(kds.getByText("Table 3").first()).toBeVisible();
  await kds.close();

  // 10% discount -> ₹936.00, then pay.
  await page.getByRole("button", { name: "10%" }).click();
  const pay = page.getByRole("button", { name: /Complete payment/ });
  await expect(pay).toContainText("₹936.00");
  await pay.click();
  await expect(page.getByText("Payment recorded")).toBeVisible();
  await expect(page.getByText("₹936.00").first()).toBeVisible();
});
