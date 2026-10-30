/**
 * Keyboard-only journeys through the Inbox (approval "inbox-keyboard-shortcuts";
 * the steps are /tmp-free copies of JOURNEYS.md, S1–S3 then J1–J8): keys only,
 * no mouse, no `click()` and no `focus()` from the script. After every key the
 * focus is somewhere (never the page itself); after every step the focus, the
 * address and the view are the ones named; at steps marked ⟲ the browser's Back
 * and Forward land where they should, focus included (finding F1); each long
 * session ends with a Back walk.
 *
 * Against the compiled binary in a scratch Inbox (inbox-keyboard-world.ts).
 * Build it first (see inbox.spec.ts). With INBOX_KEYBOARD_VIDEOS set to a
 * folder, each journey's video and checkpoint pictures are kept there.
 *
 * F is full screen for now (never saved as the view files open in); S2 also
 * takes the Full screen button, by Tab, which is a choice that is saved.
 */
import { devices, expect, test, webkit, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createKeyboardWorld, type KeyboardWorld } from './inbox-keyboard-world';
import { removeInboxScratch } from './inbox-scratch';

const videos = process.env.INBOX_KEYBOARD_VIDEOS;
if (videos) mkdirSync(videos, { recursive: true });

const BODY = 'section.ib-pane .ib-pbody:not(.ib-artbody)';

let world: KeyboardWorld;
let context: BrowserContext;
let page: Page;
let shots = 0;


test.beforeEach(async ({ browser }, info) => {
  world = await createKeyboardWorld();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(videos ? { recordVideo: { dir: videos, size: { width: 1440, height: 900 } } } : {}) });
  page = await context.newPage();
  shots = 0;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  (info as unknown as { pageErrors: string[] }).pageErrors = errors;
});

test.afterEach(async ({}, info) => {
  try {
    expect((info as unknown as { pageErrors: string[] }).pageErrors, 'no page errors').toEqual([]);
  } finally {
    const video = page.video();
    await context.close();
    if (video && videos) renameSync(await video.path(), join(videos, `${slug(info.title)}.webm`));
    await Promise.all(world.agents.map((agent) => agent.close().catch(() => {})));
    await removeInboxScratch();
  }
});

const slug = (text: string) => text.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60);

// ── what a step checks ──

/** What has focus, in words, for a failure message. */
const focusedText = (p: Page) =>
  p.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'the page itself (document.body)';
    return `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)}"`;
  });

/**
 * A cold page has focus nowhere until the first key puts it somewhere (G I, Tab, `/`); from then on it never
 * goes back to the page. Reset by each journey's load.
 */
let focusLanded = false;

/** Focus is on something: never the page itself, never an element gone from the page. */
async function focusHeld(p: Page = page): Promise<void> {
  if (!focusLanded) {
    focusLanded = await p.evaluate(() => !!document.activeElement && document.activeElement !== document.body);
    return;
  }
  await expect
    .poll(() => p.evaluate(() => !!document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected), {
      message: `focus was lost to the page (${await focusedText(p)})`,
      timeout: 3000,
    })
    .toBe(true);
}

/** Press keys one at a time, the way a person does; after each, focus is held. */
async function press(...keys: string[]): Promise<void> {
  for (const key of keys) {
    await page.keyboard.press(key);
    await page.waitForTimeout(90);
    await focusHeld();
  }
}

/** Type words (into whatever has focus). */
async function type(words: string): Promise<void> {
  await page.keyboard.type(words, { delay: 12 });
  await focusHeld();
}

type View = 'list' | 'thread' | 'side' | 'full' | 'board' | 'settings';

const pane = (p: Page = page) => p.locator('[data-attachment-pane]').filter({ visible: true });

async function viewIs(view: View, p: Page = page): Promise<void> {
  const thread = p.locator('section.ib-pane');
  if (view === 'list') {
    await expect(thread).toHaveCount(0);
    await expect(p.locator('.ib-main .ib-lbody')).toBeVisible();
  } else if (view === 'thread') {
    await expect(thread).toBeVisible();
    await expect(pane(p)).toHaveCount(0);
  } else if (view === 'side') {
    await expect(pane(p)).toBeVisible();
    await expect(p.locator('[data-attachment-pane][data-full-view]')).toHaveCount(0);
  } else if (view === 'full') {
    await expect(p.locator('[data-attachment-pane][data-full-view]')).toBeVisible();
  } else if (view === 'board') await expect(p.locator('.ib-bpage')).toBeVisible();
  else await expect(p.locator('.ib-spage')).toBeVisible();
}

const hash = (p: Page = page) => new URL(p.url()).hash;
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The address of a thread, with or without a file (any file, or the one named) and its view. */
function addr(thread: string | null, file?: { view: 'side' | 'full'; id?: string }): RegExp {
  if (!thread) return /^#?$/;
  if (!file) return new RegExp(`^#thread=${esc(thread)}$`);
  return new RegExp(`^#thread=${esc(thread)}&file=${file.id ? esc(file.id) : 'att_[^&]+'}&view=${file.view}$`);
}

interface State {
  focus: Locator;
  address: RegExp;
  view: View;
}

/** The state after a step: focus on the element named, the address, the view. A picture for the record. */
async function at(label: string, state: State, p: Page = page): Promise<void> {
  await test.step(`state: ${label}`, async () => {
    await expect(state.focus, `${label}: focus (now on ${await focusedText(p)})`).toBeFocused();
    await expect.poll(() => hash(p), { message: `${label}: address` }).toMatch(state.address);
    await viewIs(state.view, p);
  });
  if (videos) await p.screenshot({ path: join(videos, `${slug(test.info().title)}-${String(++shots).padStart(2, '0')}-${slug(label)}.png`) });
}

/** ⟲: Back lands on `back` (focus included), and Forward puts `now` back exactly. */
async function backAndForward(label: string, back: State, now: State): Promise<void> {
  await test.step(`⟲ ${label}`, async () => {
    await page.goBack();
    await at(`${label}: Back`, back);
    await page.goForward();
    await at(`${label}: Forward`, now);
    // A person's next key comes after the page has drawn; so does this journey's.
    await page.waitForTimeout(400);
    await expect(now.focus).toBeFocused();
  });
}

/**
 * A Back walk: Back until the stops, read a page at a time (a thread, the list `''`, `board`, `settings`), have been
 * `pages` in order. Focus is held at every stop (F1). A file's own stops (a thread with `file=`) are passed over:
 * Back reopening a file closed with Escape is finding F2, waiting on the full-screen close fix (#2245).
 */
