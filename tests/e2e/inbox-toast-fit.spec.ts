/**
 * Toasts with the longest real data (design record "inbox-toasts-break-fixes",
 * approved 2026-10-31): a 59-character project, an agent named with its
 * worktree id (47 characters), a 120-character thread name and a file with a
 * long name. Proved in a real browser against the compiled binary, with the
 * agents writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - at 320 and 390 (a touch phone) and 1440, the stopped Mark read, a row's
 *    Mark read naming its thread, Looks good and Draft saved take at most two
 *    lines; the ×, Undo and the Drafts chip are on screen; an agent's name is
 *    stored cut at 40 characters with "…" (the server's cap), and the live
 *    region says each toast's whole sentence;
 *  - on a phone a toast keeps above the thread's foot when a thread opens
 *    under it (Back, then another thread: break 01), and above a full-screen
 *    file's bar and name chip (break 02);
 *  - on a phone a detail that names an agent says what happened first and
 *    the name last ("Stopped · Claude Code (worktree …"), so its "…" only
 *    ever cuts the name; a desktop keeps its words;
 *  - a desktop toast is as tall as before: one line 40 px, two lines 54, a
 *    one-line error 44;
 *  - a touch tablet (768 wide, coarse pointer) gets the desktop toast with no
 *    key hint and 44 px targets for Undo and the × (break 14);
 *  - a narrow desktop window (the phone layout, a mouse) keeps Reply and
 *    Undo's Z, and its screen reader hears "Press Z to undo" (break 15);
 *  - error toasts at 320 and 1440: a batch that stopped partway leaves the
 *    project out (break 07), a long server error keeps to 4 lines on a phone
 *    and 3 on a desktop with what to do whole (break 12), and a fetch that
 *    never reached the Inbox says so in plain words, never "Failed to fetch"
 *    (break 13).
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-toast-fit.spec.ts`.
 * PNGs land in .local/proof/toast-fit/.
 */

import { expect, test, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'toast-fit');

const PROJECT = 'northwind-industries-holdings-billing-reconciliation-service';
const AGENT = 'Claude Code (worktree agent-a0316994da8440ab5)';
const AGENT_SHORT = 'Claude Code (worktree agent-a0316994da8…';
const SUBJECT = 'Fix flaky tests/e2e/inbox-attachment-stepping-save.spec.ts on WebKit after the Bun 1.4.4 upgrade (retry worker race)';
const FILE = 'Q3 Board Deck — FINAL (revised) v12 [approved by legal].md';
/** What a phone's Looks good says before the agent's name. */
const LOOKS_GOOD_NEWS = 'Read · Sends in 10 s';

const STOPPED = [
  'The retry worker races the save on WebKit. I attached the deck the board asked about.',
  '',
  ':::question',
  'Retry with the same idempotency key?',
  '',
  'Stopped: the worker cannot ship without this.',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

interface World {
  url: string;
  agents: SimAgent[];
  /** The stopped thread (the long name, the file), another with no question (Looks good), and one more. */
  threads: { stopped: string; merged: string; other: string };
  file: string;
  errors: string[];
}

let world: World;

const PHONE = (width: number, height: number): BrowserContextOptions => ({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const VIEWPORTS: { name: string; options: BrowserContextOptions; phone: boolean }[] = [
  { name: '320', options: PHONE(320, 640), phone: true },
  { name: '390', options: PHONE(390, 844), phone: true },
  { name: '1440', options: { viewport: { width: 1440, height: 900 } }, phone: false },
];

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 15_000 });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-toast-fit-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  rememberInboxOf(dataDir);
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim().split('\n').pop()!;
  const project = scratchProject(join(root, 'src'), PROJECT);
  writeFileSync(join(project, FILE), `# Q3 board deck\n\nThe numbers, revised.\n\n${'A paragraph of the deck. '.repeat(40)}\n`);
  const claude = await SimAgent.connect({ binary, env, name: AGENT, host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const other = await codex.send({ project_path: project, subject: 'Nightly build is green', body: 'The nightly build is green again.' });
  const merged = await claude.send({ project_path: project, subject: 'Merged the payouts table', thread: 'merged', body: 'Merged the payouts table. Nothing is waiting on you.' });
  const stopped = await claude.send({ project_path: project, subject: SUBJECT, thread: 'stopped', body: STOPPED, attachments: [FILE] });
  const res = await fetch(new URL(`/api/inbox/threads/${encodeURIComponent(stopped.thread_id as string)}/attachments`, url));
  const file = ((await res.json()) as { attachments?: { id: string }[] }).attachments?.[0]?.id ?? '';
  expect(file).not.toBe('');
  world = {
    url,
    agents: [claude, codex],
    threads: { stopped: stopped.thread_id as string, merged: merged.thread_id as string, other: other.thread_id as string },
    file,
    errors: [],
  };
});

test.afterAll(async () => {
  try {
    if (world) await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
  } finally {
    await removeInboxScratch();
  }
});

async function open(browser: Browser, options: BrowserContextOptions): Promise<Page> {
  const context = await browser.newContext({ ...options, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (error) => world.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') world.errors.push(message.text());
  });
  return page;
}

/** The toast's lines of text: its words' line boxes, by their distinct tops. */
async function lines(toast: Locator): Promise<number> {
  return toast.locator('.ib-tsay').evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const line = parseFloat(style.lineHeight) || 20;
    // The clamp hides lines past the second, so the box (not the line boxes, which run on unseen) is what shows.
    return Math.round((box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / line);
  });
}

