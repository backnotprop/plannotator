/**
 * List rows name their session in a project with two or more live sessions (option A, "name instead of project",
 * the owner's decision of 2026-11-10), on the compiled binary. Nothing is mocked in the window: `plannotator inbox
 * --background` under a temp PLANNOTATOR_DATA_DIR with a scratch HOME, sessions are the bridge's real long-polls
 * carrying a `label` (the person's name) and a `title` (the generated title, or Claude Code's own name, which the
 * Inbox reads from `claude agents --json`: no real `claude` runs here, so the poll carries it), messages go through
 * the Inbox's own MCP `send_message`. A Codex and a Pi session are simulated by polls with their host.
 *
 * World: `plannotator` has four Claude Code sessions (A named by the person, B named, C with a generated title only,
 * D with only Claude Code's default name), a Codex session (no name) and a Pi session (named); `workspaces` has one.
 *  - The one critical flow, on a poor link (300 ms, 1 Mbit/s, one window dropped for 8 s). The failures
 *    it catches: rows in a busy project that still read alike, or need a reload; a row that changes height when its
 *    slot names the session (wide, three-line beside a thread, phone); a rename that reaches one window and not
 *    another, or a window that lost its link and never catches up; rows that flip back to the project the moment the
 *    second-last session ends.
 *  - ROW_NAMES_SHOTS: where to write PNGs for the brief (none when unset).
 *
 * Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.ROW_NAMES_SHOTS ? resolve(process.env.ROW_NAMES_SHOTS) : null;

const S = { A: 'cc-a-7d1e0c7a', B: 'cc-b-2b44e1c7', C: 'cc-c-91b0d3aa', D: 'cc-d-3f6f2c9e', X: 'cx-019a3f2e', PI: 'pi-5d1e0c7a', W: 'cc-w-55aa01b4' } as const;
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: 'reduce' as const };

interface World {
  url: string;
  token: string;
  projects: { plannotator: string; workspaces: string };
  ids: Record<string, string>;
}
let world: World;
const polls = new Map<string, Poll>();
const contexts: BrowserContext[] = [];

/** One live session: the bridge's long-poll with its `label` and `title` on every poll, as the plugin sends them. */
class Poll {
  stopped = true;
  loop: Promise<void> = Promise.resolve();
  constructor(
    readonly session: string,
    public label: string | undefined,
    public title: string | undefined,
    readonly project: string,
    readonly host = 'claude-code',
    autostart = true,
  ) {
    if (autostart) this.start();
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }
  async run() {
    const startedAt = Date.now() - 3_600_000;
    while (!this.stopped) {
      const r = await fetch(`${world.url}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${world.token}` },
        body: JSON.stringify({ session: this.session, host: this.host, waitMs: 500, project_path: this.project, started_at: startedAt, busy: false, idle_since: startedAt, tags: true, ...(this.label === undefined ? {} : { label: this.label }), ...(this.title === undefined ? {} : { title: this.title }) }),
      }).catch(() => null);
      await r?.text().catch(() => '');
      await new Promise((d) => setTimeout(d, 150));
    }
  }
  async stop() {
    this.stopped = true;
    await this.loop;
  }
}

