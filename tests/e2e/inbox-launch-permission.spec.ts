/**
 * Launch, PR 2 (.ops/work/launch-plan/PLAN.md "Permission hook"): Claude
 * Code's permission prompts answered in the launch thread, proved in a real
 * browser against the compiled binary. Nothing in the Inbox is mocked. The
 * fake `claude` (tests/helpers/fake-claude/) plays each prompt as Claude Code
 * does: it lists itself waiting on a "permission prompt" and runs the launch
 * settings file's real PermissionRequest command, `<this binary> inbox
 * permission-hook`, with Claude Code's stdin JSON; it reads the hook's stdout
 * to allow or deny. The real Claude Code, the real home and the person's Inbox
 * are never touched: temp HOME and PLANNOTATOR_DATA_DIR,
 * PLANNOTATOR_INBOX_CONNECT=0, PLANNOTATOR_UPDATE_CHECK=0, NO_BROWSER.
 *
 *  1. Allow once: the question in the launch thread (Permission, the command,
 *     the folder, Allow once / Allow `bun run` for this session / Deny), the line
 *     "waiting on your answer", the foot "1 permission waiting", the row in
 *     Stopped on you; the hook prints allow with updatedInput and nothing more;
 *     the agent goes on; the answer never reaches the session's own poll.
 *  2. Allow for this session: updatedPermissions, destination session.
 *  3. Deny with a reason: deny, the reason in the message, and the agent goes on.
 *  4. Answered in Terminal: the hook is ended; the question is withdrawn
 *     ("Answered in Terminal.") and can no longer be answered.
 *  5. Stop while waiting: withdrawn at once ("No longer waiting.").
 *  6. The Inbox stops mid-wait and starts again: the hook keeps waiting, and the
 *     answer given after the restart decides; one question, never two.
 *  7. ExitPlanMode: the hook prints nothing at once, and no question appears.
 *  8. Only the window answers: a local call with no page Origin is refused
 *     (403 window_only) and decides nothing; the window still answers.
 *  9. Launch turned off while a question waits: the question is withdrawn,
 *     and nothing draws as a permission card.
 *
 * Pictures: LAUNCH_PR2_SHOTS_DIR (default .local/proof/launch-pr2). Build the
 * binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-launch-permission.spec.ts`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
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
const card = (page: Page) => pane(page).locator('[data-permission] fieldset.question-block').last();

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** New message → To → "Claude Code New session" → words → Send; then open the thread. */
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

type ThreadRead = { serverSession: string; thread: { messages: { id: string; author: { kind: string; session?: string | null }; body: string; reply_to?: string | null; delivery?: { session: string } | null }[] }; run?: { state: string } | null };
const readThread = (page: Page, threadId: string) => page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}`)).json(), threadId) as Promise<ThreadRead>;

/** The person's answer: a pick (or the reason typed on the free-text row), then Send in the thread's foot. */
async function answer(page: Page, pick: { choice?: string; reason?: string }): Promise<void> {
  const c = card(page);
  if (pick.choice) await c.locator('[data-question-option]', { hasText: pick.choice }).click();
  if (pick.reason) await c.getByPlaceholder('Deny, and tell it why…').fill(pick.reason);
  const send = pane(page).locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeVisible();
  await send.click();
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
  // Each test starts from a quiet fake: no prompt, no local answer.
  world.fake.configure({ prompts: [], localAnswer: false, hold: false, workMs: 800 });
});

test('allow once: the question in the launch thread, the waiting line and the foot; allow with the tool input only; the agent goes on; never a second turn', async ({ browser }) => {
  const { page, fake } = world;
  fake.configure({ prompts: [BUILD] });
  const { threadId, launchId } = await launch(page, 'The Settings search should match fuzzy, not prefix. Rebuild the Inbox bundle to check the chunk size.');
  const p = pane(page);


  // The card: an ordinary question card with its own words.
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  const c = card(page);
  await expect(c.locator('.text-muted-foreground').first()).toHaveText('Permission');
  await expect(c).toContainText('Claude Code wants to run a command');
  // The command and the folder sit over the card (never inside its block, where a list line would read as a choice).
  const body = pane(page).locator('[data-permission]').last();
  await expect(body.locator('pre').first()).toContainText('bun run --cwd apps/inbox build');
  await expect(body).toContainText('in ~/plannotator/plannotator');
  await expect(c.locator('[data-question-option]')).toHaveText(['Allow once', SESSION_CHOICE, 'Deny']);
  await expect(c.getByPlaceholder('Deny, and tell it why…')).toBeVisible();
  // The line, the foot and the row.
  await expect(p.locator('[data-run="waiting_answer"]')).toContainText(/^Claude Code is waiting on your answer · \d+ min/, { timeout: 15_000 });
  await expect(p.locator('[data-run="waiting_answer"] [data-run-stop]')).toBeVisible();
  await expect(p.locator('[data-open-questions]')).toContainText('1 permission waiting');
  // The row: the list holds still while a thread is open (the launched row was drawn in folded Quiet),
  // so it is read again as it now is: Stopped on you, unread.
  await page.reload();
  await expect(card(page)).toBeVisible();
  await expect(page.locator(`button[data-thread-id="${threadId}"]`)).toHaveAttribute('data-section', 'stopped');
  // The question is the Claude Code permission identity, never the session itself, and does not wake it.
  const read = await readThread(page, threadId);
  const question = read.thread.messages.find((m) => m.author.session?.startsWith('perm:'))!;
  expect(question).toBeTruthy();
  expect(read.run?.state).toBe('waiting_answer');
  await shot(page, 'permission-waiting');
  await shot(page, 'permission-waiting-dark', { scheme: 'dark' });

  // The phone: the same card and line.
  const phone = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const mobile = await phone.newPage();
    await mobile.goto(`${world.url}#thread=${threadId}`);
    await expect(pane(mobile).locator('[data-permission] fieldset.question-block')).toBeVisible();
    await expect(pane(mobile).locator('[data-run="waiting_answer"]')).toBeVisible();
    await pane(mobile).locator('[data-permission]').scrollIntoViewIfNeeded();
    await shot(mobile, 'permission-waiting-phone');
    await shot(mobile, 'permission-waiting-phone-dark', { scheme: 'dark' });
  } finally {
    await phone.close();
  }

  // Allow once.
  await answer(page, { choice: 'Allow once' });
  const [result] = await waitFor('the prompt decided', () => (fake.permissions().length > 0 ? fake.permissions() : null));
  expect(result!.outcome).toBe('ran');
  expect(result!.exitCode).toBe(0);
  expect(result!.output).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: BUILD.tool_input } } });
  // The agent goes on and answers; the line goes once it rests.
  await expect(p.locator('article.ib-message[data-author="agent"]').last()).toContainText('[Bash ran]', { timeout: 30_000 });
  await expect(p.locator('[data-run]')).toHaveCount(0, { timeout: 30_000 });
  await expect(c.locator('[data-question-control]').first()).toBeDisabled();
  await shot(page, 'permission-answered');
  // The answer went to the permission identity (the hook's call recorded it), never to the session's poll.
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
  await answer(page, { choice: SESSION_CHOICE });
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
  // No suggestion from Claude Code: Allow once and Deny only.
  await expect(card(page).locator('[data-question-option]')).toHaveText(['Allow once', 'Deny']);
  await answer(page, { reason: 'Never force-push main. Open a pull request instead.' });
  const result = await waitFor('the prompt decided', () => fake.permissions()[before]);
  expect(result.outcome).toBe('denied');
  const decision = result.output?.hookSpecificOutput?.decision;
  expect(decision?.behavior).toBe('deny');
  expect(decision?.message).toContain('Do not retry it');
  expect(decision?.message).toContain('Their reason: Never force-push main. Open a pull request instead.');
  await expect(pane(page).locator('article.ib-message[data-author="agent"]').last()).toContainText('[Bash denied]', { timeout: 30_000 });
});

