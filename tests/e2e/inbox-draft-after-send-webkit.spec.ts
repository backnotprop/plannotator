/**
 * A sent reply never comes back as a draft (the owner, on a phone: "I sent the
 * message and then it reappeared in draft"), proved in WebKit against the
 * compiled binary. An iPhone 15 context dictates a long reply in three bursts
 * and taps Send inside the 500 ms pause before the save; a desktop context has
 * the same thread open, as the owner's Mac had. Each case breaks the network
 * the way a phone does, then checks that the server holds no draft, that
 * neither window's foot says "Draft", and that a reload opens no box:
 *
 * - the save the Send flushes lands, but its answer never reaches the phone;
 * - the page goes (pagehide, back/forward cache) inside the pause and comes
 *   back (pageshow), then Send: the keepalive save's answer is never read;
 * - a drafts read served before the Send clears the draft is answered after
 *   the reply's answer.
 *
 * Agents write through `plannotator inbox mcp` (scripts/inbox-sim.ts). Runs in
 * the playwright config's `webkit` project. Build the binary first (see
 * inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, devices, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

// A long reply, dictated in three bursts (each burst one input event, as dictation delivers it).
const PARTS = [
  'Okay so here is what I think about the retry worker. ',
  'The 409 from Stripe should be treated as success when the idempotency key matches, and we should log it once. ',
  'Then please write the migration for the ledger table and stop there, I want to review it before you run anything.',
];
const WORDS = PARTS.join('');

let url = '';
let agent: SimAgent;
let project = '';
const contexts: BrowserContext[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-draft-after-send-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  rememberInboxOf(dataDir);
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
const pane = (page: Page) => page.locator('section.ib-pane');

/** A new thread, open on the phone (box open) and on the desktop (box closed). */
async function world(browser: Browser, name: string) {
  const sent = await agent.send({ project_path: project, subject: `Retry worker ${name}`, body: 'The retry worker is done. What next?' });
  const thread = sent.thread_id as string;
  const phoneContext = await browser.newContext(iphone);
  const deskContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(phoneContext, deskContext);
  const phone = await phoneContext.newPage();
  const desk = await deskContext.newPage();
  await desk.goto(`${url}#thread=${thread}`);
  await expect(pane(desk)).toBeVisible();
  await phone.goto(`${url}#thread=${thread}`);
  await expect(pane(phone)).toBeVisible();
  await pane(phone).locator('.ib-pfoot [data-reply-button]').first().tap();
  await expect(pane(phone).locator('textarea')).toBeVisible();
  return { thread, phone, desk };
}

/** Dictation: three bursts, the last inside the 500 ms pause before the save. */
async function dictate(phone: Page) {
  const box = pane(phone).locator('textarea');
  let text = '';
  for (const part of PARTS) {
    text += part;
    await box.fill(text);
    await phone.waitForTimeout(40);
  }
}

const tapSend = (phone: Page) => pane(phone).locator('.ib-acts .ib-pri').tap();

async function serverDraft(thread: string) {
  const res = await fetch(new URL(`/api/inbox/threads/${thread}/draft`, url));
  return ((await res.json()) as { draft: { body: string } | null }).draft;
}

/** The reply went; once everything has settled, no window and no reload brings its words back as a draft. */
async function expectNoDraftAfterSend(w: Awaited<ReturnType<typeof world>>) {
  await expect(pane(w.phone).locator('[data-message-article]').last()).toContainText(PARTS[0]!.trim(), { timeout: 15_000 });
  // Long enough for every late answer and `drafts` frame to land.
  await w.phone.waitForTimeout(2500);
  expect(await serverDraft(w.thread)).toBeNull();
  for (const page of [w.phone, w.desk]) {
    await expect(pane(page).locator('[data-draft-foot]')).toHaveCount(0);
    await expect(pane(page).locator('textarea')).toHaveCount(0);
  }
  await w.phone.reload();
  await expect(pane(w.phone)).toBeVisible();
  await w.phone.waitForTimeout(1200);
  await expect(pane(w.phone).locator('textarea')).toHaveCount(0);
  await expect(pane(w.phone).locator('[data-draft-foot]')).toHaveCount(0);
  expect(await serverDraft(w.thread)).toBeNull();
}

test('the Send\'s own save lands without its answer: no draft of the sent words', async ({ browser }) => {
  const w = await world(browser, 'lost-answer');
  let lost = 0;
  let armed = false;
  await w.phone.route('**/api/inbox/threads/*/draft', async (route: Route) => {
    if (armed && lost === 0 && route.request().method() === 'POST' && (route.request().postData() ?? '').includes(PARTS[2]!.slice(0, 30))) {
      lost += 1;
      await route.fetch(); // the Inbox saves it (and tells every window)
      return route.abort('failed'); // the phone never sees the answer
    }
    return route.continue();
  });
  await dictate(w.phone);
  armed = true;
  await tapSend(w.phone);
  await expectNoDraftAfterSend(w);
  expect(lost).toBe(1);
});

test('pagehide (back/forward cache) inside the pause, pageshow, then Send: no draft of the sent words', async ({ browser }) => {
  const w = await world(browser, 'pagehide');
  await dictate(w.phone);
  await w.phone.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await expect.poll(async () => (await serverDraft(w.thread))?.body ?? null).toBe(WORDS);
  await w.phone.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await w.phone.waitForTimeout(300);
  await tapSend(w.phone);
  await expectNoDraftAfterSend(w);
});

test('a drafts read answered after the reply\'s answer: no draft of the sent words', async ({ browser }) => {
  const w = await world(browser, 'stale-read');
  let replyAnswered!: () => void;
  const replied = new Promise<void>((done) => (replyAnswered = done));
  let armed = false;
  let held = 0;
  await w.phone.route('**/api/inbox/threads/*/draft', async (route: Route) => {
    if (armed && route.request().method() === 'GET') {
      held += 1;
      const response = await route.fetch(); // served now, before the reply clears the draft
      await replied;
      await new Promise((r) => setTimeout(r, 50));
      return route.fulfill({ response });
    }
    return route.continue();
  });
  await w.phone.route('**/api/inbox/messages/*/reply', async (route: Route) => {
    await new Promise((r) => setTimeout(r, 300)); // the drafts read goes first
    const response = await route.fetch();
    await route.fulfill({ response });
    replyAnswered();
  });
  await dictate(w.phone);
  armed = true;
  await tapSend(w.phone);
  await expectNoDraftAfterSend(w);
  expect(held).toBeGreaterThan(0);
});
