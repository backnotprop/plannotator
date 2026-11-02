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
 *  - a highlight leaves the open file when its comment goes (Send, the list),
 *    in Markdown and on an HTML page;
 *  - words half written in the list come back however it closed;
 *  - the stale guard takes the foot: no list behind it, then or later;
 *  - the list stays on screen at 1000, 390 and 320 wide, with the keyboard up
 *    and over a tall card; its header stays;
 *  - where the foot has room only for the pill, the pill's count is the button,
 *    44 px to press, and its neighbours keep theirs;
 *  - a thread with no comments gains nothing.
 *
 * An iPhone in WebKit: inbox-comments-list-webkit.spec.ts. Build the binary
 * first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { cardChip, countLink, fileHighlight, fileUrl, highlight, layout, onScreen, openThread, pane, quietThread, rowOf, rowShown, seededThread, startWorld, stopWorld, theList, threadUrl, type ListThread, type ListWorld } from './inbox-comments-list-world';

let world: ListWorld;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  world = await startWorld();
});
test.afterAll(async () => {
  await stopWorld(world);
});

type Asked = { messages: { questions?: { key: string }[] }[] };

const closeButton = (list: Locator) => list.getByRole('button', { name: 'Close the list' });
const editBox = (page: Page) => page.getByRole('textbox', { name: 'Edit the comment' });
const footSend = (page: Page) => pane(page).locator('.ib-footrow').getByRole('button', { name: 'Send' });
const focused = (page: Page) => page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`);

/** Long enough for what must not happen (a list opening a frame later) to have happened. */
const settle = (page: Page) => page.waitForTimeout(300);

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
  const look = () => highlight(page, t).evaluate((el) => `${el.className} ${getComputedStyle(el).backgroundColor}`);
  const unpressed = await look();
  await highlight(page, t).click();
  const list = theList(page, t.count);
  await expect(list).toBeVisible();
  await expect(rowOf(page, t.onMessage)).toHaveClass(/ib-at/);
  await rowShown(list, rowOf(page, t.onMessage));
  expect(await layout(page)).toBe(before);

  // One press, then Escape: the highlight shows the comment selected only while the list is at it.
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await settle(page);
  expect(await look()).toBe(unpressed);
  await highlight(page, t).click();
  await expect(list).toBeVisible();

  // Far down the list its header stays, with the count and Close.
  await onScreen(page, closeButton(list));
  const top = (await list.boundingBox())!.y;
  expect((await closeButton(list).boundingBox())!.y).toBeGreaterThanOrEqual(top);

  // Scrolled away, one more press on the same highlight brings the comment back.
  await list.evaluate((el) => (el.scrollTop = 0));
  await highlight(page, t).click();
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await rowShown(list, rowOf(page, t.onMessage));

  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(countLink(page, t.count)).toBeFocused();

  // A drag that ends on the highlight is a selection, not a press.
  const box = (await highlight(page, t).boundingBox())!;
  const drag = async () => {
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
  };
  await drag();
  await expect(page.locator('.annotation-toolbar')).toBeVisible();
  await expect(list).toHaveCount(0);
  await page.context().close();
});

test('a press that selects words in a highlight is the toolbar\'s: a double click, a triple click, and a drag with the list open', async ({ browser }) => {
  const page = await desk(browser);
  const t = await seededThread(world);
  await openThread(page, world, t);
  const list = theList(page, t.count);
  const toolbar = page.locator('.annotation-toolbar');

  await highlight(page, t).dblclick();
  await expect(toolbar).toBeVisible();
  await settle(page);
  await expect(list).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(toolbar).toHaveCount(0);

  await highlight(page, t).click({ clickCount: 3 });
  await expect(toolbar).toBeVisible();
  await settle(page);
  await expect(list).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(toolbar).toHaveCount(0);

  // Open already: the selection takes over, not both at once.
  await highlight(page, t).click();
  await expect(list).toBeVisible();
  const box = (await highlight(page, t).boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(toolbar).toBeVisible();
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

test('over a tall card in a short window the list stays on screen, with its Close', async ({ browser }) => {
  const page = await desk(browser, 1000, 560);
  const t = await seededThread(world, 8);
  await page.goto(fileUrl(world, t, t.page, 'full'));
  await expect(cardChip(page)).toBeVisible();
  await page.locator('[data-fcomp] textarea').first().fill(Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long reply.`).join('\n'));
  await cardChip(page).click();
  const list = theList(page, t.count);
  await expect(list).toBeVisible();
  await onScreen(page, list);
  await onScreen(page, closeButton(list));
  const card = (await page.locator('[data-fcomp]').boundingBox())!;
  const drawn = (await list.boundingBox())!;
  expect(drawn.y + drawn.height).toBeLessThanOrEqual(card.y);
  await page.context().close();
});

