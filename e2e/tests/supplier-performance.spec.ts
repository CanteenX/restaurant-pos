import { expect, test } from "@playwright/test";

const SUPPLIER = {
  id: "sup-e2e", name: "E2E Fresh Produce", contactName: "Asha", phone: null, email: null,
};

test("supplier row opens performance metrics", async ({ page }) => {
  await page.route("**/inventory/suppliers?*", (r) => r.fulfill({ json: [SUPPLIER] }));
  await page.route("**/inventory/suppliers/sup-e2e/performance*", (r) =>
    r.fulfill({
      json: {
        supplierId: "sup-e2e", supplierName: SUPPLIER.name, totalPurchaseOrders: 4,
        totalSpend: 12500, onTimeDeliveryRate: 75, avgLeadTimeDays: 2.5,
      },
    }),
  );
  await page.goto("/inventory/suppliers");
  await page.getByRole("button", { name: "Performance for E2E Fresh Produce" }).click();
  await expect(page.getByText("On-time delivery")).toBeVisible();
  await expect(page.getByText("75%")).toBeVisible();
  await expect(page.getByText("2.5 days")).toBeVisible();
});

test("supplier with no deliveries shows an empty note", async ({ page }) => {
  await page.route("**/inventory/suppliers?*", (r) => r.fulfill({ json: [SUPPLIER] }));
  await page.route("**/inventory/suppliers/sup-e2e/performance*", (r) =>
    r.fulfill({
      json: {
        supplierId: "sup-e2e", supplierName: SUPPLIER.name, totalPurchaseOrders: 0,
        totalSpend: 0, onTimeDeliveryRate: null, avgLeadTimeDays: null,
      },
    }),
  );
  await page.goto("/inventory/suppliers");
  await page.getByRole("button", { name: "Performance for E2E Fresh Produce" }).click();
  await expect(page.getByTestId("supplier-no-deliveries")).toBeVisible();
});

test("performance error shows a retry", async ({ page }) => {
  await page.route("**/inventory/suppliers?*", (r) => r.fulfill({ json: [SUPPLIER] }));
  await page.route("**/inventory/suppliers/sup-e2e/performance*", (r) =>
    r.fulfill({ status: 500, json: { message: "boom" } }),
  );
  await page.goto("/inventory/suppliers");
  await page.getByRole("button", { name: "Performance for E2E Fresh Produce" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
});
