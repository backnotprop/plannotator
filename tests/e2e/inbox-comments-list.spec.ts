/**
 * The list of comments, reached without opening the reply box (approval
 * "inbox-notes-count-list", 2026-11-01), proved in Chromium against the compiled
 * binary. Feedback: "I can't seem to find a button to display the notes or edit
 * them."
 *
 *  - the foot's "N comments" is a real button that opens the list; nothing
 *    behind it moves; Escape closes it, the thread stays, focus goes back;
 *  - a press on a highlight in a message opens the list at that comment;
 *  - the full-screen card's count does the same, and Escape takes the list
 *    first, from the window and from inside the page;
 *  - a highlight leaves the open file when its comment goes (Send, the list);
 *  - the list stays on screen at 1000, 390 and 320 wide and with the keyboard up;
 *  - where the foot has room only for the pill, the pill's count is the button;
 *  - a thread with no comments gains nothing.
 *
 * An iPhone in WebKit: inbox-comments-list-webkit.spec.ts. Build the binary
 * first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { cardChip, countLink, fileHighlight, fileUrl, highlight, layout, onScreen, openThread, pane, quietThread, rowOf, rowShown, seededThread, startWorld, stopWorld, theList, threadUrl, type ListWorld } from './inbox-comments-list-world';

let world: ListWorld;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  world = await startWorld();
});
test.afterAll(async () => {
  await stopWorld(world);
});

async function desk(browser: Browser, width = 1440, height = 900): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' });
  return context.newPage();
}

const phoneContext = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light' as const };

/** The iPhone keyboard the way the window sees it (inbox-fullscreen-keyboard.spec.ts): the visual viewport gives up its bottom. */
async function keyboardUp(page: Page, keyboard = 336): Promise<number> {
  await page.evaluate((px) => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight - px });
    vv.dispatchEvent(new Event('resize'));
  }, keyboard);
  const visible = page.viewportSize()!.height - keyboard;
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--ib-vvh'))).toBe(`${visible}px`);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return visible;
}

