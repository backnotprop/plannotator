/**
 * Code suggestions with long lines must not crush the opposite pane in split
 * view (issue #3772), in either wrap or scroll overflow mode. Real browser
 * against the compiled binary's code review, on a scratch git repository.
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { openReview, reviewOf } from './review-scratch-session';

const BEFORE = [
  'export function shortFn() {',
  '  const oldVal = 1;',
  '  return oldVal + 1;',
  '}',
  '',
].join('\n');

const AFTER = [
  'export function shortFn() {',
  '  const newVal = 2;',
  '  return newVal + 1;',
  '}',
  '',
].join('\n');

const LONG_SUGGESTION =
  "const extremelyLongReplacementExpression = someVeryLongServiceName.performComplexTransformationWithManyArguments('alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta');";

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

async function addSuggestionOnLine(page: Page, side: 'old' | 'new') {
  const sideAttr = side === 'new' ? 'data-additions' : 'data-deletions';
  await expect
    .poll(
      () =>
        page.evaluate((attr) => {
          const host = document.querySelector('diffs-container');
          const col = host?.shadowRoot?.querySelector(`code[${attr}] [data-column-number="2"]`);
          return col ? col.getBoundingClientRect().width > 0 : false;
        }, sideAttr),
      { timeout: 30_000 },
    )
    .toBe(true);

  const colBox = await page.evaluate((attr) => {
    const host = document.querySelector('diffs-container');
    const col = host?.shadowRoot?.querySelector(`code[${attr}] [data-column-number="2"]`) as HTMLElement | null;
    if (!col) return null;
    const r = col.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sideAttr);
  expect(colBox).not.toBeNull();

  await page.mouse.click(colBox!.x, colBox!.y);
  const selPop = page.locator('[data-selection-chooser] button:has-text("Comment")');
  if (await selPop.isVisible({ timeout: 500 }).catch(() => false)) {
    await selPop.click();
  }

  const addSuggested = page.locator('[data-highlight-composer] button:has-text("Add suggested code")');
  await expect(addSuggested).toBeVisible();
  await addSuggested.click();

  const textarea = page.locator('[data-highlight-composer] textarea.suggested-code-input');
  await expect(textarea).toBeVisible();
  await textarea.fill(LONG_SUGGESTION);
  await page.locator('[data-highlight-composer] button:has-text("Add Comment")').click();
}

async function measureSplitPanes(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector('diffs-container') as HTMLElement | null;
    const sr = host?.shadowRoot;
    const pre = sr?.querySelector('pre[data-diff]') as HTMLElement | null;
    const delContent = sr?.querySelector('code[data-deletions] [data-content]') as HTMLElement | null;
    const addContent = sr?.querySelector('code[data-additions] [data-content]') as HTMLElement | null;
    const suggestionDiff = host?.querySelector('.suggestion-diff') as HTMLElement | null;
    const reviewComment = host?.querySelector('.review-comment') as HTMLElement | null;
    return {
      preScrollW: pre?.scrollWidth ?? 0,
      preClientW: pre?.clientWidth ?? 0,
      delContentW: delContent ? delContent.getBoundingClientRect().width : 0,
      addContentW: addContent ? addContent.getBoundingClientRect().width : 0,
      reviewCommentW: reviewComment ? reviewComment.getBoundingClientRect().width : 0,
      suggestionClientW: suggestionDiff?.clientWidth ?? 0,
      suggestionScrollW: suggestionDiff?.scrollWidth ?? 0,
    };
  });
}

for (const overflow of ['wrap', 'scroll'] as const) {
  for (const side of ['new', 'old'] as const) {
    test(`split view with overflow=${overflow} keeps both panes balanced when a long suggestion is added on ${side} side`, async () => {
      const session = await reviewOf(`review-split-suggestion-${overflow}-${side}`, { 'src/example.ts': BEFORE }, { 'src/example.ts': AFTER });
      try {
        const { context, page } = await openReview(browser, session.url, async (p) => {
          await p.context().addCookies([
            { name: 'plannotator-diff-style', value: 'split', url: session.url },
            { name: 'plannotator-diff-overflow', value: overflow, url: session.url },
          ]);
        });

        await addSuggestionOnLine(page, side);
        await expect.poll(async () => (await measureSplitPanes(page)).suggestionClientW, { timeout: 10_000 }).toBeGreaterThan(0);

        const m = await measureSplitPanes(page);
        expect(m.delContentW).toBeGreaterThan(300);
        expect(m.addContentW).toBeGreaterThan(300);
        expect(Math.abs(m.delContentW - m.addContentW)).toBeLessThan(20);
        expect(m.preScrollW).toBeLessThanOrEqual(m.preClientW + 1);
        expect(m.reviewCommentW).toBeLessThanOrEqual((side === 'new' ? m.addContentW : m.delContentW) + 1);
        expect(m.suggestionScrollW).toBeGreaterThan(m.suggestionClientW);

        await context.close();
      } finally {
        await session.close();
      }
    });
  }
}
