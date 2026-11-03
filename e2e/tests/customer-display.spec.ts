import { expect, test } from "@playwright/test";

// Two browser contexts sharing the owner session (a till and a "tablet"):
// pairing the till makes the cart appear on the display over Socket.IO.
test("paired display on another context mirrors the till cart", async ({ browser, page }) => {
  await page.goto("/pos");
  await page.getByRole("button", { name: "Table 6" }).click();
  await page.getByRole("button", { name: "Pair display" }).click();
  const link = await page.getByText(/\/customer-display\?code=/).innerText();

  const state = await page.context().storageState();
  const tablet = await browser.newContext({ storageState: state });
  const display = await tablet.newPage();
  await display.goto(link);
  await expect(display.getByText("Welcome")).toBeVisible();

  // Add the first menu item to the cart on the till.
  await page.getByRole("button", { name: /Paneer\s*Tikka/ }).first().click();
  await expect(display.getByText("Your order")).toBeVisible({ timeout: 10_000 });
  await tablet.close();
});
