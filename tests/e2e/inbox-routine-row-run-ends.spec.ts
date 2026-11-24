/**
 * A routine's list row while its run ends, proved in a real browser against the compiled binary and its real
 * launch: the row's Running (with its dots) goes once the run's session has answered and gone idle, in a wide
 * window and in a phone-sized one at the same time, without the thread being opened and with the Routines page
 * closed. A run's end writes no store line (only its launch's run line moves, `event: deliveries`), so before the
 * fix the row kept Running for hours, until the person opened the thread (whose look rewrites the run's divider).
 *
 * The only fakes are the programs launch runs, on a PATH of their own (tests/helpers/fake-claude/), with `hold` so
 * the run's turn keeps working until the spec lets it answer. Temp HOME and PLANNOTATOR_DATA_DIR, the test sandbox
 * (the start-at-login item is written under the data dir, run by nothing), PLANNOTATOR_INBOX_CONNECT=0, NO_BROWSER;
 * the real Claude Code, the real home and the person's Inbox are never touched.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-routine-row-run-ends.spec.ts`.
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

interface World {
  url: string;
  home: string;
  fake: FakeClaude;
  contexts: BrowserContext[];
}
let world: World;

interface RoutineRow {
  id: string;
  state: string;
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

const badge = (page: Page, threadId: string) => page.locator(`[data-thread-id="${threadId}"] [data-scheduled-badge="running"]`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(process.platform === 'win32', 'Routines are not offered on Windows.');
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-routine-row-run-ends-e2e-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  for (const dir of [home, bin, dataDir]) mkdirSync(dir, { recursive: true });
  // Plannotator's Claude Code plugin is on in the sandbox's own agent home, and the fake `claude` is on its launch PATH
  // (PLANNOTATOR_TEST_LAUNCH_PATH below), as in inbox-icon-animate.spec.ts: a sandboxed Inbox finds no other agent CLI.
  mkdirSync(join(dataDir, 'agents-home', '.claude'), { recursive: true });
  writeFileSync(join(dataDir, 'agents-home', '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const fake = installFakeClaude({ bin, state: join(root, 'fake-claude'), config: { hold: true, workMs: 300 } });
  markTourDecided(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, inboxLaunch: { enabled: true, fullPermissions: false }, inboxScheduledThreads: true }));
  const env: Record<string, string> = {
    // Only the fakes and the system's own tools: never the agents installed on the machine running the spec.
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
  world = { url: started.stdout.trim(), home, fake, contexts: [] };
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

test("a run's end takes Running off its list row, on a wide window and a phone at once, with nothing opened", async ({ browser }: { browser: Browser }) => {
  const wide = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  world.contexts.push(wide, phone);
  const desk = await wide.newPage();
  const hand = await phone.newPage();
  for (const page of [desk, hand]) await page.goto(world.url);

  // A routine made in the window, run once now: its turn keeps working (`hold`) until the spec lets it answer.
  // A new scratch folder, made by the Inbox under its data dir: a typed path under the runner's temp dir is a system
  // folder on Linux (`/tmp`), which a routine refuses as New message does.
  const made = await windowPost(desk, '/api/inbox/scheduled', { name: 'Nightly dependency check', prompt: 'Check the dependencies for updates.', schedule: null, folder: { scratch: true }, agent: 'claude-code', attachments: [], enabled: true });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const id = (made.body.scheduled as RoutineRow).id;
  const ran = await windowPost(desk, `/api/inbox/scheduled/${id}/run`, {});
  expect(ran.status, JSON.stringify(ran.body)).toBe(202);
  expect(ran.body.failed ?? null).toBeNull();
  await waitFor('claude --bg', () => world.fake.starts().at(-1));
  const threadId = await waitFor('the routine running in its thread', async () => (await routines()).find((r) => r.id === id && r.state === 'running' && r.thread_id)?.thread_id);

  for (const page of [desk, hand]) await expect(badge(page, threadId)).toBeVisible({ timeout: 30_000 });

  // The turn answers and the session goes idle: the Inbox says the run is no longer running.
  world.fake.configure({ hold: false });
  await waitFor('the run to end in the Inbox', async () => (await routines()).find((r) => r.id === id && r.state !== 'running'));

  // Both windows drop Running by themselves: no thread opened, no Routines page.
  for (const page of [desk, hand]) {
    await expect(badge(page, threadId)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(`[data-thread-id="${threadId}"]`).first()).toBeVisible();
    expect(new URL(page.url()).hash).not.toContain('thread=');
    expect(new URL(page.url()).hash).not.toContain('routine');
  }
});
