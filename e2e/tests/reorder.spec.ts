import { expect, test } from "@playwright/test";

const SUGGESTIONS = {
  days: 30,
  groups: [
    {
      supplierId: "s1",
      supplierName: "Metro",
      suggestions: [
        { ingredientId: "i1", name: "Onion", unit: "kg", currentStock: 2, reorderLevel: 10, avgDailyConsumption: 1, suggestedQuantity: 12, packSize: null, packs: null },
        { ingredientId: "i2", name: "Oil", unit: "l", currentStock: 1, reorderLevel: 5, avgDailyConsumption: 0.5, suggestedQuantity: 5, packSize: null, packs: null },
      ],
    },
  ],
};

test("reorder suggestions: edit a quantity and create a purchase request", async ({ page }) => {
  await page.route("**/inventory/reorder-suggestions?*", (r) => r.fulfill({ json: SUGGESTIONS }));
  let posted: unknown = null;
  await page.route("**/inventory/purchase-requests?*", async (r) => {
    if (r.request().method() === "POST") {
      posted = r.request().postDataJSON();
      return r.fulfill({ json: { id: "pr1" } });
    }
    return r.fulfill({ json: [] });
  });

  await page.goto("/inventory/procurement");
  const group = page.getByTestId("reorder-group-s1");
  await expect(group.getByText("Onion")).toBeVisible();

  await group.getByLabel("Order quantity for Onion").fill("20");
  await group.getByLabel("Order quantity for Oil").fill("0");
  await group.getByRole("button", { name: "Create request" }).click();

  await expect.poll(() => posted).toEqual({ items: [{ ingredientId: "i1", quantityRequested: 20 }] });
});
