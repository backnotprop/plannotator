/**
 * The Inbox's debug log (`PLANNOTATOR_INBOX_DEBUG=1`) on a stall, in WebKit and Chromium against the compiled binary.
 * The page reaches the Inbox through a TCP relay that lets one request's connection die without a word: it stops
 * forwarding, with no reset and no close. Send stays dim, the page is refreshed, and the file must say what the old
 * page was waiting on: that is what the window's local buffer is for. Each case asks a different question:
 *
 * - a healthy Send: each step on both sides, in order, so a stall is read against what normal looks like;
 * - the reply POST never arrived: the window started it, and the server has no line for that id;
 * - the reply landed and its answer was lost: the server ended it with a 200, and the window has no end;
 * - a pick hung: the open request is the pick, and no reply was ever started.
 *
 * Off (the default) writes no file and keeps nothing in the page. Set PLANNOTATOR_E2E_SHOW_LOG=1 to print the lines.
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-debug-log.spec.ts`.
 */

import { expect, test, devices, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

type Line = Record<string, unknown>;

/** The link to the Inbox. `cutAt`: the connection carrying that request goes silent, and only that one. */
class Link {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  private cut: { marker: string; arrives: boolean } | null = null;
  port = 0;
  /** The window's sends of its buffer that came through. */
  flushes = 0;

  constructor(target: number) {
    this.server = net.createServer((client) => {
      const up = net.connect(target, '127.0.0.1');
      const state = { silentUp: false, silentDown: false };
      this.sockets.add(client).add(up);
      client.on('data', (chunk: Buffer) => {
        if (chunk.includes('POST /api/inbox/debug/log')) this.flushes += 1;
        if (this.cut && chunk.includes(this.cut.marker)) {
          state.silentDown = true;
          state.silentUp = !this.cut.arrives;
          this.cut = null;
        }
        if (!state.silentUp) up.write(chunk);
      });
      up.on('data', (chunk: Buffer) => {
        if (!state.silentDown) client.write(chunk);
      });
      client.on('close', () => {
        if (!state.silentDown) up.destroy();
      });
      up.on('close', () => {
        if (!state.silentDown) client.destroy();
      });
      client.on('error', () => {});
      up.on('error', () => {});
    });
  }

  listen(): Promise<void> {
    return new Promise((done) =>
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        done();
      }),
    );
  }

  cutAt(marker: string, arrives: boolean): void {
    this.cut = { marker, arrives };
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
  }
}

let root = '';
const started: { dataDir: string; url: string; agent: SimAgent }[] = [];

test.describe.configure({ mode: 'serial' });

async function inbox(name: string, debug: boolean) {
  const dataDir = join(root, name);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    ...(debug ? { PLANNOTATOR_INBOX_DEBUG: '1' } : {}),
  };
  const run = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(run.status, run.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const entry = { dataDir, url: run.stdout.trim(), agent: await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' }) };
  started.push(entry);
  return entry;
}

test.beforeAll(() => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  root = inboxScratch('plannotator-inbox-debug-e2e-');
});

