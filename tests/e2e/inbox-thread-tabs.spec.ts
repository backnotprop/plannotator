/**
 * Thread tabs (issue #4027; Settings → Capabilities, off by default), proved in a real browser against the compiled
 * binary. Nothing is mocked: `plannotator inbox --background` runs under scratch folders, agents write through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts), the capability is turned on through the settings API, and the
 * tabs are pages of one Chromium context, so they share the BroadcastChannel the Inbox's tabs talk over.
 *
 * A thread tab is the Inbox at `#thread=<id>&alone`: the thread only (no list), titled with the thread's name,
 * with an icon of its own, and a way back to the full Inbox. The main tab marks the threads that have one, leaves
 * them out of its tab count (unless the sub-option puts them back), opens one on ⌘/Ctrl-click of a row (the same
 * named window each time), and never navigates silently onto a thread that is open in its own tab. A plain click
 * on a link to another thread in a thread tab opens it in the main tab. `plannotator inbox --open <thread>` goes
 * to the thread's own tab, any other thread to a main tab, whichever was used last.
 *
 * Headless pages cannot be told apart as "in front", so the init script below makes every thread tab a background
 * tab (hidden, no focus): its thread stays unseen, which is what the count tests need. Only the focus() call the
 * main tab makes on a thread tab it opened is observable here (a stand-in for `window.focus`), not the window
 * coming to the front.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:sandbox tests/e2e/inbox-thread-tabs.spec.ts`.
 * The linked-machines case is tests/e2e/inbox-thread-tabs-machines.spec.ts.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, scratchEnv } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
/** A thread tab drops out of the main tab's marks within this (its goodbye on close, else its heartbeat's expiry). */
const EXPIRY_MS = 25_000;
const MOD = 'ControlOrMeta';

interface World {
  env: Record<string, string>;
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  threads: { a: string; b: string; c: string; d: string };
  names: { a: string; b: string; c: string; d: string };
}

let world: World;
/** The main tab, and the thread tabs the tests keep: A opened by `newPage` (nothing kept), B by ⌘-click (its window kept). */
let main: Page;
let tabA: Page;
let tabB: Page;

const row = (page: Page, thread: string) => page.locator(`.ib-lbody [data-thread-id="${thread}"]`);
const mark = (page: Page, thread: string) => row(page, thread).locator('[data-anchored-mark]');
const pane = (page: Page) => page.locator('section.ib-pane');
const hashOf = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1));
const threadIn = (page: Page) => hashOf(page).get('thread');
const aloneIn = (page: Page) => hashOf(page).has('alone');
const faviconOf = (page: Page) => page.evaluate(() => document.head.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '');
const hashUrl = (thread: string, alone = true) => `${world.url.replace(/\/$/, '')}/#thread=${thread}${alone ? '&alone' : ''}`;

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, world.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.ok, `${path}: ${response.status}`).toBe(true);
  return response.json();
}
const threadTabs = (on: boolean, countAnchored = false) => post('/api/inbox/settings', { thread_tabs: { on, count_anchored: countAnchored } });
const makeUnseen = async (...ids: string[]) => {
  for (const id of ids) await post(`/api/inbox/threads/${id}/mark-unread`, {});
};

/** What a widget runs: `plannotator inbox --open <thread>`; the command prints the address and opens no tab. */
function openThread(thread: string): string {
  const run = spawnSync(binary, ['inbox', '--open', thread], { env: world.env, encoding: 'utf8', timeout: 30_000 });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trim();
}

/** The person comes back to this tab (the browser's own focus, which headless pages do not get by themselves). */
const useTab = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

