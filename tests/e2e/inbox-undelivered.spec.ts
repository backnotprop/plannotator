/**
 * Replies to a busy agent (owner approval "inbox-busy-agent-reply",
 * 2026-10-21; mock.html in .product/approved/inbox-busy-agent-reply/),
 * proved in a real browser against the compiled binary.
 *
 * Nothing is mocked: the binary runs `plannotator inbox --background` under a
 * temp PLANNOTATOR_DATA_DIR and HOME; Claude Code agents write through
 * `plannotator inbox mcp` with the wake meta (scripts/inbox-sim.ts); each
 * session's connection is the bridge's real doors driven as the mod drives
 * them (busy, whether it can take a reply mid-turn, what plugin it loaded,
 * `delivered` once the reply is in); the person's Send is the window's own
 * reply box. The wait is the server's clock, started when it first saw the
 * session busy while the reply waited; minutes pass for the window by moving
 * the page's clock forward (Playwright's `page.clock`), so the badge and the
 * band read "Undelivered 3 min" without waiting 3 minutes. Going in by itself
 * runs for real with the testing knob PLANNOTATOR_INBOX_AUTO_SEND_MS (a
 * shorter wait, honoured only in a build that is not a release), across an
 * Inbox restart, which starts the clock again.
 *
 * PNGs (1440 light and dark, and a phone) land in
 * PLANNOTATOR_UNDELIVERED_SHOTS, else .local/proof/undelivered/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, INBOX_SEND_NOW_POLL_FIELD, parseInboxBridgeCommands, type InboxReplyCommand } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_UNDELIVERED_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'undelivered'));
const MIN = 60_000;

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  ledger: string;
  billing: string;
  pluginFolder: (version: string) => string;
  context: BrowserContext;
  page: Page;
  errors: string[];
  connections: Connection[];
  agents: SimAgent[];
}

let world: World;

function registry(): { port: number; token: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

/** One Claude Code session's connection, as the mod runs it: busy, whether it can take a reply mid-turn, what it loaded. */
class Connection {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = false;
  private loop: Promise<void>;
  constructor(
    readonly session: string,
    private readonly project: string,
    private readonly options: { busy: boolean; sendNow: boolean; plugin?: { version: string; root: string; loaded_at: number } },
  ) {
    this.loop = this.run();
  }

  private bridge(path: string, body: Record<string, unknown>): Promise<Response> {
    const { port, token } = registry();
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session: this.session, host: 'claude-code', ...body }),
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const response = await this.bridge(INBOX_BRIDGE_POLL_PATH, {
        waitMs: 1_000,
        project_path: this.project,
        session_folder: this.project,
        started_at: Date.now() - 50 * MIN,
        busy: this.options.busy,
        idle_since: Date.now() - 40 * MIN,
        engine: '2.1.305',
        ...(this.options.plugin ? { plugin: this.options.plugin } : {}),
        ...(this.options.sendNow ? { [INBOX_SEND_NOW_POLL_FIELD]: true } : {}),
      }).catch(() => null);
      if (response?.ok) {
        for (const command of parseInboxBridgeCommands(await response.text())) {
          const known = this.commands.findIndex((c) => c.id === command.id);
          if (known < 0) this.commands.push(command);
          else this.commands[known] = command;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async deliver(id: string): Promise<void> {
    expect((await this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'delivered', id })).status).toBe(200);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

function startInbox(extra: Record<string, string> = {}): string {
  const started = spawnSync(binary, ['inbox', '--background'], { env: { ...world.env, ...extra }, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(world.dataDir);
  return started.stdout.trim();
}

async function restartWith(extra: Record<string, string> = {}): Promise<void> {
  await stopScratchInbox(world.dataDir);
  world.url = startInbox(extra);
}

/** Minutes pass for the window: its clock is fixed `ms` ahead of now (the server's clock is untouched). */
async function windowAhead(page: Page, ms: number): Promise<void> {
  await page.clock.setFixedTime(new Date(Date.now() + ms));
}

async function sessionOf(threadId: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${threadId}`);
  const thread = ((await response.json()) as { thread: { messages: { author: { session: string } }[] } }).thread;
  return thread.messages[0]!.author.session;
}

async function lastPersonId(threadId: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${threadId}`);
  const thread = ((await response.json()) as { thread: { messages: { id: string; author: { kind: string } }[] } }).thread;
  return thread.messages.filter((m) => m.author.kind === 'person').at(-1)!.id;
}

async function waitOf(threadId: string, session: string, id: string): Promise<{ since: string; auto_since: string | null }> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${threadId}/sessions?asker=${session}`);
  const body = (await response.json()) as { asker: { connection: { waits: Record<string, { since: string; auto_since: string | null }> } } };
  return body.asker.connection.waits[id]!;
}

async function message(threadId: string, id: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${threadId}`);
  return ((await response.json()) as { thread: { messages: Record<string, unknown>[] } }).thread.messages.find((m) => m.id === id)!;
}

