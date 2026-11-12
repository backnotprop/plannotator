/**
 * `plannotator inbox --open <thread>` (issue #2506), proved in a real
 * browser against the compiled binary: a tool on this computer (a status-bar
 * widget, a script) shows a thread in the Inbox window that is already open.
 * The window moves to the thread as a row click does: a new history entry,
 * so Back returns to the thread it was on, and the reply being typed there is
 * kept as its draft and is back in the box. With two windows open, the one
 * the person used last (its last `focus`) moves and the other stays put. The
 * command prints the thread's address and opens no tab.
 *
 * Agents write through `plannotator inbox mcp` (scripts/inbox-sim.ts). PNGs
 * (the window on thread A, the same window on B after `--open B`, back on A
 * after Back) land in .local/proof/show-thread/ (or PLANNOTATOR_E2E_PROOF_DIR).
 * Build the binary first (see inbox.spec.ts), then
 * `bun run test:sandbox tests/e2e/inbox-show-thread.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, scratchEnv } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'show-thread');
const WORDS = 'Keep the totals column, drop the chart.';

interface World {
  env: Record<string, string>;
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  threads: { a: string; b: string; c: string };
}

let world: World;

const row = (page: Page, threadId: string) => page.locator(`.ib-lbody [data-thread-id="${threadId}"]`);
const pane = (page: Page) => page.locator('section.ib-pane');
const box = (page: Page) => pane(page).locator('textarea');
const draftWords = async (threadId: string) =>
  ((await (await fetch(new URL(`/api/inbox/threads/${threadId}/draft`, world.url))).json()) as { draft: { body: string } | null }).draft?.body ?? null;
const threadInHash = (page: Page) => new URLSearchParams(new URL(page.url()).hash.slice(1)).get('thread');

/** What a widget runs: the command, its stdout and how long it took. */
function openThread(thread: string): { stdout: string; ms: number } {
  const started = Date.now();
  const run = spawnSync(binary, ['inbox', '--open', thread], { env: world.env, encoding: 'utf8', timeout: 30_000 });
  expect(run.status, run.stderr).toBe(0);
  return { stdout: run.stdout.trim(), ms: Date.now() - started };
}

/** The person comes back to this window (the browser's own focus, which headless pages do not get by themselves). */
const useWindow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-show-thread-e2e-');
  const env = { ...scratchEnv(root), PATH: process.env.PATH ?? '', PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_TEST_SANDBOX: '1' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(env.PLANNOTATOR_DATA_DIR);
  const url = started.stdout.trim();
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const a = await claude.send({ project_path: billing, subject: 'The invoice list is built', body: 'The invoice list is built as cards. Tell me what to change.' });
  const b = await codex.send({ project_path: billing, subject: 'Refunds now post to the ledger', body: 'Refunds post to the ledger the moment they are approved.' });
  const c = await codex.send({ project_path: billing, subject: 'Tax rounding fixed', body: 'Tax now rounds per line, not per invoice.' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  const page = await context.newPage();
  world = { env, url, agents: [claude, codex], context, page, threads: { a: a.thread_id, b: b.thread_id, c: c.thread_id } };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.agents.map((agent) => agent.close().catch(() => {})));
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('--open B moves the open window from A to B like a row click; Back returns to A with the reply still typed', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  await row(page, threads.a).click();
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await box(page).fill(WORDS);
  await expect.poll(() => draftWords(threads.a)).toBe(WORDS);
  await useWindow(page);
  await shot(page, '1-window-on-thread-a');

  const run = openThread(threads.b);
  // It prints the thread's address and returns at once.
  expect(run.stdout).toBe(`${world.url}#thread=${threads.b}`);
  expect(run.ms).toBeLessThan(10_000);
  await expect.poll(() => threadInHash(page)).toBe(threads.b);
  await expect(pane(page)).toContainText('Refunds post to the ledger');
  // Still one window: no tab opened.
  expect(world.context.pages()).toHaveLength(1);
  // The words typed in A are kept as its draft.
  expect(await draftWords(threads.a)).toBe(WORDS);
  await shot(page, '2-same-window-on-thread-b');

  await page.goBack();
  await expect.poll(() => threadInHash(page)).toBe(threads.a);
  await expect(pane(page)).toContainText('The invoice list is built as cards');
  await expect(box(page)).toHaveValue(WORDS);
  await shot(page, '3-back-on-thread-a');
});

test('with two windows open, the one used last moves and the other stays put; a #thread= link works too', async () => {
  const { page, threads } = world;
  const other = await world.context.newPage();
  await other.goto(world.url);
  await expect(row(other, threads.c)).toBeVisible();
  await useWindow(other);
  const before = threadInHash(page);

  openThread(`${world.url}#thread=${threads.c}`);
  await expect.poll(() => threadInHash(other)).toBe(threads.c);
  await page.waitForTimeout(300);
  expect(threadInHash(page)).toBe(before);

  // The person goes back to the first window: that one moves next.
  await useWindow(page);
  await page.waitForTimeout(200);
  openThread(threads.b);
  await expect.poll(() => threadInHash(page)).toBe(threads.b);
  await other.waitForTimeout(300);
  expect(threadInHash(other)).toBe(threads.c);
  await other.close();
});
