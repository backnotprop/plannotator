/**
 * The Inbox window when its live connection dies without closing (in-app
 * feedback, 0.28.38: "an open thread did not update until I reloaded"),
 * proved in headless Chromium against the compiled binary, with an agent
 * writing through `plannotator inbox mcp` (scripts/inbox-sim.ts).
 *
 * The page reaches the Inbox through a small proxy in this spec, the honest
 * stand-in for a connection that dies silently (a proxy holding the stream
 * back, a socket dropped while the laptop slept): `stall()` keeps every open
 * event stream's socket open and passes on nothing more, and holds each new
 * one unanswered; `heal()` answers the held ones. Every other request goes
 * through untouched.
 *
 * - Stalled: a thread is open; the stream stalls; the agent writes in that
 *   thread. Within the page's silence window (25 s, liveStream.ts) the open
 *   thread shows the message, "Reconnecting…" shows under the list (and the
 *   live region says it), and it goes once the stream is back. The build
 *   before this change never shows the message (run with
 *   PLANNOTATOR_E2E_BINARY pointing at a build of main: this test fails).
 * - Healthy: for about 30 s with nothing written, the note never shows, the
 *   list and the open thread are not read again and the stream is not opened
 *   again.
 * - Shots (PLANNOTATOR_LIVE_RECONNECT_SHOTS, a folder): the list with the note
 *   (1440 by 900 at 2x, light and dark; a phone, 390 by 844 at 3x) and the
 *   healthy list.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-live-reconnect.spec.ts`.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = process.env.PLANNOTATOR_LIVE_RECONNECT_SHOTS ? resolve(process.env.PLANNOTATOR_LIVE_RECONNECT_SHOTS) : null;

/** The page's silence window (liveStream.ts STREAM_STALE_MS) and the note's grace (DEAD_NOTE_DELAY_MS). */
const STALE_MS = 25_000;
const NOTE_DELAY_MS = 3_000;

/** A pass-through proxy that can hold the Inbox's event streams back. */
class StallingProxy {
  private server: http.Server;
  private sockets = new Set<Socket>();
  private streams = new Set<{ stalled: boolean; res: http.ServerResponse }>();
  private held: { forward: () => void; res: http.ServerResponse }[] = [];
  private stalled = false;
  port = 0;
  /** Event-stream requests the browser made (not `once=1` catch-ups). */
  streamOpens = 0;
  /** Event-stream bytes passed on, and the heartbeats among them. */
  heartbeats = 0;

  constructor(private target: number) {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  listen(): Promise<void> {
    return new Promise((done) => this.server.listen(0, '127.0.0.1', () => {
      this.port = (this.server.address() as { port: number }).port;
      done();
    }));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const stream = url.pathname === '/api/inbox/events' && url.searchParams.get('once') !== '1';
    const forward = () => {
      // Host and Origin stay the page's own (loopback, this port): the Inbox sees a same-origin page.
      const up = http.request({ host: '127.0.0.1', port: this.target, method: req.method, path: req.url, headers: req.headers }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        if (!stream) {
          upRes.pipe(res);
          return;
        }
        const entry = { stalled: false, res };
        this.streams.add(entry);
        upRes.on('data', (chunk: Buffer) => {
          if (entry.stalled) return;
          this.heartbeats += chunk.toString('utf8').split('event: heartbeat').length - 1;
          res.write(chunk);
        });
        upRes.on('end', () => {
          this.streams.delete(entry);
          res.end();
        });
        res.on('close', () => {
          this.streams.delete(entry);
          up.destroy();
        });
      });
      up.on('error', () => res.destroy());
      if (req.method === 'GET' || req.method === 'HEAD') up.end();
      else req.pipe(up);
    };
    if (!stream) return forward();
    this.streamOpens += 1;
    if (this.stalled) {
      const entry = { forward, res };
      this.held.push(entry);
      res.on('close', () => {
        this.held = this.held.filter((h) => h !== entry);
      });
      return;
    }
    forward();
  }

