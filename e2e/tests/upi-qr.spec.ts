import { expect, test } from "@playwright/test";
import { openDashboard } from "./helpers";

// Dynamic UPI QR through the Razorpay adapter, against the local Razorpay
// mock (apps/backend/test/razorpay-mock-server.ts) that scripts/agent/qa-native.sh
// starts on :4010 and points the backend at (RAZORPAY_API_BASE). Never the
// real Razorpay API. Uses Tables 1 and 2 so it never collides with other specs, and
// disconnects Razorpay afterwards so other specs keep the static UPI QR.
const MOCK = process.env.RAZORPAY_MOCK_URL ?? "http://127.0.0.1:4010";
// Test-only keys the mock accepts (see razorpay-mock-server.ts).
const KEYS = { keyId: "rzp_test_mockkey000001", keySecret: "mock-razorpay-secret-not-real" };

interface MockQr {
  id: string;
  payment_amount: number;
  image_content: string;
}

// Disconnect even when the test fails or times out (own timeout budget).
test.afterEach(async ({ page }) => {
  await page.request.delete("/api/v1/integration-hub/razorpay");
});

test("Pay by UPI QR shows a Razorpay QR locked to the exact amount and closes the bill", async ({ page }) => {
  const up = await page.request.get(`${MOCK}/__mock/qr_codes`).catch(() => null);
  test.skip(!up?.ok(), `Razorpay mock not running at ${MOCK} (start it via scripts/agent/qa-native.sh)`);

  const api = page.request;
  await api.put("/api/v1/integration-hub/razorpay", { data: { credentials: KEYS } });
  const tested = await (await api.post("/api/v1/integration-hub/razorpay/test")).json();
  expect(tested.connection.status).toBe("CONNECTED");
  // The key secret never comes back from the API.
  expect(JSON.stringify(await (await api.get("/api/v1/integration-hub")).json())).not.toContain(KEYS.keySecret);

  await openDashboard(page);
  await page.goto("/pos");
  await page.getByRole("button", { name: "Table 2" }).click();
  // Paneer Tikka is ₹280 (tax-inclusive).
  await page.getByRole("button", { name: /Paneer\s*Tikka/ }).first().click();
  await page.getByRole("button", { name: /send to kitchen/i }).click();

  await page.getByRole("radio", { name: "UPI" }).click();
  await page.getByRole("button", { name: /Show Razorpay UPI QR · ₹280\.00/ }).click();

  const qr = page.getByTestId("gateway-qr");
  await expect(qr).toBeVisible();
  await expect(qr.locator("svg").first()).toBeVisible();
  await expect(page.getByTestId("gateway-qr-amount")).toHaveText(/₹280\.00 locked by Razorpay/);
  // While the QR can be paid, the manual UPI Complete must not book a second,
  // never-received payment.
  const complete = page.getByRole("button", { name: /Complete payment · ₹280\.00/ });
  await expect(complete).toBeDisabled();
  await expect(page.getByText(/A Razorpay QR is open/)).toBeVisible();
  await page.screenshot({ path: "test-results/upi-qr-razorpay.png" });

  // Razorpay was asked for exactly ₹280.00 = 28000 paise, single amount-locked QR.
  const created = (await (await api.get(`${MOCK}/__mock/qr_codes`)).json()) as MockQr[];
  expect(created[0].payment_amount).toBe(28_000);
  expect(created[0].image_content).toContain("am=280.00");

  // The guest pays; the till's poll settles the bill on its own.
  await api.post(`${MOCK}/__mock/qr_codes/${created[0].id}/pay`, { data: {} });
  await expect(page.getByText(/Payment received · ₹280\.00|already paid/)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: "test-results/upi-qr-razorpay-paid.png" });
});

test("a gateway QR is withdrawn when the amount to collect changes", async ({ page }) => {
  const up = await page.request.get(`${MOCK}/__mock/qr_codes`).catch(() => null);
  test.skip(!up?.ok(), `Razorpay mock not running at ${MOCK} (start it via scripts/agent/qa-native.sh)`);

  const api = page.request;
  await api.put("/api/v1/integration-hub/razorpay", { data: { credentials: KEYS } });
  await api.post("/api/v1/integration-hub/razorpay/test");

  await openDashboard(page);
  await page.goto("/pos");
  await page.getByRole("button", { name: /^Table 1 / }).click();
  await page.getByRole("button", { name: /Paneer\s*Tikka/ }).first().click();
  await page.getByRole("button", { name: /send to kitchen/i }).click();

  await page.getByRole("radio", { name: "UPI" }).click();
  await page.getByRole("button", { name: /Show Razorpay UPI QR · ₹280\.00/ }).click();
  await expect(page.getByTestId("gateway-qr")).toBeVisible();

  // The cashier takes only part of the bill now: the ₹280 QR must go.
  await page.getByLabel("Amount to pay now").fill("100");
  const stale = page.getByTestId("gateway-qr-stale");
  await expect(stale).toContainText("Amount changed — create a new QR for ₹100.00");
  await expect(page.getByTestId("gateway-qr")).toHaveCount(0);
  // Still held: the old QR might be paid from a phone that already scanned it.
  await expect(page.getByRole("button", { name: /Record partial payment · ₹100\.00/ })).toBeDisabled();
  await page.screenshot({ path: "test-results/upi-qr-razorpay-stale.png" });

  // A new QR is locked to the new amount.
  await stale.getByRole("button", { name: /New QR · ₹100\.00/ }).click();
  await expect(page.getByTestId("gateway-qr-amount")).toHaveText(/₹100\.00 locked by Razorpay/);
  const created = (await (await api.get(`${MOCK}/__mock/qr_codes`)).json()) as MockQr[];
  expect(created.some((q) => q.payment_amount === 10_000)).toBe(true);

  // Switching to cash releases the manual Complete.
  await page.getByRole("radio", { name: "Cash" }).click();
  await expect(page.getByRole("button", { name: /Record partial payment · ₹100\.00/ })).toBeEnabled();
});