/** `inner` lies within the window. */
async function onScreen(page: Page, inner: Locator): Promise<boolean> {
  const box = await inner.boundingBox();
  const view = page.viewportSize()!;
  return !!box && box.width > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width + 0.5 && box.y + box.height <= view.height + 0.5;
}

/** The toast fits: at most two lines, Undo (when it has one), its chip (when it has one) and the × on screen. */
async function expectFits(page: Page, toast: Locator, what: string) {
  await expect(toast).toBeVisible();
  await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
  expect(await lines(toast), `${what}: lines`).toBeLessThanOrEqual(2);
  for (const part of ['[data-toast-dismiss]', '[data-toast-undo]', '[data-toast-action]']) {
    if ((await toast.locator(part).count()) === 0) continue;
    expect(await onScreen(page, toast.locator(part)), `${what}: ${part} on screen`).toBe(true);
  }
  expect(await onScreen(page, toast), `${what}: the toast on screen`).toBe(true);
}

/** The boxes of `selector` that are drawn and that the toast overlaps (a toast that has gone says so, never a null error). */
async function overlapsToast(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const shown = document.querySelector('[data-inbox-toast]');
    if (!shown) return [`no toast on screen to check against ${selector}: it left (its 7 s ran out, or it was closed)`];
    const toast = shown.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => !el.closest('[data-inbox-toast]'))
      .map((el) => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0 && box.top < toast.bottom - 0.5 && box.bottom > toast.top + 0.5 && box.left < toast.right && box.right > toast.left)
      .map(({ el }) => el.className);
  }, selector);
}

/**
 * The first `news.length` characters of `detail` (its text starts with them) show whole: the "…" that cuts the line,
 * when it is cut, comes after them. 'shows', else what is wrong.
 */
async function newsShows(detail: Locator, news: string): Promise<string> {
  return detail.evaluate((el, news) => {
    const text = el.firstChild;
    if (!(text instanceof Text) || !text.data.startsWith(news)) return `the detail does not start with ${JSON.stringify(news)}: ${JSON.stringify(el.textContent)}`;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, news.length);
    const end = range.getBoundingClientRect().right;
    const context = document.createElement('canvas').getContext('2d')!;
    const style = getComputedStyle(el);
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const cut = el.scrollWidth > el.clientWidth + 1;
    const room = el.getBoundingClientRect().right - (cut ? context.measureText('…').width : 0);
    return end <= room + 0.5 ? 'shows' : `${JSON.stringify(news)} ends at ${end.toFixed(1)}, past ${room.toFixed(1)} where the line is cut`;
  }, news);
}

/** The toast's height in CSS pixels, once its entrance has ended. */
async function heightOf(toast: Locator): Promise<number> {
  return toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => Math.round(el.getBoundingClientRect().height * 2) / 2));
}