async function agent(): Promise<SimAgent> {
  const a = await SimAgent.connect({ binary, env: world.env, name: 'Claude Code', host: 'claude-code' });
  world.agents.push(a);
  return a;
}

/** The person replies in the window: Reply, type, Send. */
async function replyInWindow(page: Page, words: string): Promise<void> {
  const pane = page.locator('section.ib-pane');
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await pane.getByRole('textbox', { name: 'Reply to Claude Code' }).fill(words);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(pane.locator('article.ib-message[data-author="person"]').last()).toContainText(words);
}

async function shot(page: Page, name: string, clip?: () => Promise<{ x: number; y: number; width: number; height: number }>): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`), ...(clip ? { clip: await clip() } : {}) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function boxOf(page: Page, selectors: string[], pad = 10) {
  const boxes = [];
  for (const sel of selectors) {
    const b = await page.locator(sel).first().boundingBox();
    if (b) boxes.push(b);
  }
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) + pad - x, height: Math.max(...boxes.map((b) => b.y + b.height)) + pad - y };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-undelivered-e2e-');
  const dataDir = join(root, 'data');
  // Claude Code's plugin registry in the scratch HOME: plugin 0.28.25 installed, so a session that loaded 0.28.21 has no Send now.
  const pluginFolder = (version: string) => join(root, '.claude', 'plugins', 'cache', 'plannotator', 'plannotator', version);
  mkdirSync(pluginFolder('0.28.25'), { recursive: true });
  mkdirSync(pluginFolder('0.28.21'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'plannotator@plannotator': [{ scope: 'user', installPath: pluginFolder('0.28.25'), version: '0.28.25', installedAt: '2026-10-04T22:07:24.658Z', lastUpdated: '2026-10-17T05:27:07.299Z' }] } }),
  );
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = {
    root,
    dataDir,
    env,
    url: '',
    ledger: scratchProject(join(root, 'src'), 'ledger'),
    billing: scratchProject(join(root, 'src'), 'billing'),
    pluginFolder,
    context,
    page,
    errors,
    connections: [],
    agents: [],
  };
  world.url = startInbox();
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.connections.map((c) => c.stop()));
    for (const a of world.agents) await a.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

let hero: { thread: string; reply: string; connection: Connection };
let stuck: { thread: string; reply: string };

test('waiting on a busy agent: "Undelivered N min" on the row (blue / grey), Send now on hover, the band with the countdown, and the grey band that says why', async () => {
  const { page } = world;
  // The one that cannot go in sooner: a Claude Code on an older plugin (no Send now).
  const billingAgent = await agent();
  const asked = await billingAgent.send(
    { project_path: world.billing, subject: 'Invoice rounding', body: 'Rounding is off by a cent on 3 of 2,400 invoices. Round half-even like the ledger, or keep half-up and fix those three by hand?' },
    { wakes: true },
  );
  world.connections.push(
    new Connection(await sessionOf(asked.thread_id), world.billing, { busy: true, sendNow: false, plugin: { version: '0.28.21', root: world.pluginFolder('0.28.21'), loaded_at: Date.now() - 3 * 60 * MIN } }),
  );
  // The hero: Claude Code, busy, Send now possible.
  const ledgerAgent = await agent();
  const sent = await ledgerAgent.send(
    { project_path: world.ledger, subject: 'Ledger export format', body: 'The ledger migration is shipped and the backfill is running. For the export: CSV is what finance opens today; Parquet is 6× smaller and keeps the types. Which one?' },
    { wakes: true },
  );
  const connection = new Connection(await sessionOf(sent.thread_id), world.ledger, { busy: true, sendNow: true });
  world.connections.push(connection);

  await page.goto(`${world.url}#thread=${asked.thread_id}`);
  await expect(page.locator('section.ib-pane').getByRole('heading', { name: 'Invoice rounding' })).toBeVisible();
  await replyInWindow(page, 'Half-even, same as the ledger. Then re-run the 3.');
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  await page.reload();
  await expect(page.locator('section.ib-pane').getByRole('heading', { name: 'Ledger export format' })).toBeVisible();
  await replyInWindow(page, 'Parquet, and keep a CSV of the monthly summary for finance.');
  hero = { thread: sent.thread_id, reply: await lastPersonId(sent.thread_id), connection };
  stuck = { thread: asked.thread_id, reply: await lastPersonId(asked.thread_id) };
  // Handed out without `now`: under 5 minutes, nobody pressed it.
  await expect.poll(() => connection.commands.length, { timeout: 15_000 }).toBe(1);
  expect(connection.commands[0]!.now).toBeUndefined();

  // The server started both clocks when it saw the sessions busy with the replies waiting.
  const heroClock = await waitOf(hero.thread, await sessionOf(hero.thread), hero.reply);
  expect(Date.parse(heroClock.since)).toBeGreaterThanOrEqual(Date.parse(String((await message(hero.thread, hero.reply)).created_at)));
  expect(heroClock.auto_since).not.toBeNull();
  expect((await waitOf(stuck.thread, await sessionOf(stuck.thread), stuck.reply)).auto_since).toBeNull();
  // 3½ minutes pass for the window. The hero is still under 5: it waits.
  await windowAhead(page, 3.5 * MIN);
  await page.goto(`${world.url}`);
  const heroRow = page.locator(`.ib-lbody [data-thread-id="${hero.thread}"]`).first();
  const stuckRow = page.locator(`.ib-lbody [data-thread-id="${stuck.thread}"]`).first();
  // A wide row (1440) draws the full words (the owner, 2026-10-29), read as they are.
  await expect(heroRow.locator('[data-undelivered]')).toHaveText('Undelivered 3 min');
  await expect(heroRow.locator('.ib-c .ib-sr')).toHaveCount(0);
  await expect(heroRow.locator('[data-undelivered]')).not.toHaveAttribute('data-stuck', /.*/);
  await expect(stuckRow.locator('[data-undelivered]')).toHaveText('Undelivered 3 min');
  await expect(stuckRow.locator('[data-undelivered]')).toHaveAttribute('data-stuck', '');
  // The badge is the count's cell: the row reads it in its name.
  await expect(heroRow).toContainText('Undelivered 3 min');
  expect((await message(hero.thread, hero.reply)).deliver_now_by ?? null).toBeNull();
  await page.mouse.move(1, 1);
  const sentGroup = () => boxOf(page, [`.ib-group:has([data-thread-id="${hero.thread}"])`], 0);
  await shot(page, 'list', sentGroup);
  await page.screenshot({ path: join(proofDir, 'frame-list-light.png') });

  // Hover: Send now on the row that can go in now, never on the one that cannot.
  await heroRow.hover();
  const action = page.locator(`[data-row="${hero.thread}"] > [data-row-send-now]`);
  await expect(action).toBeVisible();
  // "Undelivered 3 min" sits left of the marks (approval "inbox-row-byline", the one-line row), clear of the
  // action, so it stays on screen beside Send now.
  await expect(heroRow.locator('.ib-c')).toBeVisible();
  expect((await heroRow.locator('.ib-c').boundingBox())!.x + (await heroRow.locator('.ib-c').boundingBox())!.width).toBeLessThanOrEqual((await action.boundingBox())!.x);
  await shot(page, 'list-hover', sentGroup);
  await stuckRow.hover();
  await expect(page.locator(`[data-row="${stuck.thread}"] > [data-row-send-now]`)).toHaveCount(0);
  // Keyboard focus shows it too.
  await page.mouse.move(1, 1);
  await heroRow.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(action).toBeVisible();

  // The band under the reply.
  await page.goto(`${world.url}#thread=${hero.thread}`);
  const pane = page.locator('section.ib-pane');
  const band = pane.locator('.ib-delivered[data-undelivered]');
  await expect(band).toContainText('Undelivered 3 min · Claude Code is working · goes in by itself in 2 min');
  await expect(band.locator('[data-send-now]')).toHaveText('Send now');
  await page.mouse.move(1, 1);
  const lineBox = () => boxOf(page, ['article.ib-message[data-author="person"] >> nth=-1', '.ib-delivered[data-undelivered]'], 14);
  await shot(page, 'thread-line', lineBox);
  await shot(page, 'frame-thread');
  const narrowRows = () => boxOf(page, [`.ib-group:has([data-thread-id="${hero.thread}"])`], 0);
  await shot(page, 'thread-rows', narrowRows);

  // Can't go in sooner: grey, no button, no countdown; why and the fix, with Copy. 12 minutes for the window.
  await windowAhead(page, 12.2 * MIN);
  await page.goto(`${world.url}#thread=${stuck.thread}`);
  const grey = page.locator('section.ib-pane .ib-delivered[data-undelivered]');
  await expect(grey).toHaveAttribute('data-stuck', '');
  await expect(grey).toContainText('Undelivered 12 min · Claude Code is working · it gets this when its turn ends');
  await expect(grey.locator('[data-send-now]')).toHaveCount(0);
  await expect(grey.locator('[data-stuck-why]')).toContainText("It can't go in sooner: this session runs an older Plannotator plugin. Type /reload-plugins in that Claude Code to fix it.");
  await grey.getByRole('button', { name: 'Copy /reload-plugins' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/reload-plugins');
  await page.mouse.move(1, 1);
  await page.waitForTimeout(2_200);
  await shot(page, 'stuck-line', () => boxOf(page, ['article.ib-message[data-author="person"] >> nth=-1', '.ib-delivered[data-undelivered]'], 14));
  expect(world.errors).toEqual([]);
});

