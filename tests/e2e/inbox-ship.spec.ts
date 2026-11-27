/**
 * Ship in Reviews (approval "inbox-ship-mode", look "Glint"), in a real browser against the compiled binary under a
 * temp PLANNOTATOR_DATA_DIR and HOME. The Reviews list, the PR board, the live sessions (the fake agents: Claude Code,
 * Codex and Pi in fern-api) and the ship routes are answered by the spec, so no forge and no agent is reached; `gh` and
 * `glab` are fakes first on PATH that answer nothing, so the real CLIs never run. The watch itself (what it reads and
 * whom it wakes) is proved by packages/server/inbox-ship-watch.test.ts; this proves what only a browser shows.
 *
 *  1. The row's menu: Ship first, with the agent already on the review at its end (01-menu).
 *  2. Ship's submenu: the agents that can take it, that agent ticked (02-choose-agent).
 *  3. One click on Ship: POST ships in the review's thread to that agent; the row turns to water and the sail, and the
 *     row's box and line keep their place (03-ship-mode).
 *  4. Stuck: the words on the row, in sand (04-stuck).
 *  5. The ship log from the row's menu: newest first, Stop (05-ship-log); Stop sends POST ships/stop.
 *  6. Merged: the words take the row's end, no water (06-merged).
 *  7. A phone: the rows in ship mode at 390 (07-phone).
 *  8. Another computer ("Mac mini", linked): its agents under its name in Ship's list (08-other-computer); a click
 *     ships there, in a new thread on that computer (its forwarded routes, answered by the spec), and the row and its
 *     log show that ship, with Stop sent there (09-ship-log-there).
 *  9. The review thread's own view: its ⋯ menu leads with Ship log and Stop shipping, and the log opens by it
 *     (10-thread-menu, 11-thread-ship-log). The thread is a real one, sent by a simulated agent.
 * 10. Dark theme and reduced motion, not shown in the approval: shipping and stuck rows, the log (12-dark,
 *     13-dark-ship-log, 14-reduced-motion).
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/ship.
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'ship');

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
type Fields = Record<string, unknown>;

function pull(number: number, title: string, fields: Fields = {}) {
  const fullRepo = 'harbor/fern-api';
  return {
    key: `github.com/${fullRepo}#${number}`,
    platform: 'github',
    host: 'github.com',
    repo: fullRepo,
    number,
    url: `https://github.com/${fullRepo}/pull/${number}`,
    title,
    author: 'charlie-dunn',
    mine: true,
    requested: false,
    state: 'open',
    base: 'main',
    head: `branch-${number}`,
    head_repo: fullRepo,
    head_sha: String(number).padStart(40, 'a'),
    additions: 12,
    deletions: 3,
    files: 2,
    review: 'review_required',
    approved_by: null,
    reviewers: ['ada-novak'],
    checks: 'success',
    conflicts: false,
    updated_at: ago(19 * 60_000),
    merged_at: null,
    ...fields,
  };
}

const RECEIPT = pull(614, 'Send a receipt after checkout');
const RETRY = pull(611, 'Retry failed charges twice', { checks: 'failure' });
const EXPORT = pull(612, 'Rate-limit the export endpoint');
const PULLS = [RECEIPT, RETRY, EXPORT];
const PROJECTS = { 'github.com/harbor/fern-api': ['prj_fern'] };

function stackOf(p: ReturnType<typeof pull>) {
  return { id: p.key, platform: 'github', host: 'github.com', repo: p.repo, layers: [p], parents: { [p.key]: null }, base: p.base, open_base: p.base };
}

function row(thread: string, p: ReturnType<typeof pull>, session: string, host: string, name: string, move: string) {
  return {
    id: thread,
    reviewed: true,
    move,
    reason: 'review_ready',
    thread_id: thread,
    review: null,
    stacks: [stackOf(p)],
    pull_keys: [p.key],
    link: { via: 'owner', thread_id: thread, thread_subject: null, project_id: 'prj_fern', agent: { host, session, name }, last: null, guide: null },
    pull_reason: null,
    landed: [],
    updated_at: p.updated_at,
  };
}

const ROWS = [
  row('thr_retry', RETRY, 'ses_retry', 'claude-code', 'Claude Code', 'on_you'),
  row('thr_receipt', RECEIPT, 'ses_receipt', 'claude-code', 'Claude Code', 'on_you'),
  row('thr_export', EXPORT, 'ses_export', 'codex', 'Codex', 'agents'),
];
const BOARD = { fetched_at: ago(60_000), hosts: [{ cli: 'gh', host: 'github.com', login: 'charlie-dunn' }], pulls: PULLS, links: {}, projects: PROJECTS, cards: {}, clis: { gh: 'signed_in' }, unsigned: [] };
const REVIEWS = { fetched_at: BOARD.fetched_at, hosts: BOARD.hosts, rows: ROWS, projects: PROJECTS };

const session = (id: string, host: string, label: string) => ({ session: id, host, started_at: ago(3_600_000), last_seen_at: ago(5_000), busy: false, idle_since: ago(60_000), last_thread: null, label });
const SESSIONS = {
  serverSession: 'spec',
  home: '/home/charlie',
  projects: [{ project: { id: 'prj_fern', name: 'fern-api', root: '/home/charlie/fern-api' }, sessions: [session('ses_receipt', 'claude-code', 'Receipt email review'), session('ses_export', 'codex', 'Export rate limits'), session('ses_pi', 'pi', 'Checkout cleanup')] }],
  launch: {
    agents: [
      { agent: 'claude-code', name: 'Claude Code' },
      { agent: 'codex', name: 'Codex' },
    ],
    projects: [{ id: 'prj_fern', name: 'fern-api', root: '/home/charlie/fern-api', exists: true }],
  },
};

type Ship = Record<string, unknown> & { key: string; state: string };
const shipOf = (fields: Fields): Ship => ({
  id: 'shp_614',
  key: RECEIPT.key,
  url: RECEIPT.url,
  title: RECEIPT.title,
  number: 614,
  repo: 'harbor/fern-api',
  host: 'github.com',
  thread_id: 'thr_receipt',
  project_id: 'prj_fern',
  agent: { host: 'claude-code', session: 'ses_receipt', name: 'Claude Code' },
  started_at: new Date().toISOString(),
  state: 'shipping',
  reason: null,
  ended_at: null,
  merged_at: null,
  ...fields,
});
const LOG = [
  { at: ago(2 * 60_000), by: 'agent', kind: 'step', text: 'Re-ran e2e-checkout' },
  { at: ago(5 * 60_000), by: 'agent', kind: 'step', text: 'Pushed a fix', sha: 'a3f9c21' },
  { at: ago(10 * 60_000), by: 'agent', kind: 'step', text: 'Answered ada-novak' },
  { at: ago(14 * 60_000), by: 'inbox', kind: 'checks_failed', text: 'Checks failed: e2e-checkout' },
  { at: ago(22 * 60_000), by: 'inbox', kind: 'started', text: 'Started' },
];

// Another computer, linked: "Mac mini", which takes ships. Its routes (the forward's) are answered by the spec.
const SELF = 'ibx_01M62DTW6WCYD3ZH6Z17MFMA8G';
const MINI = 'ibx_01M62DTW6WCYD3ZH6Z17MFMA9H';
const MACHINES = [
  { id: SELF, name: 'MacBook', self: true, state: 'online', since: ago(3_600_000), reason: null, version: null, address: null, both_ways: false, waiting: 0 },
  { id: MINI, name: 'Mac mini', self: false, state: 'online', since: ago(3_600_000), reason: null, version: '0.0.0', address: null, both_ways: true, waiting: 0, list_cursor: 1, launch: false, marks: ['ships'] },
];
const THERE = {
  serverSession: 'mini',
  home: '/Users/charlie',
  projects: [{ project: { id: 'prj_mini', name: 'fern-api', root: '/Users/charlie/fern-api' }, sessions: [session('ses_triage', 'claude-code', 'Nightly e2e triage')] }],
};

let url = '';
let reviews: Fields = REVIEWS;
let board: Fields = BOARD;
let env: Record<string, string> = {};
let root = '';
let ships: Ship[] = [];
let farShips: Ship[] = [];
let farPosts: { path: string; body: Record<string, unknown> }[] = [];
let posted: Record<string, unknown>[] = [];
let stops: string[] = [];

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  root = inboxScratch('plannotator-inbox-ship-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const cli of ['gh', 'glab']) {
    writeFileSync(join(bin, cli), '#!/bin/sh\necho "not signed in" >&2\nexit 1\n');
    chmodSync(join(bin, cli), 0o755);
  }
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
});

test.afterAll(async () => {
  await removeInboxScratch();
});

async function open(browser: Browser, options: { width: number; height: number; phone?: boolean; dark?: boolean; still?: boolean; before?: (page: Page) => Promise<void> }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    colorScheme: options.dark ? 'dark' : 'light',
    ...(options.still ? { reducedMotion: 'reduce' as const } : {}),
    ...(options.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const page = await context.newPage();
  const settings = await page.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(settings.status()).toBe(200);
  await page.route((u) => u.pathname === '/api/inbox/pulls', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: board }) : route.continue()));
  await page.route((u) => u.pathname === '/api/inbox/reviews', (route) => route.fulfill({ json: reviews }));
  await page.route((u) => u.pathname === '/api/inbox/sessions', (route) => route.fulfill({ json: SESSIONS }));
  await page.route(
    (u) => u.pathname === '/api/inbox/ships',
    async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { ships } });
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posted.push(body);
      ships = [shipOf({})];
      return route.fulfill({ json: { ok: true, ship: ships[0] } });
    },
  );
  await page.route((u) => u.pathname === '/api/inbox/ships/log', (route) => route.fulfill({ json: { ship: ships[0], log: LOG } }));
  await page.route(
    (u) => u.pathname === '/api/inbox/ships/stop',
    async (route) => {
      stops.push(String((route.request().postDataJSON() as { id: string }).id));
      ships = ships.map((s) => ({ ...s, state: 'stopped', ended_at: new Date().toISOString() }));
      return route.fulfill({ json: { ok: true, ship: ships[0] } });
    },
  );
  await options.before?.(page);
  await page.goto(`${url}#reviews`);
  await expect(page.locator('[data-reviews-row="thr_receipt"]')).toBeVisible({ timeout: 30_000 });
  return { context, page };
}

/**
 * "Mac mini" linked: the merged list and the machines read name it, and its forwarded routes answer as its Inbox would.
 * Every list read names the machines, the whole one and each later one answered as a change (`delta`, #2593), as a
 * linked Inbox's do: a read that left them out would unlink Mac mini in the window.
 */