test('a half-written edit comes back however the list closed, and it is still the person\'s to save or drop', async ({ browser }) => {
  const page = await desk(browser);
  const t = await seededThread(world);
  await openThread(page, world, t);
  const link = countLink(page, t.count);
  const list = theList(page, t.count);
  const words = 'Half a thought I do not want to lose.';
  const back = async () => {
    await expect(list).toHaveCount(0);
    await link.click();
    await expect(editBox(page)).toHaveValue(words);
    await expect(editBox(page)).toBeFocused();
  };

  await link.click();
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Edit' }).click();
  await editBox(page).fill(words);

  // A press outside.
  await pane(page).locator('.ib-pbody').click({ position: { x: 12, y: 12 } });
  await back();
  // Its Close.
  await closeButton(list).click();
  await back();
  // The count again.
  await link.click();
  await back();
  // Another place for it: the reply box opening takes the list away, and its chip brings the words back.
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
  await expect(list).toHaveCount(0);
  await page.locator('[data-annotations-chip]').click();
  await expect(editBox(page)).toHaveValue(words);

  // Escape is the edit's first: the words go, as they always did, and the list stays.
  await page.keyboard.press('Escape');
  await expect(editBox(page)).toHaveCount(0);
  await expect(list).toBeVisible();

  // Written again, closed, back, and saved.
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Edit' }).click();
  await editBox(page).fill(words);
  await page.locator('[data-annotations-chip]').click();
  await expect(list).toHaveCount(0);
  await page.locator('[data-annotations-chip]').click();
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Save' }).click();
  await expect(rowOf(page, t.onMessage)).toContainText(words);
  await page.context().close();
});

test('a comment gone from under an edit is no edit: the first Escape closes the list', async ({ browser }) => {
  const page = await desk(browser);
  const t = await seededThread(world);
  await openThread(page, world, t);
  const link = countLink(page, t.count);
  await link.click();
  await rowOf(page, t.onPlan).getByRole('button', { name: 'Edit' }).click();
  await editBox(page).fill('Words on a comment about to go.');
  await closeButton(theList(page, t.count)).click();

  // Another window takes the comment; this window keeps the words of an edit with no row left.
  const other = await desk(browser);
  await openThread(other, world, t);
  await countLink(other, t.count).click();
  await rowOf(other, t.onPlan).getByRole('button', { name: 'Remove' }).click();
  await expect(rowOf(other, t.onPlan)).toHaveCount(0);
  await other.context().close();

  const one = pane(page).locator('[data-foot-status]').getByRole('button', { name: '1 comment', exact: true });
  await one.click();
  const list = page.getByRole('dialog', { name: '1 comment', exact: true });
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await page.context().close();
});

