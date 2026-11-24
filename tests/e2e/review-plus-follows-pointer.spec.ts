/**
 * The "+" in a diff's gutter follows the pointer after a line comment is added or cancelled, and the next comment
 * or dragged range starts on the line the person points at. Real Chromium against the compiled binary's code review,
 * on a scratch repository, with the file open in its own tab, in Split and in Unified.
 *
 * What regresses if this fails: after Add or Escape, the "+" and the line highlight stay on the line used last
 * whatever line the pointer is on, a press on the "+" comments on that old line, and a drag from it starts there
 * ("Lines 13-21" for a drag from line 19). Each step says which line, side and action in its failure message.
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { openReview, reviewOf } from './review-scratch-session';

const FILE = 'src/plan.ts';
const CHANGED = [8, 9, 10, 11, 12];
// Only the words inside the strings change: nothing moves or is renamed, so every row stays a row.
const text = (word: 'old' | 'new') =>
  Array.from({ length: 30 }, (_, i) => `export const row${i + 1} = '${CHANGED.includes(i + 1) ? `${word} wording of row ${i + 1}.` : `row ${i + 1} stays the same.`}';`).join('\n') + '\n';

type Side = 'old' | 'new';
interface Row {
  error?: string;
  x: number;
  y: number;
  /** The "+" is drawn on this row's line number. */
  plusHere: boolean;
  /** Rows Pierre paints as selected, anywhere in the file. */
  selected: number;
}

/** A changed row of the file's diff, found by its words (`old wording of row 11.` sits on the old side only). */
function row(page: Page, side: Side, line: number): Promise<Row> {
  return page.evaluate(
    ({ side, marker }) => {
      const none = { x: 0, y: 0, plusHere: false, selected: 0 };
      const hosts = [...document.querySelectorAll('diffs-container')].filter((host) => host.checkVisibility({ visibilityProperty: true }) && host.getBoundingClientRect().width > 0);
      if (hosts.length !== 1) return { ...none, error: `${hosts.length} diffs shown` };
      const root = hosts[0]!.shadowRoot!;
      const pre = root.querySelector('pre');
      if (!pre) return { ...none, error: 'no diff yet' };
      const split = pre.getAttribute('data-diff-type') === 'split';
      const slot = root.querySelector<HTMLElement>('[data-gutter-utility-slot]');
      const selected = root.querySelectorAll('[data-selected-line]').length;
      for (const code of pre.querySelectorAll(':scope > [data-code]')) {
        if (split && !code.hasAttribute(side === 'old' ? 'data-deletions' : 'data-additions')) continue;
        const [gutter, content] = code.children;
        if (!gutter || !content) continue;
        const index = [...content.children].findIndex((line) => line.textContent?.includes(marker));
        if (index < 0) continue;
        const number = gutter.children[index] as HTMLElement;
        const box = number.getBoundingClientRect();
        return {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          plusHere: slot != null && number.contains(slot) && slot.style.visibility !== 'hidden',
          selected,
        };
      }
      return { ...none, error: `no row "${marker}"` };
    },
    { side, marker: `${side} wording of row ${line}.` },
  );
}

/** The "+" button's centre, wherever it is drawn. */
function plusButton(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const host = [...document.querySelectorAll('diffs-container')].find((h) => h.checkVisibility({ visibilityProperty: true }) && h.getBoundingClientRect().width > 0);
    const button = host?.shadowRoot?.querySelector<HTMLElement>('[data-gutter-utility-slot] [data-utility-button]');
    if (!button) return null;
    const box = button.getBoundingClientRect();
    return box.width > 0 ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  });
}

/** Points at a row's line number and waits for the "+" to be drawn there, with nothing left highlighted. */
async function hover(page: Page, side: Side, line: number, after: string): Promise<{ x: number; y: number }> {
  await expect.poll(async () => (await row(page, side, line)).error ?? 'found', { timeout: 15_000 }).toBe('found');
  const at = await row(page, side, line);
  await page.mouse.move(at.x, at.y, { steps: 6 });
  await expect
    .poll(async () => (await row(page, side, line)).plusHere, { timeout: 5_000, message: `after ${after}, the "+" follows the pointer to ${side} line ${line}` })
    .toBe(true);
  expect((await row(page, side, line)).selected, `after ${after}, no line is still highlighted`).toBe(0);
  const plus = await plusButton(page);
  expect(plus, 'the "+" is drawn').not.toBeNull();
  return plus!;
}

const composer = (page: Page) => page.locator('div.w-80', { has: page.locator('textarea[placeholder^="Leave feedback"]') });

async function expectComposerFor(page: Page, label: string, what: string) {
  await expect(composer(page), `${what} opens the comment box`).toBeVisible({ timeout: 5_000 });
  await expect(composer(page).locator('span.text-xs').first(), `${what} is for ${label}`).toHaveText(label);
}

async function cancel(page: Page) {
  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeHidden({ timeout: 5_000 });
}

async function add(page: Page, words: string, side: Side, line: number) {
  await composer(page).locator('textarea').fill(words);
  await composer(page).getByRole('button', { name: 'Add Comment' }).click();
  await expect(composer(page)).toBeHidden({ timeout: 5_000 });
  const slot = `annotation-${side === 'old' ? 'deletions' : 'additions'}-${line}`;
  await expect
    .poll(
      () =>
        page.evaluate((name) => {
          const host = [...document.querySelectorAll('diffs-container')].find((h) => h.checkVisibility({ visibilityProperty: true }) && h.getBoundingClientRect().width > 0);
          return host?.querySelector(`[slot="${name}"]`)?.textContent ?? '';
        }, slot),
      { timeout: 5_000, message: `the comment is saved on ${side} line ${line}` },
    )
    .toContain(words);
}

async function clickPlus(page: Page, side: Side, line: number, after: string) {
  const plus = await hover(page, side, line, after);
  await page.mouse.click(plus.x, plus.y);
  await expectComposerFor(page, `Line ${line}`, `after ${after}, a press on the "+" of ${side} line ${line}`);
}

async function dragPlus(page: Page, side: Side, from: number, to: number, after: string) {
  const plus = await hover(page, side, from, after);
  await page.mouse.move(plus.x, plus.y);
  await page.mouse.down();
  const end = await row(page, side, to);
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  await expectComposerFor(page, `Lines ${from}-${to}`, `after ${after}, a drag from the "+" of ${side} line ${from} to ${to}`);
}

test.use({ actionTimeout: 20_000 });

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

for (const layout of ['split', 'unified'] as const) {
  test(`${layout}: after Add or Escape the "+" follows the pointer, and the next comment or drag starts where it points`, async () => {
    const session = await reviewOf(`review-plus-follows-${layout}`, { [FILE]: text('old') }, { [FILE]: text('new') });
    try {
      const { context, page } = await openReview(browser, session.url, (p) =>
        p.context().addCookies([{ name: 'plannotator-diff-style', value: layout, url: session.url }]),
      );
      await page.locator(`[data-changes-tree] [data-type="item"][data-item-path$="plan.ts"]`).first().click();

      await clickPlus(page, 'new', 9, 'opening the file');
      await cancel(page);

      await clickPlus(page, 'old', 11, 'Escape');
      await add(page, 'Ada Novak: the old eleven.', 'old', 11);

      await clickPlus(page, 'new', 10, 'Add');
      await add(page, 'Charlie Dunn: the new ten.', 'new', 10);

      await dragPlus(page, 'old', 8, 10, 'Add');
      await cancel(page);

      await dragPlus(page, 'new', 11, 12, 'Escape');
      await cancel(page);

      await context.close();
    } finally {
      await session.close();
    }
  });
}
