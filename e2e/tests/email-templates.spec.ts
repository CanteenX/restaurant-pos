import { expect, test, type Page } from "@playwright/test";
import { DEMO_OWNER } from "./helpers";

// Settings > Email templates (#221): structured editor, live server preview,
// save / reset, branding, and "Send test to my email". The QA stack has no
// SMTP, so the send-test call itself is answered by a route mock; everything
// else talks to the real API.
const PATH = "/settings/email-templates";
const API = "/api/v1/email-templates";

async function openPasswordReset(page: Page) {
  await page.goto(PATH);
  await page.getByTestId("email-template-PASSWORD_RESET").getByRole("button").first().click();
  await expect(page.getByRole("heading", { name: "Edit: Password reset" })).toBeVisible();
}

// The dashboard scrolls inside <main>; neither it nor the document may scroll sideways.
async function expectNoHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      doc: document.documentElement.scrollWidth - window.innerWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  expect(m.doc, "document overflows horizontally").toBeLessThanOrEqual(0);
  expect(m.main, "<main> scrolls horizontally").toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ page }) => {
  // Start every test from the code default.
  await page.request.post(`${API}/PASSWORD_RESET/reset`);
});

test("the tab is listed and the page shows the 6 templates", async ({ page }) => {
  await page.goto(PATH);
  const tab = page.locator("main nav").getByRole("link", { name: "Email templates" });
  await expect(tab).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("email-template-list").locator("li")).toHaveCount(6);
  await expect(page.getByTestId("email-template-PASSWORD_RESET")).toContainText("Default");
});

test("edit the subject, see the preview update, save, then reset to default", async ({ page }) => {
  const subject = `E2E reset ${Date.now()}`;
  await openPasswordReset(page);
  await expect(page.getByTestId("email-preview-subject")).toHaveText("Subject: Reset your password");

  await page.getByLabel("Subject", { exact: true }).fill(subject);
  await page.getByLabel("Heading", { exact: true }).fill("Heading from e2e");
  await expect(page.getByTestId("email-preview-subject")).toHaveText(`Subject: ${subject}`);
  await expect(page.frameLocator('[data-testid="email-preview-frame"]').getByText("Heading from e2e")).toBeVisible();

  // Plain-text version and the mobile width.
  await page.getByRole("button", { name: "Plain text" }).click();
  await expect(page.getByTestId("email-preview-text")).toContainText("Heading from e2e");
  await page.getByRole("button", { name: "HTML" }).click();
  await page.getByRole("button", { name: "Mobile" }).click();
  await expect(page.getByTestId("email-preview-frame")).toHaveCSS("width", "375px");

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(page.getByTestId("email-template-PASSWORD_RESET")).toContainText("Customised");
  const saved = await (await page.request.get(`${API}/PASSWORD_RESET`)).json();
  expect(saved.subject).toBe(subject);

  await page.getByRole("button", { name: "Reset to default" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Reset this email to the default?");
  await dialog.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByTestId("email-template-PASSWORD_RESET")).toContainText("Default");
  await expect(page.getByLabel("Subject", { exact: true })).toHaveValue("Reset your password");
});

test("placeholder chips insert only this template's placeholders; bad ones are flagged", async ({ page }) => {
  await openPasswordReset(page);
  const chips = page.getByTestId("placeholder-chips");
  await expect(chips.getByRole("button", { name: "Insert user.name" })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Insert order.total" })).toHaveCount(0);

  const subjectInput = page.getByLabel("Subject", { exact: true });
  await subjectInput.fill("Hi ");
  await subjectInput.click();
  await subjectInput.press("End");
  await chips.getByRole("button", { name: "Insert user.name" }).click();
  await expect(subjectInput).toHaveValue("Hi {{user.name}}");

  await subjectInput.fill("Total {{order.total}}");
  await expect(page.getByText("Not available in this email: {{order.total}}")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("send test goes to the signed-in user's own email and handles 400 / 429", async ({ page }) => {
  const real = await (await page.request.get(`${API}/test-recipient`)).json();
  expect(real.email).toBe(DEMO_OWNER.email);

  // No SMTP on the QA stack: report it as configured and mock the send.
  await page.route(`**${API}/test-recipient`, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), configured: true } });
  });
  const bodies: unknown[] = [];
  let status = 200;
  await page.route(`**${API}/PASSWORD_RESET/test`, async (route) => {
    bodies.push(route.request().postDataJSON());
    if (status === 200) await route.fulfill({ json: { sent: true } });
    else
      await route.fulfill({
        status,
        json: {
          message:
            status === 429
              ? "Too many test emails. Try again in 5 minute(s)."
              : "Your account has no email address. Add one to your profile to receive test emails.",
        },
      });
  });

  await openPasswordReset(page);
  await expect(page.getByTestId("email-test-recipient")).toHaveText(`Goes to ${DEMO_OWNER.email}`);
  const send = page.getByRole("button", { name: "Send test to my email" });

  await send.click();
  await expect(page.getByRole("status").filter({ hasText: `Test email sent to ${DEMO_OWNER.email}.` })).toBeVisible();
  // The request carries the draft only, never a recipient.
  expect(Object.keys(bodies[0] as object)).toEqual(["draft"]);

  status = 429;
  await send.click();
  await expect(page.getByRole("alert").filter({ hasText: "Too many test emails" })).toBeVisible();

  status = 400;
  await send.click();
  await expect(page.getByRole("alert").filter({ hasText: "Your account has no email address" })).toBeVisible();
});

test("branding saves through the branding endpoint", async ({ page }) => {
  const before = await (await page.request.get(`${API}/branding`)).json();
  await page.goto(PATH);
  const card = page.getByTestId("email-branding");
  await card.getByLabel("Header text").fill("E2E header");
  await card.getByLabel("Reply-to address").fill("not-an-email");
  await expect(card.getByText("Enter a valid reply-to address.")).toBeVisible();
  await card.getByLabel("Reply-to address").fill("hello@example.com");
  await card.getByRole("button", { name: "Save branding" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Branding saved." })).toBeVisible();
  const after = await (await page.request.get(`${API}/branding`)).json();
  expect(after).toMatchObject({ headerText: "E2E header", replyTo: "hello@example.com" });
  // Put the demo data back.
  await page.request.put(`${API}/branding`, {
    data: { ...before, replyTo: before.replyTo ?? "" },
  });
});

for (const viewport of [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
]) {
  test(`no horizontal overflow at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPasswordReset(page);
    await expect(page.getByTestId("email-preview-frame")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if (viewport.width !== 768)
      await page.screenshot({ path: `test-results/email-templates-${viewport.width}.png`, fullPage: true });
  });
}
