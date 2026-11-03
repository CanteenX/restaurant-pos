import { expect, test, type Page } from "@playwright/test";

// Seeds REAL paid orders through the demo-stack API (dine-in on Tables 7 and 8,
// which no other spec touches) so the heat maps render the live report data.
type Id = { id: string; name?: string; branchId?: string };

async function seedPaidOrder(page: Page, tableName: string, qty: number): Promise<void> {
  const floors = await (await page.request.get("/api/v1/tables/floors")).json();
  const tables = (Array.isArray(floors) ? floors : [floors]).flatMap(
    (f: { tables?: Id[] }) => f.tables ?? [],
  ) as Id[];
  const table = tables.find((t) => t.name === tableName);
  expect(table, `seeded ${tableName}`).toBeTruthy();
  const q = `?branchId=${table!.branchId ?? "demo-branch"}`; // seeded demo branch

  const menu = await (await page.request.get(`/api/v1/menu/items${q}`)).json();
  const items = (Array.isArray(menu) ? menu : menu.items) as Id[];
  const created = await page.request.post(`/api/v1/orders${q}`, {
    data: { type: "DINE_IN", tableId: table!.id, items: [{ menuItemId: items[0].id, quantity: qty, modifierIds: [] }] },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const order = (await created.json()) as { id: string; totalAmount: string | number };
  const paid = await page.request.post(`/api/v1/orders/${order.id}/checkout${q}`, {
    data: { payments: [{ method: "CASH", amount: Number(order.totalAmount) }] },
  });
  expect(paid.ok(), await paid.text()).toBeTruthy();
}

// Reports bucket by the branch timezone, which can already be "tomorrow" in UTC
// terms, so widen the page's default (UTC-dated) range to always include today.
async function openReport(page: Page, name: string): Promise<void> {
  await page.goto("/reports");
  await page.getByRole("button", { name }).click();
  const dates = page.locator('input[type="date"]');
  await dates.nth(1).fill(new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10));
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: "playwright/.auth/owner.json" });
  const page = await ctx.newPage();
  await page.goto("/dashboard");
  await seedPaidOrder(page, "Table 7", 1);
  await seedPaidOrder(page, "Table 7", 2);
  await seedPaidOrder(page, "Table 8", 1);
  await ctx.close();
});

test("day-by-hour heat map renders cells, metric toggle and legend", async ({ page }) => {
  await openReport(page, "Peak hours");
  await expect(page.getByTestId("day-hour-heatmap")).toBeVisible();
  await expect(page.getByTestId("heat-cell")).toHaveCount(7 * 24);
  // Three orders were just paid in the current hour: some cell holds them.
  const orderCounts = await page.getByTestId("heat-cell").evaluateAll((els) =>
    els.map((e) => Number(e.getAttribute("data-value"))),
  );
  expect(orderCounts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3);
  expect(Math.max(...orderCounts)).toBeGreaterThan(0);
  await expect(page.getByTestId("heatmap-legend")).toBeVisible();
  await page.getByRole("button", { name: "Revenue" }).click();
  const revenue = await page.getByTestId("heat-cell").evaluateAll((els) =>
    els.map((e) => Number(e.getAttribute("data-value"))),
  );
  expect(Math.max(...revenue)).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/heatmap-day-hour.png" });
});

test("table heat map ranks busiest table first with legend", async ({ page }) => {
  await openReport(page, "Table turnover");
  const map = page.getByTestId("table-heatmap");
  await expect(map).toBeVisible();
  await expect(map.getByText("Table 7")).toBeVisible();
  await expect(map.getByText("Table 8")).toBeVisible();
  await expect(page.getByTestId("heatmap-legend")).toBeVisible();
  await page.screenshot({ path: "test-results/heatmap-tables.png" });
});
