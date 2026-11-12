import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_MESSAGE_INSTRUCTION,
  INBOX_WAKE_CLOSING_LINE,
  inboxWakeText,
  parseInboxBridgeCommands,
  type InboxReplyCommand,
} from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'new-message');
const SUBJECT = 'Run finished. A guided review of the export change is attached.';

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  ledger: string;
  pi: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  writer: string;
  connections: Connection[];
}

let world: World;

function registry(): { pid: number; port: number; token: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

class Connection {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = false;
  private loop: Promise<void>;
  constructor(
    readonly session: string,
    private readonly projectPath: string,
    readonly startedAt: number,
    private busy: boolean,
  ) {
    this.loop = this.run();
  }

  private bridge(path: string, body: Record<string, unknown>): Promise<Response> {
    const { port, token } = registry();
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session: this.session, host: 'pi', ...body }),
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const response = await this.bridge(INBOX_BRIDGE_POLL_PATH, {
        waitMs: 1_000,
        project_path: this.projectPath,
        started_at: this.startedAt,
        busy: this.busy,
        idle_since: this.startedAt,
      }).catch(() => null);
      if (!response) continue;
      for (const command of parseInboxBridgeCommands(await response.text())) {
        if (!this.commands.some((known) => known.id === command.id)) this.commands.push(command);
      }
    }
  }

  async setBusy(busy: boolean): Promise<void> {
    this.busy = busy;
    expect((await this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'state', busy })).status).toBe(200);
  }

  async deliver(id: string): Promise<void> {
    expect((await this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'delivered', id })).status).toBe(200);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

async function connect(session: string, startedAt: number, busy = false): Promise<Connection> {
  const connection = new Connection(session, world.ledger, startedAt, busy);
  world.connections.push(connection);
  return connection;
}

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function threadMessages(): Promise<{ id: string; author: { kind: string }; to?: { host: string; session: string } | null }[]> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${world.threadId}`);
  return ((await response.json()) as { thread: { messages: never[] } }).thread.messages;
}


test.describe.configure({ mode: 'serial' });

async function windowPost(path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, any> }> {
  const response = await world.page.request.post(`${world.url.replace(/\/$/, '')}${path}`, { data: body });
  return { status: response.status(), json: (await response.json()) as Record<string, any> };
}

async function liveSessions(): Promise<{ session: string; started_at: string; busy: boolean; wrote_thread: boolean }[]> {
  const response = await world.page.request.get(`${world.url.replace(/\/$/, '')}/api/inbox/threads/${world.threadId}/sessions`);
  return ((await response.json()) as { sessions: { session: string; started_at: string; busy: boolean; wrote_thread: boolean }[] }).sessions;
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-new-message-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
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
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const sent = await pi.send({
    project_path: ledger,
    subject: SUBJECT,
    body: 'The export now streams rows to the file instead of building it in memory. Peak memory on the March ledger went from 1.9 GB to 140 MB.',
  });
  world = { root, dataDir, env, url, ledger, pi, context, page, errors, threadId: sent.thread_id, writer: '', connections: [] };
  const [root0] = await threadMessages();
  world.writer = (root0 as unknown as { author: { session: string } }).author.session;
  expect(world.writer).toMatch(/^ses_/);
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.connections.map((c) => c.stop()));
    await world.pi.close().catch(() => {});
    await world.context.close();
    const names = [...new Set(readdirSync(proofDir).filter((f) => f.endsWith('-light.png')).map((f) => f.replace(/-light\.png$/, '')))].sort();
    writeFileSync(
      join(proofDir, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>Plannotator Inbox New message: proof</title><style>body{font:14px system-ui;margin:24px;background:#e9eaee}h2{font-size:15px;margin:24px 0 8px}.pair{display:flex;gap:12px}.pair img{width:calc(50% - 6px);box-shadow:0 0 0 1px #0002;border-radius:6px}</style><h1>Plannotator Inbox New message: every proved state, light and dark, 1440 by 900</h1>${names
        .map((n) => `<section><h2>${n}</h2><div class="pair"><img src="${n}-light.png" alt="${n} light"><img src="${n}-dark.png" alt="${n} dark"></div></section>`)
        .join('\n')}`,
    );
  } finally {
    await removeInboxScratch();
  }
});

