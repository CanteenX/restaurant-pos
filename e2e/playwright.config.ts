import { defineConfig, devices } from "@playwright/test";

// The suite assumes a FRESH demo stack (./install.sh --demo): seeded tables,
// menu and the owner@demo.local login. Specs that change data use tables no
// other spec touches. One login (auth.setup.ts) is shared by all specs because
// the login endpoint is throttled to 5/minute.
//
// In Claude cloud VMs Chrome for Testing is pre-installed and CHROME_PATH is
// set; use it instead of downloading Playwright's own browser.
const chromePath = process.env.CHROME_PATH;
const browser = {
  ...devices["Desktop Chrome"],
  ...(chromePath ? { launchOptions: { executablePath: chromePath } } : {}),
};

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:1995",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, use: browser },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: { ...browser, storageState: "playwright/.auth/owner.json" },
    },
  ],
});
