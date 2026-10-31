/**
 * The thread foot's open-questions button counts open action items too (owner,
 * 2026-10-30): "2 open action items" with no question open, "2 questions, 1
 * action item" with both ("open" goes once there are two kinds), and its list
 * holds the action items after the questions. Choosing an action item's entry
 * takes the person to that checklist row, as a question's entry does.
 *
 * A real Chromium against the compiled binary (`plannotator inbox
 * --background` under a temp PLANNOTATOR_DATA_DIR and HOME, a Claude Code
 * agent writing through `plannotator inbox mcp`, scripts/inbox-sim.ts):
 *
 *  - a thread with only action items: the button, its list, and a click on an
 *    entry scrolling to that row, focusing and ringing it;
 *  - a thread with both: the same with the action item's entry;
 *  - a thread with 12 questions and 10 action items, the longest label: one row
 *    of buttons at 1440, 810, 390 and 320; on a phone the long form first, as
 *    on a desktop, and which form shows at 390 and 320 (PHONE_CASES).
 *
 * Build the binary first (see inbox.spec.ts). Full-window PNGs land in
 * PLANNOTATOR_THREAD_FOOT_ACTIONS_SHOTS, or .local/proof/thread-foot-actions/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_THREAD_FOOT_ACTIONS_SHOTS ?? join(repo, '.local/proof/thread-foot-actions'));

const question = (prompt: string) => [':::question', prompt, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
const action = (task: string, extra: string[] = []) => [':::action', task, 'Only you can do this one.', ...extra, ':::'].join('\n');
/** A long message, so a row early in the thread sits well above the view once the thread is scrolled to its end. */
const prose = (topic: string) =>
  [`Progress on ${topic}.`, '', ...Array.from({ length: 8 }, (_, i) => `- Step ${i + 1} of ${topic}: checked the logs, the config and the retry path; nothing else changed.`)].join('\n');

type Sent = { message_id: string; thread_id: string; actions?: { key: string }[] };

interface World {
  url: string;
  context: BrowserContext;
  page: Page;
  agent: SimAgent;
  errors: string[];
  only: { thread: string; message: string; keys: string[] };
  both: { thread: string; message: string; key: string };
  longest: { thread: string };
}

