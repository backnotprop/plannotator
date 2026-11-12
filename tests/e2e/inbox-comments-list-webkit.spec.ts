/**
 * The list of comments on an iPhone, in WebKit, against the compiled binary: a
 * phone's own gestures (a tap, where the highlighter does not listen) and its
 * own surfaces (the bottom sheet, a file only ever full screen). The desktop and
 * the checks that need Chromium: inbox-comments-list.spec.ts.
 *
 * Runs in the playwright config's `webkit` project. Build the binary first (see
 * inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, devices, type Browser, type Page } from './inbox-test';
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

test('the closed foot\'s Draft carries the comment count; from the reply box\'s foot line, Review comments opens the list as the sheet, with Edit', async ({ browser }) => {
  const page = await phone(browser);
  const t = await seededThread(world);
  await openThread(page, world, t);
  // On a phone the closed foot draws no status (approval "reply-bar-pairs"): Edit draft counts the comments ("Draft 2").
  const draft = pane(page).locator('.ib-pfoot [data-edit-draft]');
  await expect(draft.locator('[data-draft-count]')).toHaveText(String(t.count));
  await expect(pane(page).locator('[data-foot-status]')).toHaveCount(0);
  await draft.tap();
  // With a question open beside the comments, the box's summary line (over its row) opens what goes with the reply;
  // Review comments opens their list (approvals "inbox-reply-foot-phone", "inbox-reply-box").
  const line = pane(page).locator('.ib-rbox [data-reply-line] [data-foot-summary]');
  await expect(line).toHaveText(/2 comments/);
  expect((await line.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await line.tap();
  await page.getByRole('dialog', { name: 'Goes with this reply' }).getByRole('button', { name: 'Review comments' }).tap();
  await isTheSheet(page, t.count);
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Edit' }).tap();
  await page.getByRole('textbox', { name: 'Edit the comment' }).fill('Say what happens on a timeout.');
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Save' }).tap();
  await expect(rowOf(page, t.onMessage)).toContainText('Say what happens on a timeout.');
  await page.context().close();
});

test('a tap on a highlight opens the sheet at that comment, with its header still there', async ({ browser }) => {
  const page = await phone(browser);
  const t = await seededThread(world, 8);
  await openThread(page, world, t);
  await highlight(page, t).tap();
  await isTheSheet(page, t.count);
  await expect(rowOf(page, t.onMessage)).toHaveClass(/ib-at/);
  await expect(rowOf(page, t.onMessage)).toBeInViewport();
  await expect(theList(page, t.count).getByRole('button', { name: 'Close the list' })).toBeInViewport();
  // A phone's foot has no count to go back to (approval "reply-bar-pairs"): closing puts focus back on the highlight.
  await page.keyboard.press('Escape');
  await expect(theList(page, t.count)).toHaveCount(0);
  await expect(highlight(page, t)).toBeFocused();
  await page.context().close();
});

test('the full-screen card count opens the sheet, not a box held inside the card', async ({ browser }) => {
  const page = await phone(browser);
  const t = await seededThread(world);
  await page.goto(fileUrl(world, t, t.page, 'full'));
  // An HTML page on a phone opens clear, the card folded to its pill (inbox-html-phone.spec.ts): the pill opens it.
  await page.locator('[data-fcomp-pill]').tap();
  // It opens on Comment, as an image's card does: the count is the Reply tab's.
  await page.locator('[data-fcomp-mode="reply"]').tap();
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