let rpc = 1;
async function send(session: string, project: string, host: string, subject: string, body: string): Promise<string> {
  const names: Record<string, string> = { codex: 'Codex', pi: 'Pi', 'claude-code': 'Claude Code' };
  const res = await fetch(`${world.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name: 'send_message', arguments: { agent_host: host, agent_name: names[host], agent_session: session, project_path: project, subject, body }, _meta: { 'ai.plannotator/inbox-wakes': true } } }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const json = JSON.parse(line ? line.slice(5) : text);
  if (json.error || json.result?.isError) throw new Error(text);
  return json.result.structuredContent.thread_id as string;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const root = inboxScratch('plannotator-session-name-rows-');
  const dataDir = join(root, 'data');
  const projects = { plannotator: join(root, 'src', 'plannotator'), workspaces: join(root, 'src', 'workspaces') };
  for (const dir of [dataDir, ...Object.values(projects), join(root, 'claude'), join(root, 'codex'), join(root, 'xdg-config'), join(root, 'xdg-data')]) mkdirSync(dir, { recursive: true });
  const past = '2026-10-01T10:00:00.000Z';
  writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ inboxVersion: '0.0.0-dev' }));
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      inboxLaunch: { enabled: false },
      inboxTour: { version: 2, seen_at: past, skipped_at: past },
      inboxNotifications: { dismissed: true },
      inboxAgentNotes: { offered: true, asked: ['claude-code', 'codex', 'opencode', 'pi', 'gemini', 'qwen', 'cursor'] },
      inboxSound: { dialogShownFor: '0.0.0-dev' },
      inboxListIntro: { shownAt: past, version: 2 },
      inboxVoiceIntro: { shownAt: past },
      inboxThemeChooser: { notNeededAt: past },
      inboxSnoozeIntro: { shownAt: past },
      inboxBoardIntro: { shownAt: past },
      inboxReveals: { lastShownAt: past },
    }),
  );
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    NO_ANON_PING: '1',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_TEST_SANDBOX: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/$/, '');
  expect(url).not.toContain(':59812');
  expect(url).not.toContain(':49606');
  const { token } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { token: string };
  world = { url, token, projects, ids: {} };

  const P = projects.plannotator;
  const def: [string, string | undefined, string | undefined, string, string][] = [
    [S.A, 'release 0.28.61', undefined, P, 'claude-code'],
    [S.B, 'docs sweep', 'Docs pass on 14 guides', P, 'claude-code'],
    [S.C, '', 'Plannotator usage reference', P, 'claude-code'],
    [S.D, '', 'plannotator-3f', P, 'claude-code'],
    [S.X, undefined, undefined, P, 'codex'],
    [S.PI, 'Refactor billing exports', undefined, P, 'pi'],
    [S.W, '', 'workspaces-9c', projects.workspaces, 'claude-code'],
  ];
  // Only A (and the workspaces session) polls at first: the critical test brings the others in.
  for (const [s, label, title, project, host] of def) polls.set(s, new Poll(s, label, title, project, host, s === S.A || s === S.W));
  await new Promise((r) => setTimeout(r, 1500));
  world.ids.W = await send(S.W, projects.workspaces, 'claude-code', 'Share links expire after 7 days', 'Share links now expire after 7 days by default.');
  world.ids.PI = await send(S.PI, P, 'pi', 'Billing exports in one file', 'The three billing exports now write one file.');
  world.ids.X = await send(S.X, P, 'codex', 'Pi server parity for sessions', 'The Pi server now answers the sessions route as the Bun server does.');
  world.ids.D = await send(S.D, P, 'claude-code', 'Flaky e2e on WebKit', 'One run in 20 fails on WebKit.');
  world.ids.C = await send(S.C, P, 'claude-code', 'How the plannotator tool is used', 'I read every call site of the tool.');
  world.ids.B = await send(S.B, P, 'claude-code', 'Docs sweep: 14 guides updated', 'Updated 14 agent guides.');
  world.ids.A = await send(S.A, P, 'claude-code', 'Release notes for 0.28.61', 'Release notes are drafted: 9 fixes, 2 features.');
});

test.afterAll(async () => {
  try {
    await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    await Promise.all([...polls.values()].map((p) => p.stop()));
  } finally {
    await removeInboxScratch();
  }
});

async function newPage(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  return context.newPage();
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function showList(page: Page, hash = '') {
  await page.goto(`${world.url}${hash}`);
  await expect(page.getByText('New since you looked').first().or(page.getByText('Waiting on you').first())).toBeVisible();
  await page.waitForTimeout(600);
}

/** The slot text of the row for `thread`. */
const slotOf = (page: Page, thread: string) => page.locator(`[data-row="${thread}"] .ib-p, .ib-nrow[data-thread-id="${thread}"] .ib-p, .ib-mrow[data-thread-id="${thread}"] .ib-p`).first();

/**
 * Each visible named row's height with its name, with the project in its place, and with a 60-character name, the
 * row's own state otherwise the same (the slot's text swapped in place, then put back): the slot alone never moves it.
 */
async function slotSwapHeights(page: Page): Promise<{ named: number; project: number; long: number }[]> {
  return page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    const out: { named: number; project: number; long: number }[] = [];
    // The swap is this test's own, not the app's: the slot recorder (recordSlot) skips it.
    (window as unknown as { __swapping?: boolean }).__swapping = true;
    for (const slot of document.querySelectorAll<HTMLElement>('[data-session-slot]')) {
      const row = slot.closest<HTMLElement>('[data-row], .ib-nrow, .ib-mrow');
      if (!row || !row.offsetParent) continue;
      const h = () => Math.round(row.getBoundingClientRect().height * 10) / 10;
      const text = slot.textContent;
      const named = h();
      slot.textContent = 'plannotator';
      await frame();
      const project = h();
      slot.textContent = 'Migrate auth tokens from the legacy cookie store to signed JWTs';
      await frame();
      const long = h();
      slot.textContent = text;
      out.push({ named, project, long });
    }
    await frame();
    (window as unknown as { __swapping?: boolean }).__swapping = false;
    return out;
  });
}

const until = async (what: string, check: () => Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const EXPECTED: Record<string, string | RegExp> = {
  A: 'release 0.28.61',
  B: 'docs sweep',
  C: 'Plannotator usage reference',
  D: 'plannotator-3f',
  X: /^plannotator-[0-9a-z]{2,}$/,
  PI: 'Refactor billing exports',
  W: 'workspaces',
};

/**
 * A poor link, as on hotel Wi-Fi: 300 ms, about 1 Mbit/s (Chromium's own throttling, which the page's requests and
 * its event stream go through). `offline` drops the connection.
 */
async function poorLink(page: Page, offline = false) {
  const cdp = await page.context().newCDPSession(page);
  const conditions = { offline, latency: 300, downloadThroughput: 125_000, uploadThroughput: 125_000 };
  await cdp.send('Network.enable');
  // No emulated packet loss: with Chromium's `packetLoss` one run in four left a window unnamed for 30 s, and that
  // emulation may drop a live-stream frame outright, which TCP would resend. The dropped connection below stands in.
  await cdp.send('Network.emulateNetworkConditions', conditions);
  return cdp;
}

/** Every text a row's slot showed, in order (a MutationObserver in the page): the proof it never flips. */
async function recordSlot(page: Page, thread: string) {
  await page.evaluate((id) => {
    const seen: string[] = [];
    (window as unknown as { __slot: string[] }).__slot = seen;
    const read = () => {
      if ((window as unknown as { __swapping?: boolean }).__swapping) return;
      const el = document.querySelector(`[data-row="${id}"] .ib-p`);
      const text = el?.textContent ?? null;
      if (text !== null && seen.at(-1) !== text) seen.push(text);
    };
    read();
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, thread);
}
const slotHistory = (page: Page) => page.evaluate(() => (window as unknown as { __slot: string[] }).__slot);

test('on a poor link: a second session names the rows in every window at once, no row changes height, a rename and a dropped link catch up, and nothing flips back', async ({ browser }) => {
  test.setTimeout(300_000);
  const others = [S.B, S.C, S.D, S.X, S.PI];
  const wide = await newPage(browser);
  const narrow = await newPage(browser);
  const phone = await newPage(browser, PHONE);
  const links = await Promise.all([wide, narrow, phone].map((p) => poorLink(p)));
  // One live session in plannotator: every row reads the project, as before. These are the heights to keep.
  await showList(wide);
  await showList(narrow, `#thread=${world.ids.W}`);
  await showList(phone);
  for (const p of [wide, narrow, phone]) await expect(slotOf(p, world.ids.B!)).toHaveText('plannotator');
  await recordSlot(wide, world.ids.D!);

  // The others start: every window names every row of the busy project without a reload; workspaces is unchanged.
  for (const s of others) polls.get(s)!.start();
  for (const p of [wide, narrow, phone]) await expect(slotOf(p, world.ids.B!)).toHaveText('docs sweep', { timeout: 30_000 });
  for (const [key, text] of Object.entries(EXPECTED)) await expect(slotOf(wide, world.ids[key]!)).toHaveText(text);
  // In each layout, every named row is as tall with its name as with the project, or with a 60-character name.
  for (const page of [wide, narrow, phone]) {
    const rows = await slotSwapHeights(page);
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) expect([row.project, row.long]).toEqual([row.named, row.named]);
  }

  // A rename reaches two windows on the poor link; one of them meanwhile loses its connection and catches up.
  await shot(wide, '04-rename-before');
  await links[2]!.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  polls.get(S.A)!.label = 'ship 0.28.61 today';
  await expect(slotOf(wide, world.ids.A!)).toHaveText('ship 0.28.61 today', { timeout: 30_000 });
  await shot(wide, '05-rename-after');
  await new Promise((r) => setTimeout(r, 8_000));
  await links[2]!.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 125_000, uploadThroughput: 125_000 });
  await expect(slotOf(phone, world.ids.A!)).toHaveText('ship 0.28.61 today', { timeout: 45_000 });

  // Every other session ends: past the live window the project has one live session, and the rows, looked at the
  // whole time, keep their names. D's row showed the project, then its name, and nothing else.
  for (const s of others) await polls.get(s)!.stop();
  await new Promise((r) => setTimeout(r, 36_000));
  for (const p of [wide, narrow, phone]) await expect(slotOf(p, world.ids.D!)).toHaveText('plannotator-3f');
  expect(await slotHistory(wide)).toEqual(['plannotator', 'plannotator-3f']);
  // And the screen agrees with the server: the list it reads now names the same sessions.
  const list = (await (await fetch(`${world.url}/api/inbox/threads`)).json()) as { session_labels: Record<string, string> };
  expect(list.session_labels[S.A]).toBe('ship 0.28.61 today');
  for (const s of others) polls.get(s)!.start();
  polls.get(S.A)!.label = 'release 0.28.61';
});