test('answered in Terminal: the hook is ended, and the question is withdrawn and can no longer be answered', async () => {
  const { page, fake } = world;
  const hooksBefore = fake.hooks().length;
  fake.configure({ prompts: [BUILD] });
  const { threadId } = await launch(page, 'Rebuild once more.');
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  await expect(pane(page).locator('[data-run="waiting_answer"]')).toBeVisible({ timeout: 15_000 });
  // The person answers the dialog in `claude attach`: Claude Code ends the hook and goes on.
  fake.configure({ localAnswer: true });
  const ended = await waitFor('the hook ended', () => fake.hooks()[hooksBefore]);
  expect(ended.local).toBe(true);
  expect(ended.stdout).toBe('');
  // The host reads the session as gone on: the question is withdrawn from the same identity.
  await expect(pane(page).locator('article.ib-message[data-author="agent"]', { hasText: 'Answered in Terminal.' })).toBeVisible({ timeout: 45_000 });
  await expect(card(page)).toHaveCount(0);
  // The card says it no longer applies; its choices are folded away behind "Show the old options".
  const withdrawn = pane(page).locator('[data-permission]').first();
  await expect(withdrawn).toContainText('No longer applies');
  await expect(withdrawn.locator('[data-question-option]').first()).toBeHidden();
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
  await expect(pane(page).locator('article.ib-message[data-author="agent"]', { hasText: 'No longer waiting.' })).toBeVisible({ timeout: 10_000 });
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
  // Down for longer than a few of the hook's 2 s retries: it keeps waiting, it never gives up into Claude Code's dialog.
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
  // Still one question: the hook came back with its question, it did not ask again.
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
  // The settings file's hook is ours alone, matcher `*`: the plugin's own ExitPlanMode hook is untouched.
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
  // The plan was decided elsewhere (plan review); the fake goes on once it is.
  fake.configure({ localAnswer: true });
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
  // An agent's curl: this run's serverSession, no Origin. Refused for a permission question.
  const refused = await fetch(`http://127.0.0.1:${world.port}/api/inbox/messages/${question.id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverSession: session, idempotency_key: 'curl-1', words: '', questions: [pick] }),
  });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { code: string }).code).toBe('window_only');
  await page.waitForTimeout(1_000);
  expect(fake.permissions().length).toBe(before);
  // The window still answers.
  await answer(page, { choice: 'Deny' });
  const result = await waitFor('the prompt decided', () => fake.permissions()[before]);
  expect(result.outcome).toBe('denied');
});

test('launch turned off while a question waits: the question is withdrawn, and nothing draws as a permission card', async () => {
  const { page, fake } = world;
  fake.configure({ prompts: [BUILD] });
  const { threadId } = await launch(page, 'A build before the switch goes off.');
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  const read = await readThread(page, threadId);
  const question = read.thread.messages.find((m) => m.author.session?.startsWith('perm:'))!;
  writeConfig({ inboxLaunch: { enabled: false } });
  try {
    await expect
      .poll(
        async () => {
          const now = await readThread(page, threadId);
          return (now.thread.messages.find((m) => m.id === question.id) as { questions?: { state: string }[] } | undefined)?.questions?.[0]?.state;
        },
        { timeout: 30_000 },
      )
      .toBe('superseded');
    await page.reload();
    await expect(pane(page).locator('article.ib-message').first()).toBeVisible();
    await expect(pane(page).locator('[data-permission]')).toHaveCount(0);
  } finally {
    writeConfig({ inboxLaunch: { enabled: true } });
    fake.configure({ localAnswer: true });
  }
});
