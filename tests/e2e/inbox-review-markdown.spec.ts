/**
 * Code review's rendered Markdown files in the Inbox (review parity B3), proved
 * in a real browser against the compiled binary, in a scratch world
 * (inbox-review-markdown-world.ts): a pull request and a guided review that
 * rewrite the README (it shows a picture the PR changes and one it does not)
 * and edit an SVG.
 *
 * The README's header has code review's Source / Changes / Read menu, starting
 * in Source (code review's default); Changes draws the rendered diff and Read
 * the whole document, its pictures read from the Inbox's own routes
 * (`/api/inbox/pulls/review-markdown-image`, `/api/inbox/messages/:id/guide/review-markdown-image`),
 * never from code review's. The SVG is its picture with Image / Source. On a
 * phone at 390 the rendered file fits the screen.
 *
 * PNGs land in <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/review-parity/.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from './inbox-test';
import { README, SVG, openPull, openReview, startMarkdownWorld, stopWorld, windowAt } from './inbox-review-markdown-world';
import type { ImagesWorld } from './inbox-review-images-world';

const repo = resolve(__dirname, '../..');
const parityDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'review-parity');

let world: ImagesWorld;
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }) => {
  mkdirSync(parityDir, { recursive: true });
  world = await startMarkdownWorld(browser);
});

test.afterAll(async () => {
  await stopWorld(world);
});

/** Every Markdown picture the page asks for: the Inbox's routes, and any of code review's own. */
function watchReads(page: Page): { inbox: { src: string; side: string; status: number }[]; review: string[] } {
  const reads = { inbox: [] as { src: string; side: string; status: number }[], review: [] as string[] };
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/inbox/') && url.pathname.endsWith('/review-markdown-image')) {
      reads.inbox.push({ src: url.searchParams.get('src') ?? '', side: url.searchParams.get('side') ?? '', status: response.status() });
    } else if (url.pathname.startsWith('/api/review-') || url.pathname === '/api/file-content') reads.review.push(url.href);
  });
  return reads;
}

const shell = (page: Page, path: string) => page.locator(`[data-guide-file-shell="${path}"]`);
const card = (page: Page) => shell(page, README).locator('[data-markdown-preview]');

async function chooseView(page: Page, view: 'source' | 'changes' | 'read'): Promise<void> {
  const menu = shell(page, README).locator('[data-markdown-view-menu]');
  await menu.scrollIntoViewIfNeeded();
  await menu.click();
  await page.locator(`[data-markdown-view-option="${view}"]`).click();
  await expect(menu).toHaveAttribute('data-markdown-view', view);
}

/** The rendered README, with every picture it shows drawn (decoded, not a placeholder). */
async function rendered(page: Page, view: 'diff' | 'whole', pictures: number): Promise<void> {
  await expect(card(page)).toHaveAttribute('data-markdown-preview-view', view, { timeout: 30_000 });
  await expect
    .poll(() => card(page).locator('img').evaluateAll((imgs) => imgs.filter((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0).length), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(pictures);
}

test("a pull request: the README in code review's Changes and Read, its pictures from the Inbox's own route; the SVG's Image / Source", async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1280, 900, false);
  const reads = watchReads(page);
  await openPull(world, page, README);

  // Code review's starting view: Source, the line diff.
  await expect(shell(page, README).locator('[data-markdown-view-menu]')).toHaveAttribute('data-markdown-view', 'source');
  await expect(card(page)).toHaveCount(0);

  await chooseView(page, 'changes');
  // The logo the PR adds to the README (unchanged runs, the chart's among them, fold away in Changes).
  await rendered(page, 'diff', 1);
  await expect(card(page)).toContainText('this quarter');
  await shell(page, README).scrollIntoViewIfNeeded();
  await shell(page, README).screenshot({ path: join(parityDir, 'b3-02-markdown-diff-light.png') });

  await chooseView(page, 'read');
  await rendered(page, 'whole', 2);
  await expect(card(page)).toContainText('Running it');
  await shell(page, README).screenshot({ path: join(parityDir, 'b3-01-markdown-rendered-light.png') });

  expect(reads.review).toEqual([]);
  expect(reads.inbox.length).toBeGreaterThan(0);
  expect(reads.inbox.every((read) => read.status === 200 || read.status === 304)).toBe(true);
  // The logo the PR does not change (read at the head) and the chart it changes, nothing else.
  expect(new Set(reads.inbox.map((read) => read.src))).toEqual(new Set(['/assets/logo.png', 'assets/dashboard.png']));

  // The SVG: its picture first, then its source diff.
  const mark = shell(page, SVG);
  await mark.scrollIntoViewIfNeeded();
  await expect(mark.locator('[data-image-diff-preview]')).toBeVisible({ timeout: 30_000 });
  await mark.locator('[data-image-view-menu]').click();
  await page.locator('[data-image-view-option="source"]').click();
  await expect(mark.locator('[data-image-diff-preview]')).toHaveCount(0);
  await expect(mark.locator('[data-image-view-menu]')).toContainText('Source');
  await mark.screenshot({ path: join(parityDir, 'b3-04-svg-source-light.png') });
  await context.close();
});

test('a pull request in dark: the README read as a document', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1280, 900, false, 'dark');
  await openPull(world, page, README);
  await chooseView(page, 'read');
  await rendered(page, 'whole', 2);
  await shell(page, README).screenshot({ path: join(parityDir, 'b3-03-markdown-rendered-dark.png') });
  await context.close();
});

test('a phone at 390: the rendered README fits the screen, its menu on the header', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 390, 844, true);
  await openPull(world, page, README);
  await chooseView(page, 'changes');
  await rendered(page, 'diff', 1);
  const fits = await card(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, page: document.documentElement.scrollWidth, width: window.innerWidth };
  });
  expect(fits.left).toBeGreaterThanOrEqual(0);
  expect(fits.right).toBeLessThanOrEqual(fits.width + 0.5);
  expect(fits.page).toBeLessThanOrEqual(fits.width);
  await expect(shell(page, README).locator('[data-markdown-view-menu]')).toBeVisible();
  // The rendered README on screen, its header at the top.
  await shell(page, README).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(card(page)).toBeInViewport();
  await page.screenshot({ path: join(parityDir, 'b3-05-phone-390-light.png') });
  await context.close();
});

test("a guided review: the same rendered README, its pictures from the message's own route", async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1280, 900, false);
  const reads = watchReads(page);
  await openReview(world, page, world.thread, README);
  await chooseView(page, 'changes');
  await rendered(page, 'diff', 1);
  expect(reads.review).toEqual([]);
  expect(reads.inbox.length).toBeGreaterThan(0);
  expect(reads.inbox.every((read) => read.status === 200 || read.status === 304)).toBe(true);
  await context.close();
});
