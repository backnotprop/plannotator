/**
 * Request guided review (the thread header's ⋯; packages/inbox/guideRequest.ts),
 * in a real Chromium against the compiled binary, with Claude Code writing
 * through `plannotator inbox mcp` (scripts/inbox-sim.ts) as a waking
 * connection:
 *
 *  - the item sits above Archive; a click puts the person's request in the
 *    thread with its Queued line, and the agent reads it as a reply to its
 *    latest message;
 *  - a half-written reply stays in the box, and Send still sends it;
 *  - a phone: the item is in the bottom sheet and works there;
 *  - an archived thread has no item.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * Screenshots (light, dark, phone; the menu open and the request sent) land in
 * /tmp/request-guide-shots/ (or PLANNOTATOR_REQUEST_GUIDE_SHOTS).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GUIDE_REQUEST_WORDS } from '../../packages/inbox/guideRequest';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_REQUEST_GUIDE_SHOTS ?? '/tmp/request-guide-shots');

const DRAFT = 'Also rename the flag to RETRY_SAME_KEY before you push.';

/** A thread where Claude Code did code work: its plan, then what it changed. */
function work(topic: string): { subject: string; plan: string; done: string } {
  return {
    subject: `${topic}: retry Stripe 409s with the same key`,
    plan: [
      'The retry worker charges twice when Stripe answers 409 `idempotency_key_in_use`: it retries every error with a **new** key.',
      '',
      'I will retry a 409 with the same idempotency key, at most 3 times, and log each one.',
    ].join('\n'),
    done: [
      'Done on branch `fix/stripe-409-same-key`, one commit on top of `main`:',
      '',
      '| File | Change |',
      '| --- | --- |',
      '| `worker/retry.ts` | same-key retry, at most `RETRY_LIMIT` (3) |',
      '| `worker/log.ts` | `stripe_409` event with the job id |',
      '| `worker/retry.test.ts` | 4 new cases |',
      '',
      'Tests pass (212 of 212). The PR is open: #142.',
    ].join('\n'),
  };
}

interface World {
  url: string;
  agent: SimAgent;
  billing: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: Record<'light' | 'dark' | 'phone' | 'archived', { thread: string; last: string }>;
}

let world: World;

test.describe.configure({ mode: 'serial' });

const threadMenu = (page: Page) => page.locator('[data-thread-menu]');
const requestItem = (page: Page) => threadMenu(page).locator('[data-thread-guide-request-item]');
const personMessages = (page: Page) => page.locator('[data-message-article][data-author="person"]');

async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(shots, name) });
}

/** The thread open, the agent heard from just now (its session is live), the one-time banner out of the way. */
async function openThread(page: Page, key: keyof World['threads']) {
  const { thread, last } = world.threads[key];
  await world.agent.readThread(thread);
  await page.goto(`${world.url}#thread=${thread}`);
  await expect(page.locator(`[data-message-article="${last}"]`)).toBeVisible();
  const hide = page.getByRole('button', { name: 'Hide', exact: true });
  if (await hide.isVisible().catch(() => false)) await hide.click();
}

/** The agent's read of the thread: the person's request is a reply to its latest message, in the request's words. */
async function requestAsRead(key: keyof World['threads']) {
  const { thread, last } = world.threads[key];
  const read = (await world.agent.readThread(thread)) as { messages: { id: string; reply_to: string | null; author: { kind: string }; body: string }[] };
  return read.messages.filter((m) => m.author.kind === 'person' && m.reply_to === last && m.body.startsWith(GUIDE_REQUEST_WORDS));
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-request-guide-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const threads = {} as World['threads'];
  for (const [key, topic] of [['archived', 'Ledger export'], ['phone', 'Refund worker'], ['dark', 'Payout worker'], ['light', 'Retry worker']] as const) {
    const w = work(topic);
    const first = await agent.send({ project_path: billing, subject: w.subject, thread: key, body: w.plan }, { wakes: true });
    const done = await agent.send({ project_path: billing, thread: key, reply_to: first.message_id as string, body: w.done }, { wakes: true });
    threads[key] = { thread: first.thread_id as string, last: done.message_id as string };
  }
  world = { url, agent, billing, context, page, errors, threads };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the item sits above Archive; a click puts the request in the thread, Queued, as a reply to the latest message', async () => {
  const { page } = world;
  await page.emulateMedia({ colorScheme: 'light' });
  await openThread(page, 'light');
  await page.locator('[data-thread-more]').click();
  await expect(threadMenu(page)).toBeVisible();
  await expect(threadMenu(page).getByRole('menuitem')).toHaveText(['Star thread', 'Copy thread', 'Copy link', 'Copy thread ID', 'Add a pull request…', 'Request guided review', 'Archive thread']);
  await requestItem(page).hover();
  await shot(page, 'desktop-light-menu-open.png');
  await requestItem(page).click();
  await expect(threadMenu(page)).toHaveCount(0);
  await expect(personMessages(page)).toHaveCount(1);
  await expect(personMessages(page).first()).toContainText('Please send me a guided review of the code changes from this thread');
  await expect(page.locator('.ib-delivered')).toHaveAttribute('data-delivery', 'queued');
  await page.mouse.move(5, 895);
  await shot(page, 'desktop-light-request-sent.png');
  expect(await requestAsRead('light')).toHaveLength(1);
});

test('dark: a half-written reply stays in the box, and Send still sends it', async () => {
  const { page } = world;
  await page.emulateMedia({ colorScheme: 'dark' });
  await openThread(page, 'dark');
  await page.getByRole('button', { name: /^Reply/ }).last().click();
  await page.locator('.ib-rbox textarea').first().fill(DRAFT);
  await page.locator('[data-thread-more]').click();
  await expect(requestItem(page)).toBeVisible();
  await requestItem(page).hover();
  await shot(page, 'desktop-dark-menu-open.png');
  await requestItem(page).click();
  await expect(personMessages(page)).toHaveCount(1);
  await expect(page.locator('.ib-rbox textarea').first()).toHaveValue(DRAFT);
  await page.mouse.move(5, 895);
  await shot(page, 'desktop-dark-request-sent.png');
  expect(await requestAsRead('dark')).toHaveLength(1);
  await page.getByRole('button', { name: /^Send/ }).last().click();
  await expect(personMessages(page)).toHaveCount(2);
  await expect(personMessages(page).last()).toContainText(DRAFT);
  await page.emulateMedia({ colorScheme: 'light' });
});

test('a phone: the item is in the bottom sheet and sends the request', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await openThread(page, 'phone');
    await page.locator('[data-thread-more]').click();
    await expect(threadMenu(page)).toBeVisible();
    await expect(page.locator('.ib-pm-pos[data-phone]')).toBeVisible();
    await expect(requestItem(page)).toBeVisible();
    await shot(page, 'phone-menu-open.png');
    await requestItem(page).click();
    await expect(personMessages(page)).toHaveCount(1);
    await expect(page.locator('.ib-delivered')).toHaveAttribute('data-delivery', 'queued');
    await shot(page, 'phone-request-sent.png');
    expect(await requestAsRead('phone')).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test('an archived thread has no item', async () => {
  const { page } = world;
  await openThread(page, 'archived');
  await page.locator('[data-thread-more]').click();
  await threadMenu(page).locator('[data-thread-archive-item]').click();
  await expect(page.locator('[data-thread-more]')).toBeVisible();
  await page.locator('[data-thread-more]').click();
  await expect(threadMenu(page).getByRole('menuitem', { name: 'Unarchive thread' })).toBeVisible();
  await expect(requestItem(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(world.errors).toEqual([]);
});
