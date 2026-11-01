/**
 * The list of comments on an iPhone, in WebKit, against the compiled binary: a
 * phone's own gestures (a tap, where the highlighter does not listen) and its
 * own surfaces (the bottom sheet, a file only ever full screen). The desktop and
 * the checks that need Chromium: inbox-comments-list.spec.ts.
 *
 * Runs in the playwright config's `webkit` project. Build the binary first (see
 * inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, devices, type Browser, type Page } from '@playwright/test';
import { cardChip, fileHighlight, fileUrl, highlight, onScreen, openThread, pane, rowOf, seededThread, startWorld, stopWorld, theList, threadUrl, type ListWorld } from './inbox-comments-list-world';

const { defaultBrowserType: _webkit, ...iphone } = devices['iPhone 15'];

let world: ListWorld;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  world = await startWorld();
});
test.afterAll(async () => {
  await stopWorld(world);
});

async function phone(browser: Browser): Promise<Page> {
  const context = await browser.newContext(iphone);
  return context.newPage();
}

/** The sheet: edge to edge at the foot of the window, wherever it opened from. */
async function isTheSheet(page: Page, count: number): Promise<void> {
  const list = theList(page, count);
  await expect(list).toBeVisible();
  await onScreen(page, list);
  const box = (await list.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(view.width);
  expect(box.y + box.height).toBeCloseTo(view.height, 0);
}

test('the foot count is a button a finger can press: the list opens as the sheet, with Edit, and the box stays closed', async ({ browser }) => {
  const page = await phone(browser);
  const t = await seededThread(world);
  await openThread(page, world, t);
  await pane(page).locator('[data-foot-status] [data-comments-link]:visible').tap();
  await isTheSheet(page, t.count);
  await expect(pane(page).locator('.ib-rfoot')).toHaveCount(0);
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Edit' }).tap();
  await page.getByRole('textbox', { name: 'Edit the comment' }).fill('Say what happens on a timeout.');
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Save' }).tap();
  await expect(rowOf(page, t.onMessage)).toContainText('Say what happens on a timeout.');
  await page.context().close();
});

test('a tap on a highlight opens the sheet at that comment', async ({ browser }) => {
  const page = await phone(browser);
  const t = await seededThread(world, 8);
  await openThread(page, world, t);
  await highlight(page, t).tap();
  await isTheSheet(page, t.count);
  await expect(rowOf(page, t.onMessage)).toHaveClass(/ib-at/);
  await expect(rowOf(page, t.onMessage)).toBeInViewport();
  await page.context().close();
});

test('the full-screen card count opens the sheet, not a box held inside the card', async ({ browser }) => {
  const page = await phone(browser);
  const t = await seededThread(world);
  await page.goto(fileUrl(world, t, t.page, 'full'));
  await cardChip(page).tap();
  await isTheSheet(page, t.count);
  await page.context().close();
});

test('a highlight leaves a file open on the phone when the comment is sent from another window', async ({ browser }) => {
  const page = await phone(browser);
  const t = await seededThread(world);
  await page.goto(fileUrl(world, t, t.plan, 'full'));
  await expect(fileHighlight(page)).toBeVisible();
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desk = await other.newPage();
  await desk.goto(threadUrl(world, t));
  await pane(desk).locator('.ib-footrow').getByRole('button', { name: 'Send' }).click();
  await expect(fileHighlight(page)).toHaveCount(0);
  await other.close();
  await page.context().close();
});
