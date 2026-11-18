import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './control',
  workers: 1,
  preserveOutput: 'never',
  use: { baseURL: 'http://localhost:4172', launchOptions: { executablePath: process.env.CHROME_PATH } },
});