import { expect, test } from "@playwright/test";

test("create a reservation with a deposit and see it in the list", async ({ page }) => {
  const stored: Record<string, unknown>[] = [];
  await page.route("**/reservations?*", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = req.postDataJSON();
      stored.push({
        id: "res-e2e", phone: null, email: null, tableId: null, table: null,
        specialRequests: null, status: "RESERVED", channel: "STAFF",
        durationMinutes: 90, ...body, deposit: String(body.deposit ?? ""),
      });
      return route.fulfill({ json: stored[0] });
    }
    return route.fulfill({ json: stored });
  });
  await page.goto("/reservations");
  await page.getByRole("button", { name: "New reservation" }).click();
  await page.getByLabel("Customer name").fill("Deposit Dana");
  await page.getByLabel("Deposit (optional)").fill("250.5");
  await page.getByRole("button", { name: "Save reservation" }).click();
  await expect(page.getByText("Deposit Dana")).toBeVisible();
  await expect(page.getByTestId("reservation-deposit")).toContainText("250.50");
});
