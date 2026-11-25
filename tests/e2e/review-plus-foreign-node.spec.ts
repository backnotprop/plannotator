/**
 * A node the diff library did not draw (one a browser extension injects, say) does not take the page down when the
 * "+" in a diff's gutter is pressed. Real Chromium against the compiled binary's code review, on a scratch
 * repository, with the file open in its own tab, in Split and in Unified: a hidden node is put first inside the diff's
 * code column, or among its gutter rows, then the "+" of a changed line is pressed.
 *
 * What regresses if this fails: the press throws inside React's commit ("gutter and content children dont match"),
 * the whole page goes blank, and no comment box opens. Each step says which layout, node and line in its message.
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { openReview, reviewOf } from './review-scratch-session';

const FILE = 'src/plan.ts';
const CHANGED = [8, 9, 10, 11, 12];
const text = (word: 'old' | 'new') =>
  Array.from({ length: 30 }, (_, i) => `export const row${i + 1} = '${CHANGED.includes(i + 1) ? `${word} wording of row ${i + 1}.` : `row ${i + 1} stays the same.`}';`).join('\n') + '\n';

type Where = 'code column' | 'gutter rows';

/** The centre of new line `line`'s number, found by its words and its line index (not by child position). */
function lineNumber(page: Page, line: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ({ marker }) => {
      const host = [...document.querySelectorAll('diffs-container')].find((h) => h.checkVisibility({ visibilityProperty: true }) && h.getBoundingClientRect().width > 0);
      const pre = host?.shadowRoot?.querySelector('pre');
      if (!pre) return null;
      const split = pre.getAttribute('data-diff-type') === 'split';
      // The new side's code column: additions in Split, the one column in Unified.
      const code = [...pre.querySelectorAll(':scope > [data-code]')].find((c) => !split || c.hasAttribute('data-additions'));
      const content = code?.querySelector(':scope > [data-content]');
      const gutter = code?.querySelector(':scope > [data-gutter]');
      const row = [...(content?.children ?? [])].find((r) => r.textContent?.includes(marker));
      const index = row?.getAttribute('data-line-index');
      const number = index == null ? null : gutter?.querySelector<HTMLElement>(`:scope > [data-line-index="${index}"]`);
      if (!number) return null;
      const box = number.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    },
    { marker: `new wording of row ${line}.` },
  );
}

/** Puts a hidden node where a browser extension might: first inside every code column, or among the gutter rows. */
function inject(page: Page, where: Where): Promise<number> {
  return page.evaluate(
    ({ where }) => {
      const host = [...document.querySelectorAll('diffs-container')].find((h) => h.checkVisibility({ visibilityProperty: true }) && h.getBoundingClientRect().width > 0);
      const root = host?.shadowRoot;
      if (!root) return 0;
      const node = () => {
        const span = document.createElement('span');
        span.setAttribute('style', 'position:absolute');
        span.setAttribute('data-from-an-extension', '');
        return span;
      };
      let count = 0;
      if (where === 'code column') {
        for (const code of root.querySelectorAll('pre > [data-code]')) {
          code.prepend(node());
          count++;
        }
      } else {
        for (const gutter of root.querySelectorAll('pre > [data-code] > [data-gutter]')) {
          gutter.insertBefore(node(), gutter.children[3] ?? null);
          count++;
        }
      }
      return count;
    },
    { where },
  );
}

function plusButton(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const host = [...document.querySelectorAll('diffs-container')].find((h) => h.checkVisibility({ visibilityProperty: true }) && h.getBoundingClientRect().width > 0);
    const button = host?.shadowRoot?.querySelector<HTMLElement>('[data-gutter-utility-slot] [data-utility-button]');
    if (!button) return null;
    const box = button.getBoundingClientRect();
    return box.width > 0 ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  });
}

const composer = (page: Page) => page.locator('div.w-80', { has: page.locator('textarea[placeholder^="Leave feedback"]') });

test.use({ actionTimeout: 20_000 });

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

for (const layout of ['split', 'unified'] as const) {
  for (const where of ['code column', 'gutter rows'] as const) {
    test(`${layout}: with a foreign node in the ${where}, the "+" opens the comment box and the page stays`, async () => {
      const session = await reviewOf(`review-plus-foreign-${layout}-${where.replace(' ', '-')}`, { [FILE]: text('old') }, { [FILE]: text('new') });
      try {
        const { context, page } = await openReview(browser, session.url, (p) =>
          p.context().addCookies([{ name: 'plannotator-diff-style', value: layout, url: session.url }]),
        );
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.locator(`[data-changes-tree] [data-type="item"][data-item-path$="plan.ts"]`).first().click();

        const line = 10;
        await expect.poll(() => lineNumber(page, line), { timeout: 15_000, message: `${layout}: new line ${line} is drawn` }).not.toBeNull();
        expect(await inject(page, where), `${layout}: a node was put in the ${where}`).toBeGreaterThan(0);

        const at = (await lineNumber(page, line))!;
        await page.mouse.move(at.x, at.y, { steps: 6 });
        await expect.poll(() => plusButton(page), { timeout: 5_000, message: `${layout}: the "+" is drawn on line ${line}` }).not.toBeNull();
        const plus = (await plusButton(page))!;
        await page.mouse.click(plus.x, plus.y);

        await expect(composer(page), `${layout}, ${where}: a press on the "+" opens the comment box`).toBeVisible({ timeout: 5_000 });
        await expect(composer(page).locator('span.text-xs').first(), `${layout}, ${where}: the box is for line ${line}`).toHaveText(`Line ${line}`);
        expect(await page.locator('#root > *').count(), `${layout}, ${where}: the page is still drawn`).toBeGreaterThan(0);
        expect(errors, `${layout}, ${where}: no uncaught error on the page`).toEqual([]);

        await context.close();
      } finally {
        await session.close();
      }
    });
  }
}