async function backWalk(pages: string[]): Promise<void> {
  await test.step('Back walk', async () => {
    const pageOf = (h: string) => h.match(/^#thread=([^&]+)/)?.[1] ?? (h.startsWith('#board') ? 'board' : h.startsWith('#settings') ? 'settings' : '');
    // The page the walk starts on is no stop (Back through its own file entries lands on it again).
    const seen: string[] = [pageOf(hash())];
    pages = [seen[0]!, ...pages];
    for (let i = 0; i < 40 && seen.length < pages.length; i++) {
      await page.goBack();
      await page.waitForTimeout(250);
      // Past the first page: the walk ran out of stops (the comparison below says which were missing).
      if (new URL(page.url()).origin !== new URL(world.url).origin) break;
      await focusHeld();
      const h = hash();
      if (/[#&]file=/.test(h)) continue;
      const at = pageOf(h);
      if (seen.at(-1) !== at) seen.push(at);
    }
    expect(seen).toEqual(pages);
  });
}

// ── where things are ──

const row = (thread: string, p: Page = page) => p.locator(`.ib-main .ib-lbody [data-thread-id="${thread}"]`).filter({ visible: true });
const firstRow = (p: Page = page) => p.locator('.ib-main .ib-lbody [data-thread-id]').filter({ visible: true }).first();
const heads = () => page.locator(`${BODY} [data-fold-head]`);
/** Rollout's message n (its words say "Step n of the rollout"), and its head. */
const messageOf = (n: number) => page.locator(`${BODY} [data-message-article]`).filter({ hasText: `Step ${n} of the rollout` });
const headOf = (n: number) => messageOf(n).locator('[data-fold-head]').first();
const earlier = () => page.locator(`${BODY} button.ib-mfold-b[data-fold-head]`);
const articles = () => page.locator(`${BODY} [data-message-article]`);
const foldedCount = () => page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-message-article]`)].filter((a) => !a.hasAttribute('data-open')).length, BODY);
/** Where `head` sits in the thread's view (px from its top): what the person sees, whatever grew above it. */
/** A head's place once a smooth scroll has ended (two reads 150 ms apart agree). */
async function settledPlace(head: Locator): Promise<number> {
  let last = await placeOf(head);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const now = await placeOf(head);
    if (Math.abs(now - last) < 0.5) return now;
    last = now;
  }
  return last;
}

const placeOf = (head: Locator) => head.evaluate((el, sel) => el.getBoundingClientRect().top - document.querySelector<HTMLElement>(sel)!.getBoundingClientRect().top, BODY);
const scrollTop = () => page.evaluate((sel) => document.querySelector<HTMLElement>(sel)?.scrollTop ?? -1, BODY);
const fileName = () => pane().getAttribute('aria-label');

/** Load the Inbox and wait for its list. */
async function load(address = ''): Promise<void> {
  focusLanded = false;
  await page.goto(`${world.url}${address}`);
  await expect(page.locator('.ib-main .ib-lbody [data-thread-id]').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

/** ↓ or ↑ (whichever way it is) through the list until `thread`'s row has focus: keys only, the list's own order. */
async function arrowTo(thread: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const where = await row(thread).evaluate((el) => {
      const active = document.activeElement;
      if (el === active) return 'here';
      return active && el.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below';
    });
    if (where === 'here') return;
    await press(where === 'above' ? 'ArrowUp' : 'ArrowDown');
  }
  await expect(row(thread)).toBeFocused();
}

/** Tab (or Shift+Tab) until `target` has focus, at most `max` presses. */
async function tabTo(target: Locator, { back = false, max = 40 } = {}): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement, undefined, { timeout: 2000 }).catch(() => false)) return;
    // Tab past the page's last stop leaves the page for the browser's own controls (the page itself in a headless
    // browser): a stop of the browser's, not focus lost, so this is the one press that does not check focus.
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    await page.waitForTimeout(60);
  }
  await expect(target, `reached by ${back ? 'Shift+Tab' : 'Tab'}`).toBeFocused();
}

/** Shift+J or Shift+K (whichever way it is; J / K are threads) until `head` has focus. */
async function moveTo(head: Locator): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const where = await head.evaluate((el) => {
      const active = document.activeElement;
      if (el === active) return 'here';
      return active && el.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below';
    });
    if (where === 'here') return;
    await press(where === 'above' ? 'Shift+K' : 'Shift+J');
  }
  await expect(head).toBeFocused();
}

/** Escape until the open file closes (full screen goes beside the thread first). */
async function escapeFile(): Promise<void> {
  // One layer per Escape: each press waits for its layer to go, as a person would see it go.
  for (let i = 0; i < 4 && (await pane().count()) > 0; i++) {
    await press('Escape');
    await expect.poll(() => pane().count(), { timeout: 700 }).toBe(0).catch(() => {});
  }
  await expect(pane()).toHaveCount(0);
}

// ── S1–S3: long sessions ──

test('S1: deep work in one thread, a detour, and back', async () => {
  const { rollout, checkout } = world.threads;
  await load();
  await press('g', 'i');
  await at('G I', { focus: firstRow(), address: addr(null), view: 'list' });

  await arrowTo(rollout);
  await press('Enter');
  await at('Rollout open', { focus: row(rollout), address: addr(rollout), view: 'thread' });
  // The six read messages are folded: the first and the last as lines, the middle ones behind "N earlier messages".
  await expect(earlier()).toHaveText(/^\d+ earlier messages$/);
  expect(await foldedCount()).toBeGreaterThanOrEqual(2);

  // N carries from the list into the thread: the first new message (7).
  await press('n');
  await at('N', { focus: headOf(7), address: addr(rollout), view: 'thread' });
  // Back to the list and Forward to the thread: focus where the keys put it (F1). Seen now, 7 and 8 are no longer new.
  await backAndForward('Rollout open', { focus: row(rollout), address: addr(null), view: 'list' }, { focus: row(rollout), address: addr(rollout), view: 'thread' });
  await moveTo(headOf(7));
  const top0 = await scrollTop();
  await press('PageDown', 'PageDown', 'PageUp');
  await at('PageDown PageDown PageUp', { focus: headOf(7), address: addr(rollout), view: 'thread' });
  expect(await scrollTop(), 'the thread scrolled').not.toBe(top0);

  // K up the folded lines to the earlier messages.
  await moveTo(earlier());
  await at('K to the earlier messages', { focus: earlier(), address: addr(rollout), view: 'thread' });
  await press('Enter');
  await expect(messageOf(4)).toBeVisible();
  await focusHeld();
  // Into the messages it showed, by Shift+J or Shift+K, to message 4.
  await moveTo(headOf(4));
  await at('message 4', { focus: headOf(4), address: addr(rollout), view: 'thread' });
  await press('Enter');
  await expect(messageOf(4)).toHaveAttribute('data-open', /.*/);
  await at('Enter unfolds 4', { focus: headOf(4), address: addr(rollout), view: 'thread' });
  await press('Enter');
  await expect(messageOf(4)).not.toHaveAttribute('data-open', /.*/);
  await at('Enter folds 4', { focus: headOf(4), address: addr(rollout), view: 'thread' });

  const expandAll = page.locator('section.ib-pane [data-expand-all]');
  await tabTo(expandAll, { back: true });
  await press('Enter');
  await expect.poll(foldedCount).toBe(0);
  await expect(articles()).toHaveCount(8);
  await at('Expand all', { focus: expandAll, address: addr(rollout), view: 'thread' });

  await moveTo(headOf(7));
  await at('back on 7', { focus: headOf(7), address: addr(rollout), view: 'thread' });
  const placeAtO = await placeOf(headOf(7));
  await press('o');
  await at('O: dashboard.webp beside', { focus: pane(), address: addr(rollout, { view: 'side' }), view: 'side' });
  expect(await fileName()).toContain(world.files.dashboard);
  await backAndForward('O', { focus: headOf(7), address: addr(rollout), view: 'thread' }, { focus: pane(), address: addr(rollout, { view: 'side' }), view: 'side' });

  const imageComment = pane().locator(`textarea[aria-label="Comment on ${world.files.dashboard}"]`);
  await tabTo(imageComment);
  await type('The p95 line needs a label');
  await press('ControlOrMeta+Enter');
  await expect(imageComment).toHaveValue('');
  await press('Escape');
  await at('image comment saved, Escape', { focus: pane(), address: addr(rollout, { view: 'side' }), view: 'side' });

  const historyAtFile = await page.evaluate(() => history.length);
  await press('[');
  await expect.poll(fileName).toContain(world.files.planPage);
  await at('[ to rollout.html', { focus: pane(), address: addr(rollout, { view: 'side' }), view: 'side' });
  // K1 (owner, 2026-10-27): commenting on part of a page stays mouse-only; the page is shown and [ ] still step.
  await press('[');
  await expect.poll(fileName).toContain(world.files.plan);
  expect(await page.evaluate(() => history.length), 'stepping files adds no history').toBe(historyAtFile);
  await at('[ to rollout.md', { focus: pane(), address: addr(rollout, { view: 'side' }), view: 'side' });

  // The whole-file comment is the keyboard path (K2: selecting a sentence stays mouse-only).
  const globalComment = pane().getByRole('button', { name: 'Global comment' });
  await tabTo(globalComment);
  await press('Enter');
  await type('Add the EU hold to step 4');
  await press('ControlOrMeta+Enter');
  await focusHeld();
  await expect(page.locator('[data-annotation-row], [data-annotation-id]').filter({ hasText: 'Add the EU hold' }).first()).toBeAttached();

  await press('f');
  await expect(page.locator('[data-attachment-pane][data-full-view]')).toBeVisible();
  await expect.poll(hash).toMatch(addr(rollout, { view: 'full' }));
  await focusHeld();
  await press(']', ']', '[');
  await expect.poll(fileName).toContain(world.files.planPage);
  await focusHeld();
  // On an HTML page the first Escape leaves Annotate for Interact (the viewer's own layer); then full screen goes.
  for (let i = 0; i < 3 && (await page.locator('[data-attachment-pane][data-full-view]').count()) > 0; i++) await press('Escape');
  await viewIs('side');
  await press('Escape');
  await at('file closed', { focus: headOf(7), address: addr(rollout), view: 'thread' });
  // The sidebar and the list spring back from full screen; the place is measured once they have.
  await page.waitForTimeout(900);
  expect(Math.abs((await placeOf(headOf(7))) - placeAtO), 'message 7 is where it was at O').toBeLessThanOrEqual(2);

  await press('r');
  const box = page.locator('section.ib-pane textarea[aria-label^="Reply to"]');
  await expect(box).toBeFocused();
  await expect(page.locator('section.ib-pane .ib-pfoot, section.ib-pane [data-reply-box]').first()).toContainText(/2 (annotations|comments)/);
  await type('Holding EU until Monday; going to everyone else today.');
  await press('Escape');
  const editDraft = page.locator('section.ib-pane [data-edit-draft]');
  await at('reply kept as a draft', { focus: editDraft, address: addr(rollout), view: 'thread' });

  await press('Escape');
  await at('thread closed', { focus: row(rollout), address: addr(null), view: 'list' });
  const rolloutLookBefore = { bold: await row(rollout).evaluate((el) => el.classList.contains('ib-u')), section: await row(rollout).getAttribute('data-section') };

  // The detour: Checkout, a file, mark read and undo.
  await arrowTo(checkout);
  // F at step 16 saved nothing: Checkout's file opens beside the thread, as files did before.
  await press('Enter');
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await press('o');
  await viewIs('side');
  await press(']');
  await escapeFile();
  await press('Escape');
  await at('Checkout file and thread closed', { focus: row(checkout), address: addr(null), view: 'list' });
  await press('e');
  await expect(page.locator('[data-toast-undo]')).toBeVisible();
  await focusHeld();
  await press('z');
  await expect(row(checkout)).toBeVisible();

  // Back to Rollout: everything as it was left.
  await arrowTo(rollout);
  await press('Enter');
  await at('Rollout again', { focus: row(rollout), address: addr(rollout), view: 'thread' });
  // Rollout is as it was left: the draft comes back in the box (focus stays on the row), with both comments; the
  // row is still read. Reopened, the read messages fold again (the Inbox's rule for a thread opened; finding F4).
  await expect(box).toHaveValue('Holding EU until Monday; going to everyone else today.');
  await expect(page.locator('section.ib-pane').getByText(/^2 annotations$/)).toBeVisible();
  expect({ bold: await row(rollout).evaluate((el) => el.classList.contains('ib-u')), section: await row(rollout).getAttribute('data-section') }, 'the row reads as it did').toEqual(rolloutLookBefore);
  await press('r');
  await expect(box).toBeFocused();
  await press('ControlOrMeta+Enter');
  const sentHead = articles().last().locator('[data-fold-head]');
  await at('sent', { focus: sentHead, address: addr(rollout), view: 'thread' });
  await expect(articles().last()).toHaveAttribute('data-author', 'person');

  await backWalk(['', checkout, '', rollout]);
});

/** The head of the message whose head has focus now, as a locator that outlives a redraw. */
async function focusedHead(): Promise<Locator> {
  const id = await page.evaluate(() => document.activeElement?.closest('[data-message-article]')?.getAttribute('data-message-article') ?? null);
  expect(id, 'a message head has focus').not.toBeNull();
  return page.locator(`${BODY} [data-message-article="${id}"] [data-fold-head]`).first();
}

/** Whatever has focus inside the open thread (a search result lands on its message, or the thread's Reply). */
const inThread = () => page.locator('section.ib-pane :focus');
/** Decide's one way in (#2241): in a thread, its open-questions list, then "Decide these N". */
const decideEntry = () => page.locator('[data-thread-decide]');
const questionsButton = () => page.locator('section.ib-pane [data-open-questions]');

/** Open `thread` (one with open questions) and Decide from it, by keys only. Returns the thread. */
async function openDecide(thread: string): Promise<string> {
  await press('g', 'i');
  await arrowTo(thread);
  await press('Enter', 'n');
  await tabTo(questionsButton(), { back: true, max: 60 });
  await press('Enter');
  // The list opens as a menu with its first item, "Decide these N", focused.
  await expect(decideEntry()).toBeFocused();
  await press('Enter');
  await expect(decide()).toBeVisible();
  return thread;
}
const decide = () => page.locator('[data-decision-mode]');
const map = () => page.locator('[data-dialog="shortcut-map"]');
const searchInput = () => page.locator('dialog[data-search-palette] input');
const boardHeading = () => page.locator('.ib-bpage h1');
const settingsHeading = () => page.locator('.ib-spage h1');
const boardCard = () => page.locator('.ib-bpage [data-card-id] button[data-card-open]').filter({ visible: true }).first();
const keycaps = () => page.locator('kbd[data-shortcut-hint]').filter({ visible: true });
const questionChoice = (n = 0) => page.locator('section.ib-pane input[data-question-control]').nth(n);

/** Search by keys: `/` (or ⌘K), the words, the first result. */
async function searchOpen(words: string, open: '/' | 'ControlOrMeta+k' = '/'): Promise<void> {
  await press(open);
  await expect(searchInput()).toBeFocused();
  await type(words);
  await expect(page.locator('dialog[data-search-palette] [role="option"]').first()).toBeVisible();
  await press('Enter');
  await expect(page.locator('dialog[data-search-palette]')).toBeHidden();
}

test('S2: a morning of triage across the whole Inbox', async () => {
  const { stopped, holding, refund, checkout } = world.threads;
  await load();
  await press('g', 'i');
  await at('G I', { focus: row(stopped), address: addr(null), view: 'list' });
  await press('ArrowDown', 'ArrowDown', 'End', 'Home');
  await at('↓ ↓ End Home', { focus: row(stopped), address: addr(null), view: 'list' });

  await arrowTo(holding);
  await press('e');
  await expect(page.locator('[data-toast-undo]')).toBeVisible();
  await focusHeld();
  await press('z');
  await expect(row(holding)).toBeVisible();
  await focusHeld();

  await arrowTo(stopped);
  await press('Enter');
  await at('Stopped open', { focus: row(stopped), address: addr(stopped), view: 'thread' });
  await press('n');
  await focusHeld();
  await backAndForward('Stopped open', { focus: row(stopped), address: addr(null), view: 'list' }, { focus: row(stopped), address: addr(stopped), view: 'thread' });
  await press('Shift+J', 'Shift+K', 'n');
  await focusHeld();

  // Answer both questions: Tab to a choice, Space; the next question's choice the same way.
  await tabTo(questionChoice(0));
  await press('Space');
  await expect(questionChoice(0)).toBeChecked();
  await tabTo(questionChoice(2));
  await press('Space');
  await focusHeld();
  await press('r');
  await expect(page.locator('section.ib-pane textarea[aria-label^="Reply to"]')).toBeFocused();
  await type('Both picked; go ahead.');
  await press('ControlOrMeta+Enter');
  await at('sent', { focus: articles().last().locator('[data-fold-head]'), address: addr(stopped), view: 'thread' });

  await searchOpen('refund');
  await at('/ refund', { focus: inThread(), address: addr(refund), view: 'thread' });
  await backAndForward('search result', { focus: row(stopped), address: addr(stopped), view: 'thread' }, { focus: page.locator('section.ib-pane :focus, .ib-main .ib-lbody :focus'), address: addr(refund), view: 'thread' });
  await press('Escape');
  await at('Refund closed', { focus: page.locator('.ib-main .ib-lbody [data-section-id="quiet"] button.ib-band').filter({ visible: true }), address: addr(null), view: 'list' });

  await press('g', 'b');
  await at('G B', { focus: boardHeading(), address: /^#board$/, view: 'board' });
  await backAndForward('Board', { focus: page.locator('.ib-main .ib-lbody [data-section-id="quiet"] button.ib-band, .ib-main .ib-lbody [data-thread-id]').filter({ visible: true }).first(), address: addr(null), view: 'list' }, { focus: boardHeading(), address: /^#board$/, view: 'board' });
  await tabTo(boardCard());
  const card = await boardCard().evaluate((el) => el.closest('[data-card-id]')!.getAttribute('data-card-id'));
  await press('Enter');
  await expect(page.locator('[data-card-panel]')).toBeVisible();
  await focusHeld();
  await press('Escape');
  await expect(page.locator('[data-card-panel]')).toHaveCount(0);
  await at('card closed', { focus: page.locator(`.ib-bpage [data-card-id="${card}"] button[data-card-open]`).filter({ visible: true }).first(), address: /^#board$/, view: 'board' });
  await press('g', 's');
  await at('G S', { focus: settingsHeading(), address: /^#settings/, view: 'settings' });
  await press('Escape');
  await at('Settings left', { focus: boardHeading(), address: /^#board$/, view: 'board' });
  await press('g', 'i');
  await at('G I from the Board', { focus: firstRow(), address: addr(null), view: 'list' });

  // Decide (since #2241) opens only from a thread with two or more decisions waiting; by now none has (Stopped's
  // are answered), so Decide is J6's.

  await press('g', 'i');
  await arrowTo(checkout);
  await press('Enter', 'n');
  const headAtO = await focusedHead();
  await press('o');
  await viewIs('side');
  const fullScreen = pane().locator('[data-full-screen-toggle]');
  await tabTo(fullScreen);
  await press('Enter');
  await viewIs('full');
  await press(']');
  for (let i = 0; i < 3 && (await page.locator('[data-attachment-pane][data-full-view]').count()) > 0; i++) await press('Escape');
  await viewIs('side');
  await escapeFile();
  await at('Checkout file closed', { focus: headAtO, address: addr(checkout), view: 'thread' });
  const holder = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120));
  await press('Shift+?');
  await expect(map()).toBeVisible();
  await press('Escape');
  await expect(map()).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)), 'the map gives focus back').toBe(holder);

  // Settings left by Escape is a stop of its own (J5): Back retraces Board, Settings, Board.
  await backWalk(['', 'board', 'settings', 'board', '', refund, stopped, '']);
});

test('S3: interrupted, a half-written reply survives everything', async () => {
  const { holding, checkout } = world.threads;
  const box = page.locator('section.ib-pane textarea[aria-label^="Reply to"]');
  await load(`#thread=${holding}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await expect(box).toHaveValue(world.holdingDraft);
  await press('r');
  await expect(box).toBeFocused();
  await page.keyboard.press('End');
  await type(' — and keep a log.');
  const words = `${world.holdingDraft} — and keep a log.`;
  await press('ControlOrMeta+k');
  await expect(searchInput()).toBeFocused();
  await type('checkout');
  await expect(page.locator('dialog[data-search-palette] [role="option"]').first()).toBeVisible();
  await press('Enter');
  await expect.poll(hash).toMatch(addr(checkout));
  await focusHeld();
  await backAndForward('to Checkout', { focus: row(holding), address: addr(holding), view: 'thread' }, { focus: row(checkout), address: addr(checkout), view: 'thread' });
  await page.goBack();
  await expect(box).toHaveValue(words);
  await page.goForward();
  await expect.poll(hash).toMatch(addr(checkout));

  await press('n', 'Shift+J', 'o');
  await viewIs('side');
  await press(']');
  const image = pane();
  await expect.poll(fileName).toContain(world.files.page);
  await press('[');
  await expect.poll(fileName).toContain(world.files.image);
  const comment = image.locator(`textarea[aria-label="Comment on ${world.files.image}"]`);
  await tabTo(comment);
  await type('Shadow too heavy');
  await press('ControlOrMeta+Enter');
  await expect(comment).toHaveValue('');
  await press('Escape');
  await at('comment saved', { focus: pane(), address: addr(checkout, { view: 'side' }), view: 'side' });
  await press('Shift+?');
  await expect(map()).toBeVisible();
  await press('Escape');
  await at('map closed', { focus: pane(), address: addr(checkout, { view: 'side' }), view: 'side' });

  // Show keys on buttons off, then Single-key shortcuts off, in Settings; Escape comes back each time.
  await press('g', 's');
  await at('G S', { focus: settingsHeading(), address: /^#settings/, view: 'settings' });
  await tabTo(page.locator('[data-settings-key-hints]'));
  await press('Space');
  await expect(page.locator('[data-settings-key-hints]')).toHaveAttribute('aria-checked', 'false');
  await tabTo(page.locator('[data-settings-single-keys]'), { back: true });
  await press('Space');
  await expect(page.locator('[data-settings-single-keys]')).toHaveAttribute('aria-checked', 'false');
  await press('Escape');
  await at('back from Settings', { focus: pane(), address: addr(checkout, { view: 'side' }), view: 'side' });
  await expect(keycaps()).toHaveCount(0);

  const was = hash();
  for (const key of ['e', 'r', 'o', 'j', 'k', 'Shift+J', '[', ']', 'Shift+?', '/', 'g', 'i']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  expect(hash(), 'no single key acted').toBe(was);
  await expect(map()).toHaveCount(0);
  await expect(page.locator('dialog[data-search-palette]')).toBeHidden();
  await expect(page.locator('[data-toast-undo]')).toHaveCount(0);
  await focusHeld();

  await press('ControlOrMeta+k');
  await type('installer');
  await expect(page.locator('dialog[data-search-palette] [role="option"]').first()).toBeVisible();
  await press('Enter');
  await expect.poll(hash).toMatch(addr(holding));
  await expect(box).toHaveValue(words);
  await tabTo(box);
  await press('ControlOrMeta+Enter');
  await at('sent', { focus: articles().last().locator('[data-fold-head]'), address: addr(holding), view: 'thread' });

  await press('ControlOrMeta+k');
  await type('checkout');
  await expect(page.locator('dialog[data-search-palette] [role="option"]').first()).toBeVisible();
  await press('Enter');
  await expect.poll(hash).toMatch(addr(checkout));
  await expect(page.locator('section.ib-pane')).toContainText(world.files.image);
  await expect(page.locator('section.ib-pane .ib-att-t').filter({ hasText: world.files.image }).first()).toContainText(/1 annotation|1 comment/);

  // Both settings back on: E works again.
  await press('Escape');
  await focusHeld();
  await tabTo(page.locator('.ib-side .ib-setrow > .ib-nav, [data-settings-nav]').first(), { back: true });
  await press('Enter');
  await expect(settingsHeading()).toBeFocused();
  await tabTo(page.locator('[data-settings-single-keys]'));
  await press('Space');
  await tabTo(page.locator('[data-settings-key-hints]'));
  await press('Space');
  await press('Escape');
  await focusHeld();
  await expect(keycaps().first()).toBeVisible();
  await press('g', 'i');
  await at('G I works again', { focus: firstRow(), address: addr(null), view: 'list' });

  // Back retraces every page, Settings included (each visit is a stop, J5), back to the load.
  await backWalk(['settings', '', checkout, holding, 'settings', checkout, holding]);
});

// ── F1: Back and Forward put focus where the page's own key would ──

test('F1: Back and Forward land focus where the page’s key puts it (the row, the Board’s heading), never on the page; not after a pointer', async () => {
  const { stopped } = world.threads;
  await load();
  await press('g', 'i', 'Enter');
  await at('a thread open', { focus: row(stopped), address: addr(stopped), view: 'thread' });
  await press('g', 'b');
  await at('the Board', { focus: boardHeading(), address: /^#board$/, view: 'board' });
  await page.goBack();
  await at('Back to the thread', { focus: row(stopped), address: addr(stopped), view: 'thread' });
  await page.goBack();
  await at('Back to the list', { focus: row(stopped), address: addr(null), view: 'list' });
  await page.goForward();
  await at('Forward to the thread', { focus: row(stopped), address: addr(stopped), view: 'thread' });
  await page.goForward();
  await at('Forward to the Board', { focus: boardHeading(), address: /^#board$/, view: 'board' });
  // After a pointer (a click on the Board's empty space), Back moves no focus onto a row: E would mark it read.
  await page.mouse.click(900, 600);
  await page.goBack();
  await expect.poll(hash).toMatch(addr(stopped));
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.ib-lbody [data-thread-id]'))).toBe(false);
});

// ── J1–J8: short supporting checks ──

test('J1: triage the list and open the newest thread', async () => {
  const { stopped, holding } = world.threads;
  await load();
  await press('g', 'i');
  await at('G I', { focus: row(stopped), address: addr(null), view: 'list' });
  await press('ArrowDown', 'ArrowDown');
  await viewIs('list');
  await press('End', 'Home');
  await at('End Home', { focus: row(stopped), address: addr(null), view: 'list' });
  // No thread open: J and K move along the rows as ↓ ↑ do (the next thread there), and open nothing.
  const second = page.locator('.ib-main .ib-lbody').locator('[data-thread-id], button.ib-band').filter({ visible: true }).nth(1);
  await press('j');
  await at('J on the list', { focus: second, address: addr(null), view: 'list' });
  await press('k', 'k');
  await at('K K on the list (no wrap)', { focus: row(stopped), address: addr(null), view: 'list' });
  await arrowTo(holding);
  await press('e');
  await expect(page.locator('[data-toast-undo]')).toBeVisible();
  await focusHeld();
  await press('z');
  await expect(row(holding)).toBeVisible();
  await press('Home', 'Enter');
  await at('Stopped open', { focus: row(stopped), address: addr(stopped), view: 'thread' });

  // J / K (the swap addendum): the next and previous thread in the list as it shows (folded Quiet left out),
  // replacing the open one in history. From the list focus stays on the rows; from the thread it lands where N puts it.
  const order = await page.evaluate(() => {
    const ids: string[] = [];
    for (const el of document.querySelectorAll('.ib-main .ib-lbody [data-thread-id]')) {
      const id = el.getAttribute('data-thread-id')!;
      if (!ids.includes(id) && el.getClientRects().length > 0) ids.push(id);
    }
    return ids;
  });
  expect(order[0]).toBe(stopped);
  expect(order, 'folded Quiet is not in the order').not.toContain(world.threads.refund);
  const entries = await page.evaluate(() => history.length);
  const live = page.locator('[data-inbox-live]');
  await press('j');
  await at('J from the row', { focus: row(order[1]!), address: addr(order[1]!), view: 'thread' });
  // On to Rollout (eight messages), into it with Shift+J (a message), then K from inside the thread.
  const rolloutAt = order.indexOf(world.threads.rollout);
  expect(rolloutAt).toBeGreaterThan(1);
  for (let i = 1; i < rolloutAt; i++) await press('j');
  await at('J to Rollout', { focus: row(world.threads.rollout), address: addr(world.threads.rollout), view: 'thread' });
  await press('Shift+J');
  await expect(inThread()).toBeFocused();
  await press('k');
  const before = order[rolloutAt - 1]!;
  await at('K from the thread', { focus: inThread(), address: addr(before), view: 'thread' });
  await expect(row(before), 'from the thread, focus stays in the thread').not.toBeFocused();
  for (let i = 0; i < rolloutAt - 1; i++) await press('k');
  await expect.poll(hash).toMatch(addr(stopped));
  await press('k');
  await expect(live).toHaveText('First thread');
  await expect.poll(hash).toMatch(addr(stopped));
  for (let i = 1; i < order.length; i++) await press('j');
  await expect.poll(hash).toMatch(addr(order.at(-1)!));
  await focusHeld();
  await press('j');
  await expect(live).toHaveText('Last thread');
  await expect.poll(hash, 'no wrap').toMatch(addr(order.at(-1)!));
  expect(await page.evaluate(() => history.length), 'J and K add no history').toBe(entries);
  // Shift+J and Shift+K are the messages: Shift+J stays in this thread.
  await press('Shift+J');
  await expect.poll(hash).toMatch(addr(order.at(-1)!));
  await page.goBack();
  await at('Back', { focus: row(order.at(-1)!), address: addr(null), view: 'list' });
});

/** The ids of the rows the list shows, top to bottom, once each (folded Quiet is not drawn). */
const shownOrder = () =>
  page.evaluate(() => {
    const ids: string[] = [];
    for (const el of document.querySelectorAll('.ib-main .ib-lbody [data-thread-id]')) {
      const id = el.getAttribute('data-thread-id')!;
      if (!ids.includes(id) && el.getClientRects().length > 0) ids.push(id);
    }
    return ids;
  });

test('J1b: J from a thread whose row left the list on screen steps from the slot it had', async () => {
  // E on an opened update moves its row into folded Quiet while the thread stays open (#2265). J and K then go on
  // from where the row was, never "not in the list".
  const { news } = world.threads;
  await load();
  await press('g', 'i');
  const order = await shownOrder();
  const slot = order.indexOf(news);
  expect(slot, 'the update shows in the list').toBeGreaterThanOrEqual(0);
  const [key, expected] = order[slot + 1] ? (['j', order[slot + 1]!] as const) : (['k', order[slot - 1]!] as const);
  await arrowTo(news);
  await press('Enter');
  await at('the update open', { focus: row(news), address: addr(news), view: 'thread' });
  // The look lands (the server has the update in Quiet; the window holds its row in place), then E.
  const sectionOf = async (id: string) => {
    const list = (await (await fetch(new URL('/api/inbox/threads?archived=exclude', world.url))).json()) as { sections: { id: string; threads: { thread_id: string }[] }[] };
    return list.sections.find((section) => section.threads.some((t) => t.thread_id === id))?.id ?? null;
  };
  await expect.poll(() => sectionOf(news), { timeout: 5000 }).toBe('quiet');
  await press('e');
  // Mark read on a seen update held in New (#2265) moves its row into folded Quiet now, the thread still open:
  // the row has left the rows on screen, so J / K must step from its slot.
  await expect.poll(shownOrder, 'E took the row out of the rows on screen').not.toContain(news);
  await expect.poll(hash).toMatch(addr(news));
  await press(key);
  await at('J after E', { focus: row(expected), address: addr(expected), view: 'thread' });
  await expect(page.locator('[data-inbox-live]')).not.toHaveText('This thread is not in the list on screen.');
});

test('J2: read a thread and its files, and come back to exactly where you were', async () => {
  const { checkout } = world.threads;
  await load(`#thread=${checkout}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await press('Shift+J', 'Shift+J', 'Shift+K', 'n');
  const head = await focusedHead();
  // J and N scroll the head into view smoothly: its place is where the scroll ends.
  const place = await settledPlace(head);
  await press('o');
  await at('O', { focus: pane(), address: addr(checkout, { view: 'side' }), view: 'side' });
  const opened = await fileName();
  const entries = await page.evaluate(() => history.length);
  await press('[');
  await expect.poll(fileName).not.toBe(opened);
  await press(']');
  await expect.poll(fileName).toBe(opened);
  await press(']');
  await expect.poll(fileName).not.toBe(opened);
  expect(await page.evaluate(() => history.length), 'stepping adds no history').toBe(entries);

  // F: full screen, and F again back beside the thread, the same file, focus in its pane.
  const stepped = await fileName();
  await press('f');
  await at('F', { focus: pane(), address: addr(checkout, { view: 'full' }), view: 'full' });
  expect(await fileName()).toBe(stepped);
  // The tooltips name F once, where it does the same: full screen came from beside the thread, so Side by side, not ×.
  const fHint = page.locator('[data-shortcut-hint="inbox-thread.fullScreen"]').filter({ visible: true });
  await tabTo(page.locator('[data-full-view-exit="exit"]'));
  await expect(fHint).toHaveCount(1);
  await tabTo(page.locator('[data-full-view-close]'));
  await expect(page.locator('[data-shortcut-hint$=".escape"]').filter({ visible: true })).toHaveCount(1);
  await expect(fHint).toHaveCount(0);
  await press('f');
  // Back beside the thread as Escape comes back (#2245): focus on the file's Side by side.
  await at('F again', { focus: pane().locator('[data-view-side]'), address: addr(checkout, { view: 'side' }), view: 'side' });
  expect(await fileName()).toBe(stepped);
  // The view switch's Full screen tooltip names F.
  await tabTo(pane().locator('[data-full-screen-toggle]'));
  await expect(fHint).toHaveCount(1);

  await escapeFile();
  await at('closed', { focus: head, address: addr(checkout), view: 'thread' });
  await page.waitForTimeout(600);
  expect(Math.abs((await placeOf(head)) - place), 'the thread is where it was').toBeLessThanOrEqual(2);

  // No file open: F opens the newest one full screen; one Escape closes it, back to where focus was.
  await press('f');
  await at('F with no file', { focus: pane(), address: addr(checkout, { view: 'full' }), view: 'full' });
  expect(await fileName()).toBe(opened);
  await press('Escape');
  await at('Escape once', { focus: head, address: addr(checkout), view: 'thread' });
  // F is never a choice: O still opens files beside the thread.
  await press('o');
  await at('O after F', { focus: pane(), address: addr(checkout, { view: 'side' }), view: 'side' });
  await escapeFile();
  // Back retraces each file opened and closed (a close is an entry: Back opens it again, finding F2), newest first:
  // O's file, F's full screen, the stepped file. F and F again left no entries of their own.
  const stops: string[] = [];
  for (let i = 0; i < 20; i++) {
    await page.goBack();
    await page.waitForTimeout(250);
    if (new URL(page.url()).origin !== new URL(world.url).origin) break;
    await focusHeld();
    stops.push(hash());
  }
  const kind = (h: string) => (!/[#&]file=/.test(h) ? 'thread' : /view=full/.test(h) ? 'full' : 'side');
  expect(stops.map(kind)).toEqual(['side', 'thread', 'full', 'thread', 'side', 'thread']);
  expect(stops.every((h) => h.startsWith(`#thread=${checkout}`)), 'every stop is this thread').toBe(true);
});

test('J3: answer a question and send a reply; letters typed are words', async () => {
  const { stopped } = world.threads;
  const box = page.locator('section.ib-pane textarea[aria-label^="Reply to"]');
  await load(`#thread=${stopped}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await press('n');
  await tabTo(questionChoice(0));
  await press('ArrowDown');
  await press('Space');
  await expect(questionChoice(1)).toBeChecked();
  await press('r');
  await expect(box).toBeFocused();
  await type('e r o j k n ? / g i');
  await expect(box).toHaveValue('e r o j k n ? / g i');
  await expect(map()).toHaveCount(0);
  await expect(page.locator('dialog[data-search-palette]')).toBeHidden();
  await press('Escape');
  await at('draft kept', { focus: page.locator('section.ib-pane [data-edit-draft]'), address: addr(stopped), view: 'thread' });
  await press('r');
  await expect(box).toHaveValue('e r o j k n ? / g i');
  await press('ControlOrMeta+Enter');
  await at('sent', { focus: articles().last().locator('[data-fold-head]'), address: addr(stopped), view: 'thread' });
});

test('J4: search with / and open a result', async () => {
  const { refund } = world.threads;
  const quiet = () => page.locator('.ib-main .ib-lbody [data-section-id="quiet"] button.ib-band').filter({ visible: true });
  await load();
  await searchOpen('refund');
  await at('result open', { focus: inThread(), address: addr(refund), view: 'thread' });
  await press('Escape');
  await at('closed: the Quiet band holds Refund', { focus: quiet(), address: addr(null), view: 'list' });
  await page.goBack();
  await expect.poll(hash).toMatch(addr(refund));
  await focusHeld();
  await press('Escape');
  await at('closed again', { focus: quiet(), address: addr(null), view: 'list' });
});

test('J5: jump with G, and come back', async () => {
  const { checkout } = world.threads;
  await load(`#thread=${checkout}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await press('g', 'b');
  await at('G B', { focus: boardHeading(), address: /^#board$/, view: 'board' });
  await tabTo(boardCard());
  const card = await boardCard().evaluate((el) => el.closest('[data-card-id]')!.getAttribute('data-card-id'));
  await press('Enter');
  await expect(page.locator('[data-card-panel]')).toBeVisible();
  await press('Escape');
  await at('card closed', { focus: page.locator(`.ib-bpage [data-card-id="${card}"] button[data-card-open]`).filter({ visible: true }).first(), address: /^#board$/, view: 'board' });
  await press('g', 's');
  await at('G S', { focus: settingsHeading(), address: /^#settings/, view: 'settings' });
  await press('Escape');
  await at('Settings left', { focus: boardHeading(), address: /^#board$/, view: 'board' });
  await press('g', 'i');
  await at('G I', { focus: firstRow(), address: addr(null), view: 'list' });
  await backWalk(['board', 'settings', 'board', checkout]);
});

test('J6: Decide mode stays its own', async () => {
  await load();
  const decidedIn = await openDecide(world.threads.stopped);
  const entries = await page.evaluate(() => history.length);
  const before = hash();
  const unread = () => row(decidedIn).evaluate((el) => el.classList.contains('ib-u'));
  const wasUnread = await unread();
  await press('e', 'r', 'o', 'j', 'Shift+J', 'Shift+?', '/');
  // E is Decide's, not Mark read on the thread behind it.
  expect(await unread(), 'the thread behind Decide was not marked read').toBe(wasUnread);
  await expect(decide()).toBeVisible();
  await expect(map()).toHaveCount(0);
  await expect(page.locator('dialog[data-search-palette]')).toBeHidden();
  expect(hash()).toBe(before);
  await tabTo(decide().getByRole('radio').first());
  await press('Space');
  // The answer stamps the card, then Decide moves to the next one and puts focus on its question: let it land
  // before Escape, so the move does not take focus from where Escape puts it.
  await expect(decide().locator('[data-decision-prompt]')).toBeFocused();
  await press('Escape');
  await expect(decide().locator('[data-decision-confirm]')).toBeVisible();
  await press('Escape');
  await expect(decide().locator('[data-decision-close]')).toBeFocused();
  await press('Escape');
  await tabTo(decide().locator('[data-decision-keep-draft]'));
  await press('Enter');
  await expect(decide()).toBeHidden();
  await at('Decide closed', { focus: questionsButton(), address: addr(decidedIn), view: 'thread' });
  expect(await page.evaluate(() => history.length), 'Decide adds no history: Back never reopens it').toBe(entries);
});

test('J7: the shortcut map, from anywhere', async () => {
  const { checkout } = world.threads;
  const box = page.locator('section.ib-pane textarea[aria-label^="Reply to"]');
  await load();
  await press('g', 'i');
  const entries = await page.evaluate(() => history.length);
  await press('Shift+?');
  await expect(map()).toBeVisible();
  expect(await map().locator('[data-map-row]').count()).toBeGreaterThan(15);
  await press('Shift+?');
  await expect(map()).toHaveCount(0);
  await at('? again closes it', { focus: firstRow(), address: addr(null), view: 'list' });
  expect(await page.evaluate(() => history.length), '? and ? again add no history').toBe(entries);

  // From a thread, a file and Settings: Escape closes it and focus goes back to what had it.
  await arrowTo(checkout);
  await press('Enter', 'n');
  const head = await focusedHead();
  await press('Shift+?', 'Escape');
  await expect(head).toBeFocused();
  await press('o');
  await press('Shift+?', 'Escape');
  await expect(pane()).toBeFocused();
  await press('g', 's');
  await press('Shift+?', 'Escape');
  await expect(settingsHeading()).toBeFocused();
  await press('Escape');
  await escapeFile();

  // In the reply box `?` is a question mark.
  await press('r');
  await expect(box).toBeFocused();
  await type('?');
  await expect(box).toHaveValue('?');
  await expect(map()).toHaveCount(0);
  await press('Escape');

  // The keyboard button beside light and dark, and Show keys on buttons in the map's foot.
  const button = page.locator('[data-shortcut-map-button]');
  const beforeButton = await page.evaluate(() => history.length);
  await tabTo(button);
  await press('Enter');
  await expect(map()).toBeVisible();
  await tabTo(map().locator('[data-map-hints]'));
  await press('Space');
  await expect(map().locator('[data-map-hints]')).toHaveAttribute('aria-checked', 'false');
  await press('Escape');
  await at('map closed', { focus: button, address: addr(checkout), view: 'thread' });
  await expect(keycaps()).toHaveCount(0);
  expect(await page.evaluate(() => history.length), 'the map from its button adds no history').toBe(beforeButton);
});

test('J8: Settings, both shortcut settings, and the keys honour them', async () => {
  const singleKeys = () => page.locator('[data-settings-single-keys]');
  await load();
  await press('g', 's');
  await at('G S', { focus: settingsHeading(), address: /^#settings/, view: 'settings' });
  await tabTo(singleKeys());
  await press('Space');
  await expect(singleKeys()).toHaveAttribute('aria-checked', 'false');
  await press('Escape');
  await viewIs('list');
  await focusHeld();
  const was = hash();
  for (const key of ['e', 'r', 'o', 'j', 'k', 'Shift+J', 'Shift+?', '/', 'g', 'i']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  expect(hash(), 'no single key acted').toBe(was);
  await expect(map()).toHaveCount(0);
  await expect(page.locator('dialog[data-search-palette]')).toBeHidden();
  await expect(page.locator('[data-toast-undo]')).toHaveCount(0);
  // Single-key keycaps are not drawn; ⌘K's still is.
  expect(await keycaps().evaluateAll((caps) => caps.map((c) => c.getAttribute('data-keycap')).filter((k) => k && /^[A-Z?/[\]]$/.test(k)))).toEqual([]);
  await press('ControlOrMeta+k');
  await expect(searchInput()).toBeFocused();
  await press('Escape');
  await focusHeld();

  // Inside a thread and with a file open beside it, the single keys stay off: `[` `]` included; the arrows step.
  const { checkout } = world.threads;
  await arrowTo(checkout);
  await press('Enter');
  await expect(page.locator('section.ib-pane')).toBeVisible();
  const inside = hash();
  for (const key of ['j', 'k', 'n', 'Shift+J', 'r', 'o', 'f']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  expect(hash(), 'no single key acted in the thread').toBe(inside);
  await tabTo(page.locator('section.ib-pane [data-attachment-id]').first());
  await press('Enter');
  await expect(pane()).toBeFocused();
  const opened = await fileName();
  await press(']');
  await press('[');
  await page.waitForTimeout(300);
  expect(await fileName(), '[ and ] are single keys: off').toBe(opened);
  await press('ArrowRight');
  await expect.poll(fileName, { message: 'the arrows still step' }).not.toBe(opened);
  await escapeFile();
  await press('Escape');

  await press('g', 'i');
  await page.reload();
  await expect(page.locator('.ib-main .ib-lbody [data-thread-id]').first()).toBeVisible();
  focusLanded = false;
  await press('g', 's');
  expect(hash(), 'still off after a reload').toBe(was);
  // Back on: Settings by Tab, the switch, and E works again.
  await tabTo(page.locator('.ib-side .ib-setrow > .ib-nav, [data-settings-nav]').first());
  await press('Enter');
  await expect(settingsHeading()).toBeFocused();
  await tabTo(singleKeys());
  await press('Space');
  await expect(singleKeys()).toHaveAttribute('aria-checked', 'true');
  await press('Escape');
  await press('g', 'i');
  await at('G I works again', { focus: firstRow(), address: addr(null), view: 'list' });
  await press('e');
  await expect(page.locator('[data-toast-undo]')).toBeVisible();
});

// ── A touch phone: no single keys but `?` (J1 and J8 the other way round); a narrow desktop window keeps them ──

/** Every single key but `?`, pressed in `p`'s list and then in an open thread: none acts, none is drawn. */
async function singleKeysDoNothing(p: Page): Promise<void> {
  const keys = ['e', 'z', 'r', 'o', 'f', 'j', 'k', 'n', 'Shift+J', 'Shift+K', '[', ']', '/', 'g', 'i', 'g', 'b', 'g', 's'];
  const pressAll = async () => {
    for (const key of keys) {
      await p.keyboard.press(key);
      await p.waitForTimeout(60);
    }
    await p.waitForTimeout(400);
  };
  const quiet = async (where: string) => {
    await expect(p.locator('[data-dialog="shortcut-map"]'), `${where}: no map`).toHaveCount(0);
    await expect(p.locator('dialog[data-search-palette][open]'), `${where}: no search`).toHaveCount(0);
    await expect(p.locator('[data-toast-undo]'), `${where}: no toast (E, Z)`).toHaveCount(0);
    await expect(p.locator('kbd[data-shortcut-hint]').filter({ visible: true }), `${where}: no keycaps`).toHaveCount(0);
    await expect(p.locator('[data-shortcut-map-button]').filter({ visible: true }), `${where}: no keyboard button`).toHaveCount(0);
  };
  await p.goto(world.url);
  await expect(p.locator('[data-thread-id]').filter({ visible: true }).first()).toBeVisible();
  const list = p.url();
  await pressAll();
  expect(p.url(), 'the list: no key moved the page').toBe(list);
  await quiet('the list');

  // An open thread, focus on its subject: R, O, F, J, K, N, Shift+J, Shift+K and the rest do nothing there either.
  await p.goto(`${world.url}#thread=${world.threads.checkout}`);
  await expect(p.locator('section.ib-pane')).toBeVisible();
  await p.locator('section.ib-pane h2.ib-subject').focus();
  const thread = p.url();
  const unread = await p.evaluate((id) => [...document.querySelectorAll(`[data-thread-id="${id}"]`)].some((el) => el.classList.contains('ib-u')), world.threads.checkout);
  await pressAll();
  expect(p.url(), 'the thread: no key moved the page').toBe(thread);
  await expect(p.locator('section.ib-pane h2.ib-subject'), 'J, K, N moved no focus').toBeFocused();
  await expect(p.locator('section.ib-pane textarea[aria-label^="Reply to"]'), 'R opened no reply box').toHaveCount(0);
  await expect(p.locator('[data-attachment-pane]'), 'O and F opened no file').toHaveCount(0);
  expect(await p.evaluate((id) => [...document.querySelectorAll(`[data-thread-id="${id}"]`)].some((el) => el.classList.contains('ib-u')), world.threads.checkout), 'E marked nothing').toBe(unread);
  await quiet('the thread');
  // Nothing names a key that does nothing here: no single key but `?` in any aria-keyshortcuts.
  const dead = (names: string[]) => names.flatMap((name) => name.split(/\s+/)).filter((token) => /^(Shift\+)?[^+]$/.test(token) && token !== 'Shift+?');
  expect(dead(await p.locator('[aria-keyshortcuts]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-keyshortcuts') ?? ''))), 'aria-keyshortcuts names no dead key').toEqual([]);
  // `?` still opens the map: a phone with a hardware keyboard (design §5.4). It lists only the keys that act here.
  await p.keyboard.press('Shift+?');
  const map = p.locator('[data-dialog="shortcut-map"]');
  await expect(map, '? opens the map').toBeVisible();
  await expect(map.locator('[data-map-row="inbox-app.openMap"]'), 'the map lists ?').toHaveCount(1);
  const caps = await map.locator('[data-map-row] kbd').allInnerTexts();
  expect(caps.filter((cap) => /^[^\s⌘]$/.test(cap.trim()) && !['?', '↑', '↓', '←', '→', '↵'].includes(cap.trim())), 'the map lists no single key that does nothing here').toEqual([]);
  for (const action of ['inbox-thread.reply', 'inbox-thread.markRead', 'inbox-thread.undo', 'inbox-thread.nextThread']) {
    await expect(map.locator(`[data-map-row="${action}"]`), `no ${action} row`).toHaveCount(0);
  }
  await expect(map.locator('#ib-map-sub')).not.toContainText('Single keys work');
  await expect(map.locator('[data-map-settings]'), 'no way to the Keyboard settings a phone hides').toHaveCount(0);
  await p.keyboard.press('Escape');
  await expect(map).toHaveCount(0);
}

test('a touch phone (WebKit, iPhone 15): no keycaps, no keyboard button, and no single key acts but ?, in the list or a thread', async () => {
  const own: Browser = await webkit.launch({ args: [] });
  try {
    const phoneContext = await own.newContext({ ...devices['iPhone 15'] });
    await singleKeysDoNothing(await phoneContext.newPage());
    await phoneContext.close();
  } finally {
    await own.close();
  }
});

test('a desktop window narrower than 768 px keeps every single key (the phone layout, no keycaps): J, E, Z, ], ?, and Escape out of Settings', async () => {
  const narrow: BrowserContext = await page.context().browser()!.newContext({ viewport: { width: 600, height: 900 } });
  try {
    const p = await narrow.newPage();
    const { checkout } = world.threads;
    await p.goto(world.url);
    await expect(p.locator('.ib-main .ib-lbody [data-thread-id]').filter({ visible: true }).first()).toBeVisible();
    const order = await p.evaluate(() => {
      const ids: string[] = [];
      for (const el of document.querySelectorAll('.ib-main .ib-lbody [data-thread-id]')) {
        const id = el.getAttribute('data-thread-id')!;
        if (!ids.includes(id) && el.getClientRects().length > 0) ids.push(id);
      }
      return ids;
    });
    const next = order[order.indexOf(checkout) + 1]!;
    expect(next, 'checkout has a thread after it').toBeTruthy();
    await p.goto(`${world.url}#thread=${checkout}`);
    await expect(p.locator('section.ib-pane')).toBeVisible();
    await p.locator('section.ib-pane h2.ib-subject').focus();
    // No keycaps and no keyboard button: the phone layout draws none.
    await expect(p.locator('kbd[data-shortcut-hint]').filter({ visible: true })).toHaveCount(0);
    await expect(p.locator('[data-shortcut-map-button]').filter({ visible: true })).toHaveCount(0);
    // O opens a file, ] steps to the next.
    await p.keyboard.press('o');
    const file = p.locator('[data-attachment-pane]').filter({ visible: true });
    await expect(file).toBeVisible();
    const opened = await file.getAttribute('aria-label');
    await p.keyboard.press(']');
    await expect.poll(() => file.getAttribute('aria-label')).not.toBe(opened);
    // Escape walks out of the file (one rung at a time, as escapeFile).
    for (let i = 0; i < 4 && (await file.count()) > 0; i++) await p.keyboard.press('Escape');
    await expect(file).toHaveCount(0);
    // E marks the thread read (the toast offers Undo), Z undoes it.
    await p.locator('section.ib-pane h2.ib-subject').focus();
    await p.keyboard.press('e');
    await expect(p.locator('[data-toast-undo]')).toBeVisible();
    await p.keyboard.press('z');
    await expect(p.locator('[data-toast-undo]')).toHaveCount(0);
    // J opens the next thread.
    await p.locator('section.ib-pane h2.ib-subject').focus();
    await p.keyboard.press('j');
    await expect.poll(() => new URL(p.url()).hash).toBe(`#thread=${next}`);
    // ? opens the map.
    await p.keyboard.press('Shift+?');
    await expect(p.locator('[data-dialog="shortcut-map"]')).toBeVisible();
    await p.keyboard.press('Escape');
    await expect(p.locator('[data-dialog="shortcut-map"]')).toHaveCount(0);
    // G S goes to Settings from the list; Escape goes back to it, as in a wide window.
    await p.goto(world.url);
    await expect(p.locator('.ib-main .ib-lbody [data-thread-id]').filter({ visible: true }).first()).toBeVisible();
    await p.locator('.ib-main .ib-lbody [data-thread-id]').filter({ visible: true }).first().focus();
    await p.keyboard.press('g');
    await p.keyboard.press('s');
    await expect.poll(() => new URL(p.url()).hash).toMatch(/^#settings/);
    await p.keyboard.press('Escape');
    await expect.poll(() => new URL(p.url()).hash).toBe('');
    await expect(p.locator('.ib-main .ib-lbody [data-thread-id]').filter({ visible: true }).first()).toBeVisible();
  } finally {
    await narrow.close();
  }
});
