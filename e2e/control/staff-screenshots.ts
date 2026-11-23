import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

export async function captureStaffScreen(page: Page, name: string) {
  const directory = process.env.CONTROL_QA_SCREENSHOT_DIR;
  if (!directory) return;
  const original = page.viewportSize();
  await mkdir(directory, { recursive: true });
  try {
    for (const { label, width, height } of [
      { label: 'desktop', width: 1440, height: 1000 },
      { label: 'mobile', width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async () => {
        await document.fonts.ready;
        window.scrollTo(0, 0);
      });
      await page.screenshot({ path: join(directory, name + '-' + label + '.png'),
        fullPage: true, animations: 'disabled' });
    }
  } finally {
    if (original) await page.setViewportSize(original);
  }
}
