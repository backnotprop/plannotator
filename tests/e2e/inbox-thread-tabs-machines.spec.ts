/**
 * Thread tabs across linked machines (issue #4027), proved in a real browser against two compiled Inboxes on
 * loopback, linked through the real CLI pairing. Studio is the window's (Thread tabs is on there); MacBook owns the
 * thread. A thread MacBook owns, opened as a thread tab on Studio, works as one of Studio's own:
 *
 *  1. The thread-only view, the thread's name as the title and an icon of its own.
 *  2. Studio's main tab marks the row and leaves the thread out of its tab count (and counts it again when asked).
 *  3. ⌘/Ctrl-click on the far row opens its thread tab.
 *  4. `plannotator inbox --open` on Studio: a thread of Studio's own with a tab goes to that tab, one without to the
 *     main tab. The command asks the machine the window is on, which knows only its own threads, so a MacBook thread
 *     is `--open`ed on MacBook (where no window is open: it says so and opens none).
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bun run test:sandbox tests/e2e/inbox-thread-tabs-machines.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const CLOSED = 'http://127.0.0.1:9';
const MOD = 'ControlOrMeta';
const EXPIRY_MS = 25_000;

interface Machine {
  name: string;
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
}

let studio: Machine;
let macbook: Machine;
let context: BrowserContext;
let main: Page;
let tabFar: Page;
let tabOwn: Page;
const agents: SimAgent[] = [];
let far = '';
let own = '';
let other = '';
const FAR_NAME = 'Refund webhook retries on the MacBook';
const OWN_NAME = 'Dark mode tokens are in';
const OTHER_NAME = 'Statements export is slow';

function machine(name: string): Machine {
  const root = inboxScratch(`plannotator-thread-tabs-${name.toLowerCase()}-`);
  const path = join(root, 'bin');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(path, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  return {
    name,
    root,
    dataDir,
    url: '',
    env: {
      PATH: `${path}:/usr/bin:/bin`,
      HOME: root,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_TEST_SANDBOX: root,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_MACHINE_NAME: name,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_INBOX_NOTES: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      NO_ANON_PING: '1',
      PLANNOTATOR_RELAY_URL: CLOSED,
      PLANNOTATOR_UPDATE_API_URL: `${CLOSED}/releases/latest`,
      PLANNOTATOR_INSTALL_SCRIPT_URL: `${CLOSED}/install.sh`,
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: `${CLOSED}/download`,
      PLANNOTATOR_FEEDBACK_URL: `${CLOSED}/feedback`,
    },
  };
}

const cli = (m: Machine, ...args: string[]) => {
  const run = spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;

function start(m: Machine): void {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
}

function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

async function send(m: Machine, subject: string, body = subject): Promise<string> {
  const agent = await SimAgent.connect({ binary, env: m.env, name: 'Claude Code', host: 'claude-code', cwd: m.root });
  agents.push(agent);
  const sent = await agent.send({ project_path: scratchProject(join(m.root, 'code'), 'billing-svc'), subject, body });
  return sent.thread_id as string;
}

async function studioPost(path: string, body: unknown): Promise<void> {
  const response = await fetch(new URL(path, studio.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.ok, `${path}: ${response.status}`).toBe(true);
}
const threadTabs = (on: boolean, countAnchored = false) => studioPost('/api/inbox/settings', { thread_tabs: { on, count_anchored: countAnchored } });

const row = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
const mark = (page: Page, id: string) => row(page, id).locator('[data-anchored-mark]');
const pane = (page: Page) => page.locator('section.ib-pane');
const hashOf = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1));
const threadIn = (page: Page) => hashOf(page).get('thread');
const aloneIn = (page: Page) => hashOf(page).has('alone');
const faviconOf = (page: Page) => page.evaluate(() => document.head.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '');
const hashUrl = (thread: string) => `${studio.url.replace(/\/$/, '')}/#thread=${thread}&alone`;
const useTab = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  studio = machine('Studio');
  macbook = machine('MacBook');
  start(studio);
  start(macbook);
  link(studio, macbook);
  far = await send(macbook, FAR_NAME, 'The retry is in. See the webhook handler.');
  own = await send(studio, OWN_NAME, 'Swapped the hard-coded greys for tokens.');
  other = await send(studio, OTHER_NAME, 'The statements export takes a minute on big accounts.');
  await threadTabs(true);
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  // A thread tab is a background tab: the news in its thread stays unseen.
  await context.addInitScript(() => {
    if (!location.hash.includes('alone')) return;
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Document.prototype.hasFocus = () => false;
  });
  main = await context.newPage();
  await main.goto(studio.url);
  await expect(row(main, far)).toBeVisible();
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('1. a thread MacBook owns, opened as a thread tab on Studio: the thread only, its name as the title, an icon of its own', async () => {
  const plain = await faviconOf(main);
  tabFar = await context.newPage();
  await tabFar.goto(hashUrl(far));
  await expect(pane(tabFar)).toContainText('The retry is in');
  await expect(tabFar.locator('.ib-lbody')).toBeHidden();
  await expect(tabFar).toHaveTitle(FAR_NAME);
  await expect.poll(() => faviconOf(tabFar)).toMatch(/^data:/);
  expect(await faviconOf(tabFar)).not.toBe(plain);
  await expect(tabFar.getByRole('button', { name: 'Show full Inbox' })).toBeVisible();
});

test('2. Studio\'s main tab marks the MacBook thread, and leaves it out of its count unless asked', async () => {
  await expect(mark(main, far)).toHaveAttribute('title', 'Open in its own tab');
  await expect(mark(main, own)).toHaveCount(0);
  // News arrives on the MacBook thread while its tab is in the background: its tab has it, the main tab's count does not.
  const agent = agents[0]!;
  await agent.send({ project_path: scratchProject(join(macbook.root, 'code'), 'billing-svc'), reply_to: far, body: 'Retries now back off, one more look?' });
  await expect(pane(tabFar)).toContainText('Retries now back off');
  // Studio's own two threads are unseen too: the count is theirs alone.
  await expect(main).toHaveTitle(/^\(2\) /);
  await threadTabs(true, true);
  await expect(main).toHaveTitle(/^\(3\) /);
  await threadTabs(true, false);
  await expect(main).toHaveTitle(/^\(2\) /);
});

test('3. ⌘/Ctrl-click on a row of Studio\'s own opens its thread tab, and a plain click on one that has a tab does not navigate', async () => {
  const [popup] = await Promise.all([main.waitForEvent('popup'), row(main, own).click({ modifiers: [MOD] })]);
  tabOwn = popup;
  await tabOwn.waitForURL(/thread=.*alone/);
  expect(threadIn(tabOwn)).toBe(own);
  await expect(pane(tabOwn)).toContainText('Swapped the hard-coded greys');
  await expect(mark(main, own)).toBeVisible();

  // The far thread's tab came from elsewhere: a plain click says it is open in another tab and the main tab stays.
  await row(main, far).click();
  await expect(main.locator('[data-anchored-banner]')).toContainText('This thread is open in another tab');
  await main.waitForTimeout(300);
  expect(threadIn(main)).toBeNull();
  await main.locator('[data-anchored-banner]').getByRole('button', { name: 'Dismiss' }).click();
});

test('4. --open on Studio: a thread of its own with a tab goes to that tab, another to the main tab; a MacBook thread is not Studio\'s to show', async () => {
  await main.evaluate((id) => (window.location.hash = `#thread=${id}`), other);
  await expect(pane(main)).toContainText('The statements export takes a minute');
  await useTab(tabOwn);
  await useTab(main);

  const run = cli(studio, '--open', own);
  expect(run.status, run.err).toBe(0);
  await main.waitForTimeout(800);
  expect(threadIn(main)).toBe(other);
  expect(threadIn(tabOwn)).toBe(own);
  expect(aloneIn(tabOwn)).toBe(true);

  // A thread of Studio's with no tab: the main tab, though the tab with a thread was used last.
  const third = await send(studio, 'Tax rounding fixed');
  await useTab(tabOwn);
  expect(cli(studio, '--open', third).status).toBe(0);
  await expect.poll(() => threadIn(main)).toBe(third);
  expect(aloneIn(main)).toBe(false);
  expect(threadIn(tabOwn)).toBe(own);

  // The MacBook's thread: Studio does not hold it, so there is nothing for Studio's windows to show; the windows are untouched.
  const far_ = cli(studio, '--open', far);
  expect(far_.status).not.toBe(0);
  expect(far_.err + far_.out).toMatch(/No thread|thread_unknown|not in this Inbox/i);
  await main.waitForTimeout(500);
  expect(threadIn(main)).toBe(third);
  expect(threadIn(tabFar)).toBe(far);
  expect(aloneIn(tabFar)).toBe(true);

  // The far thread's tab closes: its mark goes.
  await tabFar.close();
  await expect(mark(main, far)).toHaveCount(0, { timeout: EXPIRY_MS });
});
