/**
 * Copy a message, copy a thread (design record "inbox-copy-message", option
 * B, approved 2026-10-28), in a real Chromium against the compiled binary,
 * with an agent writing through `plannotator inbox mcp` (scripts/inbox-sim.ts)
 * and the person's reply sent through the window:
 *
 *  - each open message's ⋯ is hidden at rest and shows while the pointer is on
 *    the message; Copy message puts the message's Markdown on the clipboard
 *    (read back here), with the toast;
 *  - Copy link to message copies `#thread=…&msg=…`, and that link opens the
 *    thread on that message, unfolded;
 *  - the header's ⋯ Copy thread copies every message (the question block as
 *    readable lines with the sent answer, the person's words only);
 *  - the keyboard: Tab reaches ⋯ (shown while focused), Enter opens, the
 *    arrows walk, Escape gives focus back; a right-click on the head line
 *    opens the same menu;
 *  - the list row's Copy thread;
 *  - a phone: ⋯ always shown, both menus the bottom sheet.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * Screenshots, one PNG per state, land in /tmp/copy-menu-shots/ (or
 * PLANNOTATOR_COPY_MENU_SHOTS).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_COPY_MENU_SHOTS ?? '/tmp/copy-menu-shots');

const PICK = 'Retry with the same idempotency key';
const WORDS = 'Same key. And log every 409 so we can see how often it happens.';
const ASK = [
  'I checked the 409 handling against the Stripe docs. Here is what I found.',
  '',
  '## What happens today',
  '',
  '- The worker retries **every** error, including a 409 `idempotency_key_in_use`.',
  '- A retry with a *new* key can charge the customer twice.',
  '',
  '```ts',
  'if (err.statusCode === 409) {',
  '  return retry(job, { sameKey: true });',
  '}',
  '```',
  '',
  ':::question',
  'Which way should the worker go on a Stripe 409?',
  'Stopped: the retry worker cannot ship without this.',
  '',
  `- [ ] ${PICK}`,
  '- [ ] Fail the job and send it to the dead-letter queue',
  `Recommended: ${PICK}`,
  ':::',
].join('\n');
const DONE = [
  'Done. The worker now retries a 409 with the **same** idempotency key, at most 3 times, and logs each one.',
  '',
  '| File | Change |',
  '| --- | --- |',
  '| `worker/retry.ts` | same-key retry, max 3 |',
  '| `worker/log.ts` | `stripe_409` event |',
].join('\n');
const LAST = [
  'Tests pass (212 of 212). The PR is open: [#142 Retry Stripe 409s with the same key](https://github.com/example/billing-svc/pull/142).',
  '',
  'Two things to check when you review:',
  '',
  '1. The retry cap is 3. Raise it in `RETRY_LIMIT` if you want more.',
  '2. The `stripe_409` log line carries the job id, not the customer id.',
].join('\n');

interface World {
  url: string;
  env: Record<string, string>;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  thread: string;
  ids: { ask: string; reply: string; done: string; last: string };
  other: string;
}

let world: World;

test.describe.configure({ mode: 'serial' });

const article = (page: Page, id: string) => page.locator(`[data-message-article="${id}"]`);
const more = (page: Page, id: string) => page.locator(`[data-message-more="${id}"]`);
const messageMenu = (page: Page) => page.locator('[data-message-menu]');
const threadMenu = (page: Page) => page.locator('[data-thread-menu]');
const toast = (page: Page) => page.locator('[data-inbox-toast]');
const clipboardText = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

/** A screenshot once the menu's and the toast's entrances have played. */
async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(shots, name) });
}

