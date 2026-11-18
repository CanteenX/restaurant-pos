import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// Online channels (#60): connect Swiggy with a generated webhook secret, receive
// a signed order through the public webhook (self-contained, no aggregator
// mock), see it on the card, map a dish and switch it off. Uses its own dish
// so no other spec is affected.
const BRANCH = "demo-branch";
const sign = (secret: string, ts: string, body: string) =>
  `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

test("connect a channel, receive a signed order, map and switch off a dish", async ({ page }) => {
  const api = page.request;
  const tag = randomUUID().slice(0, 6);
  const dishName = `Channel Test Dish ${tag}`;
  const categories = await (await api.get(`/api/v1/menu/categories?branchId=${BRANCH}`)).json();
  const created = await api.post(`/api/v1/menu/items?branchId=${BRANCH}`, {
    data: { categoryId: categories[0].id, name: dishName, price: 150, taxRatePercent: 5 },
  });
  expect(created.ok()).toBeTruthy();
  const dish = await created.json();

  // Connect: the secret is generated in the browser and shown once.
  await page.goto("/settings/integrations");
  const card = page.getByTestId("channel-swiggy");
  await card.getByRole("button", { name: "Connect" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Generate secret" }).click();
  const secretInput = dialog.getByLabel("Webhook signing secret");
  const secret = await secretInput.inputValue();
  expect(secret).toMatch(/^[0-9a-f]{48}$/);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(card.getByText("Waiting for the first signed event")).toBeVisible();

  // Secrets are write-only: never in an API response, and not prefilled.
  const listRes = await api.get("/api/v1/integration-hub");
  expect(await listRes.text()).not.toContain(secret);
  const swiggy = (await listRes.json()).find((p: { key: string }) => p.key === "swiggy");
  expect(swiggy.connection.credentialsSet).toEqual({ webhookSecret: true });
  await card.getByRole("button", { name: "Configure" }).click();
  await expect(dialog.getByLabel("Webhook signing secret")).toHaveValue("");
  await expect(dialog.getByLabel("Webhook signing secret")).toHaveAttribute("placeholder", "Saved — leave blank to keep");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByText("No orders yet")).toBeVisible();

  // Receive: a correctly signed webhook POST.
  const deliver = (event: object) => {
    const body = JSON.stringify(event);
    const ts = String(Math.floor(Date.now() / 1000));
    return api.post(swiggy.webhookPath, {
      headers: {
        "Content-Type": "application/json",
        "X-OrderRestro-Timestamp": ts,
        "X-OrderRestro-Signature": sign(secret, ts, body),
      },
      data: body,
    });
  };
  const order = await deliver({
    event: "order.created",
    orderId: `SWG-${tag}`,
    type: "TAKEAWAY",
    paymentMode: "PREPAID",
    customer: { name: "Channel Test", phone: "9876500042" },
    items: [{ name: dishName, quantity: 2 }],
  });
  expect(order.status(), await order.text()).toBe(200);
  expect((await order.json()).duplicate).toBe(false);

  await page.reload();
  await expect(card.getByText("Live — receiving orders")).toBeVisible();
  await expect(card.getByTestId("last-order-swiggy")).not.toHaveText("No orders yet");
  await expect(card.getByText("Retries pending:")).toBeVisible();
  await page.screenshot({ path: "test-results/online-channels-page.png", fullPage: true });

  // Map the dish to Swiggy's item id; only that dish is sent and merged.
  await card.getByRole("button", { name: "Items" }).click();
  const items = page.getByRole("dialog");
  await items.getByLabel("Search dishes").fill(tag);
  await items.getByLabel(`Platform item id for ${dishName}`).fill(`SWG-ITEM-${tag}`);
  await items.getByRole("button", { name: "Save mapping" }).click();
  await expect(items).toBeHidden();
  const after = (await (await api.get("/api/v1/integration-hub")).json()).find((p: { key: string }) => p.key === "swiggy");
  expect(after.connection.itemMap).toEqual({ [dish.id]: `SWG-ITEM-${tag}` });

  // Switch the dish off from the same dialog.
  await card.getByRole("button", { name: "Items" }).click();
  await items.getByLabel("Search dishes").fill(tag);
  await expect(items.getByLabel(`Platform item id for ${dishName}`)).toHaveValue(`SWG-ITEM-${tag}`);
  const toggle = items.getByRole("switch", { name: `${dishName} available` });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  const saved = await (await api.get(`/api/v1/menu/items/${dish.id}?branchId=${BRANCH}`)).json();
  expect(saved.isActive).toBe(false);
  await page.screenshot({ path: "test-results/online-channels.png", fullPage: true });
  await items.getByRole("button", { name: "Cancel" }).click();

  // Leave the stack as it was.
  await api.delete(`/api/v1/integration-hub/swiggy`);
  await api.delete(`/api/v1/menu/items/${dish.id}?branchId=${BRANCH}`);
});
