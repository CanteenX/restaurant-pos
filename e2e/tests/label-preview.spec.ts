import { expect, test } from "@playwright/test";

test("label preview updates and generates ZPL / TSPL commands", async ({ page }) => {
  await page.goto("/labels");
  await expect(page.getByRole("heading", { name: "Labels" })).toBeVisible();

  await page.getByLabel("Title").fill("Masala Chai");
  await page.getByLabel("Price").fill("₹120.00");
  await page.getByLabel("Barcode").fill("SKU12345");
  await expect(page.getByTestId("label-preview")).toContainText("Masala Chai");
  await expect(page.getByTestId("label-preview-barcode")).toBeVisible();

  await page.getByRole("button", { name: "Show commands" }).click();
  await expect(page.getByTestId("label-commands")).toContainText("^FDMasala Chai^FS");
  await expect(page.getByTestId("label-commands")).toContainText("^BCN");

  await page.getByLabel("Printer language").selectOption("TSPL");
  await page.getByRole("button", { name: "Show commands" }).click();
  await expect(page.getByTestId("label-commands")).toContainText('TEXT 16,16,"3",0,1,1,"Masala Chai"');
});

test("batch labels from the menu and inventory entry points", async ({ page }) => {
  await page.goto("/menu");
  await page.getByRole("link", { name: "Print labels" }).click();
  await expect(page).toHaveURL(/\/labels\?source=menu/);
  await expect(page.getByTestId("label-batch-note")).toContainText("Batch from menu");
  await page.getByRole("button", { name: "Show commands" }).click();
  await expect(page.getByTestId("label-commands")).toContainText("^XA");
  await page.screenshot({ path: "test-results/labels-batch-menu.png" });

  await page.goto("/inventory");
  await page.getByRole("link", { name: "Print labels" }).click();
  await expect(page).toHaveURL(/\/labels\?source=inventory/);
  await expect(page.getByTestId("label-batch-note")).toContainText("Batch from inventory");
});
