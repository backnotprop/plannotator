/**
 * Code review's image preview in the Inbox (review parity B2), proved in a real
 * browser against the compiled binary, in a scratch world
 * (inbox-review-images-world.ts): a pull request and a guided review that
 * change three pictures (modified, added, deleted).
 *
 * Each changed picture is the review app's own preview in place of the binary
 * notice, its view menu on the file's header: Side by side, Swipe and Onion
 * skin for the modified one, the one side for the added and the deleted. Every
 * side is read from the Inbox's own routes (`/api/inbox/pulls/review-image`,
 * `/api/inbox/messages/:id/guide/review-image`), never from code review's
 * `/api/review-image`, and an added picture's before or a deleted picture's
 * after is never asked. On a phone at 390 the preview fits the screen.
 * Highlight differences draws its overlay under the Inbox's page policy
 * (`connect-src 'self'`), which logs no refusal; and a picture a guide only
 * renames (its patch names no blob) draws, not two "not found" tiles.
 *
 * PNGs land in <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/review-parity/.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from './inbox-test';
import { ADDED, DELETED, MODIFIED, RENAMED, openPull, openReview, startWorld, stopWorld, windowAt, type ImagesWorld } from './inbox-review-images-world';

const repo = resolve(__dirname, '../..');
const parityDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'review-parity');

let world: ImagesWorld;
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }) => {
  mkdirSync(parityDir, { recursive: true });
  world = await startWorld(browser);
});

test.afterAll(async () => {
  await stopWorld(world);
});

/** Every image read the page makes: the Inbox's routes, and any of code review's own. */
function watchReads(page: Page): { inbox: { path: string; side: string; status: number }[]; review: string[] } {
  const reads = { inbox: [] as { path: string; side: string; status: number }[], review: [] as string[] };
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('/review-image') && url.pathname.startsWith('/api/inbox/')) {
      reads.inbox.push({ path: url.searchParams.get('path') ?? '', side: url.searchParams.get('side') ?? '', status: response.status() });
    } else if (url.pathname === '/api/review-image') reads.review.push(url.href);
  });
  return reads;
}

/** What the page's policy (CSP) refused, as the console says it: Chromium's "violates the following Content Security Policy", WebKit's "Refused to connect". */
function watchPolicy(page: Page): string[] {
  const refused: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to (connect|load)/i.test(message.text())) refused.push(message.text());
  });
  return refused;
}

const shell = (page: Page, path: string) => page.locator(`[data-guide-file-shell="${path}"]`);
const preview = (page: Page, path: string) => shell(page, path).locator('[data-image-diff-preview]');

/** The picture's preview, with every side it has drawn (decoded, not a placeholder). */
async function drawn(page: Page, path: string, sides: number): Promise<void> {
  const box = preview(page, path);
  await box.scrollIntoViewIfNeeded();
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => box.locator('img[src^="blob:"]').evaluateAll((imgs) => imgs.filter((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0).length), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(sides);
  await expect(box.locator('[data-image-error]')).toHaveCount(0);
}

async function chooseView(page: Page, path: string, option: 'side' | 'swipe' | 'onion'): Promise<void> {
  await shell(page, path).locator('[data-image-view-menu]').click();
  await page.locator(`[data-image-view-option="${option}"]`).click();
  await expect(preview(page, path)).toHaveAttribute('data-image-diff-mode', option);
}

test('a pull request: each changed picture is code review\'s preview, read from the Inbox\'s own route, in every compare mode', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1280, 900, false);
  const reads = watchReads(page);
  await openPull(world, page);

  await drawn(page, MODIFIED, 2);
  await expect(preview(page, MODIFIED)).toHaveAttribute('data-image-diff-mode', 'side');
  // The binary notice is gone: the preview took its place.
  await expect(shell(page, MODIFIED).locator('[data-binary-file-notice]')).toHaveCount(0);
  await shell(page, MODIFIED).scrollIntoViewIfNeeded();
  await shell(page, MODIFIED).screenshot({ path: join(parityDir, 'b2-01-modified-side-by-side-light.png') });

  await chooseView(page, MODIFIED, 'onion');
  await drawn(page, MODIFIED, 2);
  await shell(page, MODIFIED).screenshot({ path: join(parityDir, 'b2-02-onion-skin-light.png') });
  await chooseView(page, MODIFIED, 'side');

  await drawn(page, ADDED, 1);
  await expect(preview(page, ADDED)).toHaveAttribute('data-image-diff-mode', 'single');
  await shell(page, ADDED).screenshot({ path: join(parityDir, 'b2-04-added-light.png') });
  await drawn(page, DELETED, 1);
  await expect(preview(page, DELETED)).toHaveAttribute('data-image-diff-mode', 'single');
  await shell(page, DELETED).screenshot({ path: join(parityDir, 'b2-05-deleted-light.png') });

  // A picture with one side offers no compare mode.
  await shell(page, ADDED).locator('[data-image-view-menu]').click();
  await expect(page.locator('[data-image-view-option="swipe"]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  expect(reads.review).toEqual([]);
  expect(reads.inbox.every((read) => read.status === 200 || read.status === 304)).toBe(true);
  const asked = new Set(reads.inbox.map((read) => `${read.path} ${read.side}`));
  expect([...asked].sort()).toEqual([`${ADDED} new`, `${MODIFIED} new`, `${MODIFIED} old`, `${DELETED} old`].sort());
  await context.close();
});

test('a pull request in dark: Swipe draws both sides over each other', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1280, 900, false, 'dark');
  await openPull(world, page);
  await drawn(page, MODIFIED, 2);
  await chooseView(page, MODIFIED, 'swipe');
  await drawn(page, MODIFIED, 2);
  await shell(page, MODIFIED).screenshot({ path: join(parityDir, 'b2-03-swipe-dark.png') });
  await chooseView(page, MODIFIED, 'side');
  await context.close();
});

