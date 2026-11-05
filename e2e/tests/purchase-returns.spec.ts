import { expect, test } from "@playwright/test";

const PO = {
  id: "po1", poNumber: "PO-0001", status: "RECEIVED", supplierId: "s1", totalAmount: "500",
  createdAt: "2026-11-01T10:00:00Z",
  supplier: { id: "s1", name: "Metro" }, createdBy: { id: "u1", name: "Owner" },
  items: [{ id: "poi1", ingredientId: "ing1", quantityOrdered: "10", quantityReceived: "10", unitCost: "50",
    ingredient: { id: "ing1", name: "Onion", unit: "kg" } }],
  goodsReceipts: [{ id: "g1", grnNumber: "GRN-0001", receivedAt: "2026-11-02T10:00:00Z",
    receivedBy: { id: "u1", name: "Owner" },
    items: [{ id: "gi1", ingredientId: "ing1", quantity: "10", unitCost: "50" }] }],
};

test("create a purchase return from a goods receipt with quantity limits", async ({ page }) => {
  const returns: unknown[] = [];
  let posted: { items: { quantity: number }[]; goodsReceiptId: string } | null = null;
  await page.route("**/inventory/purchase-orders/po1?*", (r) => r.fulfill({ json: PO }));
  await page.route("**/inventory/purchase-returns?*", async (r) => {
    if (r.request().method() === "POST") {
      posted = r.request().postDataJSON();
      returns.push({
        id: "r1", returnNumber: "DN-0001", reason: "DAMAGED", notes: null, totalAmount: "150",
        createdAt: "2026-11-04T10:00:00Z", goodsReceiptId: "g1", supplier: { id: "s1", name: "Metro" },
        goodsReceipt: { id: "g1", grnNumber: "GRN-0001" }, createdBy: { id: "u1", name: "Owner" },
        items: [{ id: "ri1", goodsReceiptItemId: "gi1", ingredientId: "ing1", quantity: "3" }],
      });
      return r.fulfill({ json: returns[0] });
    }
    return r.fulfill({ json: returns });
  });

  await page.goto("/inventory/purchase-orders/po1");
  await page.getByTestId("return-items-g1").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Can return up to 10 kg")).toBeVisible();

  await dialog.getByLabel("Quantity to return").fill("11");
  await expect(dialog.getByRole("alert")).toHaveText("At most 10 can be returned");
  await expect(dialog.getByRole("button", { name: "Record return" })).toBeDisabled();

  await dialog.getByLabel("Quantity to return").fill("3");
  await dialog.getByRole("button", { name: "Record return" }).click();

  await expect(page.getByTestId("po-returns").getByText("DN-0001")).toBeVisible();
  expect(posted).toMatchObject({ goodsReceiptId: "g1", items: [{ goodsReceiptItemId: "gi1", quantity: 3 }] });
});
