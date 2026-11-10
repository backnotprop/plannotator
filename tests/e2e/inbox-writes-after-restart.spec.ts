/**
 * A window left open across an Inbox restart keeps writing without a reload
 * (packages/inbox/sessionAdopt.ts), proved in headless Chromium against the
 * compiled binary, with an agent writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts).
 *
 * Before: the restarted Inbox refused every write of the page that lived
 * through it (409 `session_mismatch`). New messages kept arriving, so the
 * page looked whole, while the look, the draft and the reply were refused
 * until a reload.
 *
 * - The same Inbox restarts (`plannotator inbox restart`, same data folder,
 *   same release): the open thread's look is recorded again, the agent's next
 *   message shows, a draft saves and a reply is sent, with no reload and
 *   nothing said about it.
 * - The Inbox that comes back runs on a copy of the data folder (what a
 *   restore from a backup, or another Inbox taking the port, looks like): the
 *   page's reply is refused with today's words, as before.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-writes-after-restart.spec.ts`.
 */

import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const REFUSED = /This Inbox page is out of date/;

interface World {
  inbox: string;
  env: Record<string, string>;
  dataDir: string;
  agent: SimAgent;
  path: string;
}
let world: World;
let sent = 0;

async function agentStarts(subject: string): Promise<string> {
  sent += 1;
  const reply = await world.agent.send({ project_path: world.path, subject, body: `${subject}. Nothing to answer yet.`, agent_session: `ses_restart_${sent}` } as Parameters<SimAgent['send']>[0]);
  return String(reply.thread_id);
}

const start = (args: string[]) => {
  const run = spawnSync(binary, args, { env: world.env, encoding: 'utf8', timeout: 60_000 });
  expect(run.status, run.stderr).toBe(0);
  rememberInboxOf(world.dataDir);
  return run.stdout.trim().replace(/\/$/, '');
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-writes-after-restart-e2e-');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  world = { inbox: '', env, dataDir: env.PLANNOTATOR_DATA_DIR, agent: null as unknown as SimAgent, path: '' };
  world.inbox = start(['inbox', '--background']);
  world.agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world.path = scratchProject(join(root, 'src'), 'billing-svc');
  for (const subject of ['Retry budget for the webhook worker', 'Ledger export columns']) await agentStarts(subject);
});

test.afterAll(async () => {
  try {
    await world?.agent?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const pane = (page: Page) => page.locator('section.ib-pane');
const posted = (page: Page, end: RegExp, status: number) =>
  page.waitForResponse((res) => res.request().method() === 'POST' && end.test(new URL(res.url()).pathname) && res.status() === status, { timeout: 30_000 });

async function openThread(page: Page, threadId: string, subject: string): Promise<void> {
  await page.goto(`${world.inbox}/#thread=${threadId}`);
  await expect(pane(page).locator('h2.ib-subject')).toContainText(subject);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  // The page's first look and its stream are settled before anything restarts.
  await page.waitForTimeout(1_500);
}

async function reply(page: Page, words: string): Promise<void> {
  await page.locator('[data-reply-button]').click();
  await page.keyboard.type(words);
  await page.locator('[data-reply-send]').last().click();
}

test('the same Inbox restarts under an open page: the look, a draft and a reply go through with no reload', async ({ page }) => {
  test.setTimeout(120_000);
  const threadId = await agentStarts('Rollout plan for the retry budget');
  await openThread(page, threadId, 'Rollout plan for the retry budget');
  let loads = 0;
  page.on('load', () => (loads += 1));

  // The look the restarted Inbox takes from this page, once the page has read everything again.
  const look = posted(page, /\/seen$/, 200);
  expect(start(['inbox', 'restart'])).toBe(world.inbox);
  await look;

  // Reads were never the problem: the agent's next message shows.
  const body = `Canary at 5% is green (${Date.now()}).`;
  await world.agent.send({ project_path: world.path, reply_to: threadId, body } as Parameters<SimAgent['send']>[0]);
  await expect(pane(page).getByText(body)).toBeVisible({ timeout: 15_000 });

  // The writes: the draft saves as it is typed, and the reply is sent.
  const draft = posted(page, /\/draft$/, 200);
  const send = posted(page, /\/reply$/, 200);
  const words = `Go to 25% (${Date.now()}).`;
  await reply(page, words);
  await draft;
  await send;
  await expect(pane(page).locator('[data-message-id]').getByText(words)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(REFUSED)).toHaveCount(0);
  expect(loads).toBe(0);
});

test('the Inbox that comes back runs on a copy of the data folder: the page\'s reply is refused, as before', async ({ page }) => {
  test.setTimeout(120_000);
  const threadId = await agentStarts('Pager rota for the rollout');
  await openThread(page, threadId, 'Pager rota for the rollout');

  await stopScratchInbox(world.dataDir);
  // The same files in another folder at the same path: what a restore from a backup leaves.
  const folder = join(world.dataDir, 'inbox');
  cpSync(folder, `${folder}.copy`, { recursive: true });
  rmSync(folder, { recursive: true, force: true });
  renameSync(`${folder}.copy`, folder);
  expect(start(['inbox', '--background'])).toBe(world.inbox);

  // The page hears the new run (its stream is back) and is not taken for one of its pages.
  const refused = posted(page, /\/reply$/, 409);
  await page.waitForTimeout(5_000);
  await reply(page, `Hold the rollout (${Date.now()}).`);
  await refused;
  await expect(page.getByText(REFUSED).first()).toBeVisible({ timeout: 10_000 });
});
