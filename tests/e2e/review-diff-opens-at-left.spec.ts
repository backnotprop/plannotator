/**
 * A split diff opens at its left edge when a file's first change starts on screen and runs past the right edge
 * (a whole new long line): the first letters of every line stay in view. Scrolling sideways still moves both sides
 * together. Real browser against the compiled binary's code review, on a scratch git repository.
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { openReview, reviewOf } from './review-scratch-session';

const BASE = `export function total(items: { price: number; qty: number; taxable: boolean }[], taxRate: number): number {
  let sum = 0;
  for (const item of items) {
    let line = item.price * item.qty;
    if (item.taxable) line = line + Math.round(line * taxRate * 100) / 100;
    sum += line;
  }
  return sum;
}
`;

const HEAD = `export function total(items: { price: number; qty: number; taxable: boolean }[], taxRate: number): number {
  return items.reduce((acc, it) => acc + priceLine(it.price, it.qty, it.taxable ? taxRate : 0, it.discountPercent ?? 0), 0);
}
`;

type Column = { side: 'old' | 'new'; left: number; wide: boolean; marked: boolean; middle: { x: number; y: number } };

function columns(page: Page): Promise<Column[]> {
  return page.evaluate(() => {
    const out: Column[] = [];
    document.querySelectorAll('diffs-container').forEach((host) => {
      host.shadowRoot?.querySelectorAll<HTMLElement>('code[data-deletions], code[data-additions]').forEach((code) => {
        const box = code.getBoundingClientRect();
        out.push({
          side: code.hasAttribute('data-deletions') ? 'old' : 'new',
          left: code.scrollLeft,
          wide: code.scrollWidth > code.clientWidth,
          marked: code.querySelector('[data-diff-span]') != null,
          middle: { x: box.left + box.width / 2, y: box.top + Math.min(box.height, 60) / 2 },
        });
      });
    });
    return out;
  });
}

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

test('a split diff whose first change is a long new line opens at the left edge, and sideways scrolling moves both sides', async () => {
  const session = await reviewOf('review-diff-opens-at-left', { 'src/fees.ts': BASE }, { 'src/fees.ts': HEAD });
  try {
    const split = (page: Page) => page.context().addCookies([{ name: 'plannotator-diff-style', value: 'split', url: session.url }]);
    const { context, page } = await openReview(browser, session.url, split, { viewport: { width: 1440, height: 900 } });
    await expect
      .poll(async () => (await columns(page)).filter((c) => c.marked).map((c) => c.side).sort(), { timeout: 30_000 })
      .toEqual(['new', 'old']);
    const newSide = (await columns(page)).find((c) => c.side === 'new')!;
    expect(newSide.wide, 'the new line is wider than its side').toBe(true);
    for (let frame = 0; frame < 6; frame++) {
      await page.waitForTimeout(250);
      expect((await columns(page)).map((c) => `${c.side}=${c.left}`), `${frame * 250 + 250}ms after the change marks were drawn`).toEqual(['old=0', 'new=0']);
    }

    await page.mouse.move(newSide.middle.x, newSide.middle.y);
    await page.mouse.wheel(120, 0);
    await expect.poll(async () => (await columns(page)).find((c) => c.side === 'new')!.left, { timeout: 5_000 }).toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const [old, current] = await columns(page);
        return old!.left === current!.left;
      }, { timeout: 5_000 })
      .toBe(true);
    await context.close();
  } finally {
    await session.close();
  }
});
