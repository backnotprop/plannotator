/**
 * Queued, Sending, Send now (the owner's request, 2026-10-16: "The message
 * should be less deceiving. It should say this message is queued up or
 * something. And then maybe an option just to send it immediately."),
 * proved in a real browser against the compiled binary.
 *
 * Nothing is mocked: the binary runs `plannotator inbox --background` under a
 * temp PLANNOTATOR_DATA_DIR and HOME; a Claude Code agent writes through
 * `plannotator inbox mcp` with the wake meta (scripts/inbox-sim.ts), as the
 * mod does; its connection is the bridge's real doors driven as the mod
 * drives them (the bearer token from inbox.json, a long-poll saying where the
 * session works, whether a turn runs and that it can take a reply mid-turn,
 * `delivered` once the reply is in); the person's Send is the window's own
 * reply box. The mod's own code doing the delivery is
 * apps/hook/hooks/mod/inbox.test.ts (12, 13).
 *
 * PNGs (light, dark, and a phone) land in .local/proof/send-now/, or in
 * PLANNOTATOR_SEND_NOW_SHOTS when it names a folder.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_SEND_NOW_POLL_FIELD,
  parseInboxBridgeCommands,
  type InboxReplyCommand,
} from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_SEND_NOW_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'send-now'));

interface World {
  dataDir: string;
  env: Record<string, string>;
  url: string;
  ledger: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  connections: Connection[];
}

let world: World;

function registry(): { port: number; token: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

/** One Claude Code session's connection, as the mod runs it: busy or idle, and able to take a reply mid-turn. */
class Connection {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = false;
  private loop: Promise<void>;
  constructor(
    readonly session: string,
    private busy: boolean,
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
        project_path: world.ledger,
        started_at: Date.now() - 30 * 60_000,
        busy: this.busy,
        idle_since: Date.now() - 60_000,
        [INBOX_SEND_NOW_POLL_FIELD]: true,
      }).catch(() => null);
      if (!response) continue;
      for (const command of parseInboxBridgeCommands(await response.text())) {
        const known = this.commands.findIndex((c) => c.id === command.id);
        if (known < 0) this.commands.push(command);
        else this.commands[known] = command;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** A turn starts or ends: said on the next poll, as the mod says it (no store line is written). */
  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  async deliver(id: string): Promise<void> {
    expect((await this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'delivered', id })).status).toBe(200);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-send-now-e2e-');
  const dataDir = join(root, 'data');
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
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const ledger = scratchProject(join(root, 'src'), 'ledger');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { dataDir, env, url, ledger, agent, context, page, errors, connections: [] };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.connections.map((c) => c.stop()));
    await world.agent.close().catch(() => {});
    for (const agent of extraAgents) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

/** A Claude Code session of its own (one `plannotator inbox mcp` process is one session): its message starts its own thread. */
async function freshAgent(): Promise<SimAgent> {
  const agent = await SimAgent.connect({ binary, env: world.env, name: 'Claude Code', host: 'claude-code' });
  extraAgents.push(agent);
  return agent;
}
const extraAgents: SimAgent[] = [];

