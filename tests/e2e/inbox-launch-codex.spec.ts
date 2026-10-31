/**
 * Launch, PR 4: start Codex from compose's To, proved in a real browser
 * against the compiled binary and its real launch endpoint. Nothing in the
 * Inbox is mocked. The only fakes are the programs launch runs, on a PATH of
 * their own: `codex` and its app-server daemon (tests/helpers/fake-codex/:
 * JSON-RPC over a WebSocket on the control socket, threads, turns, approval
 * requests, and a turn's reply through the Inbox's MCP), `osascript`
 * (recorded, nothing opens) and a stand-in login shell. The real Codex, the
 * real home and the person's Inbox are never touched: temp HOME and
 * PLANNOTATOR_DATA_DIR, PLANNOTATOR_INBOX_CONNECT=0, PLANNOTATOR_UPDATE_CHECK=0,
 * NO_BROWSER.
 *
 * The journey: To offers "Codex New session"; Send starts the daemon and a
 * thread in the project with the folder's trust in memory (config.toml stays
 * byte for byte); the Codex wake puts the message in as a `turn/start`; the
 * line says Codex is working, and its reply lands in the thread. A reply
 * brings an approval request: the permission card, as Codex (no Auto mode or
 * Full permissions), Allow once goes back as `accept`. Stop interrupts the
 * running turn; a reply after Stop rejoins the thread and starts a turn.
 * Open in Terminal runs `codex resume <id>`; Delete deletes the thread.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-launch-codex.spec.ts`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { installFakeCodex, type FakeCodex } from '../helpers/fake-codex';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const WIDE = { width: 1440, height: 900 };

interface World {
  root: string;
  home: string;
  bin: string;
  dataDir: string;
  url: string;
  port: number;
  fake: FakeCodex;
  project: string;
  configBefore: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function git(dir: string): string {
  mkdirSync(dir, { recursive: true });
  spawnSync('/usr/bin/git', ['init', '-q'], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: world?.home ?? dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return realpathSync(dir);
}

/** An agent writes in a project through the Inbox's MCP: the project exists in the Inbox from then on. */
async function agentWrites(project: string, session: string, body: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${world.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { body, project_path: project, agent_session: session, agent_host: 'claude-code' } } }),
  });
  expect(response.status).toBe(200);
}

