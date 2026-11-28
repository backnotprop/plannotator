/**
 * A script's post says "Script" (the owner, 2026-11-23: "inform the user with the right icon and let them know, hey,
 * one of your agents created this thread with the script"), proved in a real browser against the compiled binary.
 * A script posts the way a cron job does, `plannotator inbox call send_message` from a shell that names no session;
 * a Claude Code agent writes through `plannotator inbox mcp` (scripts/inbox-sim.ts); a routine's thread is one the
 * window's routines list names (that one list read is answered by the page, so no agent has to run):
 *
 *  - the script's row draws the terminal where an agent's icon would be, and is named "Script"; the agent's row
 *    and the routine's row beside it draw what they always did;
 *  - the open script thread's heads draw the terminal and say "Script";
 *  - a thread a script started and the session took over is the session's on its row and in its reply box, while
 *    the script's own head still says "Script";
 *  - the reply box of a thread only a script wrote in says "Reply to Script".
 *
 * Build the binary first (see inbox.spec.ts). PNGs at 1440 by 900 land in .local/proof/script-posts/ (CI artifact
 * inbox-window-proof-N): the list light and dark, the open thread light, the taken-over thread with its reply box,
 * and the script-only thread's reply box.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofRoot = resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof'));
const proofDir = join(proofRoot, 'script-posts');

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  threads: { agent: string; script: string; taken: string; routine: string };
}
let world: World;

const pause = () => new Promise((r) => setTimeout(r, 30));

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[]): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.skip(process.platform === 'win32', 'Routines are not offered on Windows.');
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-script-posts-e2e-');
  const home = join(root, 'home');
  const data = join(root, 'data');
  for (const dir of [home, data]) mkdirSync(dir, { recursive: true });
  // Routines on, so a routine's thread draws as one.
  writeFileSync(join(data, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, inboxScheduledThreads: true }));
  const env: Record<string, string> = {
    // The system's own tools only: no agent CLI, so `inbox call` names no session, as from cron.
    PATH: '/usr/bin:/bin',
    PLANNOTATOR_TEST_SANDBOX: root,
    HOME: home,
    NO_ANON_PING: '1',
    PLANNOTATOR_DATA_DIR: data,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(data);
  const url = started.stdout.trim();
  const billing = scratchProject(join(root, 'src'), 'billing-svc');

  // Oldest first: the routine's run, then the script's two posts, then the agent's.
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const routineRun = await claude.send({ project_path: billing, subject: 'Nightly deps', thread: 'nightly-deps', body: 'Started at 2:00 AM. Every dependency is up to date.' });
  await pause();
  const script = (input: Record<string, unknown>) => {
    const ran = spawnSync(binary, ['inbox', 'call', 'send_message', JSON.stringify({ project_path: billing, ...input })], { env, cwd: billing, encoding: 'utf8', timeout: 60_000 });
    expect(ran.status, ran.stderr).toBe(0);
    return JSON.parse(ran.stdout) as { message_id: string; thread_id: string };
  };
  const first = script({ subject: 'Spend check', body: 'Nov 22 · $403 of $450 this month (90%). Top: batch-export (Charlie Dunn), staging cluster (Ada Novak).', idempotency_key: 'spend-1122' });
  await pause();
  script({
    reply_to: first.message_id,
    body: ['Month to date: **$412** of the $450 budget (92%), 8 days left.', '', '| Job | Owner | Today | Month |', '| --- | --- | --- | --- |', '| batch-export | Charlie Dunn | $9.80 | $188 |', '| staging cluster | Ada Novak | $6.10 | $141 |', '| load test | Bob Tully | $0.00 | $83 |'].join('\n'),
    idempotency_key: 'spend-1123',
  });
  await pause();
  // A script starts a thread and the Claude Code session takes it over by replying in it.
  const taken = script({ subject: 'Disk at 91% on node 3', body: 'Disk at 91% on node 3. Snapshots use 40 GB of it.', idempotency_key: 'disk-1123' });
  await pause();
  await claude.send({ project_path: billing, reply_to: taken.message_id, body: 'I can clear the snapshots older than a week, which frees about 30 GB. Say go and I will.' });
  await pause();
  const agent = await claude.send({ project_path: billing, subject: 'Retry webhook on 429', thread: 'webhook', body: 'Plan is ready: back off with jitter on a 429, up to five tries.' });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  // This computer's routines, as the window reads them: one, whose runs land in the routine's thread.
  const now = new Date().toISOString();
  const routine = {
    id: 'sch_nightly',
    name: 'Nightly deps',
    enabled: true,
    approved_at: now,
    prompt: 'Update the dependencies.',
    schedule: { cron: '0 2 * * *', tz: 'UTC' },
    if_missed: 'skip',
    runs_on: 'this_computer',
    folder: { path: billing },
    agent: 'claude-code',
    attachments: [],
    thread_id: routineRun.thread_id,
    handled_through: now,
    created_at: now,
    updated_at: now,
    state: 'on',
    schedule_words: 'Every day at 2:00 AM',
    tz_short: 'UTC',
    next_run: null,
    runs: 8,
    last_run: { message_id: routineRun.message_id, run: 8, due_at: now, started_at: now, late: false, outcome: 'replied' },
    running_since: null,
    folder_shown: 'billing-svc',
    project_name: 'billing-svc',
    thread_name: null,
    last_change: null,
  };
  await page.route(/\/api\/inbox\/scheduled(\?.*)?$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { scheduled: [routine], launch_on: false } }) : route.fallback(),
  );
  world = { url, agents: [claude], context, page, threads: { agent: agent.thread_id as string, script: first.thread_id, taken: taken.thread_id, routine: routineRun.thread_id as string } };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    for (const agent of world.agents) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test("the list: a script's row draws the terminal and says Script, between an agent's row and a routine's that do not change", async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  const row = (id: string) => page.locator(`[data-row="${id}"]`).first();
  await expect(row(threads.script)).toBeVisible();
  await expect(row(threads.routine).locator('[data-scheduled-tile]')).toBeVisible();
  const script = row(threads.script).locator('[data-row-agents]');
  await expect(script).toHaveAttribute('aria-label', 'Script');
  await expect(script.locator('[data-script-mark] svg[data-icon="terminal"]')).toBeVisible();
  await expect(row(threads.agent).locator('[data-row-agents]')).toHaveAttribute('aria-label', 'Claude Code');
  await expect(row(threads.agent).locator('[data-script-mark]')).toHaveCount(0);
  await expect(row(threads.routine).locator('[data-script-mark]')).toHaveCount(0);
  await shot(page, '01-list', ['light', 'dark']);
});

test("the open script thread: its heads draw the terminal and say Script", async () => {
  const { page, threads } = world;
  await page.locator(`[data-row="${threads.script}"]`).first().click();
  const heads = page.locator('[data-message-article] .ib-fl-nm');
  await expect(heads.first()).toHaveText('Script');
  await expect(heads).toHaveCount(2);
  await expect(heads.nth(1)).toHaveText('Script');
  await expect(page.locator('[data-message-article] [data-script-mark] svg[data-icon="terminal"]')).toHaveCount(2);
  await shot(page, '02-thread-head', ['light']);
});

/** Opens the open thread's reply box and returns its field. */
async function openReply(page: Page) {
  await page.getByRole('button', { name: 'Reply', exact: true }).first().click();
  const field = page.locator('textarea[aria-label^="Reply to"]').first();
  await expect(field).toBeVisible();
  return field;
}

test("a thread a script started that a Claude Code session took over: its row is the session's, the script's head still says Script, the reply goes to Claude Code", async () => {
  const { page, threads } = world;
  const row = page.locator(`[data-row="${threads.taken}"]`).first();
  await expect(row.locator('[data-row-agents]')).toHaveAttribute('aria-label', 'Claude Code');
  await expect(row.locator('[data-script-mark]')).toHaveCount(0);
  await row.click();
  const heads = page.locator('[data-message-article] .ib-fl-nm');
  await expect(heads).toHaveCount(2);
  await expect(heads.first()).toHaveText('Script');
  await expect(heads.nth(1)).toHaveText('Claude Code');
  await expect(await openReply(page)).toHaveAttribute('aria-label', 'Reply to Claude Code');
  await shot(page, '03-taken-over-thread', ['light']);
});

test("the reply box in a thread only a script wrote in names Script, as its heads do", async () => {
  const { page, threads } = world;
  await page.locator(`[data-row="${threads.script}"]`).first().click();
  await expect(page.locator('[data-message-article] .ib-fl-nm').first()).toHaveText('Script');
  await expect(await openReply(page)).toHaveAttribute('aria-label', 'Reply to Script');
  await shot(page, '04-reply-box-script-only', ['light']);
});
