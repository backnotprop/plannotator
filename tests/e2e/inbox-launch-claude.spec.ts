/**
 * Launch, PR 1 (.ops/work/launch-plan/PLAN.md): start Claude Code from
 * compose's To, proved in a real browser against the compiled binary and its
 * real launch endpoint. Nothing in the Inbox is mocked. The only fakes are the
 * programs launch runs, on a PATH of their own (tests/helpers/fake-claude/):
 * `claude` (the `--bg` / `agents --json` / stop / respawn / rm contract of
 * Claude Code 2.1.314, and a session that polls the bridge as the mod does),
 * `osascript` (recorded, nothing opens) and a stand-in login shell. The real
 * Claude Code, the real home and the person's Inbox are never touched: temp
 * HOME and PLANNOTATOR_DATA_DIR, PLANNOTATOR_INBOX_CONNECT=0,
 * PLANNOTATOR_UPDATE_CHECK=0, NO_BROWSER.
 *
 *  1. Flag off: no start rows, the launch routes answer 404. An old Claude
 *     Code offers none either.
 *  2. The journey: the To rows after the live sessions (01), the To sentence
 *     (02), the folder menu (03); Send writes the thread before `--bg`, with no
 *     prompt or secret on argv and a 0600 settings file holding the login
 *     shell's CLAUDE_* value; Starting (05) → Working · N min (06) → the ⋯
 *     items (07) → a permission prompt in "Stopped on you" (08) → answered in
 *     Terminal: the line and the Stopped-on-you row go, with no Stop → Stop
 *     (11) → a reply respawns it once, Starting again (12), delivered once →
 *     no line (10); Open in Terminal runs `claude attach`; Delete runs stop
 *     and rm, removes launch/<id>/, never purge. The login shell ran once.
 *  3. Full permissions (Settings → Agents): bypass mode on argv, Claude's env
 *     switch in the file, "Full permissions" in the header.
 *  4. A replayed Send (same key) starts `--bg` once.
 *  5. An untrusted folder (14): the cause, the "not delivered" tick, Open in
 *     Terminal runs plain `claude` there, Try again starts it.
 *  6. A folder that is gone (13): struck through, Send off, Save draft keeps it.
 *  7. Claude Code uninstalled (15): the reply waits; Send to another session
 *     re-addresses it, and the line goes.
 *  8. Stop while it starts again for a reply: "You stopped", never a
 *     failure, and the same reply does not respawn it again.
 *  9. Delete while `--bg` is still running: the session it makes is stopped
 *     and removed, never left running unseen.
 * 10. Phone: the To picker (01), the To sentence (02), the working line (06),
 *     the permission prompt without Open in Terminal (08), no Delete in ⋯.
 *
 * Pictures: LAUNCH_SHOTS_DIR (default .local/proof/launch-pr1), wide light at
 * 2x, plus 02 and 06 dark, and 01, 02, 06 and 08 on a phone. Build the binary first (see
 * inbox.spec.ts), then `bunx playwright test -c tests/e2e/playwright.config.ts inbox-launch-claude.spec.ts`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { FAKE_LOGIN_CLAUDE_VALUE, installFakeClaude, type FakeClaude } from '../helpers/fake-claude';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.LAUNCH_SHOTS_DIR ?? join(repo, '.local/proof/launch-pr1'));
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const INBOX_TOOL_PERMISSION = 'mcp__plannotator__plannotator_inbox';

interface World {
  root: string;
  home: string;
  dataDir: string;
  url: string;
  port: number;
  token: string;
  fake: FakeClaude;
  projects: Record<'plannotator' | 'workspaces' | 'billing' | 'side', string>;
  context: BrowserContext;
  page: Page;
  errors: string[];
  stopLive: (() => void)[];
}
let world: World;

function git(dir: string): string {
  mkdirSync(dir, { recursive: true });
  spawnSync('/usr/bin/git', ['init', '-q'], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: world?.home ?? dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return realpathSync(dir);
}

function writeConfig(patch: Record<string, unknown>): void {
  const file = join(world.dataDir, 'config.json');
  const config = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  writeFileSync(file, JSON.stringify({ ...config, ...patch }));
}

/** An agent writes in a project through the Inbox's MCP: the project exists in the Inbox from then on. */
async function agentWrites(project: string, session: string, body: string): Promise<{ thread_id: string; message_id: string }> {
  const response = await fetch(`http://127.0.0.1:${world.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { body, project_path: project, agent_session: session, agent_host: 'claude-code' } } }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const json = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as { result: { structuredContent: { thread_id: string; message_id: string } } };
  return json.result.structuredContent;
}

/** A Claude Code session already running in a project (the bridge poll, held and renewed until stopped). */
function holdLiveSession(project: string, session: string): () => void {
  const controller = new AbortController();
  let stopped = false;
  void (async () => {
    while (!stopped) {
      await fetch(`http://127.0.0.1:${world.port}/api/inbox/bridge/poll`, {
        method: 'POST',
        headers: { authorization: `Bearer ${world.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session, host: 'claude-code', project_path: project, started_at: Date.now() - 40 * 60_000, busy: false, waitMs: 20_000 }),
        signal: controller.signal,
      }).catch(() => undefined);
    }
  })();
  return () => {
    stopped = true;
    controller.abort();
  };
}

async function shot(page: Page, name: string, options: { scheme?: 'light' | 'dark'; phone?: boolean } = {}): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await page.emulateMedia({ colorScheme: options.scheme ?? 'light', reducedMotion: 'reduce' });
  await page.waitForFunction((dark) => document.documentElement.classList.contains('light') !== dark, options.scheme === 'dark', { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `${name}.png`) });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const dialog = (page: Page) => page.locator('dialog[data-compose]');
const pane = (page: Page) => page.locator('section.ib-pane');

async function openCompose(page: Page): Promise<void> {
  await page.locator('.ib-side [data-open-compose]').click();
  await expect(dialog(page)).toBeVisible();
}

/** New message → To → "Claude Code New session" (in the project the caption names) → words → Send. Returns the new thread's id. */
async function launchFrom(page: Page, words: string, options: { folder?: string; shoot?: boolean } = {}): Promise<string> {
  await openCompose(page);
  const d = dialog(page);
  await d.locator('[data-compose-to]').click();
  await d.locator('[data-compose-start="claude-code"]').click();
  if (options.folder) {
    await d.locator('[data-compose-folder]').click();
    await d.locator(`[data-compose-folder-option="${options.folder}"]`).click();
  }
  await d.getByRole('textbox', { name: 'Message' }).fill(words);
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/inbox/messages') && r.request().method() === 'POST');
  await d.locator('[data-compose-send]').click();
  const body = (await (await answer).json()) as { thread_id: string; launch?: { id: string; state: string } };
  expect(body.launch?.id).toMatch(/^lch_/);
  await expect(d).toHaveCount(0);
  return body.thread_id;
}

async function openThread(page: Page, threadId: string): Promise<void> {
  await page.goto(`${world.url}#thread=${threadId}`);
  await page.reload();
  await expect(pane(page).locator('[data-launched]')).toBeVisible();
}

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function projectIdOf(page: Page, root: string): Promise<string> {
  const model = await page.evaluate(async () => (await fetch('/api/inbox/sessions')).json());
  const found = (model as { launch?: { projects: { id: string; root: string }[] } }).launch?.projects.find((p) => p.root === root);
  expect(found, `project ${root} in the launch block`).toBeTruthy();
  return found!.id;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  // Old pictures go; anything else in the folder (NOTES.md) stays.
  if (existsSync(shots)) for (const name of readdirSync(shots)) if (name.endsWith('.png')) rmSync(join(shots, name));
  const root = inboxScratch('plannotator-inbox-launch-e2e-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  for (const dir of [home, bin, dataDir]) mkdirSync(dir, { recursive: true });
  // Plannotator's Claude Code plugin is on in this HOME: launch needs its mod (it is what connects the session).
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const fake = installFakeClaude({ bin, state: join(root, 'fake-claude') });
  world = { root, home, dataDir, url: '', port: 0, token: '', fake, projects: {} as World['projects'], context: undefined as never, page: undefined as never, errors: [], stopLive: [] };
  markTourDecided(dataDir);
  writeConfig({ inboxLaunch: { enabled: false } });
  const env: Record<string, string> = {
    // Only the fakes and the system's own tools: never the agents installed on the machine running the spec.
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    SHELL: fake.shell,
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
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { token: string; port: number };
  world.url = started.stdout.trim();
  world.port = registry.port;
  world.token = registry.token;
  // The one-time notification line is not what these shots are about.
  await fetch(`http://127.0.0.1:${world.port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });

  // The projects live under the scratch HOME, so the window shows them as ~/… (as the mock does).
  world.projects = {
    plannotator: git(join(home, 'plannotator', 'plannotator')),
    workspaces: git(join(home, 'workspaces-cli')),
    billing: git(join(home, 'work', 'billing-svc')),
    side: git(join(home, 'oss', 'side-project')),
  };
  await agentWrites(world.projects.workspaces, 'ses-ws', 'Token refresh fails after the laptop sleeps. I traced it to the clock skew check.');
  await agentWrites(world.projects.billing, 'ses-billing', 'Refund events: trust the webhook or poll the API? Both work; the webhook is faster.');
  await agentWrites(world.projects.side, 'ses-side', 'The side project builds again after the dependency bump.');
  await agentWrites(world.projects.plannotator, 'ses-pl', 'Reach agents on a remote machine over SSH: a sketch of the relay.');
  // One Claude Code session already running elsewhere: the start rows come after it.
  world.stopLive.push(holdLiveSession(world.projects.workspaces, 'ses-ws-live'));

  const context = await browser.newContext({ viewport: WIDE, deviceScaleFactor: 2, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write', 'notifications'], { origin: new URL(world.url).origin });
  const page = await context.newPage();
  page.on('pageerror', (error) => world.errors.push(error.message));
  world.context = context;
  world.page = page;
});

test.afterAll(async () => {
  try {
    for (const stop of world?.stopLive ?? []) stop();
    world?.fake.stopAll();
    await world?.context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('flag off: no start rows and the launch routes answer 404; an old Claude Code is not offered either', async () => {
  const { page } = world;
  await page.goto(world.url);
  await openCompose(page);
  await dialog(page).locator('[data-compose-to]').click();
  await expect(dialog(page).locator('[data-compose-session="ses-ws-live"]')).toBeVisible();
  await expect(dialog(page).locator('[data-compose-start]')).toHaveCount(0);
  const off = await page.evaluate(async () => (await fetch('/api/inbox/launch/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"full_permissions":true}' })).status);
  expect(off).toBe(404);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // On, but Claude Code is older than 2.1.314: still no row (no grey rows), and nothing ran but --version.
  writeConfig({ inboxLaunch: { enabled: true } });
  world.fake.configure({ version: '2.1.200' });
  await page.reload();
  await openCompose(page);
  await dialog(page).locator('[data-compose-to]').click();
  await expect(dialog(page).locator('[data-compose-session="ses-ws-live"]')).toBeVisible();
  // The check ran (the version was asked) and its answer offers no agent: the picker has nothing to add.
  await waitFor('claude --version', () => world.fake.calls().some((c) => c.argv[0] === '--version'));
  await expect.poll(async () => page.evaluate(async () => ((await (await fetch('/api/inbox/sessions')).json()) as { launch?: { agents: unknown[] } }).launch?.agents.length)).toBe(0);
  await expect(dialog(page).locator('[data-compose-start]')).toHaveCount(0);
  expect(world.fake.calls().every((c) => c.argv[0] === '--version')).toBe(true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  world.fake.configure({ version: '2.1.314' });
});

test('the journey: To rows, the To sentence, the folder menu; Send writes the thread, then Starting → Working → a permission prompt answered in Terminal → Stop → a reply starts it again → done; Open and Delete', async () => {
  const { page, fake } = world;
  const plannotatorId = await projectIdOf(page, world.projects.plannotator);
  // Look at plannotator's own list: the caption names the project the person is looking at.
  await page.goto(world.url);
  await page.locator('.ib-side').getByText('plannotator', { exact: true }).first().click();
  await openCompose(page);
  const d = dialog(page);
  await d.locator('[data-compose-to]').click();
  // 01: the live session first, then under one caption, one row per available agent.
  await expect(d.locator('[data-compose-start-caption]')).toHaveText('Start a new session in plannotator');
  await expect(d.locator('[data-compose-start="claude-code"]')).toContainText('Claude CodeNew session');
  const order = await d.locator('[role="option"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-compose-session') ?? `start:${el.getAttribute('data-compose-start')}`));
  expect(order).toEqual(['ses-ws-live', 'start:claude-code']);
  // A filter word naming another project moves the caption there.
  await d.getByRole('combobox', { name: 'Find an agent or project' }).fill('billing');
  await expect(d.locator('[data-compose-start-caption]')).toHaveText('Start a new session in billing-svc');
  await d.getByRole('combobox', { name: 'Find an agent or project' }).fill('');
  await shot(page, '01-new-thread-to-picker');
  // The start row is in the arrow and Enter order: ↓ ↓ Enter picks it.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  // 02: To reads as one sentence; the status line names the folder; Send is on, no Save draft.
  await expect(d.locator('[data-compose-to="start"]')).toHaveText(/New Claude Code session/);
  await expect(d.locator(`[data-compose-folder="${plannotatorId}"]`)).toHaveText('plannotator');
  const words = 'The Settings search should match fuzzy, not prefix. Look at how the command palette does it and use the same scorer.';
  await d.getByRole('textbox', { name: 'Message' }).fill(words);
  await expect(d.locator('[data-compose-status]')).toHaveText('Claude Code starts in ~/plannotator/plannotator when you send.');
  await expect(d.locator('[data-compose-send]')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(d.locator('[data-compose-save]')).toHaveCount(0);
  await shot(page, '02-new-session-ready');
  await shot(page, '02-new-session-ready-dark', { scheme: 'dark' });

  // 03: the folder menu, the Inbox's projects (✓ on the current one).
  await d.locator('[data-compose-folder]').click();
  const menu = d.locator('[data-compose-folders]');
  await expect(menu.locator(`[data-compose-folder-option="${plannotatorId}"] .ib-cp-check svg`)).toHaveCount(1);
  await expect(menu.locator('[data-compose-folder-option]')).toHaveCount(4);
  await shot(page, '03-new-session-where');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(d).toBeVisible();

  // Send: a slow first poll, so "Starting" shows; a gap between taking the turn and reporting busy
  // (as the real mod has); the turn is held so "Working" stays.
  fake.configure({ startDelayMs: 3500, busyDelayMs: 2500, hold: true });
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/inbox/messages') && r.request().method() === 'POST');
  await d.locator('[data-compose-send]').click();
  const sent = (await (await answer).json()) as { thread_id: string; launch: { id: string; state: string } };
  expect(sent.launch.state).toBe('starting');
  const threadId = sent.thread_id;
  const launchId = sent.launch.id;
  await expect(page.locator('[data-inbox-toast]')).toContainText('Starting Claude Code');

  const start = await waitFor('claude --bg', () => fake.starts()[0]);
  // The thread was written before --bg ran, and nothing of the message or the key is on argv.
  expect(start.threadExisted).toBe(true);
  expect(start.argv).toEqual(['--bg', '--name', expect.any(String), '--settings', start.settingsPath!]);
  expect(start.argv.join(' ')).not.toContain('fuzzy');
  expect(start.argv.join(' ')).not.toContain(start.settings!.env!.PLANNOTATOR_LAUNCH_KEY!);
  expect(start.cwd).toBe(world.projects.plannotator);
  expect(start.settingsMode).toBe(0o600);
  expect(start.settingsPath).toBe(join(world.dataDir, 'inbox', 'launch', launchId, 'settings.json'));
  // The login shell's CLAUDE_* value reaches the file (never argv); the Inbox tool never prompts.
  expect(start.settings!.env![FAKE_LOGIN_CLAUDE_VALUE.name]).toBe(FAKE_LOGIN_CLAUDE_VALUE.value);
  expect(start.settings!.env!.PLANNOTATOR_DATA_DIR).toBe(world.dataDir);
  expect(start.settings!.env!.PLANNOTATOR_LAUNCH).toBe(launchId);
  expect(start.settings!.env!.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS).toBeUndefined();
  expect(start.settings!.permissions!.allow).toContain(INBOX_TOOL_PERMISSION);
  // The spawn env: no Plannotator name at all (data dir, ports, markers), no session marker.
  expect(start.env.filter((name) => name.startsWith('PLANNOTATOR_'))).toEqual([]);
  expect(start.env).not.toContain('CLAUDECODE');

  // 05: the thread, the header sentence, "Starting Claude Code in plannotator…", the row says Starting.
  await openThread(page, threadId);
  const p = pane(page);
  await expect(p.locator('[data-launched]')).toHaveText('You started Claude Code in plannotator');
  await expect(p.locator('[data-run="starting"]')).toHaveText('Starting Claude Code in plannotator…');
  await expect(page.locator(`[data-thread-id="${threadId}"] [data-count-words="Starting"]`)).toBeVisible();
  await shot(page, '05-just-started');

  // The session took the turn but has not polled busy yet: still Starting, never a blink to no line.
  await waitFor('the first turn taken', () => fake.delivered().length === 1);
  const runNow = (await page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}`)).json(), threadId)) as { run?: { state: string } | null };
  expect(runNow.run?.state).toBe('starting');
  await expect(p.locator('[data-run="starting"]')).toBeVisible();

  // 06: the session polls, takes the message as its first turn: "Claude Code is working · 1 min  Stop".
  await expect(p.locator('[data-run="working"]')).toContainText(/^Claude Code is working · \d+ min/, { timeout: 20_000 });
  await expect(p.locator('[data-run="working"] [data-run-stop]')).toBeVisible();
  await expect(page.locator(`[data-thread-id="${threadId}"] [data-count-words="Working"]`)).toBeVisible();
  await shot(page, '06-working');
  await shot(page, '06-working-dark', { scheme: 'dark' });

  // 07: the ⋯ menu's items on top.
  await p.locator('[data-thread-more]').click();
  const items = page.locator('[data-thread-menu] [data-launch-item]');
  await expect(items).toHaveText(['Open in Terminal', 'Copy attach command', 'Stop Claude Code', 'Delete Claude Code session…']);
  await shot(page, '07-working-thread-menu');
  // Open in Terminal: osascript runs `claude attach <id>` in the folder, as an argument (never in the script's text).
  await page.locator('[data-launch-item="open"]').click();
  const agent = await waitFor('the fake session', () => fake.agents()[0]);
  const ran = await waitFor('osascript', () => fake.osascript()[0]);
  expect(ran.at(-1)).toBe(`cd '${world.projects.plannotator}' && claude attach ${agent.id}`);
  expect(ran.slice(0, -1).join(' ')).not.toContain('claude attach');

  // 08: Claude Code waits on a permission prompt: the line says so, the row goes to Stopped on you.
  fake.configure({ waiting: true });
  await expect(p.locator('[data-run="waiting_terminal"]')).toContainText('Claude Code is waiting on a permission prompt', { timeout: 30_000 });
  await expect(p.locator('[data-run="waiting_terminal"] [data-run-open]')).toBeVisible();
  await expect(p.locator('[data-run="waiting_terminal"] [data-run-attach] code')).toHaveText(`claude attach ${agent.id}`);
  await expect(page.locator(`button[data-thread-id="${threadId}"]`)).toHaveAttribute('data-section', 'stopped');
  await shot(page, '08-permission-prompt-v1');

  // The person answers the prompt in Terminal (no Stop): the turn ends, it answers, and it rests.
  // The line goes and the row leaves Stopped on you.
  fake.configure({ waiting: false, hold: false });
  await expect(p.locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(p.locator('[data-run]')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(`button[data-thread-id="${threadId}"]`)).not.toHaveAttribute('data-section', 'stopped');

  // 11: Stop (⋯, as it rests). The host reports it done; the line says who stopped it and that a reply starts it again.
  await p.locator('[data-thread-more]').click();
  await page.locator('[data-launch-item="stop"]').click();
  await expect(p.locator('[data-run="stopped"]')).toHaveText(/^You stopped Claude Code at \d{1,2}:\d{2} [AP]M\. Your reply starts it again\.$/);
  expect(fake.calls().some((c) => c.argv[0] === 'stop' && c.argv[1] === agent.id)).toBe(true);
  fake.configure({ waiting: false, hold: false, startDelayMs: 3500 });
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(p.locator('.ib-draft-for')).toHaveText('Reply to Claude Code in plannotator · starts it again');
  const box = p.getByRole('textbox', { name: /^Reply to Claude Code/ });
  await box.fill('Use the palette scorer, and keep exact matches first.');
  await shot(page, '11-stopped-reply-starts-it');

  // 12: the reply respawns it (once): "Starting Claude Code again…".
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(p.locator('[data-run="starting"]')).toHaveText('Starting Claude Code again…');
  await shot(page, '12-resumed-by-reply');
  // It took the reply but has not polled busy yet: still "Starting again", no blink.
  await waitFor('the reply taken', () => fake.delivered().length === 2);
  const runTaken = (await page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}`)).json(), threadId)) as { run?: { state: string; again: boolean } | null };
  expect(runTaken.run).toMatchObject({ state: 'starting', again: true });
  fake.configure({ busyDelayMs: 0 });
  // 10: it takes the reply, answers, rests: no line.
  await expect(p.locator('article.ib-message[data-author="agent"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(p.locator('[data-run]')).toHaveCount(0);
  await shot(page, '10-replied');
  expect(fake.calls().filter((c) => c.argv[0] === 'respawn')).toHaveLength(1);
  expect(fake.starts()).toHaveLength(1);
  // The login shell was read for the start alone: never for a status read, the stop or the respawn.
  expect(fake.logins()).toBe(1);
  // Delivered once: one answer to the reply, and the reply was handed over once.
  const thread = (await page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}`)).json(), threadId)) as { thread: { messages: { id: string; author: { kind: string }; reply_to?: string | null; delivery?: unknown }[] } };
  const reply = thread.thread.messages.filter((m) => m.author.kind === 'person').at(-1)!;
  expect(reply.delivery).toBeTruthy();
  expect(thread.thread.messages.filter((m) => m.author.kind === 'agent' && m.reply_to === reply.id)).toHaveLength(1);

  // Delete: stop and rm, the launch folder goes, never purge; the thread stays.
  await p.locator('[data-thread-more]').click();
  await page.locator('[data-launch-item="delete"]').click();
  await p.locator('[data-launch-delete]').click();
  await expect(p.locator('[data-launch-confirm]')).toHaveCount(0);
  await waitFor('rm', () => fake.calls().some((c) => c.argv[0] === 'rm' && c.argv[1] === agent.id));
  await waitFor('launch folder removed', () => !existsSync(join(world.dataDir, 'inbox', 'launch', launchId)));
  expect(fake.calls().some((c) => c.argv[0] === 'purge')).toBe(false);
  await expect(p.locator('[data-launched]')).toBeVisible();
  expect(world.errors).toEqual([]);
});

