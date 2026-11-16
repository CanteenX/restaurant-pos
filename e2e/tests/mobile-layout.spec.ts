import { expect, test, type Page } from "@playwright/test";

// Mobile layout guard: the settings/inventory tab bars must scroll inside
// their own container (never the page), and the POS kitchen-progress pill
// must not overlap the "Weigh item" button at phone width.
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
];

// The dashboard scrolls inside <main>, so the document itself rarely
// overflows; a too-wide tab bar shows up as <main> scrolling sideways.
async function expectNoPageOverflow(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
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

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    for (const path of ["/settings", "/settings/integrations", "/inventory"]) {
      test(`${path} has no horizontal page overflow`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole("navigation").first()).toBeVisible();
        await expectNoPageOverflow(page);
      });
    }
  });
}

test.describe("POS kitchen pill", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("does not overlap the Weigh item button", async ({ page }) => {
    await page.route("**/kds/progress?*", (r) =>
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
    const overlaps =
      a!.x < b!.x + b!.width && b!.x < a!.x + a!.width && a!.y < b!.y + b!.height && b!.y < a!.y + a!.height;
    expect(overlaps).toBe(false);
  });
});
