import { expect, test } from "@playwright/test";

test("export to Tally downloads an XML file", async ({ page }) => {
  await page.goto("/accounting");
  await page.getByRole("button", { name: "tally", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export to Tally" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^tally-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xml$/);
  const path = await download.path();
  const text = (await import("node:fs")).readFileSync(path!, "utf8");
  expect(text.trimStart()).toMatch(/^(<\?xml|<ENVELOPE)/);
});

test("ledger mapping can be edited and saved", async ({ page }) => {
  await page.goto("/accounting");
  await page.getByRole("button", { name: "tally", exact: true }).click();
  await page.getByLabel("Sales", { exact: true }).fill(`Food Sales ${Date.now()}`);
  await page.getByRole("button", { name: "Save mapping" }).click();
  await expect(page.getByText("Ledger mapping saved")).toBeVisible();
});