async function linkMini(page: Page) {
  await page.route(
    (u) => u.pathname === '/api/inbox/threads',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const json = (await response.json()) as Record<string, unknown>;
      return route.fulfill({ response, json: json && ('sections' in json || 'delta' in json) ? { ...json, self: SELF, machines: MACHINES } : json });
    },
  );
  await page.route((u) => u.pathname === '/api/inbox/machines', (route) => route.fulfill({ json: { self: SELF, machines: MACHINES } }));
  await page.route(
    (u) => u.pathname.startsWith(`/api/inbox/m/${MINI}/`),
    async (route) => {
      const path = new URL(route.request().url()).pathname.slice(`/api/inbox/m/${MINI}/`.length);
      const method = route.request().method();
      if (method === 'GET' && path === 'sessions') return route.fulfill({ json: THERE });
      if (method === 'GET' && path === 'ships') return route.fulfill({ json: { ships: farShips, projects: { 'github.com/harbor/fern-api': ['prj_mini'] } } });
      if (method === 'GET' && path === 'ships/log') return route.fulfill({ json: { ship: farShips[0], log: LOG } });
      if (method !== 'POST') return route.fulfill({ status: 404, json: { error: 'Not here.', code: 'not_found' } });
      const body = route.request().postDataJSON() as Record<string, unknown>;
      farPosts.push({ path, body });
      if (path === 'pulls/owner') return route.fulfill({ json: body.validate_only ? { ok: true, owner: null } : { ok: true } });
      if (path === 'messages') return route.fulfill({ json: { thread_id: 'msg_01M62DTT05NJ59ZR4AJCDJ7FAR', message: {}, replayed: false } });
      if (path === 'ships') {
        farShips = [shipOf({ thread_id: 'msg_01M62DTT05NJ59ZR4AJCDJ7FAR', project_id: 'prj_mini', agent: { host: 'claude-code', session: 'ses_triage', name: 'Claude Code' } })];
        return route.fulfill({ json: { ok: true, ship: farShips[0] } });
      }
      if (path === 'ships/stop') {
        farShips = farShips.map((s) => ({ ...s, state: 'stopped', ended_at: new Date().toISOString() }));
        return route.fulfill({ json: { ok: true, ship: farShips[0] } });
      }
      return route.fulfill({ status: 404, json: { error: 'Not here.', code: 'not_found' } });
    },
  );
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(proofDir, name) });
}