test('a phone at 390: the preview fits the screen, its menu on the header', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 390, 844, true);
  await openPull(world, page);
  await drawn(page, MODIFIED, 1);
  const fits = await preview(page, MODIFIED).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, page: document.documentElement.scrollWidth, width: window.innerWidth };
  });
  expect(fits.left).toBeGreaterThanOrEqual(0);
  expect(fits.right).toBeLessThanOrEqual(fits.width + 0.5);
  expect(fits.page).toBeLessThanOrEqual(fits.width);
  await expect(shell(page, MODIFIED).locator('[data-image-view-menu]')).toBeVisible();
  await page.screenshot({ path: join(parityDir, 'b2-06-phone-390-light.png') });
  await context.close();
});

test("a guided review: the same previews, read from the message's own route", async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1280, 900, false);
  const reads = watchReads(page);
  await openReview(world, page);
  await drawn(page, MODIFIED, 2);
  await shell(page, MODIFIED).screenshot({ path: join(parityDir, 'b2-07-guided-review-light.png') });
  await drawn(page, ADDED, 1);
  await drawn(page, DELETED, 1);
  expect(reads.review).toEqual([]);
  expect(reads.inbox.length).toBeGreaterThan(0);
  expect(reads.inbox.every((read) => read.status === 200 || read.status === 304)).toBe(true);
  expect(new Set(reads.inbox.map((read) => `${read.path} ${read.side}`))).not.toContain(`${ADDED} old`);
  expect(new Set(reads.inbox.map((read) => `${read.path} ${read.side}`))).not.toContain(`${DELETED} new`);
  await context.close();
});

test('Highlight differences on a modified picture: the difference is drawn, and the page policy refuses nothing', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1280, 900, false);
  const refused = watchPolicy(page);
  const reads = watchReads(page);
  await openPull(world, page);
  await drawn(page, MODIFIED, 2);
  await shell(page, MODIFIED).locator('[data-image-view-menu]').click();
  await page.locator('[data-image-differences-option]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-image-differences-option]')).toHaveCount(0);
  const overlay = preview(page, MODIFIED).locator('canvas[data-image-differences]');
  await expect(overlay).toBeVisible({ timeout: 20_000 });
  await expect(preview(page, MODIFIED)).toContainText('of pixels differ');
  // The overlay has the changed pixels on it, not an empty canvas.
  await expect
    .poll(() =>
      overlay.evaluate((el) => {
        const canvas = el as HTMLCanvasElement;
        const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) painted += 1;
        return painted;
      }),
    )
    .toBeGreaterThan(0);
  await shell(page, MODIFIED).screenshot({ path: join(parityDir, 'b2-08-differences-inbox-light.png') });
  expect(refused).toEqual([]);
  expect(reads.review).toEqual([]);
  expect(reads.inbox.every((read) => read.status === 200 || read.status === 304)).toBe(true);
  await context.close();
});

test("a guided review of a picture only renamed: drawn from the guide's commit, both sides read, its contents unchanged", async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1280, 900, false);
  const reads = watchReads(page);
  await openReview(world, page, world.renameThread, RENAMED);
  await drawn(page, RENAMED, 1);
  await expect(preview(page, RENAMED).locator('[data-image-unchanged]')).toHaveCount(1);
  await shell(page, RENAMED).screenshot({ path: join(parityDir, 'b2-09-renamed-in-guide-light.png') });
  const asked = reads.inbox.filter((read) => read.path === RENAMED);
  expect([...new Set(asked.map((read) => read.side))].sort()).toEqual(['new', 'old']);
  expect(asked.every((read) => read.status === 200 || read.status === 304)).toBe(true);
  await context.close();
});
