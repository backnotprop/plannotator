/**
 * Code review's generated-file reason and package changes card in the Inbox (review parity B5), proved in a real
 * browser against the compiled binary, in a scratch world (inbox-review-generated-world.ts): a pull request and a
 * guided review that bump package.json with its package-lock.json, and a tool's yarn.lock alone.
 *
 * A folded lockfile says why with code review's own strip ("Generated file collapsed", the header's badge) and opens
 * from it; package.json carries code review's package changes card, and the lockfile-only bump its card while folded,
 * their rows read from the Inbox's own routes (`/api/inbox/pulls/package-changes`,
 * `/api/inbox/messages/:id/guide/package-changes`), never code review's; no npm consent button. On a phone at 390 the
 * card fits the screen.
 *
 * PNGs land in <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/review-parity/.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from './inbox-test';
import { LOCK, MANIFEST, TOOL_LOCK, openPull, openReview, startGeneratedWorld, stopWorld, windowAt } from './inbox-review-generated-world';
import type { ImagesWorld } from './inbox-review-images-world';

const repo = resolve(__dirname, '../..');
const parityDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'review-parity');

let world: ImagesWorld;
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }) => {
  mkdirSync(parityDir, { recursive: true });
  world = await startGeneratedWorld(browser);
});

test.afterAll(async () => {
  await stopWorld(world);
});

/** Every package changes read the page makes: the Inbox's routes, and any of code review's own. */
function watchReads(page: Page): { inbox: { path: string; status: number }[]; review: string[] } {
  const reads = { inbox: [] as { path: string; status: number }[], review: [] as string[] };
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/inbox/') && url.pathname.endsWith('/package-changes')) reads.inbox.push({ path: url.pathname, status: response.status() });
    else if (url.pathname.startsWith('/api/package-changes')) reads.review.push(url.href);
  });
  return reads;
}

const shell = (page: Page, path: string) => page.locator(`[data-guide-file-shell="${path}"]`);
const cardOf = (page: Page, path: string) => shell(page, path).locator(`[data-package-changes="ready"][data-package-changes-path="${path}"]`);
const stripOf = (page: Page, path: string) => shell(page, path).locator('[data-pn-generated-collapsed-notice]');

test("a pull request: the folded lockfiles say why, package.json and the lockfile-only bump carry code review's card", async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1280, 900, false);
  const reads = watchReads(page);
  await openPull(world, page, MANIFEST);

  // package.json: its rows, read from the Inbox's own route.
  const card = cardOf(page, MANIFEST);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('[data-package-row]').filter({ hasText: 'date-fns' })).toHaveCount(1);
  await expect(card.locator('[data-package-row="added"]').filter({ hasText: 'tiny-invariant' })).toHaveCount(1);
  await expect(page.locator('[data-package-lookup-allow]')).toHaveCount(0);
  await shell(page, MANIFEST).screenshot({ path: join(parityDir, 'b5-02-package-card-light.png') });

  // The tool's lockfile-only bump: folded as generated, saying so, its card readable under the strip.
  const tool = shell(page, TOOL_LOCK);
  await tool.scrollIntoViewIfNeeded();
  await expect(stripOf(page, TOOL_LOCK)).toBeVisible();
  await expect(stripOf(page, TOOL_LOCK)).toContainText('Generated file collapsed');
  await expect(tool.locator('[data-pn-generated-badge]')).toBeVisible();
  await expect(cardOf(page, TOOL_LOCK)).toBeVisible({ timeout: 30_000 });
  await expect(cardOf(page, TOOL_LOCK).locator('[data-package-row]').filter({ hasText: 'prettier' })).toHaveCount(1);
  // Both inside the file's box, not cut off under a header-high fold.
  const inside = await tool.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const selector = '[data-pn-generated-collapsed-notice], [data-package-changes="ready"]';
    const parts = [...el.querySelectorAll(selector), ...[...el.querySelectorAll('diffs-container')].flatMap((view) => [...(view.shadowRoot?.querySelectorAll(selector) ?? [])])];
    return parts.map((part) => {
      const r = part.getBoundingClientRect();
      return r.height > 0 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
    });
  });
  expect(inside).toEqual([true, true]);
  await tool.screenshot({ path: join(parityDir, 'b5-01-lockfile-folded-reason-light.png') });

  // package-lock.json: folded with the reason, no card of its own (package.json's card reads it); the strip opens it.
  const lock = shell(page, LOCK);
  await lock.scrollIntoViewIfNeeded();
  await expect(stripOf(page, LOCK)).toBeVisible();
  await expect(lock.locator('[data-package-changes]')).toHaveCount(0);
  await stripOf(page, LOCK).click();
  await expect(stripOf(page, LOCK)).toHaveCount(0);
  await expect(lock.locator('[data-pn-generated-badge]')).toBeVisible();

  expect(reads.review).toEqual([]);
  expect(reads.inbox.length).toBeGreaterThan(0);
  expect(reads.inbox.every((read) => read.path === '/api/inbox/pulls/package-changes' && read.status === 200)).toBe(true);
  await context.close();
});

test('a phone at 390: the card fits the screen, its rows stacked', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 390, 844, true);
  await openPull(world, page, MANIFEST);
  const card = cardOf(page, MANIFEST);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const fits = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, page: document.documentElement.scrollWidth, width: window.innerWidth };
  });
  expect(fits.left).toBeGreaterThanOrEqual(0);
  expect(fits.right).toBeLessThanOrEqual(fits.width + 0.5);
  expect(fits.page).toBeLessThanOrEqual(fits.width);
  await page.screenshot({ path: join(parityDir, 'b5-03-phone-390-light.png') });
  await context.close();
});

test("a guided review: the same card and reason, read from the message's own route", async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1280, 900, false);
  const reads = watchReads(page);
  await openReview(world, page, world.thread, MANIFEST);
  const card = cardOf(page, MANIFEST);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('[data-package-row]').filter({ hasText: 'date-fns' })).toHaveCount(1);
  const lock = shell(page, LOCK);
  await lock.scrollIntoViewIfNeeded();
  await expect(stripOf(page, LOCK)).toBeVisible();
  expect(reads.review).toEqual([]);
  expect(reads.inbox.length).toBeGreaterThan(0);
  expect(reads.inbox.every((read) => /^\/api\/inbox\/messages\/[^/]+\/guide\/package-changes$/.test(read.path) && read.status === 200)).toBe(true);
  await context.close();
});