/** A stuck row's line: "Stuck:" drawn whole, a few characters of its reason drawn, and the title the wider of the two. */
async function stuckRoom(row: Locator) {
  return row.evaluate((el) => {
    const width = (selector: string) => el.querySelector(selector)!.getBoundingClientRect().width;
    const head = el.querySelector<HTMLElement>('.ib-shp-head')!;
    return {
      head: head.getBoundingClientRect().width > 20 && head.scrollWidth <= Math.ceil(head.getBoundingClientRect().width),
      why: width('.ib-shp-why') >= 24,
      titleLarger: width('.ib-rvr-t') >= width('[data-ship-words]'),
    };
  });
}

/** The window reads its ships again (as it does on focus). */
async function reread(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

test('desktop: Ship from the row menu with the review agent, ship mode, stuck, the ship log and Stop, merged', async ({ browser }) => {
  ships = [];
  posted = [];
  stops = [];
  const { context, page } = await open(browser, { width: 1440, height: 900 });
  try {
    const receipt = page.locator('[data-reviews-row="thr_receipt"]');
    const before = (await receipt.boundingBox())!;
    const titleBefore = (await receipt.locator('.ib-rvr-t').boundingBox())!;

    // 1. The menu: Ship first, with who will do it.
    await receipt.click({ button: 'right' });
    const menu = page.locator('[data-reviews-menu]');
    await expect(menu.locator('[role="menuitem"]').first()).toHaveText('Ship');
    await expect(menu.locator('[role="menuitem"]').nth(1)).toHaveText('Hide pull request');
    await shot(page, '01-menu.png');

    // 2. The submenu: the agents that can take it; the one on the review ticked.
    await menu.locator('[data-ship]').hover();
    const agents = page.locator('[data-ship-agents]');
    await expect(agents).toBeVisible();
    await expect(agents.locator('[data-ship-agent][data-on]')).toHaveAttribute('data-ship-agent', 'ses_receipt');
    await expect(agents.locator('[data-ship-agent]')).toHaveCount(5);
    await shot(page, '02-choose-agent.png');

    // 3. One click: shipped in the review's thread, to its agent.
    await menu.locator('[data-ship]').click();
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toMatchObject({ key: RECEIPT.key, thread_id: 'thr_receipt', to: { host: 'claude-code', session: 'ses_receipt' } });
    await expect(receipt).toHaveAttribute('data-ship', 'shipping');
    await expect(receipt.locator('.ib-shp')).toHaveCount(1);
    await expect(receipt.locator('.ib-rvr-mark .ib-shp-sail')).toBeVisible();
    await expect(page.locator('.ib-shp')).toHaveCount(1);
    // No layout shift: the row and its title where they were.
    expect(await receipt.boundingBox()).toEqual(before);
    expect((await receipt.locator('.ib-rvr-t').boundingBox())!.y).toBe(titleBefore.y);
    await page.waitForTimeout(1200);
    await shot(page, '03-ship-mode.png');

    // 4. Stuck.
    ships = [shipOf({ state: 'stuck', reason: 'e2e-checkout failing' })];
    await reread(page);
    await expect(receipt).toHaveAttribute('data-ship', 'stuck');
    await expect(receipt.locator('[data-ship-words]')).toContainText('Stuck: e2e-checkout failing');
    // Short of room: "Stuck:" whole, the start of the reason, the title the larger share; the whole words in a tooltip.
    await expect(receipt.locator('[data-ship-words]')).toHaveAttribute('title', /Stuck: e2e-checkout failing/);
    expect(await stuckRoom(receipt)).toEqual({ head: true, why: true, titleLarger: true });
    await shot(page, '04-stuck.png');
    // A long title takes no more than its share: the reason still shows its start.
    await receipt.locator('.ib-rvr-t').evaluate((el) => {
      el.textContent = 'Send a receipt after checkout with the order lines, the tax and the shipping address in it';
    });
    expect(await stuckRoom(receipt)).toEqual({ head: true, why: true, titleLarger: true });
    await shot(page, '04b-stuck-long-title.png');
    await receipt.locator('.ib-rvr-t').evaluate((el, text) => {
      el.textContent = text;
    }, RECEIPT.title);

    // 5. The ship log, from the row's menu; Stop.
    ships = [shipOf({})];
    await reread(page);
    await expect(receipt).toHaveAttribute('data-ship', 'shipping');
    await receipt.click({ button: 'right' });
    await expect(menu.locator('[role="menuitem"]')).toHaveText(['Ship log', 'Stop shipping', 'Hide pull request']);
    await menu.locator('[data-ship-log-open]').click();
    const log = page.locator('[data-ship-log]');
    await expect(log.locator('.ib-shp-e')).toHaveCount(LOG.length);
    await expect(log.locator('.ib-shp-e').first()).toContainText('Re-ran e2e-checkout');
    await expect(log.locator('code')).toHaveText('a3f9c21');
    await shot(page, '05-ship-log.png');
    await log.locator('[data-ship-log-stop]').click();
    await expect.poll(() => stops).toEqual(['shp_614']);
    await page.keyboard.press('Escape');
    await expect(receipt).not.toHaveAttribute('data-ship', /.+/);

    // 6. Merged.
    const at = new Date(NOW - 3 * 60_000).toISOString();
    ships = [shipOf({ state: 'merged', merged_at: at, ended_at: at })];
    await reread(page);
    await expect(receipt).toHaveAttribute('data-ship', 'merged');
    await expect(receipt.locator('[data-ship-words]')).toContainText('Merged');
    await expect(receipt.locator('.ib-shp')).toHaveCount(0);
    // Escape above gave the row the list's keyboard focus ring; a person reading the list has none. Ship draws no
    // ring or outline of its own on the row.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await receipt.evaluate((row) => [getComputedStyle(row).outlineStyle, getComputedStyle(row, '::before').boxShadow])).toEqual(['none', 'none']);
    await shot(page, '06-merged.png');

    // 6b. The PR merged, as the Reviews read then answers it (core inboxReviewRows, `shipMerged`): no stack left, the
    // landing only. The row stays with its title and Merged, read again from the start.
    board = { ...BOARD, pulls: [{ ...RECEIPT, state: 'merged', merged_at: at }, RETRY, EXPORT] };
    const landed = { key: RECEIPT.key, thread_id: 'thr_receipt', state: 'merged', at, url: RECEIPT.url, number: 614, title: RECEIPT.title, platform: 'github', head: RECEIPT.head, head_sha: RECEIPT.head_sha, through_review: null };
    reviews = { ...REVIEWS, rows: ROWS.map((r) => (r.id === 'thr_receipt' ? { ...r, move: 'agents', reason: 'curating', stacks: [], pull_keys: [], landed: [landed] } : r)) };
    await page.reload();
    await expect(receipt).toHaveAttribute('data-ship', 'merged', { timeout: 30_000 });
    await expect(receipt.locator('[data-ship-words]')).toContainText('Merged');
    await expect(receipt.locator('.ib-rvr-t')).toHaveText(RECEIPT.title);
  } finally {
    reviews = REVIEWS;
    board = BOARD;
    await context.close();
  }
});

test('phone: rows in ship mode', async ({ browser }) => {
  ships = [shipOf({}), shipOf({ id: 'shp_611', key: RETRY.key, number: 611, thread_id: 'thr_retry', state: 'stuck', reason: 'needs a staging secret' })];
  const { context, page } = await open(browser, { width: 390, height: 844, phone: true });
  try {
    await expect(page.locator('[data-reviews-row="thr_receipt"]')).toHaveAttribute('data-ship', 'shipping');
    await expect(page.locator('[data-reviews-row="thr_retry"]')).toHaveAttribute('data-ship', 'stuck');
    await expect(page.locator('[data-reviews-row="thr_export"]')).not.toHaveAttribute('data-ship', /.+/);
    // A ship this new fills its row from the left once (the launch); the picture is of the rows once filled.
    await expect.poll(() => page.evaluate(() => document.getAnimations().some((a) => (a as CSSAnimation).animationName?.startsWith('ib-shp-fill') && a.playState === 'running'))).toBe(false);
    // The water covers each row edge to edge, its time too.
    for (const id of ['thr_receipt', 'thr_retry']) {
      const edges = await page.locator(`[data-reviews-row="${id}"]`).evaluate((row) => {
        const box = row.getBoundingClientRect();
        const water = row.querySelector('.ib-shp-rev')!.getBoundingClientRect();
        const age = row.querySelector('.ib-rvr-age')!.getBoundingClientRect();
        return { left: Math.round(water.left - box.left), right: Math.round(box.right - water.right), ageInside: age.right <= water.right };
      });
      expect(edges).toEqual({ left: 0, right: 0, ageInside: true });
    }
    const retry = page.locator('[data-reviews-row="thr_retry"]');
    expect(await stuckRoom(retry)).toEqual({ head: true, why: true, titleLarger: true });
    await shot(page, '07-phone.png');
    // A long title on the phone: still "Stuck:" and the start of why.
    await retry.locator('.ib-rvr-t').evaluate((el) => {
      el.textContent = 'Retry failed charges twice before the card is marked declined and the person is told';
    });
    expect(await stuckRoom(retry)).toEqual({ head: true, why: true, titleLarger: true });
    await shot(page, '07b-phone-stuck-long-title.png');
  } finally {
    await context.close();
  }
});

test('another computer: its agents under its name in Ship, a ship there, its log and Stop there', async ({ browser }) => {
  ships = [];
  farShips = [];
  farPosts = [];
  posted = [];
  const { context, page } = await open(browser, { width: 1440, height: 900, before: linkMini });
  try {
    const receipt = page.locator('[data-reviews-row="thr_receipt"]');
    await receipt.click({ button: 'right' });
    const menu = page.locator('[data-reviews-menu]');
    await menu.locator('[data-ship]').hover();
    const agents = page.locator('[data-ship-agents]');
    const there = agents.locator('[data-ship-group="Mac mini"]');
    await expect(there.locator('[data-ship-agent]')).toHaveCount(1);
    await expect(there).toContainText('Mac mini');
    // The approved order: this computer's live agents, Mac mini's, then New … session.
    const order = await agents.locator('[data-ship-agent]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-ship-machine') ?? (r.textContent?.includes('New ') ? 'new' : 'here')));
    expect(order).toEqual(['here', 'here', 'here', 'ibx_01M62DTW6WCYD3ZH6Z17MFMA9H', 'new', 'new']);
    await shot(page, '08-other-computer.png');

    await there.locator('[data-ship-agent]').click();
    await expect.poll(() => farPosts.map((p) => p.path)).toEqual(['pulls/owner', 'messages', 'pulls/owner', 'ships']);
    expect(farPosts[1]!.body).toMatchObject({ to: { host: 'claude-code', session: 'ses_triage' } });
    expect(farPosts[3]!.body).toMatchObject({ key: RECEIPT.key, started: true, to: { host: 'claude-code', session: 'ses_triage' } });
    // Nothing shipped on this computer: the review's thread here is not where Mac mini's agent works.
    expect(posted).toEqual([]);
    await expect(receipt).toHaveAttribute('data-ship', 'shipping');

    await receipt.click({ button: 'right' });
    await menu.locator('[data-ship-log-open]').click();
    const log = page.locator('[data-ship-log]');
    await expect(log.locator('.ib-shp-who')).toContainText('Mac mini');
    await shot(page, '09-ship-log-there.png');
    await log.locator('[data-ship-log-stop]').click();
    await expect.poll(() => farPosts.map((p) => p.path).at(-1)).toBe('ships/stop');
  } finally {
    await context.close();
  }
});