test.afterAll(async () => {
  try {
    for (const { agent } of started.splice(0)) await agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const { defaultBrowserType: _webkit, ...iphone } = devices['iPhone 15'];
const footSend = (page: Page) => page.locator('section.ib-pane .ib-pfoot button.ib-pri').filter({ hasText: 'Send' });
const nine = (subject: string) => [`${subject}.`, '', ...Array.from({ length: 9 }, (_, i) => [':::question', `Decision ${i + 1}: keep it?`, '', '- [ ] Yes', '- [ ] No', ':::', ''].join('\n'))].join('\n');

let threads = 0;
async function open(browser: Browser, world: Awaited<ReturnType<typeof inbox>>, origin: string): Promise<{ thread: string; page: Page }> {
  threads += 1;
  const subject = `Debug check ${threads}`;
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  const sent = await world.agent.send({ project_path: project, subject, body: nine(subject), agent_session: `ses_debug_${threads}` });
  const context = await browser.newContext(iphone);
  const page = await context.newPage();
  await page.goto(`${origin}#thread=${sent.thread_id}`);
  await expect(page.locator('fieldset[data-question-key]')).toHaveCount(9);
  return { thread: sent.thread_id as string, page };
}

async function pick(page: Page, count: number, from = 0): Promise<void> {
  const cards = page.locator('fieldset[data-question-key]');
  for (let i = from; i < from + count; i += 1) {
    await cards.nth(i).locator('[data-question-option]').filter({ hasText: 'Yes' }).click();
    await expect(cards.nth(i).locator('input:checked')).toHaveCount(1);
  }
}

const logOf = (dataDir: string): Line[] => {
  const path = join(dataDir, 'inbox', 'debug.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line);
};

const windowEv = (lines: Line[], ev: string, route?: string) => lines.filter((l) => l.side === 'window' && l.ev === ev && (route === undefined || l.route === route));

/** Lines that say an answer came. */
const answered = (lines: Line[]) => lines.filter((l) => l.ev === 'req_head' || l.ev === 'req_end');

/** The window's lines for the stalled press, after the refresh has sent them, in time order. */
function show(lines: Line[], label: string): void {
  if (!process.env.PLANNOTATOR_E2E_SHOW_LOG) return;
  const press = Number(windowEv(lines, 'send_press').at(-1)?.t ?? 0);
  const around = lines.filter((l) => Number(l.t) >= press - 200).sort((a, b) => Number(a.t) - Number(b.t));
  console.log(`--- ${label}\n${around.map((l) => JSON.stringify(l)).join('\n')}`);
}

test('off: nothing is written and the page keeps nothing', async ({ browser }) => {
  const world = await inbox('off', false);
  const { thread, page } = await open(browser, world, world.url);
  await pick(page, 8);
  await footSend(page).click();
  await expect(footSend(page)).toHaveCount(0);
  expect(thread).toBeTruthy();
  expect(existsSync(join(world.dataDir, 'inbox', 'debug.log'))).toBe(false);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('debug')))).toEqual([]);
});

test('a healthy Send on this computer: press, the reply on both sides, clear, with the page\'s protocol', async ({ browser }) => {
  const world = await inbox('healthy', true);
  const { page } = await open(browser, world, world.url);
  await page.reload();
  await expect(page.locator('fieldset[data-question-key]')).toHaveCount(9);
  await pick(page, 8);
  await footSend(page).click();
  await expect(footSend(page)).toHaveCount(0);
  await expect.poll(() => windowEv(logOf(world.dataDir), 'send_clear').length, { timeout: 15_000 }).toBe(1);
  const lines = logOf(world.dataDir);
  show(lines, 'a healthy Send');
  const end = lines.find((l) => l.side === 'server' && l.ev === 'req_end' && String(l.route).endsWith('/reply'))!;
  expect(end).toMatchObject({ status: 200, via: 'local' });
  expect(lines.filter((l) => l.id === end.id && l.side === 'window').map((l) => l.ev)).toEqual(['req_start', 'req_head', 'req_end']);
  const order = [...lines].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0)).filter((l) => l.side === 'window' && l.id === end.id || l.ev === 'send_press' || l.ev === 'send_clear').map((l) => l.ev);
  expect(order).toEqual(['send_press', 'req_start', 'req_head', 'req_end', 'send_clear']);
  expect(windowEv(lines, 'page_load').at(-1)?.protocol).toBeTruthy();
});