let world: World;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-foot-actions-e2e-');
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = scratchProject(join(root, 'src'), 'web-release');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  // The notification line is not what these pictures are about.
  const port = new URL(url).port;
  await fetch(`http://127.0.0.1:${port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });

  // Only action items: two in the first message, then long progress notes below them.
  const onlyFirst = (await agent.send(
    {
      project_path: project,
      subject: 'Release 4.2 needs two things from you',
      thread: 'release',
      body: ['Release 4.2 is built. Two things only you can do.', '', action('Approve the production deploy on Vercel', ['Stopped: release 4.2 cannot go out until it is approved']), '', action('Sign in to npm in your terminal', ['Run: `npm login`', 'Holds up: the 0.29 publish'])].join('\n'),
    },
    { wakes: true },
  )) as Sent;
  for (const topic of ['the changelog', 'the docs site', 'the smoke tests']) await agent.send({ project_path: project, reply_to: onlyFirst.message_id, body: prose(topic) }, { wakes: true });

  // Both kinds: an action item early, two questions at the end.
  const bothFirst = (await agent.send(
    { project_path: project, subject: 'Billing retry worker', thread: 'billing', body: ['The retry worker runs in staging.', '', action('Rotate the Stripe test key in the dashboard', ['Holds up: the staging run'])].join('\n') },
    { wakes: true },
  )) as Sent;
  for (const topic of ['the retry worker', 'the admin page']) await agent.send({ project_path: project, reply_to: bothFirst.message_id, body: prose(topic) }, { wakes: true });
  await agent.send({ project_path: project, reply_to: bothFirst.message_id, body: ['Two calls before I ship it.', '', question('Ship the retry worker behind a flag?'), '', question('Retry a rate-limited charge 5 times?')].join('\n') }, { wakes: true });

  // The longest realistic label: 12 questions and 10 action items.
  const longest = (await agent.send(
    {
      project_path: project,
      subject: 'Onboarding launch checklist',
      thread: 'onboarding',
      body: [
        'Everything for the onboarding launch; take them as you can.',
        '',
        ...Array.from({ length: 12 }, (_, i) => question(`Onboarding call ${i + 1}: keep step ${i + 1}?`)).flatMap((b) => [b, '']),
        ...Array.from({ length: 10 }, (_, i) => action(`Launch task ${i + 1}: approve item ${i + 1} in the console`)).flatMap((b) => [b, '']),
      ].join('\n'),
    },
    { wakes: true },
  )) as Sent;

  const keysOf = (sent: Sent) => (sent.actions ?? []).map((a) => a.key);
  world = {
    url,
    context,
    page,
    agent,
    errors,
    only: { thread: onlyFirst.thread_id, message: onlyFirst.message_id, keys: keysOf(onlyFirst) },
    both: { thread: bothFirst.thread_id, message: bothFirst.message_id, key: keysOf(bothFirst)[0]! },
    longest: { thread: longest.thread_id },
  };
  expect(world.only.keys).toHaveLength(2);
  expect(keysOf(longest)).toHaveLength(10);
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

/** Which form the phone's button shows on the compiled window: the longest that keeps one row. */
const PHONE_CASES: { width: number; thread: 'both' | 'longest'; form: 'full' | 'short' | 'count'; shot?: string }[] = [
  { width: 390, thread: 'both', form: 'full', shot: 'phone-390-both' },
  // 320: Reply and "2 questions, 1 action item" do not share a row (44 px phone buttons): "3 open".
  { width: 320, thread: 'both', form: 'short' },
  { width: 320, thread: 'longest', form: 'short', shot: 'phone-320-longest' },
];

async function openThread(page: Page, threadId: string): Promise<void> {
  await page.goto(`${world.url}#thread=${threadId}`);
  await expect(page.locator('section.ib-pane .ib-pfoot [data-open-questions]')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** The thread scrolled to its end, so a row near its top sits above the view. */
async function scrollToEnd(page: Page): Promise<void> {
  await page.locator('section.ib-pane .ib-pbody').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.waitForTimeout(150);
}

/** Every button in the foot's row on one line, inside the foot. */
async function expectOneRow(page: Page): Promise<void> {
  const buttons = page.locator('section.ib-pane .ib-pfoot [data-foot-buttons]');
  await expect(async () => {
    const { boxes, rowRight } = await buttons.evaluate((row) => ({
      boxes: [...row.children]
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { text: (el.textContent ?? '').trim(), top: Math.round(r.top), right: r.right, overflow: el.scrollWidth > el.clientWidth + 1 };
        }),
      rowRight: row.parentElement!.getBoundingClientRect().right,
    }));
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(boxes.map((b) => b.top)).size, JSON.stringify(boxes)).toBe(1);
    for (const b of boxes) {
      expect(b.right, JSON.stringify({ boxes, rowRight })).toBeLessThanOrEqual(rowRight + 0.5);
      expect(b.overflow, JSON.stringify(b)).toBe(false);
    }
  }).toPass({ timeout: 5000 });
}

/** Choosing the entry took the person to that checklist row: in view, focused, and ringed. */
async function expectLandedOn(page: Page, messageId: string, key: string): Promise<void> {
  const row = page.locator(`section.ib-pane [data-message-id="${messageId}"] [data-action-card="${key}"]`);
  await expect(page.locator('[data-open-questions-list]')).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect(row).toHaveClass(/ib-q-target/);
  await expect(row).toBeInViewport();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}

test('only action items: "2 open action items", the list holds both, and an entry takes the person to its row', async () => {
  const { page } = world;
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await openThread(page, world.only.thread);
  const button = page.locator('section.ib-pane .ib-pfoot [data-open-questions]');
  await expect(button).toHaveText('2 open action items');
  await expectOneRow(page);
  await scrollToEnd(page);
  const target = page.locator(`section.ib-pane [data-message-id="${world.only.message}"] [data-action-card="${world.only.keys[1]}"]`);
  await expect(target).not.toBeInViewport();
  await shot(page, 'desktop-actions-only');

  await button.click();
  const list = page.locator('[data-open-questions-list]');
  await expect(list).toBeVisible();
  await expect(list).toHaveAttribute('aria-label', '2 open action items in this thread');
  await expect(list.locator('[data-open-question]')).toHaveCount(0);
  const entries = list.locator('[data-open-action]');
  await expect(entries.locator('.ib-oq-p')).toHaveText(['Approve the production deploy on Vercel', 'Sign in to npm in your terminal']);
  await expect(entries.nth(0).locator('.ib-b-stop')).toHaveText('Stopped');
  await expect(entries.nth(1).locator('.ib-b-hold')).toHaveText('Holds up 1');
  await expect(entries.nth(1).locator('.ib-oq-when')).toContainText('above');
  // Skip is for questions: none here.
  await expect(list.locator('[data-open-questions-skip-mode]')).toHaveCount(0);

  await entries.nth(1).click();
  await expectLandedOn(page, world.only.message, world.only.keys[1]!);
  expect(world.errors).toEqual([]);
});

