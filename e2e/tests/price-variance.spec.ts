import { expect, test } from "@playwright/test";

const COLUMNS = [
  "Ingredient", "Supplier", "Unit", "Receipts", "Last cost", "Average cost", "Min cost", "Max cost",
  "Previous cost", "Variance vs previous %", "Quoted price", "Variance vs quote %",
];
const ROWS = [
  ["Onion", "Metro", "kg", 2, 30, 30, 30, 30, 30, 0, null, null],
  ["Tomato", "Fresh Farm", "kg", 2, 60, 55, 50, 60, 50, 20, 55, 9.09],
];

test("price variance report highlights, filters and offers CSV", async ({ page }) => {
  await page.route("**/reports/price-variance?*", (r) =>
    r.fulfill({ json: { key: "price-variance", title: "Purchase price variance", columns: COLUMNS, rows: ROWS } }),
  );
  await page.goto("/reports");
  await page.getByRole("button", { name: "Purchase price variance" }).click();
  const table = page.getByTestId("price-variance");
  await expect(table.getByText("Tomato")).toBeVisible();
  await expect(table.locator('td[data-variance="high"]')).toHaveCount(1);
  await expect(page.getByTestId("price-variance-csv")).toHaveAttribute("href", /format=csv/);

  await page.getByLabel("Filter ingredient or supplier").fill("onion");
  await expect(table.getByText("Tomato")).toHaveCount(0);
  await expect(table.getByText("Onion")).toBeVisible();
});