test('pictures for the brief (only with ROW_NAMES_SHOTS): light, dark, phone, the tooltip, awkward states', async ({ browser }) => {
  test.skip(!shots, 'pictures only');
  test.setTimeout(180_000);
  for (const poll of polls.values()) poll.start();
  for (const scheme of ['light', 'dark'] as const) {
    const page = await newPage(browser, { colorScheme: scheme });
    await showList(page);
    await expect(slotOf(page, world.ids.A!)).toHaveText('release 0.28.61', { timeout: 30_000 });
    await shot(page, `01-list-${scheme}`);
    if (scheme === 'light') {
      await slotOf(page, world.ids.C!).hover();
      await expect(page.locator('[data-pn-tooltip]').filter({ hasText: 'plannotator · Plannotator usage reference' })).toBeVisible();
      await shot(page, '02-tooltip');
    }
  }
  const phone = await newPage(browser, PHONE);
  await showList(phone);
  await shot(phone, '03-phone');
  // Two sessions named alike, a very long name, a session that ended (its thread stays).
  polls.get(S.D)!.label = 'docs sweep';
  polls.get(S.C)!.label = 'Migrate auth tokens from the legacy cookie store to signed JWTs everywhere';
  await polls.get(S.X)!.stop();
  const page = await newPage(browser);
  await showList(page);
  await expect(slotOf(page, world.ids.D!)).toHaveText(/^docs sweep \([0-9a-z]{2,}\)$/, { timeout: 30_000 });
  await until('the Codex session to end', async () => {
    const list = (await (await fetch(`${world.url}/api/inbox/threads`)).json()) as { agents?: { agents: { session: string; live: boolean }[] }[] };
    return list.agents?.[0]?.agents.find((a) => a.session === S.X)?.live === false;
  });
  await page.waitForTimeout(1_500);
  await shot(page, '06-awkward');
  await slotOf(page, world.ids.C!).hover();
  await expect(page.locator('[data-pn-tooltip]').filter({ hasText: 'legacy cookie store' })).toBeVisible();
  await shot(page, '07-long-name-tooltip');
});