test('on a phone: the row badge, the band and a 44 px Send now', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await windowAhead(page, 3.5 * MIN);
    await page.goto(world.url);
    const row = page.locator(`.ib-mrow[data-thread-id="${hero.thread}"]`);
    await expect(row.locator('[data-undelivered]')).toHaveText('Undelivered 3m');
    // A phone row keeps one tap target: no Send now on it.
    await expect(page.locator('[data-row-send-now]')).toHaveCount(0);
    await shot(page, 'phone-list');
    await page.goto(`${world.url}#thread=${hero.thread}`);
    const button = page.locator('section.ib-pane .ib-delivered[data-undelivered] [data-send-now]');
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const target = await button.evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      return el.getBoundingClientRect().height - parseFloat(after.top === 'auto' ? '0' : after.top) - parseFloat(after.bottom === 'auto' ? '0' : after.bottom);
    });
    expect(target).toBeGreaterThanOrEqual(44);
    await page.locator('.ib-delivered[data-undelivered]').scrollIntoViewIfNeeded();
    await shot(page, 'phone-thread');
    await page.goto(`${world.url}#thread=${stuck.thread}`);
    await expect(page.locator('section.ib-pane .ib-delivered[data-stuck]')).toBeVisible();
    await page.locator('.ib-delivered[data-undelivered]').scrollIntoViewIfNeeded();
    await shot(page, 'phone-stuck');
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(wide).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});

