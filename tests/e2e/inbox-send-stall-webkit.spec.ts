/**
 * A Send never stays dim without an end (the owner, on a phone over 5G: "the send
 * button turns dimmed after sending but never sends"), proved in WebKit with an
 * iPhone 15 against the compiled binary. A request here is held with `page.route`
 * and never answered, the way a stalled link or a queue in the browser holds one:
 *
 * - a reply POST that hangs ends with a line near Send, Send back and the picks kept;
 * - a reply that landed with its answer and read-back lost: the next Send looks for it
 *   first, and there is one reply;
 * - a hung list or thread read never holds Send once the reply is confirmed;
 * - a slow list with eight picks: one read at a time, and the reply is not behind them;
 * - a hung pick stops the Send: nothing goes without that answer;
 * - a hung draft save holds Send only for its limit, and a reload brings the words back;
 * - a reply on its way across a reload lands once (the key is kept on the device);
 * - a connection that dies without a word mid-request after a network change, through a
 *   TCP relay that stops forwarding and sends no reset: the reply landed or never arrived,
 *   Send ends, and the next Send leaves one reply;
 * - the Inbox restarted while Send waits: the out-of-date line, then one reply after a reload.
 *
 * Each timeout is the real one (20 s), so this spec takes a few minutes. Agents write
 * through `plannotator inbox mcp` (scripts/inbox-sim.ts). Runs in the playwright
 * config's `webkit` project. Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-send-stall-webkit.spec.ts`.
 */

import { expect, test, devices, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
/** WRITE_TIMEOUT_MS and a margin: what a held request costs, at most, before Send is back. */
const SEND_ENDS_MS = 35_000;

const REPLY = '**/api/inbox/messages/*/reply';
const PICKS = '**/api/inbox/messages/*/picks';
const LIST = '**/api/inbox/threads?*';
const THREAD_READ = /\/api\/inbox\/threads\/[^/?]+$/;
const DRAFT = '**/api/inbox/threads/*/draft';

let url = '';
let agent: SimAgent;
let project = '';
let dataDir = '';
let env: Record<string, string> = {};
const contexts: BrowserContext[] = [];

test.describe.configure({ mode: 'serial' });

function startInbox(): string {
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  return started.stdout.trim();
}

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-send-stall-e2e-');
  dataDir = join(root, 'data');
  env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  url = startInbox();
  project = scratchProject(join(root, 'src'), 'billing-svc');
  agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
});