  /** Every open stream goes silent (its socket stays open); new ones are held unanswered. */
  stall(): void {
    this.stalled = true;
    for (const entry of this.streams) entry.stalled = true;
  }
  /** The held streams are answered; new ones go through. The silenced ones stay silent, as a dead socket does. */
  heal(): void {
    this.stalled = false;
    for (const entry of this.held.splice(0)) if (!entry.res.destroyed) entry.forward();
  }
  get openStreams(): number {
    return this.streams.size;
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((done) => this.server.close(() => done()));
  }
}

interface World {
  inbox: string;
  agent: SimAgent;
  path: string;
  proxy: StallingProxy;
}
let world: World;
let sent = 0;

async function agentStarts(subject: string): Promise<string> {
  sent += 1;
  const reply = await world.agent.send({ project_path: world.path, subject, body: `${subject}. Nothing to answer yet.`, agent_session: `ses_live_${sent}` } as Parameters<SimAgent['send']>[0]);
  return String(reply.thread_id);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-live-reconnect-e2e-');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(env.PLANNOTATOR_DATA_DIR);
  const inbox = started.stdout.trim().replace(/\/$/, '');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const path = scratchProject(join(root, 'src'), 'billing-svc');
  const proxy = new StallingProxy(Number(new URL(inbox).port));
  await proxy.listen();
  world = { inbox, agent, path, proxy };
  for (const subject of ['Retry budget for the webhook worker', 'Ledger export columns', 'Flaky invoice e2e']) await agentStarts(subject);
});

