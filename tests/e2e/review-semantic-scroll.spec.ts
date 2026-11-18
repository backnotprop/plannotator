/**
 * When the semantic notes land in other files, the row under the person's eye
 * keeps its place on screen, whether or not they opened unchanged lines in
 * their own file first. Real Chromium against the compiled binary's code
 * review, on a scratch repository; the files around are read late, so their
 * notes land after the person opened lines.
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { openReview, reviewOf } from './review-scratch-session';

const fn = (name: string, lines: number) => [`export function ${name}(value: number): number {`, ...Array.from({ length: lines }, (_, i) => `  value = value * ${i + 2} + ${name.length};`), '  return value;', '}', ''];
const text = (...blocks: string[][]) => blocks.flat().join('\n');
const totals = (changed: boolean) => Array.from({ length: 40 }, (_, i) => `export const total${i + 1} = ${changed && i === 25 ? 260 : i + 1};`).join('\n') + '\n';

const BASE = {
  'src/a-money.ts': text(fn('cents', 8), fn('round', 8), fn('format', 8), fn('parse', 8)),
  'src/b-totals.ts': totals(false),
  'src/c-validators.ts': text(fn('isEmail', 6), fn('isPhone', 6), fn('isName', 6)),
};
const HEAD = {
  'src/a-money.ts': text(fn('round', 8), fn('format', 8), fn('parse', 8), fn('cents', 8)),
  'src/b-totals.ts': totals(true),
  'src/c-validators.ts': text(fn('isPhone', 6), fn('isName', 6), fn('isEmail', 6)),
};

const OPENED_ROW = 'export const total5 = 5;';
const SHOWN_ROW = 'export const total26 = 260;';

async function holdEngine(page: Page) {
  await page.route('**/api/file-content?*', async (route) => {
    if (/money|validators/.test(route.request().url())) await new Promise((done) => setTimeout(done, 3_000));
    await route.continue().catch(() => {});
  });
}

const rowTop = (page: Page, row: string) =>
  page.evaluate((wanted) => {
    for (const host of document.querySelectorAll('diffs-container')) {
      for (const line of host.shadowRoot?.querySelectorAll('[data-line]') ?? []) if (line.textContent?.includes(wanted)) return line.getBoundingClientRect().top;
    }
    return null;
  }, row);

const totalsLabel = (page: Page) =>
  page.evaluate(() => {
    for (const host of document.querySelectorAll('diffs-container')) {
      if (!host.shadowRoot?.textContent?.includes('total26')) continue;
      const label = host.shadowRoot.querySelector('[data-unmodified-lines]');
      if (!label) return null;
      const box = label.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    return null;
  });

async function bringTotalsToMiddle(page: Page) {
  await expect.poll(() => totalsLabel(page), { timeout: 30_000 }).not.toBeNull();
  await page.evaluate(() => {
    for (const host of document.querySelectorAll('diffs-container')) {
      if (!host.shadowRoot?.textContent?.includes('total26')) continue;
      let scroller: HTMLElement | null = host.parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      const label = host.shadowRoot.querySelector('[data-unmodified-lines]')!;
      if (scroller) scroller.scrollTop += label.getBoundingClientRect().top - 520;
    }
  });
  await page.waitForTimeout(400);
}

const notesLanded = (page: Page) => expect(page.locator('[data-semantic-note="semantic"]').first()).toBeAttached({ timeout: 45_000 });

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

test('lines opened in one file stay where they are on screen when the notes land in the files around it', async () => {
  const session = await reviewOf('review-semantic-scroll', BASE, HEAD);
  try {
    const { context, page } = await openReview(browser, session.url, holdEngine);
    await bringTotalsToMiddle(page);
    const label = (await totalsLabel(page))!;
    await page.mouse.move(label.x, label.y);
    await page.mouse.click(label.x, label.y);
    await expect.poll(() => rowTop(page, OPENED_ROW), { timeout: 15_000 }).not.toBeNull();
    await expect(page.locator('[data-semantic-note="semantic"]')).toHaveCount(0);
    await page.waitForTimeout(300);
    const before = await rowTop(page, OPENED_ROW);
    await notesLanded(page);
    await page.waitForTimeout(800);
    const after = await rowTop(page, OPENED_ROW);
    expect(Math.abs(after! - before!)).toBeLessThanOrEqual(2);
    await context.close();
  } finally {
    await session.close();
  }
});

test('with nothing opened, a row on screen stays where it is when the notes land around it', async () => {
  const session = await reviewOf('review-semantic-scroll-plain', BASE, HEAD);
  try {
    const { context, page } = await openReview(browser, session.url, holdEngine);
    await bringTotalsToMiddle(page);
    await expect(page.locator('[data-semantic-note="semantic"]')).toHaveCount(0);
    const before = await rowTop(page, SHOWN_ROW);
    await notesLanded(page);
    await page.waitForTimeout(800);
    const after = await rowTop(page, SHOWN_ROW);
    expect(Math.abs(after! - before!)).toBeLessThanOrEqual(2);
    await context.close();
  } finally {
    await session.close();
  }
});