test.afterAll(async () => {
  try {
    for (const context of contexts.splice(0)) await context.close().catch(() => {});
    await agent?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const { defaultBrowserType: _webkit, ...iphone } = devices['iPhone 15'];
const foot = (page: Page) => page.locator('section.ib-pane .ib-pfoot');
const footSend = (page: Page) => foot(page).locator('button.ib-pri').filter({ hasText: 'Send' });
const failure = (page: Page) => foot(page).locator('.ib-error');

const nineQuestions = (subject: string) =>
  [`${subject}.`, '', ...Array.from({ length: 9 }, (_, i) => [':::question', `Decision ${i + 1}: keep it?`, '', '- [ ] Yes', '- [ ] No', ':::', ''].join('\n'))].join('\n');

/**
 * The link between the phone and the Inbox, as plain TCP. `cutAt` is the moment the phone moves to
 * another network: every connection open then goes silent for good, with no reset and no close, so
 * neither end hears of it. `dark` holds new connections the same way, until the network is back.
 */
class Link {
  private server: net.Server;
  private pairs = new Set<{ client: net.Socket; up: net.Socket | null; silentUp: boolean; silentDown: boolean }>();
  private cut: { marker: string; arrives: boolean } | null = null;
  dark = false;
  port = 0;

  constructor(target: () => number) {
    this.server = net.createServer((client) => {
      const up = this.dark ? null : net.connect(target(), '127.0.0.1');
      const pair = { client, up, silentUp: this.dark, silentDown: this.dark };
      this.pairs.add(pair);
      client.on('data', (chunk: Buffer) => {
        const cut = this.cut;
        if (cut && chunk.includes(cut.marker)) {
          this.cut = null;
          this.dark = true;
          for (const p of this.pairs) p.silentUp = p.silentDown = true;
          // The one that reaches the Inbox: its request goes on arriving, and only its answer is lost.
          pair.silentUp = !cut.arrives;
        }
        if (!pair.silentUp) up?.write(chunk);
      });
      up?.on('data', (chunk: Buffer) => {
        if (!pair.silentDown) client.write(chunk);
      });
      const closed = (other: net.Socket | null, silent: () => boolean) => () => {
        if (!silent()) other?.destroy();
      };
      client.on('close', closed(up, () => pair.silentUp && pair.silentDown));
      up?.on('close', closed(client, () => pair.silentDown));
      client.on('error', () => {});
      up?.on('error', () => {});
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

  /** The next request carrying `marker` is the one the connection dies under. */
  cutAt(marker: string, arrives: boolean): void {
    this.cut = { marker, arrives };
  }

  close(): void {
    for (const { client, up } of this.pairs) {
      client.destroy();
      up?.destroy();
    }
    this.server.close();
  }
}

let threads = 0;
async function open(browser: Browser, link?: Link): Promise<{ thread: string; page: Page }> {
  threads += 1;
  const subject = `Send check ${threads}`;
  const sent = await agent.send({ project_path: project, subject, body: nineQuestions(subject), agent_session: `ses_stall_${threads}` });
  const thread = sent.thread_id as string;
  const context = await browser.newContext(iphone);
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${link ? `http://127.0.0.1:${link.port}/` : url}#thread=${thread}`);
  await expect(page.locator('section.ib-pane h2.ib-subject')).toBeVisible();
  return { thread, page };
}

async function pickEight(page: Page): Promise<void> {
  const cards = page.locator('fieldset[data-question-key]');
  await expect(cards).toHaveCount(9);
  for (let i = 0; i < 8; i += 1) {
    await cards.nth(i).locator('[data-question-option]').filter({ hasText: 'Yes' }).click();
    await expect(cards.nth(i).locator('input:checked')).toHaveCount(1);
  }
  await expect(foot(page)).toContainText('8 picks');
}

async function typeWords(page: Page, words: string): Promise<void> {
  if ((await page.locator('.ib-rtext').count()) === 0) await page.locator('[data-reply-button]').first().click();
  await page.locator('.ib-rtext').fill(words);
}

async function replies(thread: string): Promise<string[]> {
  const read = await fetch(new URL(`/api/inbox/threads/${thread}`, url));
  const { thread: t } = (await read.json()) as { thread: { messages: { author: { kind: string }; body: string }[] } };
  return t.messages.filter((m) => m.author.kind === 'person').map((m) => m.body);
}

/** Holds what matches for good: the request stays pending, as on a stalled link. */
const hold = (page: Page, match: string | RegExp, method?: string) =>
  page.route(match, (route: Route) => {
    if (method && route.request().method() !== method) return route.continue();
    // Never answered.
  });

test('a reply POST that never answers ends with a line near Send, Send back, the picks kept', async ({ browser }) => {
  const { thread, page } = await open(browser);
  await pickEight(page);
  await hold(page, REPLY);
  await footSend(page).click();
  await expect(footSend(page)).toBeDisabled();
  await expect(footSend(page)).toBeEnabled({ timeout: SEND_ENDS_MS });
  await expect(failure(page)).toContainText('may not have gone');
  await expect(foot(page)).toContainText('8 picks');
  expect(await replies(thread)).toHaveLength(0);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await footSend(page).click();
  await expect(footSend(page)).toHaveCount(0);
  expect(await replies(thread)).toHaveLength(1);
});

test('landed, its answer and the read-back lost: Send looks for it first, and there is one reply', async ({ browser }) => {
  const { thread, page } = await open(browser);
  await pickEight(page);
  await typeWords(page, 'Words and picks.');
  await expect(foot(page)).toContainText('Saved', { timeout: 5_000 });
  await page.route(REPLY, async (route: Route) => {
    await route.fetch(); // the Inbox writes it
    // The answer never comes.
  });
  await page.route(THREAD_READ, () => {});
  await page.locator('.ib-acts .ib-pri').click();
  await expect(failure(page)).toContainText('may not have gone', { timeout: SEND_ENDS_MS + 10_000 });
  expect(await replies(thread)).toHaveLength(1);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // A thread read that lands first finds the reply and closes the box by itself; if not, Send finds it.
  await page.locator('.ib-acts .ib-pri').click({ timeout: 3_000 }).catch(() => {});
  await expect(page.locator('.ib-rtext')).toHaveCount(0, { timeout: 15_000 });
  expect(await replies(thread)).toHaveLength(1);
});

test('a hung list or thread read never holds Send once the reply is confirmed', async ({ browser }) => {
  const { thread, page } = await open(browser);
  await pickEight(page);
  await hold(page, LIST);
  await hold(page, THREAD_READ);
  await footSend(page).click();
  // Confirmed: Send is gone at once, well inside the 8 s a thread read may take.
  await expect(footSend(page)).toHaveCount(0, { timeout: 3_000 });
  await expect(failure(page)).toHaveCount(0);
  expect(await replies(thread)).toHaveLength(1);
});

test('a slow list with eight picks: one read at a time, and the reply does not wait behind them', async ({ browser }) => {
  const { thread, page } = await open(browser);
  let out = 0;
  let most = 0;
  await page.route(LIST, async (route: Route) => {
    out += 1;
    most = Math.max(most, out);
    await new Promise((done) => setTimeout(done, 3_000));
    await route.continue().catch(() => {});
    out -= 1;
  });
  await pickEight(page);
  const pressed = Date.now();
  await footSend(page).click();
  await expect(footSend(page)).toHaveCount(0, { timeout: 5_000 });
  expect(Date.now() - pressed).toBeLessThan(5_000);
  expect(most).toBe(1);
  expect(await replies(thread)).toHaveLength(1);
});

test('a hung pick stops the Send: nothing goes without that answer', async ({ browser }) => {
  const { thread, page } = await open(browser);
  await pickEight(page);
  await hold(page, PICKS);
  const cards = page.locator('fieldset[data-question-key]');
  await cards.nth(8).locator('[data-question-option]').filter({ hasText: 'Yes' }).click();
  await footSend(page).click();
  await expect(failure(page)).toContainText('not saved', { timeout: SEND_ENDS_MS });
  await expect(footSend(page)).toBeEnabled();
  expect(await replies(thread)).toHaveLength(0);
});

test('a hung draft save holds Send only for its limit: then the words go, once', async ({ browser }) => {
  const { thread, page } = await open(browser);
  await hold(page, DRAFT, 'POST');
  await typeWords(page, 'Words a hung save carries.');
  await page.waitForTimeout(800);
  await page.locator('.ib-acts .ib-pri').click();
  await expect(page.locator('.ib-rtext')).toHaveCount(0, { timeout: SEND_ENDS_MS });
  expect(await replies(thread)).toEqual([expect.stringContaining('Words a hung save carries.')]);
});

test('a hung draft save and a reload: the words come back, and go once', async ({ browser }) => {
  const { thread, page } = await open(browser);
  await hold(page, DRAFT, 'POST');
  await typeWords(page, 'Words a reload would have lost.');
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.locator('.ib-rtext')).toHaveValue('Words a reload would have lost.');

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.locator('.ib-acts .ib-pri').click();
  await expect(page.locator('.ib-rtext')).toHaveCount(0, { timeout: SEND_ENDS_MS });
  expect(await replies(thread)).toEqual([expect.stringContaining('Words a reload would have lost.')]);
});

test('a words-only reply on its way across a reload lands once', async ({ browser }) => {
  const { thread, page } = await open(browser);
  await typeWords(page, 'Words with no picks.');
  await expect(page.locator('section.ib-pane')).toContainText('Saved', { timeout: 5_000 });
  let late: { url: string; body: string } | null = null;
  await page.route(REPLY, (route: Route) => {
    late = { url: route.request().url(), body: route.request().postData() ?? '' };
    // Still on its way, somewhere between the phone and the Inbox.
  });
  await page.locator('.ib-acts .ib-pri').click();
  await expect.poll(() => late).not.toBeNull();

  // The reload ends the page's request; lifting the hold before it would let that request through.
  await page.reload();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await expect(footSend(page)).toBeEnabled();
  expect(await replies(thread)).toHaveLength(0);
  await footSend(page).click();
  await expect(footSend(page)).toHaveCount(0);
  expect(await replies(thread)).toHaveLength(1);

  // The first request lands at last.
  const arrived = await fetch(late!.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: late!.body });
  expect(((await arrived.json()) as { replayed: boolean }).replayed).toBe(true);
  expect(await replies(thread)).toHaveLength(1);
});

test('the connection dies without a word as the reply lands: Send ends, the picks stay, and the next Send leaves one reply', async ({ browser }) => {
  const link = new Link(() => Number(new URL(url).port));
  await link.listen();
  try {
    const { thread, page } = await open(browser, link);
    await pickEight(page);
    link.cutAt('/reply HTTP/', true);
    await footSend(page).click();
    await expect(footSend(page)).toBeDisabled();
    await expect.poll(() => replies(thread)).toHaveLength(1);
    // No answer, and no way to read the thread: all it can say is that it may not have gone.
    await expect(failure(page)).toContainText('may not have gone', { timeout: SEND_ENDS_MS });
    await expect(footSend(page)).toBeEnabled();
    await expect(foot(page)).toContainText('8 picks');

    link.dark = false;
    await footSend(page).click();
    await expect(footSend(page)).toHaveCount(0, { timeout: SEND_ENDS_MS });
    expect(await replies(thread)).toHaveLength(1);
  } finally {
    link.close();
  }
});

test('the connection dies without a word before the reply arrives, and the new network works: Send ends, and the next Send delivers it once', async ({ browser }) => {
  const link = new Link(() => Number(new URL(url).port));
  await link.listen();
  try {
    const { thread, page } = await open(browser, link);
    await pickEight(page);
    link.cutAt('/reply HTTP/', false);
    await footSend(page).click();
    await expect.poll(() => link.dark).toBe(true);
    link.dark = false;
    await expect(failure(page)).toContainText('may not have gone', { timeout: SEND_ENDS_MS });
    await expect(footSend(page)).toBeEnabled();
    expect(await replies(thread)).toHaveLength(0);

    await footSend(page).click();
    await expect(footSend(page)).toHaveCount(0, { timeout: SEND_ENDS_MS });
    expect(await replies(thread)).toHaveLength(1);
  } finally {
    link.close();
  }
});

test('the Inbox restarted while Send waits: the out-of-date line, then one reply after a reload', async ({ browser }) => {
  const { thread, page } = await open(browser);
  await pickEight(page);
  await hold(page, REPLY);
  await footSend(page).click();
  await stopScratchInbox(dataDir, 'SIGKILL');
  url = startInbox();
  expect(new URL(page.url()).port).toBe(new URL(url).port);
  await expect(failure(page)).toContainText('may not have gone', { timeout: SEND_ENDS_MS });
  await expect(footSend(page)).toBeEnabled();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await footSend(page).click();
  await expect(failure(page)).toContainText('out of date');
  await expect(footSend(page)).toBeEnabled();
  expect(await replies(thread)).toHaveLength(0);

  await page.reload();
  await expect(footSend(page)).toBeEnabled();
  await footSend(page).click();
  await expect(footSend(page)).toHaveCount(0);
  expect(await replies(thread)).toHaveLength(1);
});