const pane = (page: Page) => page.locator('section.ib-pane');
const toastOf = (page: Page) => page.locator('[data-inbox-toast]');
const markRead = (page: Page, phone: boolean) => (phone ? pane(page).locator('.ib-phead .ib-hbtn') : page.locator('[data-mark-read]'));

async function openThread(page: Page, thread: string, heading: RegExp) {
  await page.goto(`${world.url}#thread=${thread}`);
  await expect(pane(page).getByRole('heading', { name: heading })).toBeVisible();
}

for (const vp of VIEWPORTS) {
  test(`${vp.name}: the longest toasts take at most two lines, with Undo, the chip and the × on screen`, async ({ browser }) => {
    const page = await open(browser, vp.options);
    try {
      // Mark read on the stopped thread: the warning names the agent, cut at 40 characters.
      await openThread(page, world.threads.stopped, /Fix flaky tests/);
      const read = markRead(page, vp.phone);
      await expect(read).toHaveAttribute('aria-pressed', 'false');
      await read.click();
      const toast = toastOf(page);
      // A phone: what happened first, the name last, so the "…" that cuts the line only ever cuts the name.
      await expect(toast.locator('.ib-tdetail')).toHaveText(vp.phone ? `Stopped · ${AGENT_SHORT}` : `${AGENT_SHORT} was stopped`);
      await expectFits(page, toast, 'stopped Mark read');
      if (vp.phone) expect(await newsShows(toast.locator('.ib-tdetail'), 'Stopped'), 'stopped Mark read: the news').toBe('shows');
      // The Inbox stored the name cut at 40 (the server's cap): the thread shows that, and the live region says the
      // whole sentence, whatever the toast's line cuts.
      await expect(page.locator('[data-inbox-live]')).toContainText(`Marked read. ${AGENT_SHORT} was stopped.`);
      await expect(pane(page)).toContainText(AGENT_SHORT);
      await expect(pane(page)).not.toContainText(AGENT);
      await page.screenshot({ path: join(proofDir, `${vp.name}-stopped-mark-read.png`) });
      if (vp.phone) {
        // Clear of the thread's foot (Reply).
        expect(await overlapsToast(page, 'section.ib-pane .ib-pfoot')).toEqual([]);
      }
      await toast.getByRole('button', { name: /Undo/ }).click();
      await expect(read).toHaveAttribute('aria-pressed', 'false');

      if (!vp.phone) {
        // A row's Mark read while another thread is open names the row's thread: its 120 characters held to two lines.
        await openThread(page, world.threads.merged, /Merged the payouts table/);
        const row = page.locator(`.ib-lbody [data-row="${world.threads.stopped}"]`);
        await row.hover();
        await row.locator('[data-row-mark-read]').click();
        await expect(toast.locator('.ib-tdetail')).toContainText('Fix flaky tests');
        await expectFits(page, toast, 'row Mark read');
        // Two lines are as tall as before (54 px).
        expect(await lines(toast), 'row Mark read: two lines').toBe(2);
        expect(await heightOf(toast), 'row Mark read: height').toBe(54);
        // Its words, cut, show whole in the window's component tooltip (never a native title).
        await expect(toast.locator('[title]')).toHaveCount(0);
        await toast.locator('.ib-tsay').hover();
        await expect(page.locator('[data-pn-tooltip]')).toContainText(SUBJECT);
        await page.screenshot({ path: join(proofDir, `${vp.name}-row-mark-read.png`) });
        await toast.getByRole('button', { name: /Undo/ }).click();
      }

      // Looks good: "Goes to <the agent, cut> in 10 s · Moves to Quiet".
      await openThread(page, world.threads.merged, /Merged the payouts table/);
      const ack = pane(page).locator('[data-ack]');
      await ack.click();
      // A phone puts the name last.
      await expect(toast.locator('.ib-tdetail')).toHaveText(vp.phone ? `${LOOKS_GOOD_NEWS} · ${AGENT_SHORT}` : `Goes to ${AGENT_SHORT} in 10 s · Moves to Quiet`);
      await expectFits(page, toast, 'Looks good');
      if (vp.phone) expect(await newsShows(toast.locator('.ib-tdetail'), LOOKS_GOOD_NEWS), 'Looks good: the news').toBe('shows');
      await expect(page.locator('[data-inbox-live]')).toContainText(`Goes to ${AGENT_SHORT} in 10 seconds and moves to Quiet.`);
      await page.screenshot({ path: join(proofDir, `${vp.name}-looks-good.png`) });
      await toast.getByRole('button', { name: /Undo/ }).click();
      await expect(ack).toHaveAttribute('aria-pressed', 'false');

      // Draft saved: the Drafts chip on screen beside the words.
      await page.goto(world.url);
      await page.locator('[data-open-compose]:visible').first().click();
      const dialog = page.locator('dialog[data-compose]');
      await dialog.locator('[data-compose-text] textarea').fill(`A draft for ${PROJECT}, kept from ${vp.name} px.`);
      // Closing asks to keep or discard (a phone's sheet has Cancel; a window, Escape).
      if (vp.phone) await dialog.locator('[data-compose-cancel]').click();
      else await page.keyboard.press('Escape');
      await dialog.locator('[data-compose-keep]').click();
      await expect(dialog).toHaveCount(0);
      await expect(toast).toContainText('Draft saved');
      await expectFits(page, toast, 'Draft saved');
      await expect(toast.locator('[data-toast-action]')).toHaveText('Drafts');
      // One line is as tall as before (40 px).
      if (!vp.phone) expect(await heightOf(toast), 'Draft saved: one line, height').toBe(40);
      await page.screenshot({ path: join(proofDir, `${vp.name}-draft-saved.png`) });
    } finally {
      await page.context().close();
    }
    expect(world.errors).toEqual([]);
  });
}