test('full permissions: Settings → Agents switch puts bypass mode on argv and Claude\'s switch in the file; the header says so', async () => {
  const { page, fake } = world;
  await page.goto(`${world.url}#settings/agents`);
  const row = page.locator('[data-launch-full-row]');
  await expect(row).toBeVisible();
  await row.getByRole('switch', { name: 'Start new sessions with full permissions' }).click();
  await expect(row.getByRole('switch', { name: 'Start new sessions with full permissions' })).toHaveAttribute('aria-checked', 'true');
  expect((JSON.parse(readFileSync(join(world.dataDir, 'config.json'), 'utf8')) as { inboxLaunch: { fullPermissions?: boolean } }).inboxLaunch.fullPermissions).toBe(true);
  fake.configure({ startDelayMs: 0, hold: false });
  await page.goto(world.url);
  const before = fake.starts().length;
  const threadId = await launchFrom(page, 'Bump the lockfile and run the tests.');
  const start = await waitFor('claude --bg', () => fake.starts()[before]);
  expect(start.argv.slice(-2)).toEqual(['--permission-mode', 'bypassPermissions']);
  expect(start.settings!.env!.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS).toBe('1');
  await openThread(page, threadId);
  await expect(pane(page).locator('[data-launched] [data-launch-full]')).toHaveText('Full permissions');
  await page.goto(`${world.url}#settings/agents`);
  await page.locator('[data-launch-full-row]').getByRole('switch').click();
  await expect(page.locator('[data-launch-full-row]').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
});

test('a replayed Send (same idempotency key) answers the same thread and starts --bg once', async () => {
  const { page, fake } = world;
  await page.goto(world.url);
  const projectId = await projectIdOf(page, world.projects.side);
  const before = fake.starts().length;
  const results = await page.evaluate(async (project_id) => {
    const session = ((await (await fetch('/api/inbox/sessions')).json()) as { serverSession: string }).serverSession;
    const body = JSON.stringify({ to: { launch: { agent: 'claude-code', project_id } }, body: 'Check the build once more.', idempotency_key: 'replay-key-1', serverSession: session });
    const send = () => fetch('/api/inbox/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then((r) => r.json());
    const first = await send();
    const second = await send();
    return [first, second] as { thread_id: string; replayed: boolean }[];
  }, projectId);
  expect(results[1]!.thread_id).toBe(results[0]!.thread_id);
  expect(results[1]!.replayed).toBe(true);
  await waitFor('the one --bg', () => fake.starts().length === before + 1);
  // The start settled (the session answered): any second --bg would have run by now.
  await expect
    .poll(async () => page.evaluate(async (id) => ((await (await fetch(`/api/inbox/threads/${id}`)).json()) as { thread: { messages: { author: { kind: string } }[] } }).thread.messages.filter((m) => m.author.kind === 'agent').length, results[0]!.thread_id), { timeout: 30_000 })
    .toBe(1);
  expect(fake.starts()).toHaveLength(before + 1);
});

test('an untrusted folder (14): the cause, the not-delivered tick, Open in Terminal runs plain claude there, Try again starts it', async () => {
  const { page, fake } = world;
  fake.configure({ fault: 'untrusted' });
  await page.goto(world.url);
  const sideId = await projectIdOf(page, world.projects.side);
  const threadId = await launchFrom(page, 'Tidy the README install section.', { folder: sideId });
  await openThread(page, threadId);
  const p = pane(page);
  const line = p.locator('[data-run="failed"]');
  await expect(line).toContainText("Claude Code didn't start.");
  await expect(line).toContainText("~/oss/side-project isn't a trusted folder yet. Open it once in Terminal and accept Claude Code's trust prompt, then try again. Your message is kept.");
  await expect(page.locator(`[data-thread-id="${threadId}"] [data-tick="undelivered"]`)).toBeVisible();
  await shot(page, '14-fail-did-not-start');
  const opened = fake.osascript().length;
  await line.locator('[data-run-open]').click();
  const ran = await waitFor('osascript', () => fake.osascript()[opened]);
  expect(ran.at(-1)).toBe(`cd '${world.projects.side}' && claude`);
  fake.configure({ fault: null, startDelayMs: 0 });
  await line.locator('[data-run-retry]').click();
  await expect(p.locator('[data-run="failed"]')).toHaveCount(0);
  await expect(p.locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
});

test('a project folder that is gone (13): struck through, Send off, nothing sent; Save draft keeps the words', async () => {
  const { page, fake } = world;
  await page.goto(world.url);
  const billingId = await projectIdOf(page, world.projects.billing);
  rmSync(world.projects.billing, { recursive: true, force: true });
  const before = fake.starts().length;
  await openCompose(page);
  const d = dialog(page);
  await d.locator('[data-compose-to]').click();
  await d.locator('[data-compose-start="claude-code"]').click();
  await d.locator('[data-compose-folder]').click();
  await d.locator(`[data-compose-folder-option="${billingId}"]`).click();
  await d.getByRole('textbox', { name: 'Message' }).fill('Switch refunds to the webhook and drop the poller.');
  await expect(d.locator(`[data-compose-folder="${billingId}"] s`)).toHaveText('billing-svc');
  await expect(d.locator('[data-compose-note="folder-missing"]')).toContainText("~/work/billing-svc isn't there any more.");
  await expect(d.locator('[data-compose-status]')).toHaveText('Pick a folder to start in.');
  await expect(d.locator('[data-compose-send]')).toHaveAttribute('aria-disabled', 'true');
  await shot(page, '13-fail-folder-missing');
  await page.keyboard.press('Meta+Enter');
  await expect(d.locator('[data-compose-error]')).toHaveText('Nothing sent: pick a folder to start in.');
  await d.locator('[data-compose-save]').click();
  await expect(d).toHaveCount(0);
  await expect(page.locator('[data-drafts-nav]')).toContainText('Drafts1');
  expect(fake.starts()).toHaveLength(before);
  // The endpoint refuses it too, before writing anything.
  const refused = await page.evaluate(async (project_id) => {
    const session = ((await (await fetch('/api/inbox/sessions')).json()) as { serverSession: string }).serverSession;
    const response = await fetch('/api/inbox/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: { launch: { agent: 'claude-code', project_id } }, body: 'x', idempotency_key: 'gone-1', serverSession: session }) });
    return { status: response.status, code: ((await response.json()) as { code: string }).code };
  }, billingId);
  expect(refused).toEqual({ status: 422, code: 'folder_missing' });
});

test('Claude Code uninstalled (15): the reply waits, the line says so; Send to another session re-addresses it and the line goes; compose stops offering it', async () => {
  const { page, fake } = world;
  // It is stopped mid-turn, before it answers: the person's next words are addressed to the session itself (re-addressable).
  fake.configure({ startDelayMs: 0, hold: true });
  // Another session runs in the project the launch starts in: the reply can go there.
  const stopOther = holdLiveSession(world.projects.side, 'ses-side-live');
  world.stopLive.push(stopOther);
  await page.goto(world.url);
  const threadId = await launchFrom(page, 'Add a changelog entry for the fuzzy search.');
  await openThread(page, threadId);
  const p = pane(page);
  await expect(p.locator('[data-run="working"]')).toBeVisible({ timeout: 20_000 });
  await p.locator('[data-thread-more]').click();
  await page.locator('[data-launch-item="stop"]').click();
  await expect(p.locator('[data-run="stopped"]')).toBeVisible();
  fake.configure({ hold: false });
  fake.setInstalled(false);
  try {
    await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
    await p.getByRole('textbox', { name: /^Reply to Claude Code/ }).fill('Also mention the palette scorer.');
    await p.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
    const line = p.locator('[data-run="missing"]');
    await expect(line).toContainText("Claude Code isn't on this computer any more.", { timeout: 20_000 });
    await expect(line).toContainText('or send the reply to another session');
    await expect(p.locator('[data-readdress-open]')).toBeVisible();
    await shot(page, '15-fail-agent-not-installed');
    // Send to another session: the reply goes to the live one; nothing waits on the gone agent, so no line.
    await p.locator('[data-readdress-open]').click();
    await p.locator('[data-readdress-session="ses-side-live"]').click();
    await p.locator('[data-readdress-send]').click();
    await expect(p.locator('[data-run]')).toHaveCount(0, { timeout: 20_000 });
    const moved = (await page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}`)).json(), threadId)) as { thread: { messages: { author: { kind: string }; to?: { session: string } | null }[] } };
    expect(moved.thread.messages.filter((m) => m.author.kind === 'person').at(-1)!.to?.session).toBe('ses-side-live');
    await openCompose(page);
    await dialog(page).locator('[data-compose-to]').click();
    await expect(dialog(page).locator('[data-compose-session="ses-ws-live"]')).toBeVisible();
    await expect(dialog(page).locator('[data-compose-start]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  } finally {
    fake.setInstalled(true);
  }
});

test('Stop while it starts again for a reply: "You stopped", never a failure, and the same reply does not start it again', async () => {
  const { page, fake } = world;
  fake.configure({ startDelayMs: 0, hold: false });
  try {
    await page.goto(world.url);
    const threadId = await launchFrom(page, 'Drop the unused export.');
    await openThread(page, threadId);
    const p = pane(page);
    await expect(p.locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(p.locator('[data-run]')).toHaveCount(0);
    await p.locator('[data-thread-more]').click();
    await page.locator('[data-launch-item="stop"]').click();
    await expect(p.locator('[data-run="stopped"]')).toBeVisible();
    // The respawned session is slow to connect: Stop lands while the line says "Starting again".
    fake.configure({ startDelayMs: 30_000 });
    const respawnsBefore = fake.calls().filter((c) => c.argv[0] === 'respawn').length;
    await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
    await p.getByRole('textbox', { name: /^Reply to Claude Code/ }).fill('And the test that imports it.');
    await p.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(p.locator('[data-run="starting"]')).toHaveText('Starting Claude Code again…');
    const agentReads = fake.calls().filter((c) => c.argv[0] === 'agents').length;
    await p.locator('[data-thread-more]').click();
    await page.locator('[data-launch-item="stop"]').click();
    await expect(p.locator('[data-run="stopped"]')).toHaveText(/^You stopped Claude Code at \d{1,2}:\d{2} [AP]M\. Your reply starts it again\.$/);
    // A sweep ran since (Stop drops the host view; the next sweep respawns first, then reads it again):
    // the reply that already respawned it once did not respawn it again, and the line holds.
    await waitFor('a sweep after Stop', () => fake.calls().filter((c) => c.argv[0] === 'agents').length > agentReads);
    expect(fake.calls().filter((c) => c.argv[0] === 'respawn')).toHaveLength(respawnsBefore + 1);
    await expect(p.locator('[data-run="stopped"]')).toBeVisible();
  } finally {
    fake.configure({ startDelayMs: 0 });
  }
});

test('Delete while --bg is still running: the session it makes is stopped and removed, never left running', async () => {
  const { page, fake } = world;
  fake.configure({ bgDelayMs: 2500, startDelayMs: 0, hold: false });
  try {
    await page.goto(world.url);
    const threadId = await launchFrom(page, 'Rename the flag to match the docs.');
    const known = new Set(fake.agents().map((agent) => agent.id));
    await openThread(page, threadId);
    const p = pane(page);
    await expect(p.locator('[data-run="starting"]')).toBeVisible();
    await p.locator('[data-thread-more]').click();
    await page.locator('[data-launch-item="delete"]').click();
    await p.locator('[data-launch-delete]').click();
    await expect(p.locator('[data-launch-confirm]')).toHaveCount(0);
    // --bg answers after the delete: the Inbox stops and removes what it made.
    const made = await waitFor('the session --bg made', () => fake.agents().find((agent) => !known.has(agent.id)));
    await waitFor('stop and rm of it', () => fake.calls().some((c) => c.argv[0] === 'stop' && c.argv[1] === made.id) && fake.calls().some((c) => c.argv[0] === 'rm' && c.argv[1] === made.id));
    // The thread stays as the person left it: never re-addressed to the session, no line.
    const root = (await page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}`)).json(), threadId)) as { thread: { messages: { to?: { session: string } | null }[] }; run?: unknown };
    expect(root.thread.messages[0]!.to?.session).toMatch(/^launch:/);
    expect(root.run ?? null).toBeNull();
  } finally {
    fake.configure({ bgDelayMs: 0 });
  }
});

