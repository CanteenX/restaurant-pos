import { expect, test } from "@playwright/test";

test("scan uses the active branch menu and blocks ambiguous codes", async ({ page }) => {
  let duplicate = false;
  await page.route("**/api/v1/menu/items?branchId=*", async (route) => {
    const response = await route.fetch();
    const items = await response.json();
    const first = items.find((item: { isActive: boolean }) => item.isActive);
    first.barcode = "000381";
    first.sku = "000381";
    if (duplicate) items.push({ ...first, id: "duplicate-381", name: "Duplicate 381" });
    await route.fulfill({ response, json: items });
  });
  await page.goto("/pos");
  await page.getByRole("button", { name: "Table 6" }).click();
  const search = page.getByPlaceholder(/search/i).first();
  await search.fill("000381");
  await search.press("Enter");
  const scan = page.getByLabel("Scan barcode or SKU");
  await expect(scan).toHaveValue("");
  await search.clear();
  await scan.fill("000381");
  await scan.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: /Selected/ })).toBeVisible();
  await expect(scan).toHaveValue("");

  duplicate = true;
  await scan.fill("000381");
  await scan.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: /matches multiple items/ })).toBeVisible();

  await scan.fill("not-a-real-code");
  await scan.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: /No active item matches/ })).toBeVisible();

  await page.context().setOffline(true);
  await scan.fill("000381");
  await scan.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: /unavailable offline/ })).toBeVisible();
  await page.context().setOffline(false);
});
