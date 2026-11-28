/**
 * Start an agent in T3 Code (issue #3590): Settings → Agents' "Start new agents in" T3 Code, then New message's
 * Claude Code, proved in a real browser against the compiled binary and its real launch endpoint. Nothing in the Inbox
 * is mocked; the only fakes are T3 Code's `t3` launcher in the sandbox's own agent home (tests/helpers/fake-t3.ts) and
 * Claude Code's `claude` (tests/helpers/fake-claude), for the start in the background. The real T3 Code, the real home
 * and the person's Inbox are never touched: PLANNOTATOR_TEST_SANDBOX, a temp HOME and PLANNOTATOR_DATA_DIR, a launch
 * PATH of the fakes and the system's tools alone, PLANNOTATOR_INBOX_CONNECT=0, NO_BROWSER.
 *
 *  1. The journey: Settings → Agents offers T3 Code and saves it; New message → Claude Code in shop → Send runs one
 *     `t3 thread start . - --title=… --provider=claudeAgent --model=opus --json` in the project (the model T3 last ran
 *     Claude Code on there), the message on stdin; the thread says "In T3 Code · opus", has no Stop, and a reply goes
 *     into the T3 thread once.
 *  2. T3 Code not running: the agent starts in the background, and its line says why.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-launch-t3.spec.ts`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_T3_NOT_HERE } from '../../packages/core/inbox-run-line';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { installFakeClaude, type FakeClaude } from '../helpers/fake-claude';
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
  claude: FakeClaude;
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

/** New message → To → "Claude Code in shop" → words → Send; the thread opened. */
async function launch(page: Page, words: string): Promise<{ threadId: string; launchId: string }> {
  await page.goto(world.url);
  await page.locator('.ib-side [data-open-compose]').click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.locator('[data-compose-to]').click();
  await d.locator('[data-compose-start="claude-code"]').click();
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
    thread: { messages: { id: string; body: string; author: { kind: string }; to?: { host: string; session: string } | null; delivery?: { state: string } | null; launch?: { t3?: Record<string, true> } }[] };
  };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-launch-t3-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  // The project: a git repository on `main`.
  const shop = join(root, 'code', 'shop');
  mkdirSync(shop, { recursive: true });
  const agentsHome = join(dataDir, 'agents-home');
  // T3 Code's launcher where its desktop app puts it, in the sandbox's agent home; T3 knows the repository, and last
  // ran Claude Code there on opus.
  const t3 = makeFakeT3Home(agentsHome, {}, { projects: [realpathSync(shop)], db: false, used: { [realpathSync(shop)]: [{ threadId: 'thread:project:shop:1', title: 'Totals', providerInstanceId: 'claudeAgent', model: 'opus' }] } });
  // Claude Code, for New message's row and a start in the background: Plannotator's plugin on, the project trusted.
  const fakes = join(root, 'fakes');
  const claude = installFakeClaude({ bin: fakes, state: join(root, 'fake-claude') });
  mkdirSync(join(agentsHome, '.claude'), { recursive: true });
  writeFileSync(join(agentsHome, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  writeFileSync(join(agentsHome, '.claude.json'), JSON.stringify({ projects: { [realpathSync(shop)]: { hasTrustDialogAccepted: true } } }));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxLaunch: { enabled: true } }));
  markTourDecided(dataDir);
  const env: Record<string, string> = {
    // The system's own tools alone: never a `t3` installed on the machine running the spec.
    PATH: '/usr/bin:/bin',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_TEST_LAUNCH_PATH: `${fakes}:/usr/bin:/bin`,
    SHELL: claude.shell,
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
  world = { root, dataDir, env, url: started.stdout.trim(), port: registry.port, t3, claude, shop: realpathSync(shop), context: undefined as never, page: undefined as never, errors: [] };
  await fetch(`http://127.0.0.1:${world.port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  await seed(world.shop, 'ses-seed-shop');
  const context = await browser.newContext({ viewport: WIDE, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (error) => world.errors.push(error.message));
  world.context = context;
  world.page = page;
});

test.afterAll(async () => {
  try {
    world?.claude?.stopAll();
    await world?.context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the journey: Settings → Agents starts new agents in T3 Code; Claude Code starts as one T3 thread on the model T3 last ran it on, no Stop, a reply goes into the thread once', async () => {
  test.setTimeout(120_000);
  const { page, t3 } = world;
  // Settings → Agents: T3 Code is on this computer, so it is offered; the person picks it.
  await page.goto(`${world.url}#settings/agents`);
  const row = page.locator('[data-launch-start-in-row]');
  await expect(row.locator('[data-launch-start-in="t3"]')).toHaveText('T3 Code');
  await row.locator('[data-launch-start-in="t3"]').click();
  await expect(row).toHaveAttribute('data-launch-start-in-row', 't3');
  await expect(row.locator('[data-launch-start-in-t3]')).toContainText('In T3 Code, each new agent runs as a thread of T3 Code for its project');

  const { threadId } = await launch(page, 'Tighten the checkout copy. Keep the button label.');
  const p = pane(page);
  await expect(p.locator('[data-launched]')).toContainText('You started Claude Code in shop');
  await expect(p.locator('[data-launch-t3]')).toHaveText('In T3 Code · opus', { timeout: 20_000 });

  const start = await waitFor('t3 thread start', () => t3.starts()[0]);
  expect(start).toMatchObject({ cwd: world.shop, base: null, provider: 'claudeAgent', model: 'opus' });
  const starts = t3.calls().filter((args) => args[0] === 'thread' && args[1] === 'start');
  expect(starts).toHaveLength(1);
  expect(starts[0]!.slice(0, 4)).toEqual(['thread', 'start', '.', '-']);
  expect(starts[0]!.slice(5)).toEqual(['--provider=claudeAgent', '--model=opus', '--json']);
  // T3 knew the model: no token was asked for.
  expect(t3.issued()).toEqual([]);
  // The T3 wake never took the launch's placeholder for a thread; the message went in on stdin.
  expect(t3.calls().filter((args) => args.some((arg) => arg.startsWith('launch:')))).toEqual([]);
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
  await expect(page.locator('[data-thread-menu] [data-launch-item="stop"]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await p.getByRole('textbox', { name: /^Reply to/ }).fill('Also check the totals line.');
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  await waitFor('the reply went into the T3 thread', () => t3.turns().some(([at, text]) => at === start.id && text.includes('Also check the totals line.')), 30_000);
  expect(t3.sends()).toEqual([['thread', 'send', start.id, '-', '--json']]);
  expect(t3.starts()).toHaveLength(1);
  expect(world.errors).toEqual([]);
});

test("T3 Code not running: the agent starts in the background, and its line says why", async () => {
  test.setTimeout(120_000);
  const { page, t3 } = world;
  t3.setState('down');
  try {
    const before = t3.starts().length;
    const { threadId } = await launch(page, 'Rename the cart module.');
    await expect
      .poll(async () => (await readThread(page, threadId)).thread.messages[0]?.launch?.t3, { timeout: 30_000 })
      .toEqual({ unavailable: true });
    await expect(pane(page).locator('[data-run-t3-away]')).toHaveText(INBOX_T3_NOT_HERE, { timeout: 30_000 });
    expect(t3.starts()).toHaveLength(before);
  } finally {
    t3.setState('up');
  }
});
