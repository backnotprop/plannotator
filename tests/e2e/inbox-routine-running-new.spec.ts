/**
 * A routine's run going is under New, with its Running mark, until the run ends (the owner, 2026-11-24), proved in
 * a real browser against the compiled binary and its real launch, with the windows open the whole time: a wide one
 * light and dark and a phone-sized one light and dark. Run 1 ends and its thread is read (Quiet); Run 2 then starts
 * and its row comes up under New with Running in every window without a reload; when Run 2 ends Running goes and
 * the row keeps its place. Before the fix Run 2's thread stayed in folded Quiet (its divider, taken by the run's
 * session, is a reply the agent has) and the held list let nothing in until a reload (release QA, 0.29.4).
 *
 * The only fakes are the programs launch runs, on a PATH of their own (tests/helpers/fake-claude/), with `hold` so
 * each run's turn keeps working until the spec lets it answer. Temp HOME and PLANNOTATOR_DATA_DIR, the test sandbox
 * (the start-at-login item is written under the data dir, run by nothing), PLANNOTATOR_INBOX_CONNECT=0, NO_BROWSER;
 * the real Claude Code, the real home and the person's Inbox are never touched.
 *
 * Whole-window pictures land in PLANNOTATOR_ROUTINE_RUNNING_SHOTS, else .local/proof/routine-running (CI keeps
 * .local/proof/ as the shard's artifact). Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-routine-running-new.spec.ts`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { installFakeClaude, type FakeClaude } from '../helpers/fake-claude';
import { E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_ROUTINE_RUNNING_SHOTS ?? join(repo, '.local/proof/routine-running'));

interface World {
  url: string;
  fake: FakeClaude;
  contexts: BrowserContext[];
}
let world: World;

interface RoutineRow {
  id: string;
  state: string;
  runs: number;
  thread_id: string | null;
}

/** A window route (same origin, this run's `serverSession`), from the page itself. */
async function windowPost(page: Page, path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ path, body }) => {
      const health = (await (await fetch('/api/inbox/health')).json()) as { serverSession: string };
      const answer = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, serverSession: health.serverSession }) });
      return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
    },
    { path, body },
  );
}

/** The Inbox's own routines, read from it (never the page). */
async function routines(): Promise<RoutineRow[]> {
  const answer = await fetch(new URL('/api/inbox/scheduled', world.url), { headers: { Accept: 'application/json' } });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { scheduled: RoutineRow[] }).scheduled;
}

async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const inNew = (page: Page, threadId: string) => page.locator(`[data-section-id="new"] [data-thread-id="${threadId}"]`);
const running = (page: Page, threadId: string) => page.locator(`[data-thread-id="${threadId}"] [data-scheduled-badge="running"]`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(process.platform === 'win32', 'Routines are not offered on Windows.');
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-routine-running-new-e2e-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  for (const dir of [home, bin, dataDir]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(dataDir, 'agents-home', '.claude'), { recursive: true });
  writeFileSync(join(dataDir, 'agents-home', '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const fake = installFakeClaude({ bin, state: join(root, 'fake-claude'), config: { hold: true, workMs: 300 } });
  markTourDecided(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, inboxLaunch: { enabled: true, fullPermissions: false }, inboxScheduledThreads: true }));
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    SHELL: fake.shell,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_TEST_LAUNCH_PATH: `${bin}:/usr/bin:/bin`,
    NO_ANON_PING: '1',
    PLANNOTATOR_DATA_DIR: dataDir,
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
  rememberInboxOf(dataDir);
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number };
  world = { url: started.stdout.trim(), fake, contexts: [] };
  await fetch(`http://127.0.0.1:${registry.port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
});

test.afterAll(async () => {
  try {
    world?.fake.stopAll();
    for (const context of world?.contexts ?? []) await context.close();
  } finally {
    await removeInboxScratch();
  }
});

test("a routine's second run, with the windows open: its row comes up under New with Running at once, and keeps its place when the run ends", async ({ browser }: { browser: Browser }) => {
  const looks = [
    { look: 'desk-light', viewport: { width: 1440, height: 900 }, colorScheme: 'light' as const, phone: false },
    { look: 'desk-dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' as const, phone: false },
    { look: 'phone-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' as const, phone: true },
    { look: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' as const, phone: true },
  ];
  const pages: { look: string; page: Page }[] = [];
  for (const { look, viewport, colorScheme, phone } of looks) {
    const context = await browser.newContext({ viewport, colorScheme, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    world.contexts.push(context);
    const page = await context.newPage();
    await page.goto(world.url);
    pages.push({ look, page });
  }
  const desk = pages[0]!.page;

  // Run 1: a routine made in the window, run once now; it answers and ends, and the person reads its thread.
  const made = await windowPost(desk, '/api/inbox/scheduled', { name: 'Nightly ledger check', prompt: 'Check the ledger exports for Ada Novak.', schedule: null, folder: { scratch: true }, agent: 'claude-code', attachments: [], enabled: true });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const id = (made.body.scheduled as RoutineRow).id;
  const first = await windowPost(desk, `/api/inbox/scheduled/${id}/run`, {});
  expect([first.status, first.body.failed ?? null]).toEqual([202, null]);
  const threadId = await waitFor('Run 1 going in its thread', async () => (await routines()).find((r) => r.id === id && r.state === 'running' && r.thread_id)?.thread_id);
  world.fake.configure({ hold: false });
  await waitFor('Run 1 to end', async () => (await routines()).find((r) => r.id === id && r.state !== 'running'));
  const seen = await windowPost(desk, `/api/inbox/threads/${threadId}/seen`, {});
  expect(seen.status).toBe(200);
  for (const { page } of pages) {
    await page.reload();
    // Read and ended: the thread is in Quiet (folded), not in New.
    await expect(page.locator('[data-section-id="quiet"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(inNew(page, threadId)).toHaveCount(0);
  }

  // Run 2, the windows open: no reload from here on.
  world.fake.configure({ hold: true });
  const second = await windowPost(desk, `/api/inbox/scheduled/${id}/run`, {});
  expect([second.status, second.body.failed ?? null]).toEqual([202, null]);
  await waitFor('Run 2 going', async () => (await routines()).find((r) => r.id === id && r.state === 'running' && r.runs === 2));
  for (const { look, page } of pages) {
    await expect(running(page, threadId)).toBeVisible({ timeout: 30_000 });
    await expect(inNew(page, threadId)).toBeVisible();
    // Shown, not announced: the tab's title carries no count. That it raises no "N new" and is not bold is
    // packages/inbox/scheduled/runEntersHeld.test.tsx's to prove.
    await expect(page.locator('[data-section-id="new"] [data-thread-id] [data-scheduled-badge="running"]')).toHaveCount(1);
    expect(await page.title()).not.toMatch(/^\(\d/);
    await page.screenshot({ path: join(shots, `second-run-started-${look}.png`) });
  }

  // Run 2 ends: Running goes by itself, and the row stays where it is on screen.
  world.fake.configure({ hold: false });
  await waitFor('Run 2 to end', async () => (await routines()).find((r) => r.id === id && r.state !== 'running'));
  for (const { look, page } of pages) {
    await expect(running(page, threadId)).toHaveCount(0, { timeout: 15_000 });
    await expect(inNew(page, threadId)).toBeVisible();
    expect(new URL(page.url()).hash).not.toContain('thread=');
    await page.screenshot({ path: join(shots, `run-ended-${look}.png`) });
  }
});
