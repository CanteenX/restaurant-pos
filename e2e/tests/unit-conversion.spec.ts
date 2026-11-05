import { expect, test } from "@playwright/test";

const FLOUR = {
  id: "ing-e2e", name: "E2E Flour", sku: null, unit: "KG", reorderLevel: "1",
  currentStock: "40.000", costPerUnit: "50.000000", isActive: true,
};

test("waste dialog previews a converted quantity and sends the entered unit", async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  await page.route("**/inventory/ingredients?*", (r) => r.fulfill({ json: [FLOUR] }));
  await page.route("**/inventory/ingredients/ing-e2e/conversions*", (r) =>
    r.fulfill({ json: [{ unit: "PACK", factor: "25.000000" }] }),
  );
  await page.route("**/inventory/waste?*", async (r) => {
    if (r.request().method() === "POST") {
      posted = r.request().postDataJSON() as Record<string, unknown>;
      return r.fulfill({ json: {} });
    }
    return r.fulfill({ json: [] });
  });

  await page.goto("/inventory/waste");
  await page.getByRole("button", { name: "Log waste" }).first().click();
  await page.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /E2E Flour/ }).click();
  await page.getByLabel(/Quantity/).fill("500");

  await page.getByTestId("unit-select").click();
  await expect(page.getByRole("option", { name: "G", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "PACK" })).toBeVisible();
  await page.getByRole("option", { name: "G", exact: true }).click();
  await expect(page.getByTestId("unit-preview")).toHaveText("Equals 0.5 KG");

  await page.getByTestId("unit-select").click();
  await page.getByRole("option", { name: "PACK" }).click();
  await page.getByLabel(/Quantity/).fill("2");
  await expect(page.getByTestId("unit-preview")).toHaveText("Equals 50 KG");

  await page.getByRole("dialog").getByRole("button", { name: "Log waste" }).click();
  await expect.poll(() => posted).toMatchObject({ ingredientId: "ing-e2e", quantity: 2, unit: "PACK" });
});