test('the stale guard takes the foot: the list goes with it, a highlight opens nothing, and nothing opens after Keep editing', async ({ browser }) => {
  const page = await desk(browser);
  const t = await seededThread(world);
  await openThread(page, world, t);
  await pane(page).getByRole('radio', { name: /^Yes/ }).first().click({ force: true });
  await expect(pane(page).locator('[data-foot-status]')).toContainText('1 pick');
  const model = (await (await fetch(new URL(`/api/inbox/threads/${t.thread}`, world.url))).json()) as { thread?: Asked; messages?: Asked['messages'] };
  const key = (model.thread?.messages ?? model.messages)![0]!.questions![0]!.key;
  await world.agent.send({ project_path: world.project, reply_to: t.message, body: 'A new question.\n\n:::question\nShip it on Monday?\n\n- [ ] Yes\n- [ ] No\n:::', supersedes: [`${t.message}/${key}`] });
  await expect(pane(page).locator('[data-question-part="prompt"]', { hasText: 'Ship it on Monday?' })).toBeVisible();

  // The list is open when the guard rises (Send by keyboard, so no press outside closes it first).
  await countLink(page, t.count).click();
  const list = theList(page, t.count);
  await expect(list).toBeVisible();
  await footSend(page).focus();
  await page.keyboard.press('Enter');
  const guard = pane(page).locator('.ib-guard');
  await expect(guard).toBeVisible();
  await expect(list).toHaveCount(0);

  // The comments keep their one word here too.
  await expect(guard.getByRole('button', { name: `Send ${t.count} comments only` })).toBeVisible();

  // A press on a highlight: nothing to open, and it does not stay selected for a list that is not there.
  const look = () => highlight(page, t).evaluate((el) => `${el.className} ${getComputedStyle(el).backgroundColor}`);
  const before = await look();
  await highlight(page, t).click();
  await settle(page);
  await expect(page.locator('[data-comments-list]')).toHaveCount(0);
  expect(await look()).toBe(before);

  await guard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(guard).toHaveCount(0);
  await settle(page);
  await expect(page.locator('[data-comments-list]')).toHaveCount(0);
  await expect(footSend(page)).toBeFocused();
  await page.context().close();
});

test('with no comment left, focus does not fall to the page; a Send that took them keeps its own place', async ({ browser }) => {
  // From the reply box's chip: the chip is disabled by then, so the reply field takes it.
  const page = await desk(browser);
  const t = await seededThread(world);
  await openThread(page, world, t);
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
  await page.locator('[data-annotations-chip]').click();
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Remove' }).click();
  await expect(rowOf(page, t.onMessage)).toHaveCount(0);
  await rowOf(page, t.onPlan).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('[data-comments-list]')).toHaveCount(0);
  await expect(page.locator('.ib-rbox textarea')).toBeFocused();
  await page.context().close();

  // Send by keyboard lands in the same place with the list open as without it.
  const sendFrom = async (open: boolean) => {
    const sender = await desk(browser);
    const sent = await seededThread(world);
    await openThread(sender, world, sent);
    if (open) {
      await countLink(sender, sent.count).click();
      await expect(theList(sender, sent.count)).toBeVisible();
    }
    await footSend(sender).focus();
    await sender.keyboard.press('Enter');
    await expect(pane(sender).locator('[data-foot-status]')).toHaveCount(0);
    await expect(sender.locator('[data-comments-list]')).toHaveCount(0);
    await settle(sender);
    const where = await focused(sender);
    await sender.context().close();
    return where;
  };
  expect(await sendFrom(true)).toBe(await sendFrom(false));
});

test('on a phone, the last comment removed from the card leaves focus on the card, not on the field that raises the keyboard', async ({ browser }) => {
  const context = await browser.newContext(phoneContext);
  const page = await context.newPage();
  const t = await seededThread(world);
  await page.goto(fileUrl(world, t, t.page, 'full'));
  await cardChip(page).tap();
  await rowOf(page, t.onMessage).getByRole('button', { name: 'Remove' }).tap();
  await expect(rowOf(page, t.onMessage)).toHaveCount(0);
  await rowOf(page, t.onPlan).getByRole('button', { name: 'Remove' }).tap();
  await expect(page.locator('[data-comments-list]')).toHaveCount(0);
  await expect(page.locator('[data-fcomp]')).toBeFocused();
  await context.close();
});

