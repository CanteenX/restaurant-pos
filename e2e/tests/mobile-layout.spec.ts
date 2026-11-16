import { expect, test, type Page } from "@playwright/test";

// Mobile layout guard: the settings/inventory tab bars must scroll inside
// their own container (never the page), and the POS kitchen-progress pill
// must not overlap the "Weigh item" button at phone width.
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
];

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// The dashboard scrolls inside <main>, so the document itself rarely
// overflows; a too-wide tab bar shows up as <main> scrolling sideways.
async function expectNoPageOverflow(page: Page) {
  const m = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      hasMain: main !== null,
      doc: document.documentElement.scrollWidth - window.innerWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  expect(m.hasMain, "dashboard <main> is rendered").toBe(true);
  expect(m.doc, "document overflows horizontally").toBeLessThanOrEqual(0);
  expect(m.main, "<main> scrolls horizontally").toBeLessThanOrEqual(1);
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const path of ["/settings", "/settings/integrations", "/inventory"]) {
      test(`${path} has no horizontal page overflow`, async ({ page }) => {
        await page.goto(path);
        // The page's own tab bar (inside <main>), not the sidebar nav.
        const tabBar = page.locator("main nav").first();
        await expect(tabBar).toBeVisible();
        await expect(tabBar.locator('[aria-current="page"]')).toBeVisible();
        await expectNoPageOverflow(page);
      });
    }
  });
}

test.describe("tab bar at 375", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("settings tabs scroll inside their own bar", async ({ page }) => {
    await page.goto("/settings");
    const tabBar = page.locator("main nav").first();
    await expect(tabBar).toBeVisible();
    const scrollable = await tabBar.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrollable, "tab bar is wider than the screen and scrolls itself").toBe(true);
  });
});

test.describe("POS kitchen pill", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("does not overlap the Weigh item button", async ({ page }) => {
    await page.route("**/kds/progress**", (r) =>
      r.fulfill({
        json: [
          { id: "k1", status: "NEW" },
          { id: "k2", status: "ACCEPTED" },
          { id: "k3", status: "PREPARING" },
          { id: "k4", status: "READY" },
        ],
      }),
    );
    await page.goto("/pos");
    const weigh = page.getByRole("button", { name: "Weigh item" });
    await expect(weigh).toBeVisible();
    const pill = page.getByTestId("kitchen-progress-pill");
    await expect(pill).toBeVisible();
    const [a, b] = await Promise.all([pill.boundingBox(), weigh.boundingBox()]);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(overlaps(a!, b!)).toBe(false);
  });

  test("no empty row when the kitchen has no active tickets", async ({ page }) => {
    await page.route("**/kds/progress**", (r) => r.fulfill({ json: [] }));
    await page.goto("/pos");
    const weigh = page.getByRole("button", { name: "Weigh item" });
    await expect(weigh).toBeVisible();
    await expect(page.getByTestId("kitchen-progress-pill")).toHaveCount(0);
    // The hidden pill's wrapper must not leave a blank full-width row above
    // the buttons: "Weigh item" sits at the very top of the toolbar.
    const toolbar = weigh.locator("..");
    const [w, row] = await Promise.all([weigh.boundingBox(), toolbar.boundingBox()]);
    expect(w).toBeTruthy();
    expect(row).toBeTruthy();
    expect(w!.y - row!.y).toBeLessThanOrEqual(2);
  });
});