test('the reply never arrived: after a refresh the file shows the window started it and the server never saw it', async ({ browser }) => {
  const world = await inbox('never-arrived', true);
  const link = new Link(Number(new URL(world.url).port));
  await link.listen();
  try {
    const { page } = await open(browser, world, `http://127.0.0.1:${link.port}/`);
    await pick(page, 8);
    link.cutAt('/reply HTTP/', false);
    await footSend(page).click();
    await expect(footSend(page)).toBeDisabled();
    // The timed send (every 5 s) waits while a request is out: a stalled page sends nothing until the refresh.
    await page.waitForTimeout(500);
    const flushed = link.flushes;
    await page.waitForTimeout(6_000);
    expect(link.flushes).toBe(flushed);
    await expect(footSend(page)).toBeDisabled();

    await page.reload();
    await expect.poll(() => windowEv(logOf(world.dataDir), 'send_press').length, { timeout: 15_000 }).toBe(1);
    const lines = logOf(world.dataDir);
    show(lines, 'the reply never arrived');
    const started = lines.filter((l) => l.side === 'window' && l.ev === 'req_start' && String(l.route).endsWith('/reply'));
    expect(started).toHaveLength(1);
    const mine = lines.filter((l) => l.id === started[0]!.id);
    expect(mine.filter((l) => l.side === 'server')).toEqual([]);
    expect(answered(mine)).toEqual([]);
    // WebKit fails what is open as the reload starts, a few ms before page_hide; that is the reload, not the network.
    const hide = Number(windowEv(lines, 'page_hide').find((l) => l.page === started[0]!.page)?.t);
    const failed = mine.find((l) => l.ev === 'req_fail');
    if (failed) expect(hide - Number(failed.t)).toBeLessThan(200);
  } finally {
    link.close();
  }
});

test('the reply landed and its answer was lost: the server ended it, and the window has no end', async ({ browser }) => {
  const world = await inbox('answer-lost', true);
  const link = new Link(Number(new URL(world.url).port));
  await link.listen();
  try {
    const { page } = await open(browser, world, `http://127.0.0.1:${link.port}/`);
    await pick(page, 8);
    link.cutAt('/reply HTTP/', true);
    await footSend(page).click();
    await expect.poll(() => logOf(world.dataDir).filter((l) => l.side === 'server' && l.ev === 'req_end' && String(l.route).endsWith('/reply')).length).toBe(1);
    await page.waitForTimeout(500);

    await page.reload();
    await expect.poll(() => windowEv(logOf(world.dataDir), 'send_press').length, { timeout: 15_000 }).toBe(1);
    const lines = logOf(world.dataDir);
    show(lines, 'the answer was lost');
    const end = lines.find((l) => l.side === 'server' && l.ev === 'req_end' && String(l.route).endsWith('/reply'))!;
    expect(end.status).toBe(200);
    const mine = lines.filter((l) => l.id === end.id && l.side === 'window');
    expect(mine[0]?.ev).toBe('req_start');
    expect(answered(mine)).toEqual([]);
  } finally {
    link.close();
  }
});

test('a pick hung: the open request is the pick, and no reply was ever started', async ({ browser }) => {
  const world = await inbox('pick-hung', true);
  const link = new Link(Number(new URL(world.url).port));
  await link.listen();
  try {
    const { page } = await open(browser, world, `http://127.0.0.1:${link.port}/`);
    await pick(page, 7);
    link.cutAt('/picks HTTP/', false);
    await pick(page, 1, 7);
    await footSend(page).click();
    await expect(footSend(page)).toBeDisabled();
    await page.waitForTimeout(1_000);

    const refreshed = Date.now();
    await page.reload();
    await expect.poll(() => windowEv(logOf(world.dataDir), 'send_press').length, { timeout: 15_000 }).toBe(1);
    const lines = logOf(world.dataDir);
    show(lines, 'a pick hung');
    const ended = new Set(lines.filter((l) => l.side === 'window' && l.ev === 'req_end').map((l) => l.id));
    const waiting = lines.filter((l) => l.side === 'window' && l.ev === 'req_start' && !ended.has(l.id) && String(l.route).endsWith('/picks'));
    expect(waiting).toHaveLength(1);
    // Until the refresh failed the pick, Send waited on it: no reply had started.
    expect(lines.filter((l) => l.ev === 'req_start' && String(l.route).endsWith('/reply') && Number(l.t) < refreshed)).toEqual([]);
  } finally {
    link.close();
  }
});