/** A comment pinned on the page's heading, the way a person pins one. */
async function pinOnPage(page: Page, t: ListThread): Promise<Locator> {
  await page.goto(fileUrl(world, t, t.page, 'side'));
  const frame = page.frameLocator('[data-attachment-pane] iframe').first();
  await frame.getByRole('heading', { name: 'Dead-lettered charges' }).click();
  const composer = page.locator('[data-comment-popover]');
  await composer.locator('textarea').first().fill('Say how many are waiting.');
  await composer.getByRole('button', { name: 'Save' }).click();
  const pin = frame.locator('[data-plannotator-marker]');
  await expect(pin).toHaveCount(1);
  return pin;
}

test('an HTML page\'s pin leaves with its comment: after Send, after Remove in the list, after the panel\'s Remove', async ({ browser }) => {
  const page = await desk(browser);
  const panel = page.locator('[data-attachment-pane]');

  const sent = await seededThread(world);
  const pin = await pinOnPage(page, sent);
  await footSend(page).click();
  await expect(pane(page).locator('[data-foot-status]')).toHaveCount(0);
  await expect(panel).toContainText('No annotations yet');
  await expect(pin).toHaveCount(0);

  const listed = await seededThread(world);
  await pinOnPage(page, listed);
  await countLink(page, listed.count + 1).click();
  await page.locator('[data-annotation-row]').filter({ hasText: 'Say how many' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('[data-annotation-row]').filter({ hasText: 'Say how many' })).toHaveCount(0);
  await expect(pin).toHaveCount(0);

  const paneOwn = await seededThread(world);
  await pinOnPage(page, paneOwn);
  const entry = panel.locator('[data-annotation-id]').first();
  await entry.hover();
  await entry.getByRole('button').last().click();
  await expect(pin).toHaveCount(0);
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

for (const [width, height] of [[390, 844], [320, 640]] as const) {
  test(`at ${width} wide the count is 44 px to press, drawn on an overlay, and every button beside it keeps its own press`, async ({ browser }) => {
    const context = await browser.newContext({ ...phoneContext, viewport: { width, height } });
    const page = await context.newPage();
    const t = await seededThread(world);
    await openThread(page, world, t);
    // The pill's count, or the words where the foot wraps instead: whichever this width shows.
    const count = pane(page).locator('[data-foot-status] [data-comments-link]:visible').first();
    await expect(count).toBeVisible();
    await layout(page);
    const drawn = (await count.boundingBox())!;

    // Every button of the row answers for itself, corner to corner.
    const taken = await count.evaluate((self) => {
      const buttons = [...document.querySelectorAll<HTMLElement>('section.ib-pane .ib-pfoot button')].filter((el) => el !== self && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible');
      return buttons.flatMap((el) => {
        const box = el.getBoundingClientRect();
        const points = [[box.left + 2, box.top + 2], [box.right - 2, box.top + 2], [box.left + 2, box.bottom - 2], [box.right - 2, box.bottom - 2], [box.left + box.width / 2, box.top + box.height / 2]];
        return points.filter(([x, y]) => document.elementFromPoint(x!, y!)?.closest('button') === self).map(() => el.textContent);
      });
    });
    expect(taken).toEqual([]);

    // A finger 21 px from the count's middle, each way, still lands on it.
    const [x, y] = [drawn.x + drawn.width / 2, drawn.y + drawn.height / 2];
    for (const [dx, dy] of [[0, -21], [0, 21], [-21, 0], [21, 0]] as const) {
      expect(await count.evaluate((self, [px, py]) => self.contains(document.elementFromPoint(px!, py!)), [x + dx, y + dy])).toBe(true);
    }
    await page.touchscreen.tap(x, y - 21);
    await expect(theList(page, t.count)).toBeVisible();
    await context.close();
  });
}

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
