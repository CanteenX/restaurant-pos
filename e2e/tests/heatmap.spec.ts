import { expect, test } from "@playwright/test";

const CATALOG = [
  { key: "peak-hours", title: "Peak hours", group: "Analytics" },
  { key: "table-turnover", title: "Table turnover", group: "Operations" },
];

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/v1\/reports(\?.*)?$/, (r) => r.fulfill({ json: CATALOG }));
  await page.route("**/api/v1/reports/peak-hours?*", (r) =>
    r.fulfill({
      json: {
        key: "peak-hours", title: "Peak hours", columns: ["Day", "Hour", "Orders", "Sales"],
        rows: [["Fri", "20:00", 10, 900], ["Mon", "09:00", 2, 50]],
      },
    }),
  );
  await page.route("**/api/v1/reports/table-turnover?*", (r) =>
    r.fulfill({
      json: {
        key: "table-turnover", title: "Table turnover", columns: ["Table", "Orders", "Avg minutes per order"],
        rows: [["Table 1", 9, 42], ["Table 2", 3, 30]],
      },
    }),
  );
});

test("day-by-hour heat map renders cells, metric toggle and legend", async ({ page }) => {
  await page.goto("/reports");
  await page.getByRole("button", { name: "Peak hours" }).click();
  await expect(page.getByTestId("day-hour-heatmap")).toBeVisible();
  await expect(page.getByTestId("heat-cell")).toHaveCount(7 * 24);
  await expect(page.locator('[data-testid="heat-cell"][data-value="10"]')).toHaveCount(1);
  await expect(page.getByTestId("heatmap-legend")).toBeVisible();
  await page.getByRole("button", { name: "Revenue" }).click();
  await expect(page.locator('[data-testid="heat-cell"][data-value="900"]')).toHaveCount(1);
  await page.screenshot({ path: "test-results/heatmap-day-hour.png" });
});

test("table heat map ranks busiest table first with legend", async ({ page }) => {
  await page.goto("/reports");
  await page.getByRole("button", { name: "Table turnover" }).click();
  const map = page.getByTestId("table-heatmap");
  await expect(map).toBeVisible();
  await expect(map.getByText("Table 1")).toBeVisible();
  await expect(page.getByTestId("heatmap-legend")).toBeVisible();
  await page.screenshot({ path: "test-results/heatmap-tables.png" });
});