const dialog = (page: Page) => page.locator('dialog[data-compose]');
const pane = (page: Page) => page.locator('section.ib-pane');
const card = (page: Page) => pane(page).locator('section.pc-card[data-permission]').last();
const agentMessages = (page: Page) => pane(page).locator('article.ib-message[data-author="agent"]');

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The thread's reply box: the words, then Send. */
async function replyInWindow(page: Page, words: string): Promise<void> {
  const p = pane(page);
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await p.getByRole('textbox', { name: /^Reply to Codex/ }).fill(words);
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-launch-codex-e2e-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  for (const dir of [home, bin, dataDir]) mkdirSync(dir, { recursive: true });
  // A person who connected Codex: the Inbox's MCP entry in config.toml (how a launched thread answers), and their own lines.
  const fake = installFakeCodex({
    bin,
    state: join(root, 'fake-codex'),
    home,
    config: { workMs: 600 },
    inboxMcp: join(bin, 'plannotator'),
    configToml: `model = "gpt-5"\n# the person's own comment\n[projects."${join(home, 'elsewhere')}"]\ntrust_level = "untrusted"\n`,
  });
  // Open in Terminal: what it would have run, recorded; nothing opens.
  writeFileSync(join(bin, 'osascript'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> ${q(join(root, 'osascript.log'))}\nprintf '\\n' >> ${q(join(root, 'osascript.log'))}\n`, { mode: 0o755 });
  // `$SHELL -ilc <command>`: the command, with the fakes first on PATH (the person's .zshrc would).
  const shell = join(bin, 'login-shell');
  writeFileSync(shell, `#!/bin/sh\nPATH=${q(bin)}:"$PATH"\nexport PATH\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });
  world = { root, home, bin, dataDir, url: '', port: 0, fake, project: '', configBefore: fake.configToml()!, context: undefined as never, page: undefined as never, errors: [] };
  markTourDecided(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const env: Record<string, string> = {
    // Only the fakes and the system's own tools: never the agents installed on the machine running the spec.
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    SHELL: shell,
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
  world.url = started.stdout.trim();
  world.port = registry.port;
  await fetch(`http://127.0.0.1:${world.port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  world.project = git(join(home, 'work', 'ledger'));
  await agentWrites(world.project, 'ses-ledger', 'The ledger totals drift by a cent on refunds.');

  const context = await browser.newContext({ viewport: WIDE, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (error) => world.errors.push(error.message));
  world.context = context;
  world.page = page;
});

test.afterAll(async () => {
  try {
    world?.fake.stopAll();
    await world?.context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the journey: To offers Codex; Send starts a thread (config.toml untouched) and its first turn; its reply; an approval on the card; Stop; a reply after Stop; Open; Delete', async () => {
  const { page, fake } = world;
  await page.goto(world.url);
  await page.locator('.ib-side').getByText('ledger', { exact: true }).first().click();
  await page.locator('.ib-side [data-open-compose]').click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.locator('[data-compose-to]').click();
  await expect(d.locator('[data-compose-start="codex"]')).toContainText('CodexNew session');
  await d.locator('[data-compose-start="codex"]').click();
  await expect(d.locator('[data-compose-to="start"]')).toHaveText(/New Codex session/);
  const words = 'The refund total is off by a cent. Find where the rounding happens.';
  await d.getByRole('textbox', { name: 'Message' }).fill(words);
  await expect(d.locator('[data-compose-status]')).toHaveText('Codex starts in ~/work/ledger when you send.');
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/inbox/messages') && r.request().method() === 'POST');
  await d.locator('[data-compose-send]').click();
  const sent = (await (await answer).json()) as { thread_id: string; launch: { id: string; state: string } };
  expect(sent.launch.state).toBe('starting');
  const threadId = sent.thread_id;
  const launchId = sent.launch.id;

  // The daemon, then thread/start in the project: its trust in memory, this Inbox's data dir for its MCP; nothing on disk changes.
  await waitFor('codex app-server daemon start', () => fake.calls().some((c) => c.argv.join(' ') === 'app-server daemon start'));
  const start = await waitFor('thread/start', () => fake.rpc('thread/start')[0]);
  expect(start.params.cwd).toBe(world.project);
  expect(start.params.config.projects).toEqual({ [world.project]: { trust_level: 'trusted' } });
  expect(start.params.config['mcp_servers.plannotator-inbox.env.PLANNOTATOR_DATA_DIR']).toBe(world.dataDir);
  expect(fake.configToml()).toBe(world.configBefore);

  // The Codex wake puts the message in as the thread's first turn (turn/start, never codex queue); it answers in the thread.
  const first = await waitFor('the first turn', () => fake.turns().find((t) => t.how === 'turn/start'), 30_000);
  expect(first.text).toContain(words);
  expect(first.text).toMatch(/^Plannotator Inbox: /);
  expect(fake.calls().some((c) => c.argv[0] === 'queue')).toBe(false);
  await page.goto(`${world.url}#thread=${threadId}`);
  await page.reload();
  const p = pane(page);
  await expect(p.locator('[data-launched]')).toHaveText('You started Codex in ledger');
  await expect(agentMessages(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(agentMessages(page).first()).toContainText('Done (turn 1)');
  await expect(p.locator('[data-run]')).toHaveCount(0, { timeout: 30_000 });

  // A reply; this turn asks to run a command: the permission card, as Codex, with Codex's choices.
  fake.configure({ prompts: [{ kind: 'command', command: 'bun test', reason: 'Run the tests' }] });
  await replyInWindow(page, 'Run the tests first.');
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  await expect(card(page).locator('.pc-app')).toHaveText('Codex');
  await expect(card(page)).toHaveAttribute('aria-label', 'Codex asks permission to run a command');
  await expect(card(page).locator('[data-perm-detail]')).toHaveText('bun test');
  await expect(card(page).locator('[data-perm-mode]')).toHaveCount(0);
  await expect(card(page).locator('[data-perm="session"]')).toBeVisible();
  await expect(card(page)).toHaveAttribute('data-perm-armed', '', { timeout: 30_000 });
  await card(page).locator('[data-perm="once"]').click();
  const approved = await waitFor('the approval answered', () => fake.approvals()[0], 30_000);
  expect(approved).toMatchObject({ method: 'item/commandExecution/requestApproval', result: { decision: 'accept' }, how: 'answered' });
  await expect(p.locator('[data-perm-record="once"]')).toContainText('You chose Allow once');
  await expect(agentMessages(page).filter({ hasText: 'Done (turn 2) [accept]' })).toHaveCount(1, { timeout: 30_000 });

  // Stop while a turn runs: turn/interrupt of that turn; the line says who stopped it.
  fake.configure({ prompts: [], hold: true });
  await replyInWindow(page, 'Now fix the rounding.');
  await expect(p.locator('[data-run="working"]')).toContainText(/^Codex is working/, { timeout: 30_000 });
  const third = await waitFor('the third turn', () => fake.turns().filter((t) => t.how === 'turn/start')[2]);
  await p.locator('[data-run="working"] [data-run-stop]').click();
  await expect(p.locator('[data-run="stopped"]')).toHaveText(/^You stopped Codex at \d{1,2}:\d{2} [AP]M\. Your reply starts it again\.$/, { timeout: 30_000 });
  const interrupt = await waitFor('turn/interrupt', () => fake.rpc('turn/interrupt')[0]);
  expect(interrupt.params).toMatchObject({ threadId: first.threadId, turnId: third.turnId });
  await waitFor('the turn interrupted', () => fake.turns().some((t) => t.turnId === third.turnId && t.ended === 'interrupted'));

  // A reply after Stop: the thread is rejoined and the reply starts a turn (a queued message would wait on the interrupted thread).
  fake.configure({ hold: false });
  await replyInWindow(page, 'Go on, keep exact matches first.');
  await waitFor('thread/resume', () => fake.rpc('thread/resume').length > 0, 30_000);
  await expect(agentMessages(page).filter({ hasText: 'Done (turn 4)' })).toHaveCount(1, { timeout: 30_000 });
  expect(fake.turns().filter((t) => t.how === 'turn/start')).toHaveLength(4);
  expect(fake.calls().some((c) => c.argv[0] === 'queue')).toBe(false);

  // Open in Terminal: `codex resume <id>` in the folder.
  const threadIdInCodex = first.threadId;
  await p.locator('[data-thread-more]').click();
  await page.locator('[data-launch-item="open"]').click();
  const ran = await waitFor('osascript', () => (existsSync(join(world.root, 'osascript.log')) ? readFileSync(join(world.root, 'osascript.log'), 'utf8').split('\n').filter(Boolean)[0] : null));
  expect(ran.split('\u001f').filter(Boolean).at(-1)).toBe(`cd '${world.project}' && codex resume ${threadIdInCodex}`);

  // Delete: the thread goes in Codex; the Inbox thread stays.
  await p.locator('[data-thread-more]').click();
  await page.locator('[data-launch-item="delete"]').click();
  await p.locator('[data-launch-delete]').click();
  await waitFor('thread/delete', () => fake.rpc('thread/delete').some((r) => r.params.threadId === threadIdInCodex));
  await waitFor('launch folder removed', () => !existsSync(join(world.dataDir, 'inbox', 'launch', launchId)));
  await expect(p.locator('[data-launched]')).toBeVisible();

  // Byte for byte as the person left it.
  expect(fake.configToml()).toBe(world.configBefore);
  expect(world.errors).toEqual([]);
});