async function sessionOf(threadId: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${threadId}`);
  const thread = ((await response.json()) as { thread: { messages: { author: { session: string } }[] } }).thread;
  return thread.messages[0]!.author.session;
}

/** The person replies in the window: Reply, type, Send. */
async function replyInWindow(page: Page, words: string): Promise<void> {
  const pane = page.locator('section.ib-pane');
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  const box = pane.getByRole('textbox', { name: 'Reply to Claude Code' });
  await box.fill(words);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(pane.locator('article.ib-message[data-author="person"]').last()).toContainText(words);
}

test('Claude Code at work: the reply reads "Undelivered · … is working" with Send now; pressing it hands the reply over with `now`, then Delivered', async () => {
  const { page } = world;
  const sent = await world.agent.send(
    { project_path: world.ledger, subject: 'Migration shipped', body: 'The ledger migration is shipped and the backfill is running. Anything else before I move on to the export?' },
    { wakes: true },
  );
  const session = await sessionOf(sent.thread_id);
  const connection = new Connection(session, true);
  world.connections.push(connection);

  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Migration shipped' })).toBeVisible();
  await replyInWindow(page, 'Yes: bump the version and add a changelog line before the export.');

  const line = pane.locator('[data-delivery]');
  await expect(line).toHaveAttribute('data-delivery', 'queued');
  await expect(line).toContainText(/Undelivered(?: \d+ min)? · Claude Code is working · goes in by itself in /);
  const button = pane.locator('[data-send-now]');
  await expect(button).toBeVisible();
  await expect(button).toHaveText('Send now');
  // The list row (approval "inbox-row-delivery", Ticks): its own subject, a clock before the time, the state in
  // its name, and the thread's line as the tooltip.
  const row = page.locator(`.ib-lbody [data-thread-id="${sent.thread_id}"]`).first();
  const tick = row.locator('.ib-tick');
  await expect(tick).toHaveAttribute('data-tick', 'queued');
  await expect(tick).toHaveAttribute('aria-label', 'Queued for Claude Code,');
  await expect(row.locator('.ib-title')).toHaveText('Migration shipped');
  await expect(tick).not.toHaveAttribute('title', /./);
  // Waiting on a busy agent (approval "inbox-busy-agent-reply"): "Undelivered" in place of the count, and on hover
  // the row's own Send now takes the count's and the time's place (so the tick's tooltip is not offered then).
  await expect(row.locator('[data-undelivered]')).toHaveText(/^Undelivered/);
  await row.hover();
  await expect(page.locator(`[data-row="${sent.thread_id}"] > [data-row-send-now]`)).toBeVisible();
  await page.mouse.move(0, 0);
  // Handed out without `now` while nobody pressed it.
  await expect.poll(() => connection.commands.length, { timeout: 15_000 }).toBe(1);
  expect(connection.commands[0]!.now).toBeUndefined();
  await shot(page, '1-queued-working');

  await button.click();
  await expect(line).toHaveAttribute('data-delivery', 'sending');
  await expect(line).toHaveText('Sending to Claude Code now…');
  await expect(button).toHaveCount(0);
  await expect.poll(() => connection.commands[0]?.now, { timeout: 15_000 }).toBe(true);
  await expect(tick).toHaveAttribute('data-tick', 'sending');
  await shot(page, '2-sending-now');

  // The connection put it into the running turn.
  await connection.deliver(connection.commands[0]!.id);
  await expect(line).toHaveAttribute('data-delivery', 'delivered');
  await expect(line).toHaveText(/^Delivered to Claude Code, (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d{2} [AP]M$/);
  await expect(tick).toHaveAttribute('data-tick', 'delivered');
  await expect(tick).toHaveAttribute('aria-label', 'Delivered to Claude Code,');
  await shot(page, '3-delivered');
});

test('idle: "Sending to Claude Code…", no Send now', async () => {
  const { page } = world;
  for (const c of world.connections.splice(0)) await c.stop();
  const sent = await (await freshAgent()).send({ project_path: world.ledger, subject: 'Export streams now', body: 'The export streams rows now. Peak memory went from 1.9 GB to 140 MB.' }, { wakes: true });
  const connection = new Connection(await sessionOf(sent.thread_id), false);
  world.connections.push(connection);
  // A fresh load: a thread that arrived while another was open waits behind "N new" in the list.
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  await page.reload();
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Export streams now' })).toBeVisible();
  await replyInWindow(page, 'Great. Post the numbers in the PR.');
  const line = pane.locator('[data-delivery]');
  await expect(line).toHaveAttribute('data-delivery', 'sending');
  await expect(line).toHaveText('Sending to Claude Code…');
  await expect(pane.locator('[data-send-now]')).toHaveCount(0);
  await shot(page, '4-sending-idle');
});

test('an MCP-only agent: "Saved for … It sees it when it next reads this thread", no Send now; the list row says the same', async () => {
  const { page } = world;
  for (const c of world.connections.splice(0)) await c.stop();
  const sent = await (await freshAgent()).send({ project_path: world.ledger, subject: 'Docs pass done', body: 'The docs pass is done.' });
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  await page.reload();
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Docs pass done' })).toBeVisible();
  await replyInWindow(page, 'Thanks.');
  const line = pane.locator('[data-delivery]');
  await expect(line).toHaveText('Saved for Claude Code. It sees it when it next reads this thread.');
  await expect(pane.locator('[data-send-now]')).toHaveCount(0);
  // The list holds still while the thread is open: when its first read came after the look, the row sits in
  // Quiet (folded), where the reply shows in place.
  if ((await page.locator('[data-section-id="quiet"] .ib-band').count()) > 0) await openQuiet(page);
  const row = page.locator(`.ib-lbody [data-thread-id="${sent.thread_id}"]`).first();
  await expect(row.locator('.ib-tick')).toHaveAttribute('data-tick', 'saved');
  await expect(row.locator('.ib-title')).toHaveText('Docs pass done');
  await shot(page, '5-saved-mcp-only');
  expect(world.errors).toEqual([]);
});

test('on a phone: the queued line and Send now fit, and the button has a 44 px target', async ({ browser }) => {
  for (const c of world.connections.splice(0)) await c.stop();
  const sent = await (await freshAgent()).send({ project_path: world.ledger, subject: 'Tests green', body: 'All tests are green on the branch.' }, { wakes: true });
  const connection = new Connection(await sessionOf(sent.thread_id), true);
  world.connections.push(connection);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${sent.thread_id}`);
    const pane = page.locator('section.ib-pane');
    await expect(pane.getByRole('heading', { name: 'Tests green' })).toBeVisible();
    await replyInWindow(page, 'Merge it.');
    await expect(pane.locator('[data-delivery]')).toContainText('is working');
    const button = pane.locator('[data-send-now]');
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const target = await button.evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      const rect = el.getBoundingClientRect();
      return rect.height + parseFloat(after.top === 'auto' ? '0' : after.top) * -1 + parseFloat(after.bottom === 'auto' ? '0' : after.bottom) * -1;
    });
    expect(target).toBeGreaterThanOrEqual(44);
    await shot(page, '6-phone-queued');
  } finally {
    await context.close();
  }
});