test('a phone: a toast raised in a thread keeps above the foot of the next thread opened under it (break 01)', async ({ browser }) => {
  const page = await open(browser, PHONE(390, 844));
  try {
    await openThread(page, world.threads.stopped, /Fix flaky tests/);
    const read = markRead(page, true);
    await read.click();
    const toast = toastOf(page);
    await expect(toast).toBeVisible();
    // Back to the list, then another thread, the toast still up.
    await pane(page).locator('.ib-pback').click();
    await expect(pane(page)).toHaveCount(0);
    await page.locator(`.ib-mrow[data-thread-id="${world.threads.other}"]`).click();
    await expect(pane(page).getByRole('heading', { name: /Nightly build is green/ })).toBeVisible();
    await expect(toast).toBeVisible();
    await expect.poll(() => overlapsToast(page, 'section.ib-pane .ib-pfoot')).toEqual([]);
    const [toastBox, footBox] = await Promise.all([toast.boundingBox(), pane(page).locator('.ib-pfoot').boundingBox()]);
    expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(footBox!.y);
    await page.screenshot({ path: join(proofDir, '390-toast-over-next-thread.png') });
    await toast.getByRole('button', { name: /Undo/ }).click();
  } finally {
    await page.context().close();
  }
  expect(world.errors).toEqual([]);
});

test('a phone: a toast keeps above a full-screen file\'s bar and its name chip (break 02)', async ({ browser }) => {
  const page = await open(browser, PHONE(320, 640));
  try {
    await openThread(page, world.threads.stopped, /Fix flaky tests/);
    await markRead(page, true).click();
    const toast = toastOf(page);
    await expect(toast).toBeVisible();
    // The file opens full screen while the toast is up.
    await page.evaluate(({ thread, file }) => {
      location.hash = `thread=${thread}&file=${file}&view=full`;
    }, { thread: world.threads.stopped, file: world.file });
    await expect(page.locator('.ib-fvdock-phone .ib-fvbar')).toBeVisible();
    await expect(toast).toBeVisible();
    await expect.poll(() => overlapsToast(page, '.ib-fvdock-phone .ib-fvbar, .ib-fvdock-phone .ib-fvhandle, .ib-view.ib-phone .ib-fvchip')).toEqual([]);
    await page.screenshot({ path: join(proofDir, '320-toast-over-file.png') });
    await toast.getByRole('button', { name: /Undo/ }).click();
    await expect(toast).toHaveCount(0);
  } finally {
    await page.context().close();
  }
  expect(world.errors).toEqual([]);
});

