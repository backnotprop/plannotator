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
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/ship.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

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

let url = '';
let ships: Ship[] = [];
let posted: Record<string, unknown>[] = [];
let stops: string[] = [];

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-ship-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const cli of ['gh', 'glab']) {
    writeFileSync(join(bin, cli), '#!/bin/sh\necho "not signed in" >&2\nexit 1\n');
    chmodSync(join(bin, cli), 0o755);
  }
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
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

async function open(browser: Browser, options: { width: number; height: number; phone?: boolean }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    colorScheme: 'light',
    ...(options.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  const page = await context.newPage();
  const settings = await page.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(settings.status()).toBe(200);
  await page.route((u) => u.pathname === '/api/inbox/pulls', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: BOARD }) : route.continue()));
  await page.route((u) => u.pathname === '/api/inbox/reviews', (route) => route.fulfill({ json: REVIEWS }));
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
  await page.goto(`${url}#reviews`);
  await expect(page.locator('[data-reviews-row="thr_receipt"]')).toBeVisible({ timeout: 30_000 });
  return { context, page };
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(proofDir, name) });
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
    await shot(page, '04-stuck.png');

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
    await shot(page, '06-merged.png');
  } finally {
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
    await shot(page, '07-phone.png');
  } finally {
    await context.close();
  }
});
