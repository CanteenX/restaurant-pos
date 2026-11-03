import { expect, test } from "@playwright/test";

const CUSTOMER = {
  id: "cust-e2e", name: "Referral Tester", phone: null, email: null, address: null,
  birthday: null, anniversary: null, allergies: null, notes: null, loyaltyPoints: 0,
  walletBalance: "0", createdAt: new Date().toISOString(), addresses: [], orders: [], giftCards: [],
};
const ROW = {
  id: "ref1", code: "FRIEND23", status: "PENDING", createdAt: new Date().toISOString(),
  rewardedAt: null, referrerPoints: null, referredPoints: null,
  referrer: { id: "cust-e2e", name: "Referral Tester" }, referred: { id: "c2", name: "New Friend" },
};

test("staff applies a referral code and sees it", async ({ page }) => {
  let applied = false;
  await page.route("**/customers/cust-e2e?*", (r) => r.fulfill({ json: CUSTOMER }));
  await page.route("**/customers/cust-e2e/rewards*", (r) => r.fulfill({ status: 404, json: {} }));
  await page.route("**/referrals/customer/cust-e2e*", (r) =>
    r.fulfill({
      json: applied
        ? { made: [ROW], usedCode: { ...ROW, referrer: { id: "x", name: "Asha" }, referred: { id: "cust-e2e", name: "Referral Tester" } } }
        : { made: [ROW], usedCode: null },
    }),
  );
  await page.route("**/referrals/apply*", (r) => {
    applied = true;
    return r.fulfill({ json: { applied: true, referrerName: "Asha" } });
  });
  await page.goto("/customers/cust-e2e");
  await expect(page.getByTestId("referral-list")).toContainText("New Friend");
  await page.getByLabel("Have a referral code?").fill("friend23");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("referral-used")).toContainText("Asha");
});

test("invalid or own code shows an error", async ({ page }) => {
  await page.route("**/customers/cust-e2e?*", (r) => r.fulfill({ json: CUSTOMER }));
  await page.route("**/customers/cust-e2e/rewards*", (r) => r.fulfill({ status: 404, json: {} }));
  await page.route("**/referrals/customer/cust-e2e*", (r) => r.fulfill({ json: { made: [], usedCode: null } }));
  await page.route("**/referrals/apply*", (r) =>
    r.fulfill({ status: 400, json: { message: "You cannot use your own referral code" } }),
  );
  await page.goto("/customers/cust-e2e");
  await page.getByLabel("Have a referral code?").fill("abc");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("referral-error")).toContainText("valid referral code");
  await page.getByLabel("Have a referral code?").fill("MYOWNCODE1");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("referral-error")).toContainText("own referral code");
});
