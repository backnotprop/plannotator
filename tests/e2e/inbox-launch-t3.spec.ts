/**
 * Start T3 Code from compose's To (issue #3590), proved in a real browser against the compiled binary and its real
 * launch endpoint. Nothing in the Inbox is mocked; the only fake is T3 Code's `t3` launcher in the sandbox's own
 * agent home (tests/helpers/fake-t3.ts: `thread start` and `thread send` as T3's cli/thread.ts answers them). The
 * real T3 Code, the real home and the person's Inbox are never touched: PLANNOTATOR_TEST_SANDBOX, a temp HOME and
 * PLANNOTATOR_DATA_DIR, a launch PATH of the system's tools alone, PLANNOTATOR_INBOX_CONNECT=0, NO_BROWSER.
 *
 *  1. The journey: To offers T3 Code in the git repository only, and says it starts in a new worktree from the
 *     branch the project is on; Send runs one `t3 thread start . - --worktree main …` in the project with the
 *     message on stdin; the thread says who started it, has no Stop, and a reply goes into the new T3 thread once.
 *  2. T3 Code not running: the line says why in T3's own words and keeps the message; Try again starts it.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-launch-t3.spec.ts`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { makeFakeT3Home, type FakeT3Home } from '../helpers/fake-t3';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const WIDE = { width: 1440, height: 900 };
const CLOSED = 'http://127.0.0.1:9';

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  port: number;
  t3: FakeT3Home;
  shop: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const dialog = (page: Page) => page.locator('dialog[data-compose]');
const pane = (page: Page) => page.locator('section.ib-pane');

/** An agent writes from `folder`, so it is one of the Inbox's projects. */
async function seed(folder: string, session: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${world.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { body: 'The build is green again.', project_path: folder, agent_session: session, agent_host: 'claude-code' } } }),
  });
  expect(response.status).toBe(200);
  await response.text();
}

/** New message → To → "T3 Code in shop" → words → Send; the thread opened. */
async function launch(page: Page, words: string): Promise<{ threadId: string; launchId: string }> {
  await page.goto(world.url);
  await page.locator('.ib-side [data-open-compose]').click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.locator('[data-compose-to]').click();
  // Only the git repository: the plain folder is no place for T3 Code's worktree.
  await expect(d.locator('[data-compose-start="t3"]')).toHaveCount(1);
  await expect(d.locator('[data-compose-start="t3"]')).toHaveAttribute('data-compose-start-project', 'shop');
  await d.locator('[data-compose-start="t3"]').click();
  await expect(d.locator('[data-compose-to="start"]')).toHaveText(/New T3 Code session/);
  await expect(d.locator('[data-compose-status]')).toHaveText('T3 Code starts in a new worktree, from the branch shop is on now.');
  await d.getByRole('textbox', { name: 'Message' }).fill(words);
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/inbox/messages') && r.request().method() === 'POST');
  await d.locator('[data-compose-send]').click();
  const body = (await (await answer).json()) as { thread_id: string; launch: { id: string; state: string } };
  expect(body.launch.state).toBe('starting');
  await expect(d).toHaveCount(0);
  await page.goto(`${world.url}#thread=${body.thread_id}`);
  await page.reload();
  await expect(pane(page).locator('[data-launched]')).toBeVisible();
  return { threadId: body.thread_id, launchId: body.launch.id };
}