/** The thread open, the pointer parked in a corner, the one-time notifications banner out of the way. */
async function openThread(page: Page, hash = `#thread=${world.thread}`) {
  await page.goto(`${world.url}${hash}`);
  await expect(article(page, world.ids.last)).toBeVisible();
  const hide = page.getByRole('button', { name: 'Hide', exact: true });
  if (await hide.isVisible().catch(() => false)) await hide.click();
  // The last test's toast is not part of this one's screenshots.
  const dismiss = page.locator('[data-toast-dismiss]');
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
  await expect(toast(page)).toHaveCount(0);
  await page.mouse.move(5, 895);
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-copy-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const docs = scratchProject(join(root, 'src'), 'docs-site');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const other = await agent.send({ project_path: docs, subject: 'Install page detects agents', thread: 'install', body: 'The install page now detects the installed agents.' });
  const ask = await agent.send({ project_path: billing, subject: 'Retry worker for Stripe 409s', thread: 'retry', body: ASK });
  const thread = ask.thread_id as string;
  // The person answers through the window: the recommended pick and their words.
  await page.goto(`${url}#thread=${thread}`);
  await page.getByText(PICK, { exact: true }).first().click();
  const box = page.locator('.ib-rbox textarea').first();
  if (!(await box.isVisible().catch(() => false))) await page.getByRole('button', { name: /^Reply/ }).last().click();
  await page.locator('.ib-rbox textarea').first().fill(WORDS);
  await page.getByRole('button', { name: /^Send/ }).last().click();
  await expect(page.locator('[data-author="person"]')).toHaveCount(1);
  const read = await agent.readThread(thread);
  const reply = ((read.messages ?? []) as { id: string; author: { kind: string } }[]).find((m) => m.author.kind === 'person')!.id;
  const done = await agent.send({ project_path: billing, thread: 'retry', reply_to: reply, body: DONE });
  const last = await agent.send({ project_path: billing, thread: 'retry', reply_to: done.message_id as string, body: LAST });
  world = {
    url,
    env,
    agent,
    context,
    page,
    errors,
    thread,
    ids: { ask: ask.message_id as string, reply, done: done.message_id as string, last: last.message_id as string },
    other: other.thread_id as string,
  };
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

test("a message's ⋯ shows on hover; Copy message copies its Markdown with the toast", async () => {
  const { page, ids } = world;
  await page.emulateMedia({ colorScheme: 'light' });
  await openThread(page);
  const button = more(page, ids.last);
  // Quiet at rest: nothing new on screen while reading.
  await expect(button).toHaveCSS('opacity', '0');
  await article(page, ids.last).locator('.ib-body').first().hover({ position: { x: 200, y: 10 } });
  await expect(button).toHaveCSS('opacity', '1');
  await button.click();
  await expect(messageMenu(page)).toBeVisible();
  await expect(messageMenu(page).getByRole('menuitem')).toHaveText(['Copy message', 'Copy link to message', 'Copy thread']);
  await shot(page, 'desktop-light-message-menu-open.png');
  await messageMenu(page).locator('[data-copy-item="message"]').click();
  await expect(toast(page)).toContainText('Message copied');
  expect(await clipboardText(page)).toBe(LAST);
  await page.mouse.move(5, 895);
  await shot(page, 'desktop-light-message-copied-toast.png');
});

test('Copy link to message copies #thread=…&msg=…, and the link opens the thread on that message', async () => {
  const { page, ids, thread } = world;
  await openThread(page);
  // The agent's first message: opened from its folded line when the thread shows it folded.
  const head = article(page, ids.ask).locator('[data-open-head]');
  if (!(await head.isVisible())) await article(page, ids.ask).locator('button').first().click();
  await expect(head).toBeVisible();
  await head.hover();
  await more(page, ids.ask).click();
  await messageMenu(page).locator('[data-copy-item="message-link"]').click();
  await expect(toast(page)).toContainText('Link copied');
  const link = await clipboardText(page);
  expect(link).toBe(`${new URL(world.url).origin}/#thread=${thread}&msg=${ids.ask}`);
  const landed = await world.context.newPage();
  await landed.goto(link);
  // Landed: that message is open and holds focus (the search result's landing).
  await expect(article(landed, ids.ask).locator('[data-open-head]')).toBeVisible();
  await expect(article(landed, ids.ask)).toBeFocused();
  await landed.close();
});

test("the header's ⋯: Copy thread copies every message, the answer on its question and the person's words only", async () => {
  const { page } = world;
  await openThread(page);
  await page.locator('[data-thread-more]').click();
  await expect(threadMenu(page)).toBeVisible();
  await expect(threadMenu(page).getByRole('menuitem')).toHaveText(['Pin thread', 'Copy thread', 'Copy link', 'Copy thread ID']);
  await shot(page, 'desktop-light-thread-menu-open.png');
  await threadMenu(page).locator('[data-copy-item="thread"]').click();
  await expect(toast(page)).toContainText('Thread copied');
  await expect(toast(page)).toContainText('4 messages');
  const text = await clipboardText(page);
  expect(text.startsWith('# Retry worker for Stripe 409s\n\nbilling-svc · 4 messages\n\n---\n\n**Claude Code** · '), text).toBe(true);
  expect(text).toContain(['**Q1.** Which way should the worker go on a Stripe 409?', 'Stopped: the retry worker cannot ship without this.', `- ${PICK} (recommended)`, '- Fail the job and send it to the dead-letter queue', '', `Answer: ${PICK}`].join('\n'));
  expect(text).toMatch(new RegExp(`\\n\\*\\*You\\*\\* · [^\\n]+\\n\\n${WORDS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n---\\n`));
  expect(text).not.toContain('Answers to your questions');
  expect(text).not.toContain('Answered 1 question');
  expect(text.split('\n---\n')).toHaveLength(5);
  await page.mouse.move(5, 895);
  await shot(page, 'desktop-light-thread-copied-toast.png');
});

test('the keyboard: Tab reaches ⋯ and shows it, Enter opens, the arrows walk, Escape gives focus back; a right-click opens the same menu', async () => {
  const { page, ids } = world;
  await openThread(page);
  await article(page, ids.last).getByRole('button', { name: 'Reply' }).focus();
  await page.keyboard.press('Tab');
  const button = more(page, ids.last);
  await expect(button).toBeFocused();
  await expect(button).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(messageMenu(page)).toBeVisible();
  // Opened from the keyboard: the first item has focus, then the arrows walk.
  await expect(messageMenu(page).locator('[data-copy-item="message"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(messageMenu(page).locator('[data-copy-item="message-link"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(messageMenu(page)).toHaveCount(0);
  await expect(button).toBeFocused();
  // A right-click on the head line: the same items, at the pointer.
  await page.mouse.move(5, 895);
  const head = article(page, ids.last).locator('[data-open-head]');
  const box = (await head.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height / 2, { button: 'right' });
  await expect(page.locator('[data-message-menu][data-context]')).toBeVisible();
  await expect(page.locator('[data-message-menu][data-context]').getByRole('menuitem')).toHaveText(['Copy message', 'Copy link to message', 'Copy thread']);
  await page.keyboard.press('Escape');
  await expect(messageMenu(page)).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("the list row's Copy thread copies a thread that is not open", async () => {
  const { page } = world;
  await openThread(page);
  await page.locator(`.ib-lbody [data-thread-id="${world.other}"]`).click({ button: 'right' });
  await page.locator('[data-row-action="copy-thread"]').click();
  await expect(toast(page)).toContainText('Thread copied');
  await expect(toast(page)).toContainText('1 message');
  expect(await clipboardText(page)).toContain('# Install page detects agents\n\ndocs-site · 1 message');
  // The open thread is still the one open.
  expect(page.url()).toContain(`thread=${world.thread}`);
});

test('dark: the message menu', async () => {
  const { page, ids } = world;
  await page.emulateMedia({ colorScheme: 'dark' });
  await openThread(page);
  await article(page, ids.last).locator('.ib-body').first().hover({ position: { x: 200, y: 10 } });
  await more(page, ids.last).click();
  await expect(messageMenu(page)).toBeVisible();
  await shot(page, 'desktop-dark-message-menu-open.png');
  await page.keyboard.press('Escape');
  await page.locator('[data-thread-more]').click();
  await expect(threadMenu(page)).toBeVisible();
  await shot(page, 'desktop-dark-thread-menu-open.png');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'light' });
  expect(world.errors).toEqual([]);
});

test('a phone: ⋯ always shown, both menus the bottom sheet', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(world.url).origin });
  const page = await context.newPage();
  try {
    await page.goto(`${world.url}#thread=${world.thread}`);
    await expect(article(page, world.ids.last)).toBeVisible();
    const button = more(page, world.ids.last);
    await expect(button).toHaveCSS('opacity', '1');
    await button.tap();
    await expect(messageMenu(page)).toBeVisible();
    await expect(page.locator('.ib-pm-pos[data-phone] [data-message-menu]')).toBeVisible();
    await expect(messageMenu(page).locator('.ib-pm-title')).toContainText('Claude Code · ');
    await shot(page, 'phone-light-message-sheet.png');
    await page.keyboard.press('Escape');
    await expect(messageMenu(page)).toHaveCount(0);
    await page.locator('[data-thread-more]').tap();
    await expect(page.locator('.ib-pm-pos[data-phone] [data-thread-menu]')).toBeVisible();
    await expect(threadMenu(page).locator('.ib-pm-title')).toHaveText('Retry worker for Stripe 409s');
    await shot(page, 'phone-light-thread-sheet.png');
    await threadMenu(page).locator('[data-copy-item="thread"]').tap();
    await expect(toast(page)).toContainText('Thread copied');
    expect((await clipboardText(page)).startsWith('# Retry worker for Stripe 409s')).toBe(true);
  } finally {
    await context.close();
  }
});