test('phone: the To picker, the To sentence, the working line, the permission prompt; no Open in Terminal or Delete', async ({ browser }) => {
  const { fake } = world;
  const phone = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const page = await phone.newPage();
  try {
    await page.goto(world.url);
    await page.locator('.ib-lhead [data-open-compose]').click();
    const d = dialog(page);
    await d.locator('[data-compose-to]').click();
    await expect(d.locator('[data-compose-start="claude-code"]')).toBeVisible();
    await shot(page, '01-new-thread-to-picker-phone');
    await d.locator('[data-compose-start="claude-code"]').click();
    await d.getByRole('textbox', { name: 'Message' }).fill('Make the Settings search fuzzy, like the palette.');
    await expect(d.locator('[data-compose-to="start"]')).toBeVisible();
    await shot(page, '02-new-session-ready-phone');
    fake.configure({ hold: true, startDelayMs: 0 });
    const answer = page.waitForResponse((r) => r.url().endsWith('/api/inbox/messages') && r.request().method() === 'POST');
    await d.locator('.ib-cp-bar [data-compose-send]').click();
    const { thread_id } = (await (await answer).json()) as { thread_id: string };
    await page.goto(`${world.url}#thread=${thread_id}`);
    await expect(page.locator('[data-run="working"]')).toBeVisible({ timeout: 20_000 });
    // The "Starting Claude Code" toast is not what this picture is about.
    for (const dismiss of await page.locator('[data-inbox-toast] [data-toast-dismiss]').all()) await dismiss.click();
    await expect(page.locator('[data-inbox-toast]')).toHaveCount(0);
    await shot(page, '06-working-phone');
    // 08 on a phone: where to answer, the attach command and Stop; no Open in Terminal.
    fake.configure({ waiting: true });
    const waiting = page.locator('[data-run="waiting_terminal"]');
    await expect(waiting).toContainText('Answer it in Terminal on your Mac:', { timeout: 30_000 });
    await expect(waiting.locator('[data-run-attach]')).toBeVisible();
    await expect(waiting.locator('[data-run-stop]')).toBeVisible();
    await expect(waiting.locator('[data-run-open]')).toHaveCount(0);
    await shot(page, '08-permission-prompt-v1-phone');
    // ⋯ on a phone: no Open in Terminal, no Delete.
    await page.locator('[data-thread-more]').click();
    await expect(page.locator('[data-thread-menu] [data-launch-item]')).toHaveText(['Copy attach command', 'Stop Claude Code']);
  } finally {
    fake.configure({ hold: false, waiting: false });
    await phone.close();
  }
});