test('it goes into the running turn by itself after the wait, counted again from the restart: the poll hands it with `now`; then "went into its turn by itself after N min"', async () => {
  const { page } = world;
  await page.clock.setFixedTime(new Date());
  // A one-minute wait (the testing knob). The restart forgets every clock: nothing goes in at once.
  await restartWith({ PLANNOTATOR_INBOX_AUTO_SEND_MS: String(MIN) });
  await page.waitForTimeout(3_000);
  expect((await message(hero.thread, hero.reply)).deliver_now_by ?? null).toBeNull();
  expect(hero.connection.commands.find((c) => c.id === hero.reply)?.now).toBeUndefined();
  await expect.poll(() => hero.connection.commands.find((c) => c.id === hero.reply)?.now, { timeout: 90_000, intervals: [1_000] }).toBe(true);
  const marked = await message(hero.thread, hero.reply);
  expect(marked).toMatchObject({ deliver_now_by: 'auto' });
  expect(Date.parse(String(marked.deliver_now_at)) - Date.parse(String(marked.wait_started_at))).toBeGreaterThanOrEqual(MIN);
  await page.clock.setFixedTime(new Date());
  await page.goto(`${world.url}#thread=${hero.thread}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('[data-delivery]')).toHaveText('Sending to Claude Code now…');
  // The connection put it into the running turn.
  await hero.connection.deliver(hero.reply);
  expect((await message(hero.thread, hero.reply)).delivery).toMatchObject({ into_turn: true });
  const line = pane.locator('[data-delivery]');
  await expect(line).toHaveAttribute('data-delivery', 'delivered');
  await expect(line).toHaveText(/^Delivered to Claude Code, (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d{2} [AP]M · went into its turn by itself after 1 min$/);
  const row = page.locator(`.ib-lbody [data-thread-id="${hero.thread}"]`).first();
  await expect(row.locator('.ib-tick')).toHaveAttribute('data-tick', 'delivered');
  await expect(row.locator('[data-undelivered]')).toHaveCount(0);
  await page.mouse.move(1, 1);
  await shot(page, 'thread-auto-line', () => boxOf(page, ['article.ib-message[data-author="person"] >> nth=-1', 'section.ib-pane [data-delivery]'], 14));
  await shot(page, 'thread-auto-rows', () => boxOf(page, [`.ib-group:has([data-thread-id="${hero.thread}"])`], 0));
  // Never twice, and the one that cannot go in sooner never went.
  expect((await message(stuck.thread, stuck.reply)).deliver_now_by ?? null).toBeNull();
});

test('the live timer: with no window and no press, a waiting reply goes in once the wait has passed (testing knob PLANNOTATOR_INBOX_AUTO_SEND_MS)', async () => {
  await restartWith({ PLANNOTATOR_INBOX_AUTO_SEND_MS: '2000' });
  const fresh = await agent();
  const sent = await fresh.send({ project_path: world.ledger, subject: 'Backfill done', body: 'The backfill is done. Drop the old table now?' }, { wakes: true });
  const connection = new Connection(await sessionOf(sent.thread_id), world.ledger, { busy: true, sendNow: true });
  world.connections.push(connection);
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/messages/${(await message(sent.thread_id, sent.message_id)).id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotency_key: 'k-live', words: 'Not yet: keep it a week.' }),
  });
  expect(response.status).toBe(200);
  const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
  await expect.poll(() => connection.commands.find((c) => c.id === replyId), { timeout: 10_000 }).toBeTruthy();
  expect(connection.commands.find((c) => c.id === replyId)!.now).toBeUndefined();
  await expect.poll(() => connection.commands.find((c) => c.id === replyId)?.now, { timeout: 20_000 }).toBe(true);
  expect(await message(sent.thread_id, replyId)).toMatchObject({ deliver_now_by: 'auto' });
});