test('a touch tablet (768, coarse pointer): the desktop toast, no key hint, 44 px targets for Undo and the × (break 14)', async ({ browser }) => {
  const page = await open(browser, { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    await openThread(page, world.threads.stopped, /Fix flaky tests/);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse) and (hover: none)').matches)).toBe(true);
    const read = page.locator('[data-mark-read]');
    await expect(read).toHaveAttribute('aria-pressed', 'false');
    await read.click();
    const toast = toastOf(page);
    await expectFits(page, toast, 'tablet Mark read');
    await expect(toast).not.toHaveClass(/ib-toast-phone/);
    // Undo's Z hint is not drawn (a tablet's keyboard may be away); Z still undoes.
    await expect(toast.locator('.ib-tundo kbd')).toBeHidden();
    const target = (selector: string) =>
      toast.locator(selector).evaluate((el) => {
        const box = el.getBoundingClientRect();
        const after = getComputedStyle(el, '::after');
        return Math.min(box.height - parseFloat(after.top) - parseFloat(after.bottom), box.width - parseFloat(after.left) - parseFloat(after.right));
      });
    expect(await target('[data-toast-undo]')).toBeGreaterThanOrEqual(44);
    expect(await target('[data-toast-dismiss]')).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: join(proofDir, '768-touch-tablet.png') });
    await toast.getByRole('button', { name: /Undo/ }).click();
  } finally {
    await page.context().close();
  }
  expect(world.errors).toEqual([]);
});

test('a narrow desktop window (the phone layout, a mouse and keys) keeps Reply and Undo\'s Z, and says "Press Z to undo" (break 15)', async ({ browser }) => {
  const page = await open(browser, { viewport: { width: 600, height: 800 } });
  try {
    await openThread(page, world.threads.stopped, /Fix flaky tests/);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse) and (hover: none)').matches)).toBe(false);
    const read = markRead(page, true);
    await expect(read).toHaveAttribute('aria-pressed', 'false');
    await read.click();
    const toast = toastOf(page);
    await expectFits(page, toast, 'narrow window Mark read');
    await expect(toast).toHaveClass(/ib-toast-phone/);
    await expect(toast.locator('[data-toast-reply]')).toBeVisible();
    await expect(toast.locator('.ib-tundo kbd')).toBeVisible();
    await expect(toast.locator('[data-toast-undo]')).toHaveAttribute('aria-keyshortcuts', 'Z');
    await expect(page.locator('[data-inbox-live]')).toContainText('Press Z to undo.');
    await page.screenshot({ path: join(proofDir, '600-narrow-window.png') });
    // Z undoes, as the hint says.
    await page.keyboard.press('z');
    await expect(read).toHaveAttribute('aria-pressed', 'false');
    await expect(toast).toHaveCount(0);
  } finally {
    await page.context().close();
  }
  expect(world.errors).toEqual([]);
});

/** A server error of 151 characters: what happened, then what to do (its last sentence). */
const LONG_ERROR = 'Another window changed this thread while you were marking it read, so nothing was written to it and the list now shows its current state. Try it again.';
const LONG_ERROR_ACTION = 'Try it again.';
const READ_ROUTE = '**/api/inbox/threads/*/read';

/** Whether `action`'s words all show inside the toast's words (none past a line clamp or the edge): 'whole', else how not. */
async function actionWhole(toast: Locator, action: string): Promise<string> {
  return toast.evaluate((el, action) => {
    const say = el.querySelector('.ib-tsay')!.getBoundingClientRect();
    const node = el.querySelector('.ib-taction') ?? el.querySelector('.ib-tlead')!;
    const text = [...node.childNodes].find((n) => n instanceof Text && n.data.includes(action)) as Text | undefined;
    if (!text) return `no text holds ${JSON.stringify(action)}`;
    const range = document.createRange();
    range.setStart(text, text.data.indexOf(action));
    range.setEnd(text, text.data.indexOf(action) + action.length);
    const rects = [...range.getClientRects()];
    const cut = rects.some((r) => r.bottom > say.bottom + 0.5 || r.right > say.right + 0.5) || node.scrollHeight > node.clientHeight + 1;
    return cut ? `cut: its lines at ${JSON.stringify(rects.map((r) => [r.top, r.bottom]))}, the words end at ${say.bottom}` : 'whole';
  }, action);
}