test('both kinds: "2 questions, 1 action item", the action item listed after the questions, and its entry takes the person there', async () => {
  const { page } = world;
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await openThread(page, world.both.thread);
  const button = page.locator('section.ib-pane .ib-pfoot [data-open-questions]');
  await expect(button).toHaveText('2 questions, 1 action item');
  await expectOneRow(page);
  await scrollToEnd(page);
  await shot(page, 'desktop-both');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await shot(page, 'desktop-both-dark');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

  await button.click();
  const list = page.locator('[data-open-questions-list]');
  await expect(list).toHaveAttribute('aria-label', '2 questions, 1 action item in this thread');
  const rows = list.locator('.ib-oq-row');
  await expect(rows.locator('.ib-oq-p')).toHaveText(['Ship the retry worker behind a flag?', 'Retry a rate-limited charge 5 times?', 'Rotate the Stripe test key in the dashboard']);
  await expect(rows.nth(2)).toHaveAttribute('data-open-action', /.+/);
  await expect(list.locator('[data-open-questions-skip-mode]')).toBeVisible();
  await shot(page, 'list-both');

  const target = page.locator(`section.ib-pane [data-message-id="${world.both.message}"] [data-action-card="${world.both.key}"]`);
  await expect(target).not.toBeInViewport();
  await rows.nth(2).click();
  await expectLandedOn(page, world.both.message, world.both.key);
  // A question's entry in a message that is not folded lands the same way: its card focused and ringed.
  await button.click();
  await rows.nth(0).click();
  const card = page.locator('section.ib-pane [data-question-key]').first();
  await expect(card).toBeFocused();
  await expect(card).toHaveClass(/ib-q-target/);
  expect(world.errors).toEqual([]);
});

test('the longest label, "12 questions, 10 action items": the buttons keep one row from 1440 down to a 320 px phone', async ({ browser }: { browser: Browser }) => {
  const { page } = world;
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const button = page.locator('section.ib-pane .ib-pfoot [data-open-questions]');
  for (const width of [1440, 810]) {
    await page.setViewportSize({ width, height: 900 });
    await openThread(page, world.longest.thread);
    await expectOneRow(page);
    await expect(button).toHaveAccessibleName('12 questions, 10 action items');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await openThread(page, world.longest.thread);
  await expect(button).toHaveText('12 questions, 10 action items');

  // A phone (touch, 390 and 320 wide) tries the long form first too (owner: "it should say both"), then "N open",
  // then "N"; the name always says each kind.
  for (const c of PHONE_CASES) {
    const context = await browser.newContext({ viewport: { width: c.width, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const phone = await context.newPage();
      const both = c.thread === 'both';
      await openThread(phone, both ? world.both.thread : world.longest.thread);
      await expectOneRow(phone);
      const b = phone.locator('section.ib-pane .ib-pfoot [data-open-questions]');
      const label = both ? '2 questions, 1 action item' : '12 questions, 10 action items';
      await expect(b).toHaveAccessibleName(label);
      await expect(b, `${c.thread} at ${c.width}`).toHaveAttribute('data-label-form', c.form);
      await expect(b).toHaveText(c.form === 'full' ? label : c.form === 'short' ? (both ? '3 open' : '22 open') : both ? '3' : '22');
      if (c.shot) await shot(phone, c.shot);
      // The list on a phone takes the person to the action item too.
      if (both && c.width === 390) {
        await b.click();
        const entry = phone.locator('[data-open-questions-list] [data-open-action]');
        await expect(entry).toHaveCount(1);
        await entry.click();
        await expectLandedOn(phone, world.both.message, world.both.key);
      }
    } finally {
      await context.close();
    }
  }
  expect(world.errors).toEqual([]);
});
