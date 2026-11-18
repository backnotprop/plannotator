/**
 * A Ctrl+click on an arrow opens the context menu and nothing else: no lines open under it. Real Chromium against
 * the compiled binary's code review, on a scratch repository.
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { openReview, reviewOf } from './review-scratch-session';

const totals = (changed: boolean) => Array.from({ length: 40 }, (_, i) => `export const total${i + 1} = ${changed && i === 25 ? 260 : i + 1};`).join('\n') + '\n';
const OPENED_ROW = 'export const total5 = 5;';

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

const arrow = (page: Page) =>
  page.evaluate(() => {
    const found = document.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-expand-button]');
    if (!found) return null;
    const box = found.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });

const opened = (page: Page) =>
  page.evaluate((row) => [...(document.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]') ?? [])].some((line) => line.textContent?.includes(row)), OPENED_ROW);

test('a Ctrl+click on an arrow opens no lines', async () => {
  const session = await reviewOf('review-arrow-ctrl-click', { 'src/totals.ts': totals(false) }, { 'src/totals.ts': totals(true) });
  try {
    const { context, page } = await openReview(browser, session.url);
    await expect.poll(() => arrow(page), { timeout: 30_000 }).not.toBeNull();
    const at = (await arrow(page))!;
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(500);
    await page.keyboard.down('Control');
    await page.mouse.click(at.x, at.y);
    await page.keyboard.up('Control');
    await page.waitForTimeout(1_000);
    expect(await opened(page)).toBe(false);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => opened(page), { timeout: 5_000 }).toBe(true);
    await context.close();
  } finally {
    await session.close();
  }
});