test.afterAll(async () => {
  try {
    await world?.proxy.close().catch(() => {});
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const pageUrl = () => `http://127.0.0.1:${world.proxy.port}/`;
const note = (page: Page) => page.locator('[data-inbox-reconnecting]');
const row = (page: Page, id: string) => page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`);

/** Counts what the page asks for, and whether the note ever showed (an observer from the page's first script). */
async function watched(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __noteSeen: number }).__noteSeen = 0;
    new MutationObserver(() => {
      if (document.querySelector('[data-inbox-reconnecting]')) (window as unknown as { __noteSeen: number }).__noteSeen += 1;
    }).observe(document, { subtree: true, childList: true });
  });
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/inbox/')) requests.push(`${url.pathname}${url.search}`);
  });
  return requests;
}
const noteSeen = (page: Page) => page.evaluate(() => (window as unknown as { __noteSeen: number }).__noteSeen);

async function openList(page: Page): Promise<void> {
  await page.goto(pageUrl());
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  // The stream is open and has said hello through the proxy.
  await expect.poll(() => world.proxy.openStreams).toBeGreaterThanOrEqual(1);
}

test('the stream stalls with a thread open: the agent\'s new message shows within the window, "Reconnecting…" shows, and goes when the stream is back', async ({ page }) => {
  test.setTimeout(150_000);
  const requests = await watched(page);
  const threadId = await agentStarts('Rollout plan for the retry budget');
  await openList(page);
  await row(page, threadId).click();
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('h2.ib-subject')).toContainText('Rollout plan for the retry budget');
  await page.waitForTimeout(1_000);

  world.proxy.stall();
  const stalledAt = Date.now();
  const body = `Canary at 5% is green; moving to 25% (${Date.now()}).`;
  await world.agent.send({ project_path: world.path, reply_to: threadId, body } as Parameters<SimAgent['send']>[0]);
  await page.waitForTimeout(3_000);
  // Nothing reaches the page through the dead stream.
  await expect(pane.getByText(body)).toHaveCount(0);

  // Within the window (from the last frame the page heard, before the stall) plus a margin: the catch-up read the thread.
  await expect(pane.getByText(body)).toBeVisible({ timeout: STALE_MS + 10_000 });
  // The reconnect is held too: after the grace, the quiet line under the list.
  await expect(note(page)).toBeVisible({ timeout: NOTE_DELAY_MS + 10_000 });
  await expect(note(page)).toHaveText('Reconnecting…');
  await expect(page.locator('[data-inbox-live]')).toHaveText('Reconnecting…');
  expect(Date.now() - stalledAt).toBeLessThan(STALE_MS + NOTE_DELAY_MS + 10_000);
  // The catch-up read the list and the open thread through the usual paths.
  expect(requests.some((r) => r.startsWith('/api/inbox/threads?'))).toBe(true);

  world.proxy.heal();
  await expect(note(page)).toHaveCount(0, { timeout: 10_000 });
  // The live region said it once, and says nothing of the return.
  await expect(page.locator('[data-inbox-live]')).toHaveText('Reconnecting…');

  // Live again: the next message arrives through the stream, at once.
  const next = `Moved to 25%; error rate flat (${Date.now()}).`;
  await world.agent.send({ project_path: world.path, reply_to: threadId, body: next } as Parameters<SimAgent['send']>[0]);
  await expect(pane.getByText(next)).toBeVisible({ timeout: 5_000 });
});

test('healthy for about 30 s: the note never shows, nothing is read again, the stream is not opened again', async ({ page }) => {
  test.setTimeout(120_000);
  const requests = await watched(page);
  const threadId = await agentStarts('Quiet thread');
  await openList(page);
  await row(page, threadId).click();
  await expect(page.locator('section.ib-pane h2.ib-subject')).toContainText('Quiet thread');
  // The first reads settle (the agents are read once more 2.5 s after load).
  await page.waitForTimeout(4_000);
  const before = requests.length;
  const opens = world.proxy.streamOpens;
  const beats = world.proxy.heartbeats;
  await page.waitForTimeout(32_000);
  const during = requests.slice(before);
  // The list read and the open thread's own read (its sessions line polls on its own, as before this change).
  const threadRead = `/api/inbox/threads/${threadId}`;
  expect(during.filter((r) => r.startsWith('/api/inbox/threads?') || r === threadRead || r.startsWith(`${threadRead}?`))).toEqual([]);
  expect(during.filter((r) => r.startsWith('/api/inbox/events'))).toEqual([]);
  expect(world.proxy.streamOpens).toBe(opens);
  expect(await noteSeen(page)).toBe(0);
  await expect(note(page)).toHaveCount(0);
  // The stream was alive throughout: the window's heartbeat came every 10 s.
  expect(world.proxy.heartbeats - beats).toBeGreaterThanOrEqual(3);
});

test('shots: the list with "Reconnecting…" (light, dark, a phone) and the healthy list', async ({ browser }) => {
  test.skip(!shotsDir, 'set PLANNOTATOR_LIVE_RECONNECT_SHOTS to a folder');
  test.setTimeout(150_000);
  mkdirSync(shotsDir!, { recursive: true });
  const open = async (b: Browser, options: Parameters<Browser['newContext']>[0]) => {
    const context = await b.newContext(options);
    const page = await context.newPage();
    await openList(page);
    await page.mouse.move(5, 895);
    return page;
  };
  const light = await open(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const dark = await open(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const phone = await open(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  // Rows lit on arrival fade first.
  await light.waitForTimeout(1_500);
  await light.screenshot({ path: join(shotsDir!, 'healthy-list-light.png') });
  await dark.screenshot({ path: join(shotsDir!, 'healthy-list-dark.png') });
  await phone.screenshot({ path: join(shotsDir!, 'healthy-list-phone.png') });
  world.proxy.stall();
  for (const page of [light, dark, phone]) await expect(note(page)).toBeVisible({ timeout: STALE_MS + NOTE_DELAY_MS + 15_000 });
  await light.screenshot({ path: join(shotsDir!, 'reconnecting-list-light.png') });
  await dark.screenshot({ path: join(shotsDir!, 'reconnecting-list-dark.png') });
  await phone.screenshot({ path: join(shotsDir!, 'reconnecting-list-phone.png') });
  world.proxy.heal();
  for (const page of [light, dark, phone]) {
    await expect(note(page)).toHaveCount(0, { timeout: 10_000 });
    await page.context().close();
  }
});
