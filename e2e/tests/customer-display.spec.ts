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

// A display opened after the till already has a cart shows it at once: the
// server hands a late joiner the till's latest state (#146 review).
test("display paired after the cart was built shows it without a cart change", async ({ browser, page }) => {
  await page.goto("/pos");
  await page.getByRole("button", { name: "Table 6" }).click();
  await page.getByRole("button", { name: /Paneer\s*Tikka/ }).first().click();
  await page.getByRole("button", { name: "Pair display" }).click();
  const link = await page.getByText(/\/customer-display\?code=/).innerText();

  const state = await page.context().storageState();
  const tablet = await browser.newContext({ storageState: state });
  const display = await tablet.newPage();
  await display.goto(link);
  await expect(display.getByText("Your order")).toBeVisible({ timeout: 10_000 });
  await tablet.close();
});

// Keyboard/screen-reader access to the pairing popover (WCAG 2.1 AA).
test("pair display popover opens by keyboard, closes on Esc, Unpair works", async ({ page }) => {
  await page.goto("/pos");
  await page.getByRole("button", { name: "Table 6" }).click();
  const trigger = page.getByRole("button", { name: "Pair display" });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const unpair = page.getByRole("button", { name: "Unpair" });
  await expect(unpair).toBeVisible();
  const box = await unpair.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await page.keyboard.press("Escape");
  await expect(unpair).toBeHidden();
  await expect(page.getByRole("button", { name: /Paired/ })).toBeFocused();

  await page.getByRole("button", { name: /Paired/ }).click();
  await page.getByRole("button", { name: "Unpair" }).click();
  await expect(page.getByRole("button", { name: "Pair display" })).toBeVisible();
});

test("a bad pairing link tells the user to scan again", async ({ page }) => {
  await page.goto("/customer-display?code=BAD&branch=x");
  await expect(page.locator("main").getByRole("alert")).toContainText("Invalid pairing link — scan the code on the till again");
  await expect(page.getByText("Welcome")).toHaveCount(0);
});