test("the review thread's own view: Ship log and Stop shipping in its ⋯ menu, and the log by it", async ({ browser }) => {
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  try {
    const sent = await agent.send({ project_path: scratchProject(root, 'fern-api'), subject: 'Send a receipt after checkout', body: 'Reviewed #614: two notes on the receipt template, both fixed.' });
    const thread = String(sent.thread_id);
    ships = [shipOf({ thread_id: thread })];
    stops = [];
    const { context, page } = await open(browser, {
      width: 1440,
      height: 900,
      before: async (p) => {
        await p.route(
          (u) => u.pathname === `/api/inbox/threads/${thread}`,
          async (route) => {
            if (route.request().method() !== 'GET') return route.fallback();
            const response = await route.fetch();
            const json = (await response.json()) as Record<string, unknown>;
            return route.fulfill({ response, json: json.thread ? { ...json, thread: { ...(json.thread as object), pull_keys: [RECEIPT.key] } } : { ...json, pull_keys: [RECEIPT.key] } });
          },
        );
      },
    });
    try {
      await page.goto(`${url}#thread=${thread}`);
      await page.locator('[data-thread-more]').first().click();
      const menu = page.locator('[data-thread-menu]');
      await expect(menu.locator('[role="menuitem"]').nth(0)).toHaveText('Ship log');
      await expect(menu.locator('[role="menuitem"]').nth(1)).toHaveText('Stop shipping');
      await shot(page, '10-thread-menu.png');
      await menu.locator('[data-ship-log-open]').click();
      const log = page.locator('[data-ship-log]');
      await expect(log.locator('.ib-shp-e')).toHaveCount(LOG.length);
      await expect(log.locator('.ib-shp-e').first()).toContainText('Re-ran e2e-checkout');
      await shot(page, '11-thread-ship-log.png');
      await log.locator('[data-ship-log-stop]').click();
      await expect.poll(() => stops).toEqual(['shp_614']);
    } finally {
      await context.close();
    }
  } finally {
    await agent.close().catch(() => {});
  }
});

