import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers";

// Split a 3-item order across 2 guests and settle both. Uses Table 2 so it
// never collides with other specs.
test("split a bill by guest and settle both shares", async ({ page }) => {
  await openDashboard(page);
  await page.goto("/pos");
  await page.getByRole("button", { name: "Table 2" }).click();

  // 2 x Paneer Tikka (₹280) = ₹560 for guest 1; Margherita ₹420 for guest 2.
  const paneer = page.getByRole("button", { name: /Paneer\s*Tikka/ }).first();
  await paneer.click();
  await paneer.click();
  await page.getByRole("button", { name: /Margherita/ }).first().click();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await page.getByRole("button", { name: /send to kitchen/i }).click();

  await page.getByRole("button", { name: "Split by guest…" }).click();
  await page.getByLabel(/Paneer\s*Tikka for guest 1/).check();
  await page.getByLabel(/Margherita.*for guest 2/).check();
  await expect(page.getByTestId("split-share-1")).toHaveText("₹560.00");
  await expect(page.getByTestId("split-share-2")).toHaveText("₹420.00");
  await page.screenshot({ path: "test-results/split-bill-dialog.png" });

  // Guest 1 pays their share first (part payment), then guest 2 settles.
  await page.getByTestId("split-shares").getByRole("button", { name: "Pay" }).first().click();
  await page.getByRole("button", { name: /Record partial payment/ }).click();
  await expect(page.getByText(/Part payment of ₹560\.00 recorded/)).toBeVisible();

  await page.getByRole("button", { name: "Split by guest…" }).click();
  await page.getByTestId("split-shares").getByRole("button", { name: "Pay" }).last().click();
  await page.getByRole("button", { name: /Complete payment/ }).click();
  await expect(page.getByText("Payment recorded")).toBeVisible();
});
