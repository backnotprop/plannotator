/**
 * In WebKit a mouse click on an arrow or on its "unmodified lines" label opens the lines even when the file's whole
 * text lands while the button is held down: nothing redraws the row between the press and the click. Real WebKit
 * against the compiled binary's code review, on a scratch repository; the whole text is held until the press.
 */

import { expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { openReview, reviewOf } from './review-scratch-session';

const totals = (changed: boolean) => Array.from({ length: 40 }, (_, i) => `export const total${i + 1} = ${changed && i === 25 ? 260 : i + 1};`).join('\n') + '\n';
const OPENED_ROW = 'export const total5 = 5;';

let browser: Browser;
test.beforeAll(async () => {
  browser = await webkit.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

const target = (page: Page, selector: string) =>
  page.evaluate((wanted) => {
    const found = document.querySelector('diffs-container')?.shadowRoot?.querySelector(wanted);
    if (!found) return null;
    const box = found.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, selector);

const opened = (page: Page) =>
  page.evaluate((row) => [...(document.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]') ?? [])].some((line) => line.textContent?.includes(row)), OPENED_ROW);

for (const [name, selector] of [
  ['arrow', '[data-expand-button]'],
  ['label', '[data-unmodified-lines]'],
] as const) {
  test(`a mouse click on the ${name} opens the lines when the whole text lands during the press`, async () => {
    const session = await reviewOf(`review-arrow-press-${name}`, { 'src/totals.ts': totals(false) }, { 'src/totals.ts': totals(true) });
    try {
      let release = () => {};
      const held = new Promise<void>((done) => {
        release = done;
      });
      const { context, page } = await openReview(browser, session.url, (page) =>
        page.route('**/api/file-content?*', async (route) => {
          await held;
          await route.continue().catch(() => {});
        }),
      );
      await expect.poll(() => target(page, selector), { timeout: 30_000 }).not.toBeNull();
      const at = (await target(page, selector))!;
      await page.mouse.move(at.x - 4, at.y);
      await page.mouse.move(at.x, at.y);
      await page.waitForTimeout(200);
      await page.mouse.down();
      release();
      await page.waitForTimeout(700);
      await page.mouse.up();
      await expect.poll(() => opened(page), { timeout: 5_000 }).toBe(true);
      await context.close();
    } finally {
      await session.close();
    }
  });
}