test('one live session (5.1): a message sent through the route is drawn "to Pi", delivered once through the wake path, and the thread says Delivered', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: SUBJECT })).toBeVisible();
  await expect(pane.locator('[data-new-message]')).toHaveCount(0);
  const startedAt = Date.now() - 60 * 60_000;
  const writer = await connect(world.writer, startedAt);
  await expect.poll(async () => (await liveSessions()).map((l) => l.session), { timeout: 15_000 }).toEqual([world.writer]);
  const words = 'While you are in there, add a header row to the CSV export.';
  const sent = await windowPost(`/api/inbox/threads/${world.threadId}/message`, { session: world.writer, body: words, idempotency_key: 'nm-1' });
  expect(sent.status).toBe(200);

  const mine = pane.locator('article.ib-message[data-author="person"]');
  await expect(mine).toHaveCount(1);
  await expect(mine.locator('.ib-who')).toHaveText('You');
  await expect(mine.locator('.ib-fl-meta')).toContainText('in ledger');
  await expect(mine.locator('.ib-to')).toHaveText('to Pi');
  await expect(mine).toContainText(words);
  const command = await waitFor('the message command', () => writer.commands[0]);
  expect(command).toMatchObject({ type: 'message', reply_to: null, thread_id: world.threadId, subject: null, body: words });
  const wake = inboxWakeText(command);
  expect(wake.split('\n').slice(0, 2)).toEqual([`Plannotator Inbox: a message (${command.id})`, INBOX_MESSAGE_INSTRUCTION]);
  expect(wake).not.toContain(SUBJECT);
  expect(wake.endsWith(`\n\n${words}\n\n${INBOX_WAKE_CLOSING_LINE}`)).toBe(true);
  const messages = await threadMessages();
  expect(messages.at(-1)).toMatchObject({ id: command.id, author: { kind: 'person' }, to: { host: 'pi', session: world.writer } });
  await expect(pane.locator('[data-delivery="sending"]')).toHaveText('Sending to Pi…');

  await writer.deliver(command.id);
  await expect(pane.locator('[data-delivery="delivered"]')).toHaveText(/^Delivered to Pi, (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d{2} [AP]M$/);
  await page.waitForTimeout(2_500);
  expect(writer.commands).toHaveLength(1);
  await shot('5.1-delivered');
});

test('two live sessions (5.2): the list puts the writer first; the picked session gets the message, the other nothing', async () => {
  const { page } = world;
  const writer = world.connections[0]!;
  const laterStart = Date.now() - 5 * 60_000;
  const second = await connect('pi-session-two', laterStart, true);
  const pane = page.locator('section.ib-pane');
  await expect.poll(async () => (await liveSessions()).length, { timeout: 15_000 }).toBe(2);
  const sessions = await liveSessions();
  expect(sessions.map((l) => l.session)).toEqual([world.writer, 'pi-session-two']);
  expect(sessions[0]).toMatchObject({ wrote_thread: true, busy: false, started_at: new Date(writer.startedAt).toISOString() });
  expect(sessions[1]).toMatchObject({ wrote_thread: false, busy: true, started_at: new Date(laterStart).toISOString() });

  const words = 'When this turn ends, rerun the March export and post the peak memory.';
  const sent = await windowPost(`/api/inbox/threads/${world.threadId}/message`, { session: 'pi-session-two', body: words, idempotency_key: 'nm-2' });
  expect(sent.status).toBe(200);
  await expect(pane.locator('article.ib-message[data-author="person"]').last()).toContainText(words);
  const command = await waitFor('the second session handed the message', () => second.commands[0]);
  expect(command).toMatchObject({ type: 'message', body: words });
  await page.waitForTimeout(2_000);
  expect(writer.commands).toHaveLength(1);
  expect((await threadMessages()).at(-1)).toMatchObject({ id: command.id, to: { host: 'pi', session: 'pi-session-two' } });

  await second.setBusy(false);
  await second.deliver(command.id);
  await expect(pane.locator('[data-delivery="delivered"]')).toHaveText(/^Delivered to Pi, (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d{2} [AP]M$/);
  await shot('5.2-delivered-to-the-picked-session');
});

test('a session that stops polling leaves the list, and a message to it is refused; the page logged no errors', async () => {
  const { page } = world;
  for (const connection of world.connections) await connection.stop();
  world.connections = [];
  await page.waitForTimeout(31_000);
  expect(await liveSessions()).toEqual([]);
  const refused = await windowPost(`/api/inbox/threads/${world.threadId}/message`, { session: world.writer, body: 'Anyone there?', idempotency_key: 'nm-3' });
  expect([refused.status, refused.json.code]).toEqual([409, 'session_not_live']);
  expect(world.errors).toEqual([]);
});
