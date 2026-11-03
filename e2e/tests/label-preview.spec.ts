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