async function readThread(page: Page, threadId: string) {
  return (await page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}`)).json(), threadId)) as {
    thread: { messages: { id: string; body: string; author: { kind: string }; to?: { host: string; session: string } | null; delivery?: { state: string } | null }[] };
  };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-launch-t3-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  // The projects: one git repository (on `main`), one plain folder.
  const shop = join(root, 'code', 'shop');
  const notes = join(root, 'code', 'notes');
  for (const dir of [shop, notes]) mkdirSync(dir, { recursive: true });
  // T3 Code's launcher where its desktop app puts it, in the sandbox's agent home; T3 knows the repository.
  const t3 = makeFakeT3Home(join(dataDir, 'agents-home'), {}, { projects: [realpathSync(shop)], db: false });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxLaunch: { enabled: true } }));
  markTourDecided(dataDir);
  const env: Record<string, string> = {
    // The system's own tools alone: never a `t3` installed on the machine running the spec.
    PATH: '/usr/bin:/bin',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_TEST_LAUNCH_PATH: '/usr/bin:/bin',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER: '1',
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: CLOSED,
  };
  // The repository, made with the spec's own env and no git config of the machine's.
  const git = spawnSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: shop, env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  expect(git.status).toBe(0);
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number };
  world = { root, dataDir, env, url: started.stdout.trim(), port: registry.port, t3, shop: realpathSync(shop), context: undefined as never, page: undefined as never, errors: [] };
  await fetch(`http://127.0.0.1:${world.port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  await seed(world.shop, 'ses-seed-shop');
  await seed(realpathSync(notes), 'ses-seed-notes');
  const context = await browser.newContext({ viewport: WIDE, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (error) => world.errors.push(error.message));
  world.context = context;
  world.page = page;
});

test.afterAll(async () => {
  try {
    await world?.context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the journey: T3 Code in the repository only, one `t3 thread start` in a new worktree from main, no Stop, a reply goes into the thread once', async () => {
  test.setTimeout(120_000);
  const { page, t3 } = world;
  const { threadId } = await launch(page, 'Tighten the checkout copy. Keep the button label.');
  const p = pane(page);
  await expect(p.locator('[data-launched]')).toHaveText('You started T3 Code in shop');

  const start = await waitFor('t3 thread start', () => t3.starts()[0]);
  expect(start.cwd).toBe(world.shop);
  expect(start.base).toBe('main');
  expect(t3.calls()[0]!.slice(0, 7)).toEqual(['thread', 'start', '.', '-', '--worktree', 'main', '--title']);
  expect(t3.calls()[0]!.at(-1)).toBe('--json');
  // The message went in on stdin, never on the command line.
  expect(start.text).toContain('Tighten the checkout copy.');
  expect(t3.calls().flat().join(' ')).not.toContain('Tighten');

  // The root is the new thread's, delivered: no wake sends it again.
  await expect
    .poll(async () => (await readThread(page, threadId)).thread.messages[0], { timeout: 20_000 })
    .toMatchObject({ to: { host: 't3', session: start.id }, delivery: { state: 'delivered' } });
  await page.waitForTimeout(2_000);
  expect(t3.sends()).toEqual([]);

  // T3 Code runs the thread: no Stop on the thread's menu.
  await p.locator('[data-thread-more]').click();
  await page.locator('[data-thread-menu] [data-launch-item]').first().waitFor({ state: 'visible', timeout: 10_000 });
  expect(await page.locator('[data-thread-menu] [data-launch-item]').allTextContents()).not.toContain('Stop T3 Code');
  await page.keyboard.press('Escape');

  await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await p.getByRole('textbox', { name: /^Reply to/ }).fill('Also check the totals line.');
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  await waitFor('the reply went into the T3 thread', () => t3.turns().some(([at, text]) => at === start.id && text.includes('Also check the totals line.')), 30_000);
  expect(t3.sends()).toEqual([['thread', 'send', start.id, '-', '--json']]);
  expect(t3.starts()).toHaveLength(1);
  expect(world.errors).toEqual([]);
});

test("T3 Code not running: the line gives T3's own reason and keeps the message; Try again starts it", async () => {
  test.setTimeout(120_000);
  const { page, t3 } = world;
  t3.setState('down');
  try {
    const before = t3.starts().length;
    await launch(page, 'Rename the cart module.');
    const p = pane(page);
    const line = p.locator('[data-run="failed"]');
    await expect(line).toContainText("T3 Code didn't start.", { timeout: 30_000 });
    await expect(line).toContainText('Start T3 Code, then retry.');
    await expect(line).toContainText('Your message is kept.');
    expect(t3.starts()).toHaveLength(before);
    t3.setState('up');
    await line.locator('[data-run-retry]').click();
    await waitFor('the thread started', () => t3.starts().length === before + 1, 30_000);
    await expect(p.locator('[data-run="failed"]')).toHaveCount(0, { timeout: 20_000 });
  } finally {
    t3.setState('up');
  }
});
