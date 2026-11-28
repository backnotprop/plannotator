/**
 * A Send always ends (the owner, on a phone: Send turned dim after pressing and never sent, until a refresh),
 * proved in WebKit with an iPhone 15 against the compiled binary. The reply's request is held with `page.route` and
 * never answered, the way a connection that dies without a word (a phone changing networks, a proxy dropping the
 * answer) holds one:
 *
 * - the request never reaches the Inbox: Send ends with the failure line, the words stay in the box, and Send again
 *   writes one reply;
 * - the request reaches the Inbox and only its answer is lost: Send ends, the reply is found by its key, the box
 *   closes, and the Inbox holds one reply.
 *
 * The wait is the real one (20 s with nothing arriving, apiWrite.ts), so each case takes about half a minute. The cases
 * one by one, with a short limit, are the DOM test packages/inbox/sendAlwaysEnds.test.tsx. Agents write through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts). Build the binary first (see inbox.spec.ts).
 */

import { expect, test, devices, type Page, type Route } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
/** The write limit (20 s), the read back (10 s at most) and a margin. */
const SEND_ENDS_MS = 40_000;
const REPLY = '**/api/inbox/messages/*/reply';
const WORDS = 'Roll out eu-west first, then us-east once the error rate holds for an hour.';

let url = '';
let agent: SimAgent;
let project = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-send-always-ends-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  rememberInboxOf(dataDir);
  project = scratchProject(join(root, 'src'), 'harbor');
  agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
});

test.afterAll(async () => {
  try {
    await agent?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const { defaultBrowserType: _webkit, ...iphone } = devices['iPhone 15'];
const pane = (page: Page) => page.locator('section.ib-pane');
const send = (page: Page) => pane(page).locator('.ib-rbox [data-reply-send]');
const failure = (page: Page) => pane(page).locator('.ib-pfoot .ib-error[role="alert"]');

async function personReplies(thread: string): Promise<string[]> {
  const model = (await (await fetch(new URL(`/api/inbox/threads/${thread}`, url))).json()) as { thread: { messages: { author: { kind: string }; body: string }[] } };
  return model.thread.messages.filter((m) => m.author.kind === 'person').map((m) => m.body);
}

/** A new thread open on the phone, the box open with the words typed. */
async function typed(page: Page, name: string): Promise<string> {
  const sent = await agent.send({ project_path: project, subject: `Rollout order ${name}`, body: 'Both regions are built. Which goes first?' });
  const thread = sent.thread_id as string;
  await page.goto(`${url}#thread=${thread}`);
  await expect(pane(page)).toBeVisible();
  await pane(page).locator('.ib-pfoot [data-reply-button]').first().tap();
  await pane(page).locator('textarea').fill(WORDS);
  return thread;
}

test('the reply never reaches the Inbox: Send ends with the failure line, the words stay, and Send again writes one reply', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext(iphone);
  try {
    const page = await context.newPage();
    const thread = await typed(page, 'held');
    let held = 0;
    // Never answered and never passed on: the connection died on the way.
    await page.route(REPLY, (_route: Route) => void (held += 1));
    await send(page).tap();
    await expect(send(page)).toBeDisabled();
    await expect(failure(page)).toHaveText(/^The reply was not sent\. Send again to retry\./, { timeout: SEND_ENDS_MS });
    await expect(pane(page).locator('textarea')).toHaveValue(WORDS);
    await expect(send(page)).toBeEnabled();
    expect(held).toBe(1);
    expect(await personReplies(thread)).toEqual([]);
    await page.unroute(REPLY);
    await send(page).tap();
    await expect(pane(page).locator('textarea')).toHaveCount(0, { timeout: 15_000 });
    expect(await personReplies(thread)).toEqual([WORDS]);
  } finally {
    await context.close();
  }
});

test('the reply reaches the Inbox and only its answer is lost: Send ends, the reply is found, and there is one', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext(iphone);
  try {
    const page = await context.newPage();
    const thread = await typed(page, 'answer-lost');
    let landed = 0;
    await page.route(REPLY, async (route: Route) => {
      await route.fetch(); // the Inbox writes it
      landed += 1; // and the phone never hears back
    });
    await send(page).tap();
    await expect(send(page)).toBeDisabled();
    await expect(pane(page).locator('textarea')).toHaveCount(0, { timeout: SEND_ENDS_MS });
    await expect(failure(page)).toHaveCount(0);
    expect(landed).toBe(1);
    expect(await personReplies(thread)).toEqual([WORDS]);
  } finally {
    await context.close();
  }
});
