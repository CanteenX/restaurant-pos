import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers";

// Guest scans a table QR code and orders without logging in; the ticket must
// reach the right kitchen station with the guest's name. Uses Table 6.
test("guest QR order reaches the kitchen display", async ({ page, browser }) => {
  await openDashboard(page);

  const floors = await (await page.request.get("/api/v1/tables/floors")).json();
  const tables = (Array.isArray(floors) ? floors : [floors]).flatMap((f: { tables?: unknown[] }) => f.tables ?? []) as {
    id: string;
    name: string;
    branchId?: string;
  }[];
  const table = tables.find((t) => t.name === "Table 6");
  expect(table, "seeded Table 6").toBeTruthy();

  const rotated = await page.request.post(
    `/api/v1/tables/${table!.id}/qr-token${table!.branchId ? `?branchId=${table!.branchId}` : ""}`,
  );
  expect(rotated.ok()).toBeTruthy();
  const { qrToken } = (await rotated.json()) as { qrToken: string };

  // Guest: separate, logged-out browser context.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(`/order/${qrToken}`);
  await guest.getByPlaceholder("e.g. Priya").fill("Asha");
  await guest.keyboard.press("Enter");
  await guest.getByRole("button", { name: "Add" }).last().click(); // last item on the menu (a drink)
  await guest.getByRole("button", { name: /Place order/ }).click();
  await expect(guest.getByText("Thank you, Asha!")).toBeVisible();
  await guestContext.close();

  await page.goto("/kds");
  await expect(page.getByText(/Table 6 .*Asha/).first()).toBeVisible();
});