test('the foot count opens the list without the reply box: a real button, nothing moves, Edit saves, Escape closes back to it', async ({ browser }) => {
  const page = await desk(browser);
  const t = await seededThread(world);
  await openThread(page, world, t);
  const link = countLink(page, t.count);
  await expect(link).toHaveAttribute('aria-expanded', 'false');
  const before = await layout(page);

  await link.click();
  const list = theList(page, t.count);
  await expect(list).toBeVisible();
  await expect(pane(page).locator('.ib-rfoot')).toHaveCount(0);
  await expect(link).toHaveAttribute('aria-expanded', 'true');
  expect(await layout(page)).toBe(before);
  await expect(rowOf(page, t.onMessage)).toContainText('Is that true when the first request times out?');

  // Edit and Remove are today's.
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Edit the comment' }).fill('Say what happens on a timeout.');
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Save' }).click();
  await expect(rowOf(page, t.onMessage)).toContainText('Say what happens on a timeout.');

  // Escape takes the edit first, then the list; the thread stays and focus is back on the link.
  await rowOf(page, t.onPlan).getByRole('button', { name: 'Edit' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Edit the comment' })).toHaveCount(0);
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(pane(page)).toBeVisible();
  await expect(link).toBeFocused();

  // By the keyboard: Enter opens it, the link again closes it (a press on it is not a press outside).
  await page.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await link.click();
  await expect(list).toHaveCount(0);

  // The last comment removed: the list goes, and focus does not go with it.
  await link.click();
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Remove' }).click();
  await expect(rowOf(page, t.onMessage)).toHaveCount(0);
  await rowOf(page, t.onPlan).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('[data-comments-list]')).toHaveCount(0);
  await expect(pane(page).locator('.ib-footrow button').first()).toBeFocused();
  await page.context().close();
});

test('a press on a highlight opens the list at that comment, far down a long list, and only a plain press does', async ({ browser }) => {
  const page = await desk(browser);
  const t = await seededThread(world, 12);
  await openThread(page, world, t);
  const before = await layout(page);
  await highlight(page, t).click();
  const list = theList(page, t.count);
  await expect(list).toBeVisible();
  await expect(rowOf(page, t.onMessage)).toHaveClass(/ib-at/);
  await rowShown(list, rowOf(page, t.onMessage));
  expect(await layout(page)).toBe(before);
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(countLink(page, t.count)).toBeFocused();

  // A drag that ends on the highlight is a selection, not a press.
  const box = (await highlight(page, t).boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.annotation-toolbar')).toBeVisible();
  await expect(list).toHaveCount(0);
  await page.context().close();
});

test('with the reply box open, a highlight opens the box chip list, and the chip says comments', async ({ browser }) => {
  const page = await desk(browser);
  const t = await seededThread(world);
  await openThread(page, world, t);
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
  const chip = page.locator('[data-annotations-chip]');
  await expect(chip).toHaveText(`${t.count} comments`);
  await highlight(page, t).click();
  await expect(theList(page, t.count)).toBeVisible();
  await expect(page.locator('[data-comments-list]')).toHaveCount(1);
  await expect(rowOf(page, t.onMessage)).toHaveClass(/ib-at/);
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
  await page.context().close();
});

test('the full-screen card count opens the list above the card; Escape takes the list first, from the window and from the page', async ({ browser }) => {
  const page = await desk(browser);
  const t = await seededThread(world);
  await page.goto(fileUrl(world, t, t.page, 'full'));
  const chip = cardChip(page);
  await expect(chip).toBeVisible();
  await expect(chip).toHaveJSProperty('tagName', 'BUTTON');
  const before = await layout(page);
  await chip.click();
  const list = theList(page, t.count);
  await expect(list).toBeVisible();
  await onScreen(page, list);
  expect(await layout(page)).toBe(before);
  const card = (await page.locator('[data-fcomp]').boundingBox())!;
  const drawn = (await list.boundingBox())!;
  expect(drawn.y + drawn.height).toBeLessThanOrEqual(card.y);

  // From the window: the list goes, full screen stays, focus is back on the chip.
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(page.locator('[data-fcomp]')).toBeVisible();
  await expect(chip).toBeFocused();

  // From inside the page: the bridge's Escape takes the list, and Annotate stays on.
  const pen = page.locator('[data-full-view-pen]');
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  await chip.click();
  await expect(list).toBeVisible();
  await page.locator('iframe').first().contentFrame().locator('body').evaluate(() => window.parent.postMessage({ type: 'plannotator-bridge-annotate-exit' }, '*'));
  await expect(list).toHaveCount(0);
  await expect(pen).toHaveAttribute('aria-pressed', 'true');

  // A press inside the page reaches this window only as focus leaving for the frame.
  await chip.click();
  await expect(list).toBeVisible();
  await page.locator('iframe').first().contentFrame().locator('h1').click();
  await expect(list).toHaveCount(0);

  // A comment on a message's text is in the thread: the row goes back there, to the passage.
  await chip.click();
  await rowOf(page, t.onMessage).getByRole('button', { name: /message/ }).click();
  await expect(page.locator('[data-fcomp]')).toHaveCount(0);
  await expect(highlight(page, t)).toBeInViewport();
  await page.context().close();
});

test('a highlight leaves the open file with its comment after Send', async ({ browser }) => {
  const page = await desk(browser);
  const t = await seededThread(world);
  await page.goto(fileUrl(world, t, t.plan, 'side'));
  await expect(fileHighlight(page)).toBeVisible();
  await pane(page).locator('.ib-footrow').getByRole('button', { name: 'Send' }).click();
  await expect(pane(page).locator('[data-foot-status]')).toHaveCount(0);
  await expect(page.locator('[data-attachment-pane]')).toContainText('No annotations yet');
  await expect(fileHighlight(page)).toHaveCount(0);
  await page.context().close();
});

test('a highlight leaves the open file when the list removes its comment', async ({ browser }) => {
  const page = await desk(browser);
  const t = await seededThread(world);
  await page.goto(fileUrl(world, t, t.plan, 'side'));
  await expect(fileHighlight(page)).toBeVisible();
  await countLink(page, t.count).click();
  await rowOf(page, t.onPlan).getByRole('button', { name: 'Remove' }).click();
  await expect(rowOf(page, t.onPlan)).toHaveCount(0);
  await expect(fileHighlight(page)).toHaveCount(0);
  await page.context().close();
});

for (const size of [
  { name: '1000 wide', width: 1000, height: 700, phone: false },
  { name: '1000 wide with a file beside', width: 1000, height: 700, phone: false, beside: true },
  { name: 'a 390 px phone', width: 390, height: 844, phone: true },
  { name: 'a 320 px phone', width: 320, height: 640, phone: true },
]) {
  test(`the list stays on screen at ${size.name}, and nothing moves`, async ({ browser }) => {
    const context = await browser.newContext(size.phone ? { ...phoneContext, viewport: { width: size.width, height: size.height } } : { viewport: { width: size.width, height: size.height } });
    const page = await context.newPage();
    const t = await seededThread(world, 6);
    await page.goto(size.beside ? fileUrl(world, t, t.plan, 'side') : threadUrl(world, t));
    const link = countLink(page, t.count);
    await expect(link).toBeVisible();
    const before = await layout(page);
    if (size.phone) await link.tap();
    else await link.click();
    const list = theList(page, t.count);
    await expect(list).toBeVisible();
    await onScreen(page, list);
    await onScreen(page, list.getByRole('button', { name: 'Close the list' }));
    expect(await layout(page)).toBe(before);
    await context.close();
  });
}

test('the sheet ends at the keyboard, and the comment being edited shows above it', async ({ browser }) => {
  const context = await browser.newContext(phoneContext);
  const page = await context.newPage();
  const t = await seededThread(world, 6);
  await openThread(page, world, t);
  await countLink(page, t.count).tap();
  const list = theList(page, t.count);
  await rowOf(page, t.onPlan).getByRole('button', { name: 'Edit' }).tap();
  const visible = await keyboardUp(page);
  await onScreen(page, list, visible);
  await onScreen(page, page.getByRole('textbox', { name: 'Edit the comment' }), visible);
  await context.close();
});

test('where the foot has room only for the pill, its count is the button, and the clipped words are out of the Tab order', async ({ browser }) => {
  const context = await browser.newContext(phoneContext);
  const page = await context.newPage();
  const t = await seededThread(world);
  await openThread(page, world, t);
  const pill = pane(page).locator('button[data-draft-pill-count]');
  const words = pane(page).locator('button[data-draft-comments]');
  await expect(pill).toBeVisible();
  await expect(words).toBeHidden();
  expect(await words.evaluate((el: HTMLElement) => (el.focus(), document.activeElement === el))).toBe(false);
  await pill.tap();
  await expect(theList(page, t.count)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pill).toBeFocused();
  await context.close();
});

test('a thread with no comments gains no link', async ({ browser }) => {
  const page = await desk(browser);
  await page.goto(`${world.url}#thread=${await quietThread(world)}`);
  await expect(pane(page).locator('.ib-footrow')).toBeVisible();
  await expect(pane(page).locator('[data-foot-status]')).toHaveCount(0);
  await expect(page.locator('[data-comments-link]')).toHaveCount(0);
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await expect(page.locator('[data-annotations-chip]')).toBeDisabled();
  await expect(page.locator('[data-annotations-chip]')).toHaveText('No comments');
  await page.context().close();
});