/** The tab's own window.focus() calls from now on are counted: the main tab calls it on a thread tab it opened. */
async function countFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __focused: number };
    w.__focused = 0;
    window.focus = () => void w.__focused++;
  });
}
const focused = (page: Page) => page.evaluate(() => (window as unknown as { __focused: number }).__focused);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-thread-tabs-e2e-');
  const env = { ...scratchEnv(root), PATH: process.env.PATH ?? '', PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_TEST_SANDBOX: '1' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(env.PLANNOTATOR_DATA_DIR);
  const url = started.stdout.trim();
  const origin = new URL(url).origin;
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const names = { a: 'The invoice list is built', b: 'Refunds now post to the ledger', c: 'Tax rounding fixed', d: 'Statements export is slow' };
  const c = await codex.send({ project_path: billing, subject: names.c, body: 'Tax now rounds per line, not per invoice.' });
  // A's message links the Inbox's thread C: the click that moves another tab.
  const a = await claude.send({ project_path: billing, subject: names.a, body: `The invoice list is built as cards. The rounding is in [the tax thread](${origin}/#thread=${c.thread_id}).` });
  const b = await codex.send({ project_path: billing, subject: names.b, body: 'Refunds post to the ledger the moment they are approved.' });
  const d = await claude.send({ project_path: billing, subject: names.d, body: 'The statements export takes a minute on big accounts.' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  // A thread tab is a background tab: its thread is not seen on sight, so the counts have something to leave out.
  await context.addInitScript(() => {
    if (!location.hash.includes('alone')) return;
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Document.prototype.hasFocus = () => false;
  });
  world = { env, url, agents: [claude, codex], context, threads: { a: a.thread_id, b: b.thread_id, c: c.thread_id, d: d.thread_id }, names };
  main = await context.newPage();
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.agents.map((agent) => agent.close().catch(() => {})));
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('capability off: #thread=…&alone is the normal full Inbox and ⌘-click on a row is still the Inbox\'s own (it picks the row)', async () => {
  const { threads } = world;
  await main.goto(`${hashUrl(threads.a)}`);
  await expect(row(main, threads.a)).toBeVisible();
  await expect(pane(main)).toContainText('The invoice list is built as cards');
  // The list is there, there is no way "back to the full Inbox", the title is the Inbox's own.
  await expect(main.locator('[data-full-back]')).toHaveCount(0);
  await expect(main).not.toHaveTitle(world.names.a);

  await main.goto(world.url);
  await expect(row(main, threads.b)).toBeVisible();
  const opened: string[] = [];
  main.context().on('page', (page) => void opened.push(page.url()));
  await row(main, threads.b).click({ modifiers: [MOD] });
  // The Inbox's own ⌘-click: the row is picked (multi-select), no thread opens, no page of its own, nothing is marked.
  await expect(row(main, threads.b)).toHaveAttribute('aria-pressed', 'true');
  await main.waitForTimeout(500);
  expect(threadIn(main)).toBeNull();
  expect(opened).toEqual([]);
  expect(world.context.pages()).toHaveLength(1);
  await expect(main.locator('[data-anchored-mark]')).toHaveCount(0);
  await main.getByRole('button', { name: 'Done' }).click();
  main.context().removeAllListeners('page');
});

test('1. a thread tab: the thread only, its name as the title, an icon of its own, and "Show full Inbox" back', async () => {
  const { threads, names } = world;
  await threadTabs(true);
  await main.goto(world.url);
  const plain = await faviconOf(main);
  expect(plain).not.toMatch(/^data:/);

  const solo = await world.context.newPage();
  await solo.goto(hashUrl(threads.a));
  await expect(pane(solo)).toContainText('The invoice list is built as cards');
  // Thread only: no list, no sidebar of rows.
  await expect(solo.locator('.ib-lbody')).toBeHidden();
  await expect(solo).toHaveTitle(names.a);
  await expect.poll(() => faviconOf(solo)).toMatch(/^data:/);
  const threadIcon = await faviconOf(solo);
  expect(threadIcon).not.toBe(plain);

  await solo.getByRole('button', { name: 'Show full Inbox' }).click();
  await expect(row(solo, threads.b)).toBeVisible();
  expect(threadIn(solo)).toBe(threads.a);
  expect(aloneIn(solo)).toBe(false);
  await expect(solo).not.toHaveTitle(names.a);
  // The Inbox's own icon is back (drawn with the count when news is waiting), not the thread's.
  await expect.poll(() => faviconOf(solo)).not.toBe(threadIcon);
  await solo.close();
});

test('2. the main tab marks a thread that has a tab, counts without it unless asked, and forgets it when the tab closes', async () => {
  const { threads } = world;
  await makeUnseen(threads.a, threads.b, threads.c, threads.d);
  await main.goto(world.url);
  await expect(row(main, threads.a)).toBeVisible();
  await expect(main).toHaveTitle(/^\(4\) /);
  await expect(main.locator('[data-anchored-mark]')).toHaveCount(0);

  tabA = await world.context.newPage();
  await tabA.goto(hashUrl(threads.a));
  await expect(pane(tabA)).toContainText('The invoice list is built as cards');
  await expect(mark(main, threads.a)).toHaveAttribute('title', 'Open in its own tab');
  await expect(mark(main, threads.a)).toHaveAccessibleName('Open in its own tab');
  await expect(main.locator('[data-anchored-mark]')).toHaveCount(1);
  // News in A's tab (in the background, so unseen) is not news in the main tab: the count leaves it out.
  await makeUnseen(threads.a);
  await expect(main).toHaveTitle(/^\(3\) /);
  // The sub-option puts it back, and takes it out again.
  await threadTabs(true, true);
  await expect(main).toHaveTitle(/^\(4\) /);
  await threadTabs(true, false);
  await expect(main).toHaveTitle(/^\(3\) /);

  // Closing a thread tab drops its mark and its place out of the count's leaving-out.
  const temp = await world.context.newPage();
  await temp.goto(hashUrl(threads.d));
  await expect(mark(main, threads.d)).toBeVisible();
  await expect(main).toHaveTitle(/^\(2\) /);
  await temp.close();
  await expect(mark(main, threads.d)).toHaveCount(0, { timeout: EXPIRY_MS });
  await expect(main).toHaveTitle(/^\(3\) /);
  await expect(mark(main, threads.a)).toBeVisible();
});

test('3. ⌘/Ctrl-click on a row opens its thread tab in a named window; a second click reuses it', async () => {
  const { threads } = world;
  const before = world.context.pages().length;
  const [popup] = await Promise.all([main.waitForEvent('popup'), row(main, threads.b).click({ modifiers: [MOD] })]);
  tabB = popup;
  await tabB.waitForURL(/thread=.*alone/);
  expect(threadIn(tabB)).toBe(threads.b);
  expect(aloneIn(tabB)).toBe(true);
  await expect(pane(tabB)).toContainText('Refunds post to the ledger');
  await expect(tabB.locator('.ib-lbody')).toBeHidden();
  // The main tab did not navigate.
  expect(threadIn(main)).toBeNull();
  await expect(mark(main, threads.b)).toBeVisible();
  expect(world.context.pages()).toHaveLength(before + 1);

  await row(main, threads.b).click({ modifiers: [MOD] });
  await main.waitForTimeout(800);
  expect(world.context.pages()).toHaveLength(before + 1);
  expect(threadIn(tabB)).toBe(threads.b);
  expect(threadIn(main)).toBeNull();
});

test('4. a plain click on a thread that has a tab never navigates the main tab: it focuses the tab it opened, or says it is open elsewhere', async () => {
  const { threads } = world;
  await countFocus(tabB);
  // B's tab was opened by this tab: it takes the focus, with no banner.
  await row(main, threads.b).click();
  await expect.poll(() => focused(tabB)).toBeGreaterThan(0);
  expect(threadIn(main)).toBeNull();
  await expect(main.locator('[data-anchored-banner]')).toHaveCount(0);

  // A's tab came from elsewhere (nothing here can reach it): the banner, and the main tab stays.
  await row(main, threads.a).click();
  const banner = main.locator('[data-anchored-banner]');
  await expect(banner).toContainText('This thread is open in another tab');
  await main.waitForTimeout(300);
  expect(threadIn(main)).toBeNull();
  // The person may still open it here.
  await banner.getByRole('button', { name: 'Open here anyway' }).click();
  await expect.poll(() => threadIn(main)).toBe(threads.a);
  expect(aloneIn(main)).toBe(false);
  await expect(banner).toHaveCount(0);
  // The thread tab stays where it is.
  expect(threadIn(tabA)).toBe(threads.a);
  expect(aloneIn(tabA)).toBe(true);
  // Park the main tab on a thread that has no tab.
  await main.evaluate((id) => (window.location.hash = `#thread=${id}`), threads.d);
  await expect(pane(main)).toContainText('The statements export takes a minute');
});

test('5. in a thread tab a plain click on a link to another thread leaves the tab where it is and moves the main tab', async () => {
  const { threads } = world;
  await useTab(main);
  const pages = world.context.pages().length;
  await tabA.locator('section.ib-pane a', { hasText: 'the tax thread' }).click();
  await expect.poll(() => threadIn(main)).toBe(threads.c);
  expect(aloneIn(main)).toBe(false);
  await expect(pane(main)).toContainText('Tax now rounds per line');
  // The thread tab stayed on A, and no tab was opened.
  await tabA.waitForTimeout(500);
  expect(threadIn(tabA)).toBe(threads.a);
  expect(aloneIn(tabA)).toBe(true);
  expect(world.context.pages()).toHaveLength(pages);
});

test('6. plannotator inbox --open: a thread with its own tab goes to that tab, any other thread to the main tab, whichever was used last', async () => {
  const { threads } = world;
  await main.evaluate((id) => (window.location.hash = `#thread=${id}`), threads.d);
  await expect(pane(main)).toContainText('The statements export takes a minute');

  // The main tab was used last; A's tab is still the one that shows A.
  await useTab(tabA);
  await useTab(main);
  expect(openThread(threads.a)).toBe(`${world.url.replace(/\/$/, '')}/#thread=${threads.a}`);
  await main.waitForTimeout(800);
  expect(threadIn(main)).toBe(threads.d);
  expect(threadIn(tabA)).toBe(threads.a);
  expect(aloneIn(tabA)).toBe(true);

  // A's tab was used last; C has no tab, so the main tab moves and A's tab does not.
  await useTab(tabA);
  openThread(threads.c);
  await expect.poll(() => threadIn(main)).toBe(threads.c);
  expect(aloneIn(main)).toBe(false);
  expect(threadIn(tabA)).toBe(threads.a);
  expect(aloneIn(tabA)).toBe(true);
  expect(threadIn(tabB)).toBe(threads.b);

  // A's tab closes: the thread has no tab left to go to, and the main tab takes it.
  await tabA.close();
  await expect(mark(main, threads.a)).toHaveCount(0, { timeout: EXPIRY_MS });
  await useTab(main);
  await expect
    .poll(
      () => {
        openThread(threads.a);
        return threadIn(main);
      },
      { timeout: EXPIRY_MS + 10_000, intervals: [1_000] },
    )
    .toBe(threads.a);
  expect(aloneIn(main)).toBe(false);
  await expect(mark(main, threads.b)).toBeVisible();
});

test('7. capability off again: a thread tab shows the full Inbox, marks go, and ⌘-click is a pick again', async () => {
  const { threads } = world;
  await tabB.close();
  await threadTabs(false);
  await makeUnseen(threads.a, threads.b, threads.c, threads.d);
  await main.goto(world.url);
  await expect(row(main, threads.b)).toBeVisible();
  await expect(main.locator('[data-anchored-mark]')).toHaveCount(0);

  const off = await world.context.newPage();
  await off.goto(hashUrl(threads.b));
  await expect(row(off, threads.a)).toBeVisible();
  await expect(off.locator('[data-full-back]')).toHaveCount(0);
  await expect(pane(off)).toContainText('Refunds post to the ledger');
  await off.close();

  const pages = world.context.pages().length;
  await row(main, threads.c).click({ modifiers: [MOD] });
  await expect(row(main, threads.c)).toHaveAttribute('aria-pressed', 'true');
  await main.waitForTimeout(500);
  expect(threadIn(main)).toBeNull();
  expect(world.context.pages()).toHaveLength(pages);
});