test('dark theme and reduced motion: shipping and stuck rows, and the log', async ({ browser }) => {
  ships = [shipOf({}), shipOf({ id: 'shp_611', key: RETRY.key, number: 611, thread_id: 'thr_retry', state: 'stuck', reason: 'e2e-checkout failing' })];
  const dark = await open(browser, { width: 1440, height: 900, dark: true });
  try {
    const receipt = dark.page.locator('[data-reviews-row="thr_receipt"]');
    await expect(receipt).toHaveAttribute('data-ship', 'shipping');
    await expect(dark.page.locator('[data-reviews-row="thr_retry"]')).toHaveAttribute('data-ship', 'stuck');
    await dark.page.waitForTimeout(1200);
    await shot(dark.page, '12-dark.png');
    await receipt.click({ button: 'right' });
    await dark.page.locator('[data-reviews-menu] [data-ship-log-open]').click();
    await expect(dark.page.locator('[data-ship-log] .ib-shp-e')).toHaveCount(LOG.length);
    await shot(dark.page, '13-dark-ship-log.png');
  } finally {
    await dark.context.close();
  }
  const still = await open(browser, { width: 1440, height: 900, still: true });
  try {
    const receipt = still.page.locator('[data-reviews-row="thr_receipt"]');
    await expect(receipt).toHaveAttribute('data-ship', 'shipping');
    // Reduced motion: nothing in the water moves; the glint is not drawn.
    const moving = await receipt.evaluate((row) => [...row.querySelectorAll('.ib-shp, .ib-shp *, .ib-shp-sail, .ib-shp-rock, .ib-rvr-agent')].filter((el) => getComputedStyle(el).animationName !== 'none').length);
    expect(moving).toBe(0);
    await expect(receipt.locator('.ib-shp-glide')).toBeHidden();
    await shot(still.page, '14-reduced-motion.png');
  } finally {
    await still.context.close();
  }
});
