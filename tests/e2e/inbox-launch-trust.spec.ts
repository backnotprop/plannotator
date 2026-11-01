/**
 * The thread's Trust folder button (docs/agent-guides/inbox-launch.md, "Trusting a folder"): the fallback for a launch
 * that still stops on trust, clicked through in a real browser against the compiled binary. New message's own button
 * is inbox-launch-trust-compose.spec.ts. The only fake is the program launch runs: tests/helpers/fake-claude/ with
 * Claude's folder trust on, so `--bg` refuses until the key is in `$CLAUDE_CONFIG_DIR/.claude.json` and nothing passes by accident. Temp
 * HOME, CLAUDE_CONFIG_DIR and PLANNOTATOR_DATA_DIR, PLANNOTATOR_INBOX_CONNECT=0, NO_BROWSER; the real Claude Code, the
 * real `~/.claude.json` and the person's Inbox are never touched.
 *
 *  1. A folder with hooks and an MCP server: the start is refused, the line says what would run, one click saves the
 *     key (nothing else in the file changes) and starts it once, and the kept message reaches the session. The fake
 *     blocks on Claude's MCP approval prompt as the real one does, so the launch's own setting is what gets it through;
 *     the server the folder turned off stays off.
 *  2. A folder with none of these shows no warning line.
 *  3. A config that isn't JSON: the click says why, the file and the message stay, and it works once it is fixed.
 *  4. A phone, where Open in Terminal is hidden, still gets Trust folder.
 *  5. A folder that changes after the line was read: the click saves nothing and shows the new line; the next one works.
 *
 * Pictures: LAUNCH_TRUST_SHOTS_DIR (default .local/proof/launch-trust), wide light at 2x.
 * Build the binary first, then `bunx playwright test -c tests/e2e/playwright.config.ts inbox-launch-trust.spec.ts`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { refuseRealClaudeConfig } from '../helpers/real-data-dir';
import { markTourDecided } from '../helpers/tour-decided';
import { installFakeClaude, type FakeClaude } from '../helpers/fake-claude';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.LAUNCH_TRUST_SHOTS_DIR ?? join(repo, '.local/proof/launch-trust'));
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

interface World {
  home: string;
  config: string;
  url: string;
  port: number;
  fake: FakeClaude;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

const CONFIG_TEXT = '{\n  "numStartups": 41,\n  "oauthAccount": {"emailAddress": "person@example.com"},\n  "tipsShown": 1.50\n}\n';
const KEY_LINE = '"hasTrustDialogAccepted": true';

function project(name: string, files: Record<string, unknown> = {}): string {
  const dir = join(world.home, 'code', name);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  spawnSync('/usr/bin/git', ['init', '-q'], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: world.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  for (const [file, value] of Object.entries(files)) writeFileSync(join(dir, file), JSON.stringify(value));
  return realpathSync(dir);
}

async function agentWrites(folder: string, session: string, body: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${world.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { body, project_path: folder, agent_session: session, agent_host: 'claude-code' } } }),
  });
  expect(response.status).toBe(200);
  await response.text();
}

const pane = (page: Page) => page.locator('section.ib-pane');

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `${name}.png`) });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/**
 * A launch that stops on trust, for the thread's own button: a Send with no press of Trust and start (New message's
 * own button trusts first: inbox-launch-trust-compose.spec.ts). The thread, open on its refused start.
 */