for (const vp of [VIEWPORTS[0]!, VIEWPORTS[2]!]) {
  test(`${vp.name}: error toasts: plain words when the Inbox did not answer (13), a long error keeps what to do (12), no project in a stopped batch (07)`, async ({ browser }) => {
    const page = await open(browser, vp.options);
    const most = vp.phone ? 4 : 3;
    try {
      const toast = toastOf(page);
      const settled = () => toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
      // 13: Mark read never reaches the Inbox.
      // The stopped thread: Mark read is offered on it (a refused or unreached write changes nothing).
      await openThread(page, world.threads.stopped, /Fix flaky tests/);
      await page.route(READ_ROUTE, (route) => route.abort('failed'));
      await markRead(page, vp.phone).click();
      await expect(toast).toContainText('The Inbox did not answer. Try again in a moment.');
      await expect(toast).not.toContainText(/failed to fetch/i);
      await expect(toast).toHaveClass(/ib-toast-warn/);
      await settled();
      expect(await lines(toast), '13: lines').toBeLessThanOrEqual(most);
      // A one-line error with its × is as tall as before (44 px).
      if (!vp.phone) expect(await heightOf(toast), '13: one-line error, height').toBe(44);
      await page.screenshot({ path: join(proofDir, `${vp.name}-error-unreachable.png`) });
      await page.unroute(READ_ROUTE);
      await toast.locator('[data-toast-dismiss]').click();
      await expect(toast).toHaveCount(0);

      // 12: the Inbox answers with a long sentence: held to its most lines, what to do whole and on screen.
      expect(LONG_ERROR.length).toBe(151);
      await page.route(READ_ROUTE, (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: LONG_ERROR, code: 'conflict' }) }));
      await markRead(page, vp.phone).click();
      await expect(toast).toContainText(LONG_ERROR_ACTION);
      await settled();
      expect(await lines(toast), '12: lines').toBeLessThanOrEqual(most);
      expect(await onScreen(page, toast), '12: the toast on screen').toBe(true);
      expect(await actionWhole(toast, LONG_ERROR_ACTION), '12: what to do').toBe('whole');
      await page.screenshot({ path: join(proofDir, `${vp.name}-error-long.png`) });
      await page.unroute(READ_ROUTE);
      await toast.locator('[data-toast-dismiss]').click();
      await expect(toast).toHaveCount(0);

      // 07: the project's Mark all as read stops partway (the server's answer, as it words it): the warning, never the project's name.
      await page.goto(world.url);
      await page.route('**/api/inbox/projects/*/read', async (route) => {
        const answer = (await (await route.fetch()).json()) as Record<string, unknown>;
        await route.fulfill({ json: { ...answer, error: { code: 'batch_incomplete', message: 'Stopped partway; the other threads did not change.' } } });
      });
      const project = page.locator('.ib-projrow', { has: page.locator('.ib-name', { hasText: new RegExp(`^${PROJECT}$`) }) });
      if (vp.phone) {
        await page.locator('[data-sidebar="trigger"]').first().tap();
        await project.locator('.ib-pmore').tap();
        await page.locator('[data-project-action="read"]').tap();
      } else {
        await project.locator('.ib-proj').click({ button: 'right' });
        await page.locator('[data-project-action="read"]').click();
      }
      await expect(toast).toContainText('Stopped partway; the other threads did not change.');
      await expect(toast).not.toContainText(PROJECT);
      // The live region still names it.
      await expect(page.locator('[data-inbox-live]')).toContainText(PROJECT);
      await settled();
      expect(await lines(toast), '07: lines').toBeLessThanOrEqual(most);
      expect(await onScreen(page, toast.locator('[data-toast-undo]')), '07: Undo on screen').toBe(true);
      await page.screenshot({ path: join(proofDir, `${vp.name}-error-batch.png`) });
      await page.unroute('**/api/inbox/projects/*/read');
      await toast.getByRole('button', { name: /Undo/ }).click();
      await expect(toast).toHaveCount(0);
    } finally {
      await page.context().close();
    }
    // The browser logs the aborted and refused requests themselves; nothing else may go wrong.
    expect(world.errors.filter((error) => !/Failed to load resource/.test(error))).toEqual([]);
    world.errors = [];
  });
}
