import { expect, test, type Page } from "@playwright/test";
import { demoBranchId, openDashboard } from "./helpers";

// Digital receipt email at checkout (#222): the optional email field and the
// consent checkbox at phone, tablet and desktop widths. Uses Table 4. The QA
// stack has no SMTP, so the send itself is covered by the backend e2e; here we
// check the field, the consent rule and that the address was recorded.
const WIDTHS = [375, 768, 1440];

test.afterEach(async ({ page }) => {
  await page.request.patch("/api/v1/settings/restaurant", { data: { digitalReceiptsEnabled: false } });
});

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

for (const width of WIDTHS) {
  test(`receipt email field and consent at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.request.patch("/api/v1/settings/restaurant", { data: { digitalReceiptsEnabled: true } });
    const branchId = await demoBranchId(page);

    await openDashboard(page);
    await page.goto("/pos");
    await page.getByRole("button", { name: /^Table 4 / }).click();
    await page.getByRole("button", { name: /Paneer\s*Tikka/ }).first().click();
    // On a phone or tablet the cart opens from a "View cart" bar.
    const viewCart = page.getByRole("button", { name: /View cart/ });
    if (await viewCart.isVisible()) await viewCart.click();
    await page.getByRole("button", { name: /send to kitchen/i }).click();

    const field = page.getByTestId("receipt-email-field");
    await expect(field).toBeVisible();
    await field.scrollIntoViewIfNeeded();
    await noHorizontalScroll(page);
    await page.screenshot({ path: `test-results/receipt-email-${width}.png` });

    // A bad address with consent is refused before anything is charged.
    await page.getByLabel(/Email the receipt to/).fill("not-an-email");
    await field.getByRole("checkbox").check();
    await expect(page.getByText("Enter a valid email address")).toBeVisible();

    await page.getByLabel(/Email the receipt to/).fill("guest@example.com");
    await expect(page.getByText("Enter a valid email address")).toBeHidden();
    const checkoutCall = page.waitForResponse((r) => /\/orders\/[^/]+\/checkout/.test(r.url()) && r.request().method() === "POST");
    await page.getByRole("button", { name: /Complete payment/ }).click();
    const paid = (await (await checkoutCall).json()) as { id: string };

    // The address was recorded with consent (masked in the API).
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/v1/orders/${paid.id}/receipt-email?branchId=${branchId}`);
        return ((await res.json()) as { maskedEmail?: string }).maskedEmail;
      })
      .toBe("g***@example.com");
    await noHorizontalScroll(page);
  });
}