async function sendTo(page: Page, name: string, words: string, threadName: string): Promise<{ threadId: string; folder: string }> {
  const inbox = `http://127.0.0.1:${world.port}/api/inbox`;
  const { launch } = (await (await fetch(`${inbox}/sessions`)).json()) as { launch: { projects: { id: string; name: string }[] } };
  const to = { launch: { agent: 'claude-code', project_id: launch.projects.find((p) => p.name === name)!.id } };
  const sent = await fetch(`${inbox}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, body: words, thread_name: threadName, idempotency_key: crypto.randomUUID() }),
  });
  expect(sent.status).toBe(200);
  const body = (await sent.json()) as { thread_id: string; project: { root: string } };
  await page.goto(`${world.url}#thread=${body.thread_id}`);
  await page.reload();
  await expect(pane(page).locator('[data-run="failed"]')).toBeVisible({ timeout: 30_000 });
  return { threadId: body.thread_id, folder: body.project.root };
}

const projects = () => (JSON.parse(readFileSync(world.config, 'utf8')) as { projects?: Record<string, unknown> }).projects ?? {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  if (existsSync(shots)) for (const name of readdirSync(shots)) if (name.endsWith('.png')) rmSync(join(shots, name));
  const root = inboxScratch('plannotator-inbox-launch-trust-e2e-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  const configDir = refuseRealClaudeConfig(join(root, 'claude-config'), 'inbox-launch-trust.spec');
  for (const dir of [home, bin, dataDir, configDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const config = join(configDir, '.claude.json');
  writeFileSync(config, CONFIG_TEXT);
  const fake = installFakeClaude({ bin, state: join(root, 'fake-claude'), config: { trustCheck: true, workMs: 300 } });
  world = { home, config, url: '', port: 0, fake, context: undefined as never, page: undefined as never, errors: [] };
  markTourDecided(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxLaunch: { enabled: true, fullPermissions: false } }));
  const env: Record<string, string> = {
    // Only the fakes and the system's own tools: never the agents installed on the machine running the spec.
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    SHELL: fake.shell,
    CLAUDE_CONFIG_DIR: configDir,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number };
  world.url = started.stdout.trim();
  world.port = registry.port;
  await fetch(`http://127.0.0.1:${world.port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  const hook = { hooks: [{ type: 'command', command: 'echo hi' }] };
  await agentWrites(
    project('storefront', {
      '.claude/settings.json': { hooks: { PreToolUse: [hook], Stop: [hook] } },
      '.claude/settings.local.json': { disabledMcpjsonServers: ['retired'] },
      '.mcp.json': { mcpServers: { billing: { command: 'node' }, retired: { command: 'node' } } },
    }),
    'ses-a',
    'The checkout totals are in.',
  );
  await agentWrites(project('notes'), 'ses-b', 'The notes are sorted.');
  await agentWrites(project('recipes'), 'ses-c', 'The recipes are in order.');
  await agentWrites(project('garden'), 'ses-d', 'The garden plan is ready.');
  await agentWrites(project('orchard'), 'ses-e', 'The orchard map is drawn.');

  const context = await browser.newContext({ viewport: WIDE, deviceScaleFactor: 2, colorScheme: 'light' });
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

test('a folder with hooks and an MCP server: the line says so, one click saves the key and starts it once, and the message reaches the session', async () => {
  const { page, fake } = world;
  const { folder } = await sendTo(page, 'storefront', 'Add the coupon field to checkout.', 'Coupon field');
  expect(fake.agents()).toHaveLength(0);
  const line = pane(page).locator('[data-run="failed"]');
  await expect(line).toContainText("isn't a trusted folder yet.");
  await expect(line).toContainText('Your message is kept.');
  await expect(line.locator('[data-run-trust-warning]')).toHaveText('This folder has 2 hooks and 1 MCP server that will run once you trust it.');
  await expect(line.locator('[data-run-open]')).toBeVisible();
  await shot(page, 'trust-folder-with-warning');
  expect(projects()).toEqual({});

  const before = fake.starts().length;
  await line.locator('[data-run-trust]').click();
  await expect(pane(page).locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
  expect(fake.starts()).toHaveLength(before + 1);
  expect(fake.starts().at(-1)!.cwd).toBe(folder);
  expect(fake.starts().at(-1)!.mcp).toEqual({ running: ['billing'], rejected: ['retired'], pending: [] });
  expect(fake.agents().filter((a) => a.cwd === folder)).toHaveLength(1);

  // That one value: the rest of the file is byte for byte what it was.
  expect(projects()).toEqual({ [folder]: { hasTrustDialogAccepted: true } });
  const saved = readFileSync(world.config, 'utf8');
  expect(saved).toContain('"oauthAccount": {"emailAddress": "person@example.com"}');
  expect(saved).toContain('"tipsShown": 1.50');
  expect(saved.startsWith('{\n  "numStartups": 41,\n')).toBe(true);
  expect(existsSync(`${world.config}.lock`)).toBe(false);
  expect(world.errors).toEqual([]);
});

test('a folder with none of these shows no warning line', async () => {
  const { page, fake } = world;
  const { folder } = await sendTo(page, 'notes', 'Sort the notes by date.', 'Sort notes');
  const line = pane(page).locator('[data-run="failed"]');
  await expect(line.locator('[data-run-trust]')).toBeVisible();
  await expect(line.locator('[data-run-trust-warning]')).toHaveCount(0);
  await shot(page, 'trust-folder-no-warning');
  await line.locator('[data-run-trust]').click();
  await expect(pane(page).locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
  expect(fake.starts().filter((s) => s.cwd === folder)).toHaveLength(2);
  expect(world.errors).toEqual([]);
});

test('a config that is not JSON: the click says why, the file and the message stay, and it works once fixed', async () => {
  const { page } = world;
  const { folder } = await sendTo(page, 'recipes', 'Group the recipes by season.', 'Group recipes');
  const good = readFileSync(world.config, 'utf8');
  const bad = '{ "oauthAccount": ';
  writeFileSync(world.config, bad);
  const line = pane(page).locator('[data-run="failed"]');
  await line.locator('[data-run-trust]').click();
  await expect(line.locator('[data-run-error]')).toContainText('it is not plain JSON. Nothing was changed.');
  await expect(line).toContainText('Your message is kept.');
  expect(readFileSync(world.config, 'utf8')).toBe(bad);
  expect(existsSync(`${world.config}.lock`)).toBe(false);

  writeFileSync(world.config, good);
  await line.locator('[data-run-trust]').click();
  await expect(pane(page).locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
  expect(projects()[folder]).toEqual({ hasTrustDialogAccepted: true });
  expect(readFileSync(world.config, 'utf8').split(KEY_LINE)).toHaveLength(Object.keys(projects()).length + 1);
});

test('a phone gets Trust folder, where Open in Terminal is hidden', async ({ browser }) => {
  const { fake } = world;
  const phone = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const page = await phone.newPage();
  try {
    await page.goto(world.url);
    // Sent from the wide window: compose on a phone is its own flow, and the click is what this test is for.
    const sent = await sendTo(world.page, 'garden', 'Plan the spring beds.', 'Spring beds');
    await page.goto(`${world.url}#thread=${sent.threadId}`);
    await page.reload();
    const line = pane(page).locator('[data-run="failed"]');
    await expect(line.locator('[data-run-trust]')).toBeVisible({ timeout: 30_000 });
    await expect(line.locator('[data-run-open]')).toHaveCount(0);
    await line.locator('[data-run-trust]').tap();
    await expect(pane(page).locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
    expect(fake.starts().filter((s) => s.cwd === sent.folder)).toHaveLength(2);
  } finally {
    await phone.close();
  }
});

test('a folder that changes after the line was read: the click saves nothing and shows the new line, and the next click works', async () => {
  const { page } = world;
  const { folder } = await sendTo(page, 'orchard', 'Map the apple rows.', 'Apple rows');
  const line = pane(page).locator('[data-run="failed"]');
  await expect(line.locator('[data-run-trust]')).toBeVisible();
  await expect(line.locator('[data-run-trust-warning]')).toHaveCount(0);

  writeFileSync(join(folder, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo pulled' }] }] } }));
  await line.locator('[data-run-trust]').click();
  await expect(line.locator('[data-run-error]')).toContainText('This folder changed, so nothing was saved.');
  await expect(line.locator('[data-run-trust-warning]')).toHaveText('This folder has 1 hook that will run once you trust it.');
  expect(projects()[folder]).toBeUndefined();

  await line.locator('[data-run-trust]').click();
  await expect(pane(page).locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
  expect(projects()[folder]).toEqual({ hasTrustDialogAccepted: true });
  expect(world.errors).toEqual([]);
});