// ── The list row's delivery glyph (approval "inbox-row-delivery", "Ticks") ──

/** Where the row-ticks shots go: PLANNOTATOR_ROW_TICKS_SHOTS, else beside the send-now shots. */
const ticksDir = resolve(process.env.PLANNOTATOR_ROW_TICKS_SHOTS ?? join(proofDir, 'row-ticks'));

/** The window's own routes, from the page (its serverSession from health). */
async function windowPost(page: Page, path: string, body: Record<string, unknown>): Promise<number> {
  return page.evaluate(
    async ({ path, body }) => {
      const health = (await (await fetch('/api/inbox/health')).json()) as { serverSession: string };
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, serverSession: health.serverSession }) });
      return res.status;
    },
    { path, body },
  );
}

const replyApi = (page: Page, messageId: string, words: string) => windowPost(page, `/api/inbox/messages/${messageId}/reply`, { idempotency_key: `k-${messageId}`, words });

async function openQuiet(page: Page): Promise<void> {
  const band = page.locator('[data-section-id="quiet"] .ib-band');
  await expect(band).toBeVisible();
  if ((await band.getAttribute('aria-expanded')) !== 'true') await band.click();
  await expect(band).toHaveAttribute('aria-expanded', 'true');
}

async function ticksShot(page: Page, name: string): Promise<void> {
  mkdirSync(ticksDir, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(ticksDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test('a turn ending moves the row from queued to sending live: no store line, no reload', async () => {
  const { page } = world;
  for (const c of world.connections.splice(0)) await c.stop();
  const sent = await (await freshAgent()).send({ project_path: world.ledger, subject: 'Flaky test quarantined', body: 'I quarantined the flaky ledger test. Want a ticket for it?' }, { wakes: true });
  const connection = new Connection(await sessionOf(sent.thread_id), true);
  world.connections.push(connection);
  await page.goto(world.url);
  await page.reload();
  await expect.poll(() => replyApi(page, sent.message_id, 'Yes, file one.')).toBe(200);
  const tick = page.locator(`.ib-lbody [data-thread-id="${sent.thread_id}"] .ib-tick`).first();
  await expect(tick).toHaveAttribute('data-tick', 'queued');
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
  connection.setBusy(false);
  await expect(tick).toHaveAttribute('data-tick', 'sending', { timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  connection.setBusy(true);
  await expect(tick).toHaveAttribute('data-tick', 'queued', { timeout: 10_000 });
});

test('the ticks on wide rows, beside a thread and on a phone, light and dark; the dots are still under reduced motion', async ({ browser }) => {
  const { page } = world;
  for (const c of world.connections.splice(0)) await c.stop();
  const make = async (subject: string, body: string, wakes: boolean) => (await freshAgent()).send({ project_path: world.ledger, subject, body }, wakes ? { wakes: true } : {});
  const queued = await make('Retry policy for the Stripe webhook', 'Exponential, capped at 5 tries?', true);
  const sending = await make('Visibility timeout for ledger-writes', 'I set it to 90 s. Fine?', true);
  const saved = await make('App Store screenshots: light or dark?', 'Which ones should I ship?', false);
  const delivered = await make('Search index for the docs site', 'The index builds in 4 s now.', true);
  const acked = await make('Invoice PDF renders in 40 ms now', 'The invoice PDF renders in 40 ms.', true);
  const busy = new Connection(await sessionOf(queued.thread_id), true);
  const idle = new Connection(await sessionOf(sending.thread_id), false);
  const done = new Connection(await sessionOf(delivered.thread_id), true);
  world.connections.push(busy, idle, done);

  await page.goto(world.url);
  await page.reload();
  for (const [sent, words] of [
    [queued, 'Yes, and log each retry.'],
    [sending, 'Make it 120 s.'],
    [saved, 'Light, with one dark.'],
    [delivered, 'Nice. Ship it.'],
  ] as const) {
    await expect.poll(() => replyApi(page, sent.message_id, words)).toBe(200);
  }
  await expect.poll(() => done.commands.length, { timeout: 15_000 }).toBe(1);
  await done.deliver(done.commands[0]!.id);
  await expect.poll(() => windowPost(page, `/api/inbox/messages/${acked.message_id}/ack`, {})).toBe(200);

  const tickOf = (p: Page, threadId: string) => p.locator(`.ib-lbody [data-thread-id="${threadId}"] .ib-tick`).first();
  const expectStates = async (p: Page) => {
    await expect(tickOf(p, queued.thread_id)).toHaveAttribute('data-tick', 'queued');
    await expect(tickOf(p, sending.thread_id)).toHaveAttribute('data-tick', 'sending');
    await expect(tickOf(p, saved.thread_id)).toHaveAttribute('data-tick', 'saved');
    await expect(tickOf(p, delivered.thread_id)).toHaveAttribute('data-tick', 'delivered');
    await expect(tickOf(p, acked.thread_id)).toHaveAttribute('data-tick', 'queued');
    await expect(tickOf(p, acked.thread_id)).toHaveAttribute('aria-label', 'Looks good, queued for Claude Code,');
  };

  // Wide rows, 1440.
  await page.reload();
  await openQuiet(page);
  await expectStates(page);
  // Sent rows keep their own subject.
  await expect(page.locator(`.ib-lbody [data-thread-id="${saved.thread_id}"] .ib-title`).first()).toHaveText('App Store screenshots: light or dark?');
  // The dots breathe, and stand still under reduced motion.
  const dot = tickOf(page, sending.thread_id).locator('.ib-dots i').first();
  expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe('ib-dots');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await dot.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await ticksShot(page, 'ticks-wide-1440');

  // Beside a thread, 1280: the two-line rows carry the same glyphs.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${world.url}#thread=${queued.thread_id}`);
  await expect(page.locator('section.ib-pane').getByRole('heading', { name: 'Retry policy for the Stripe webhook' })).toBeVisible();
  await openQuiet(page);
  await expectStates(page);
  await ticksShot(page, 'ticks-beside-thread-1280');
  await page.setViewportSize({ width: 1440, height: 900 });

  // A phone.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' });
  try {
    const phone = await context.newPage();
    await phone.goto(world.url);
    await openQuiet(phone);
    await expectStates(phone);
    expect(await phone.locator('.ib-mrow .ib-tick').count()).toBeGreaterThanOrEqual(5);
    await ticksShot(phone, 'ticks-phone');
    await phone.locator('[data-section-id="quiet"]').scrollIntoViewIfNeeded();
    await ticksShot(phone, 'ticks-phone-quiet');
  } finally {
    await context.close();
  }
  expect(world.errors).toEqual([]);
});
