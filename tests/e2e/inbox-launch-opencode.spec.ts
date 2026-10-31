/**
 * Launch with OpenCode: start OpenCode 1 from compose's To, proved in a real
 * browser against the compiled binary and its real launch endpoint. Nothing in
 * the Inbox is mocked. The only fakes are the programs launch runs, on a PATH
 * of their own: `opencode` (tests/helpers/fake-opencode/: `--version`,
 * `opencode serve`'s HTTP API as 1.18.23 has it, `session delete`, and an agent
 * that answers through the Inbox as Plannotator's plugin does), `osascript`
 * (recorded, nothing opens) and a stand-in login shell. The real OpenCode, the
 * real home and the person's Inbox are never touched: temp HOME and
 * PLANNOTATOR_DATA_DIR, PLANNOTATOR_INBOX_CONNECT=0,
 * PLANNOTATOR_UPDATE_CHECK=0, NO_BROWSER.
 *
 *  1. The journey: the To row, Send starts one `opencode serve` in the folder
 *     on a free port it picked (never 0 or 4096) with this Inbox's data dir,
 *     the plugin's tool and the launch id; its
 *     password only in launch/<id>/server.json (0600), never in a log, the
 *     page, the run line or the attach command; Working; Open in Terminal runs
 *     `opencode attach`; the answer lands as a reply to the root.
 *  2. Permission prompts on the card: the header names OpenCode, OpenCode's
 *     choices (no mode switch, no Terminal hand-off); the session choice is
 *     OpenCode's "always", Deny with a reason is a reject with the reason, and
 *     the agent goes on; a prompt answered in `opencode attach` withdraws the
 *     card ("Answered in Terminal"); a subagent's prompt (a child session) is
 *     the same card with "From a subagent (…)".
 *  3. An Inbox restart while a card waits: the server keeps running, the
 *     Inbox adopts it (no second server), the same card answers it.
 *  4. Stop: the turn is aborted, the server and the command it ran end, "You
 *     stopped OpenCode"; a reply starts a new server on the same session.
 *  5. Delete: the server and its children end, `session delete --pure` runs,
 *     launch/<id>/ goes, no fake process is left.
 *  6. Full permissions: the session gets OpenCode's allow-all ruleset.
 *  7. OpenCode 2 and a missing plugin (checked first): no row.
 *  8. Delete leaves no `opencode serve` and no command one ran.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-launch-opencode.spec.ts`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { installFakeOpenCode, type FakeOpenCode, type FakeOpenCodePrompt } from '../helpers/fake-opencode';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const WIDE = { width: 1440, height: 900 };

interface World {
  root: string;
  home: string;
  bin: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  port: number;
  fake: FakeOpenCode;
  projects: Record<'plannotator' | 'side', string>;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  errors: string[];
  /** Every launch this spec started (the last test deletes those still there). */
  launches: { threadId: string; launchId: string }[];
}
let world: World;

const BUILD: FakeOpenCodePrompt = { permission: 'bash', patterns: ['bun run build'], always: ['bun run *'], metadata: { command: 'bun run build', description: 'Build the bundle' } };

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

/** The person's own OpenCode config, in the temp HOME: Plannotator's plugin listed (or not). */
function openCodeConfig(plugin: boolean): void {
  mkdirSync(join(world.home, '.config', 'opencode'), { recursive: true });
  writeFileSync(join(world.home, '.config', 'opencode', 'opencode.json'), JSON.stringify(plugin ? { plugin: ['@plannotator/opencode'] } : {}));
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

function startInbox(): void {
  const started = spawnSync(binary, ['inbox', '--background'], { env: world.env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(world.dataDir);
  const registry = JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number };
  world.url = started.stdout.trim();
  world.port = registry.port;
}

async function newPage(): Promise<void> {
  const context = await world.browser.newContext({ viewport: WIDE, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (error) => world.errors.push(error.message));
  world.context = context;
  world.page = page;
}

const dialog = (page: Page) => page.locator('dialog[data-compose]');
const pane = (page: Page) => page.locator('section.ib-pane');
const card = (page: Page) => pane(page).locator('section.pc-card[data-permission]').last();
const record = (page: Page, outcome: string) => pane(page).locator(`[data-perm-record="${outcome}"]`);
const armed = (page: Page) => expect(card(page)).toHaveAttribute('data-perm-armed', '', { timeout: 30_000 });
/** OpenCode's answers in the thread (not its permission questions, which draw as cards or their records). */
const agentMessages = (page: Page) => pane(page).locator('article.ib-message[data-author="agent"]:not(:has([data-permission], [data-perm-record]))');

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

/** New message → To → "OpenCode New session" (in `folder`) → words → Send. */
async function launchFrom(page: Page, words: string, folder: string): Promise<{ threadId: string; launchId: string }> {
  await page.goto(world.url);
  const folderId = await projectIdOf(page, folder);
  await page.locator('.ib-side [data-open-compose]').click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.locator('[data-compose-to]').click();
  await d.locator('[data-compose-start="opencode"]').click();
  await d.locator('[data-compose-folder]').click();
  await d.locator(`[data-compose-folder-option="${folderId}"]`).click();
  await d.getByRole('textbox', { name: 'Message' }).fill(words);
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/inbox/messages') && r.request().method() === 'POST');
  await d.locator('[data-compose-send]').click();
  const body = (await (await answer).json()) as { thread_id: string; launch?: { id: string } };
  expect(body.launch?.id).toMatch(/^lch_/);
  await expect(d).toHaveCount(0);
  await openThread(page, body.thread_id);
  world.launches.push({ threadId: body.thread_id, launchId: body.launch!.id });
  return { threadId: body.thread_id, launchId: body.launch!.id };
}

async function openThread(page: Page, threadId: string): Promise<void> {
  await page.goto(`${world.url}#thread=${threadId}`);
  await page.reload();
  await expect(pane(page).locator('[data-launched]')).toBeVisible();
}

async function reply(page: Page, words: string): Promise<void> {
  const p = pane(page);
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await p.getByRole('textbox', { name: /^Reply to OpenCode/ }).fill(words);
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
}

type ThreadRead = { thread: { messages: { id: string; author: { kind: string; session?: string | null }; questions?: unknown[]; reply_to?: string | null; to?: { session: string } | null; delivery?: unknown }[] }; run?: unknown; attach_command?: string | null };
const readThread = (page: Page, threadId: string) => page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}`)).json(), threadId) as Promise<ThreadRead>;

const launchDir = (launchId: string) => join(world.dataDir, 'inbox', 'launch', launchId);
/** A launched thread's OpenCode session (its root's `to`, once started). */
const sessionOf = async (page: Page, threadId: string) => {
  const session = (await readThread(page, threadId)).thread.messages[0]?.to?.session;
  expect(session).toMatch(/^ses_/);
  return session!;
};
const serverOf = (launchId: string) => JSON.parse(readFileSync(join(launchDir(launchId), 'server.json'), 'utf8')) as { pid: number; url: string; password: string };

/** Every file under `dir` whose bytes hold `secret`. */
function filesHolding(dir: string, secret: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) filesHolding(path, secret, found);
    else if (entry.isFile() && statSync(path).size < 20_000_000 && readFileSync(path).includes(secret)) found.push(path);
  }
  return found;
}

const osascriptRuns = () =>
  existsSync(join(world.root, 'osascript.log'))
    ? readFileSync(join(world.root, 'osascript.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\u001f').filter(Boolean))
    : [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-launch-opencode-e2e-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  for (const dir of [home, bin, dataDir]) mkdirSync(dir, { recursive: true });
  const fake = installFakeOpenCode({ bin, state: join(root, 'fake-opencode') });
  // `$SHELL -ilc <command>`: the fakes on PATH, as a person's .zshrc would put them.
  writeFileSync(join(bin, 'login-shell'), `#!/bin/sh\nPATH='${bin}':"$PATH"\nexport PATH\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });
  // Open in Terminal: what it would have run, recorded; nothing opens.
  writeFileSync(join(bin, 'osascript'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> '${join(root, 'osascript.log')}'\nprintf '\\n' >> '${join(root, 'osascript.log')}'\n`, { mode: 0o755 });
  const env: Record<string, string> = {
    // Only the fakes and the system's own tools: never the agents installed on the machine running the spec.
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    SHELL: join(bin, 'login-shell'),
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
  world = { root, home, bin, dataDir, env, url: '', port: 0, fake, projects: {} as World['projects'], browser, context: undefined as never, page: undefined as never, errors: [], launches: [] };
  markTourDecided(dataDir);
  writeConfig({ inboxLaunch: { enabled: true } });
  openCodeConfig(true);
  startInbox();
  await fetch(`http://127.0.0.1:${world.port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  world.projects = { plannotator: git(join(home, 'plannotator', 'plannotator')), side: git(join(home, 'oss', 'side-project')) };
  await agentWrites(world.projects.plannotator, 'ses-pl', 'Reach agents on a remote machine over SSH: a sketch of the relay.');
  await agentWrites(world.projects.side, 'ses-side', 'The side project builds again after the dependency bump.');
  await newPage();
});

test.afterAll(async () => {
  try {
    world?.fake.stopAll();
    await world?.context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('OpenCode 2, or no Plannotator plugin in the OpenCode config: no row; with both, the row', async () => {
  const { page, fake } = world;
  // Before any check passed (a passed one is kept 30 s; a failed one is checked again at once).
  const offered = () => page.evaluate(async () => ((await (await fetch('/api/inbox/sessions')).json()) as { launch?: { agents: { agent: string }[] } }).launch?.agents.map((a) => a.agent) ?? []);
  fake.configure({ version: '2.1.4' });
  await page.goto(world.url);
  await expect.poll(offered, { timeout: 20_000 }).toEqual([]);
  expect(fake.calls().some((c) => c.argv[0] === '--version')).toBe(true);
  openCodeConfig(false);
  fake.configure({ version: '1.18.23' });
  await page.reload();
  await expect.poll(offered, { timeout: 20_000 }).toEqual([]);
  // Nothing ran but --version.
  expect(fake.calls().every((c) => c.argv[0] === '--version')).toBe(true);
  openCodeConfig(true);
  await page.reload();
  await expect.poll(offered, { timeout: 20_000 }).toEqual(['opencode']);
});

test('the journey: the To row; Send starts one server with the password only in server.json; Working; Open in Terminal; the answer lands', async () => {
  const { page, fake } = world;
  fake.configure({ hold: true, prompts: [] });
  await page.goto(world.url);
  await page.locator('.ib-side [data-open-compose]').click();
  const d = dialog(page);
  await d.locator('[data-compose-to]').click();
  await expect(d.locator('[data-compose-start="opencode"]')).toContainText('OpenCodeNew session');
  // No claude on this PATH: OpenCode is the one agent offered.
  await expect(d.locator('[data-compose-start]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  const { threadId, launchId } = await launchFrom(page, 'Make the Settings search fuzzy, like the command palette.', world.projects.plannotator);
  const serve = await waitFor('opencode serve', () => fake.serves()[0]);
  // A free port the Inbox picked itself: never `--port 0` (OpenCode would take its default 4096) and never 4096.
  expect(serve.argv.slice(0, 4)).toEqual(['serve', '--hostname', '127.0.0.1', '--port']);
  expect(Number(serve.argv[4]) > 0 && serve.argv[4] !== '4096').toBe(true);
  expect(serve.cwd).toBe(world.projects.plannotator);
  // This Inbox (a temp data dir), the plugin's tool on, this launch: the plugin replies here, and its replies come back as turns.
  expect(serve.values).toMatchObject({ PLANNOTATOR_DATA_DIR: world.dataDir, PLANNOTATOR_INBOX_TOOL: '1', PLANNOTATOR_LAUNCH: launchId });
  expect(serve.passwordSet).toBe(true);
  expect(serve.argv.join(' ')).not.toContain('fuzzy');

  // The server file: 0600, one per launch, the only place its password lives.
  const file = join(launchDir(launchId), 'server.json');
  await waitFor('server.json', () => existsSync(file));
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const server = serverOf(launchId);
  expect(server.pid).toBe(serve.pid);
  expect(server.password).toMatch(/^[0-9a-f]{48}$/);

  const p = pane(page);
  await expect(p.locator('[data-launched]')).toHaveText('You started OpenCode in plannotator');
  await expect(p.locator('[data-run="working"]')).toContainText(/^OpenCode is working/, { timeout: 20_000 });
  // The root went to the session the server made, as its first turn.
  const session = fake.sessions()[0]!;
  expect(session.directory).toBe(world.projects.plannotator);
  expect(fake.prompts()[0]).toMatchObject({ session: session.id, server: serve.pid });
  expect(fake.prompts()[0]!.text).toContain('Make the Settings search fuzzy');
  // The person's own OpenCode permissions: no ruleset of the Inbox's.
  expect(session.permission).toBeNull();

  // ⋯: Open in Terminal runs `opencode attach` on this server and session; the password is read from the file there, never written out.
  await p.locator('[data-thread-more]').click();
  await expect(page.locator('[data-thread-menu] [data-launch-item]')).toHaveText(['Open in Terminal', 'Copy attach command', 'Stop OpenCode', 'Delete OpenCode session…']);
  await page.locator('[data-launch-item="open"]').click();
  const ran = await waitFor('osascript', () => osascriptRuns()[0]);
  expect(ran.at(-1)).toContain(`cd ${world.projects.plannotator} && OPENCODE_SERVER_PASSWORD="$(sed -n`);
  expect(ran.at(-1)).toContain(`opencode attach ${server.url} --session ${session.id}`);

  // It answers: a reply to the root, and it rests.
  fake.configure({ hold: false });
  await expect(agentMessages(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(p.locator('[data-run]')).toHaveCount(0, { timeout: 30_000 });
  const read = await readThread(page, threadId);
  expect(read.thread.messages.find((m) => m.author.kind === 'agent')!.reply_to).toBe(read.thread.messages[0]!.id);
  expect(read.thread.messages[0]!.to?.session).toBe(session.id);

  // The password: in server.json and nowhere else (start.log, server.log, the Inbox's logs, the fake's records), nor in the page, the run line or the attach command.
  expect(filesHolding(world.root, server.password)).toEqual([file]);
  expect(JSON.stringify(read)).not.toContain(server.password);
  expect(read.attach_command).toContain('opencode attach');
  expect(await page.content()).not.toContain(server.password);
  expect(ran.join(' ')).not.toContain(server.password);
  // The attach command's shell read does yield it (Open in Terminal works).
  const probe = spawnSync('/bin/sh', ['-c', `${ran.at(-1)!.replace(/ opencode attach .*$/, '')} /bin/sh -c 'printf %s "$OPENCODE_SERVER_PASSWORD"'`], { encoding: 'utf8' });
  expect(probe.stdout).toBe(server.password);
});

test('permission prompts on the card: OpenCode in the header, its choices; the session choice is "always", Deny with a reason a reject with it; answered in opencode attach withdraws the card', async () => {
  const { page, fake } = world;
  const EDIT: FakeOpenCodePrompt = { permission: 'edit', patterns: ['src/search.ts'], always: ['*'], metadata: { filepath: join(world.projects.side, 'src/search.ts'), diff: `Index: src/search.ts\n===\n--- src/search.ts\n+++ src/search.ts\n@@ -1,2 +1,2 @@\n export const match = (a, b) =>\n-  a.startsWith(b);\n+  fuzzy(a, b);\n` } };
  fake.configure({ prompts: [BUILD, EDIT], localAnswer: false, hold: false });
  const { threadId } = await launchFrom(page, 'Make the side project search fuzzy and rebuild it.', world.projects.side);
  const p = pane(page);

  // 1. The command.
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  const c = card(page);
  await expect(c.locator('.pc-app')).toHaveText('OpenCode');
  await expect(c).toHaveAttribute('aria-label', 'OpenCode asks permission to run a command');
  await expect(c.locator('.pc-title')).toHaveText('Run a command');
  await expect(c.locator('[data-perm-detail]')).toHaveText('bun run build');
  await expect(c.locator('.pc-row button')).toHaveText(['Allow once', 'Allow bun run for this session', 'Deny', 'Deny with a reason']);
  // OpenCode has no modes to switch to and no dialog to hand off to.
  await expect(c.locator('[data-perm-mode], [data-perm="terminal"]')).toHaveCount(0);
  await expect(c.locator('[data-run="waiting_answer"]')).toContainText('OpenCode is waiting for your permission', { timeout: 15_000 });
  await armed(page);
  await c.locator('[data-perm="session"]').click();
  await expect(record(page, 'session')).toContainText('You chose Allow bun run for this session', { timeout: 15_000 });
  await waitFor('the always reply', () => fake.replies().find((r) => r.permission === 'bash' && r.reply === 'always'));

  // 2. The file change: OpenCode's own diff; denied with a reason, the reason carried.
  await expect(card(page).locator('.pc-facts')).toHaveText('1 removed, 1 added', { timeout: 30_000 });
  await expect(card(page).locator('[data-perm="session"]')).toHaveText('Allow every file edit for this session');
  await armed(page);
  await card(page).locator('[data-perm="reason"]').click();
  await card(page).getByRole('textbox', { name: 'Why you deny this, for OpenCode' }).fill('Keep prefix matches first, then fuzzy.');
  await card(page).locator('[data-perm-deny-send]').click();
  const denied = await waitFor('the reject reply', () => fake.replies().find((r) => r.permission === 'edit'));
  expect(denied.reply).toBe('reject');
  expect(denied.message).toContain('Their reason: Keep prefix matches first, then fuzzy.');
  await expect(record(page, 'deny')).toBeVisible();
  // The agent goes on and answers.
  await expect(agentMessages(page)).toHaveCount(1, { timeout: 30_000 });

  // 3. A prompt the person answers in `opencode attach`: the card is withdrawn and can no longer be answered.
  fake.configure({ prompts: [BUILD], localAnswer: true });
  await reply(page, 'Rebuild once more.');
  await expect(record(page, 'withdrawn')).toContainText('Answered in Terminal', { timeout: 30_000 });
  await expect(pane(page).locator('[data-perm]')).toHaveCount(0);
  await expect(agentMessages(page)).toHaveCount(2, { timeout: 30_000 });
  // Each prompt reached the server once, answered once.
  const session = await sessionOf(page, threadId);
  expect(fake.replies().filter((r) => r.session === session)).toHaveLength(3);
  // The reply went to the same server: no second one for a session still running.
  expect(fake.serves()).toHaveLength(2);
  expect((await readThread(page, threadId)).thread.messages.filter((m) => m.author.session?.startsWith('perm:') && (m.questions?.length ?? 0) > 0)).toHaveLength(3);
  await expect(p.locator('[data-run]')).toHaveCount(0);

  // 4. A subagent's prompt (the task tool's child session): the same card, saying where it comes from.
  fake.configure({ prompts: [BUILD], localAnswer: false, subagent: true });
  try {
    await reply(page, 'Ask a subagent to check the build.');
    await expect(card(page).locator('[data-perm-note]')).toHaveText('From a subagent (Look around (@explore subagent)).', { timeout: 30_000 });
    await armed(page);
    await card(page).locator('[data-perm="once"]').click();
    const child = await waitFor('the child session', () => fake.sessions().find((s) => s.parentID === session));
    await waitFor('the reply in the child session', () => fake.replies().find((r) => r.session === child.id && r.reply === 'once'));
    await expect(agentMessages(page)).toHaveCount(3, { timeout: 30_000 });
  } finally {
    fake.configure({ subagent: false });
  }
});

test('an Inbox restart while a card waits: the server runs on, the Inbox adopts it (no second server), and the same card answers it', async () => {
  const { fake } = world;
  fake.configure({ prompts: [BUILD], localAnswer: false, hold: false });
  const { threadId, launchId } = await launchFrom(world.page, 'Rebuild after the restart.', world.projects.side);
  await expect(card(world.page)).toBeVisible({ timeout: 30_000 });
  const serves = fake.serves().length;
  const server = serverOf(launchId);
  await world.context.close();
  await stopScratchInbox(world.dataDir);
  expect(fake.processes().find((x) => x.pid === server.pid)?.alive).toBe(true);
  startInbox();
  await newPage();
  const { page } = world;
  await page.goto(`${world.url}#thread=${threadId}`);
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
  // Still one question: the Inbox found its card again, it did not ask twice.
  expect((await readThread(page, threadId)).thread.messages.filter((m) => m.author.session?.startsWith('perm:') && (m.questions?.length ?? 0) > 0)).toHaveLength(1);
  const session = await sessionOf(page, threadId);
  await armed(page);
  await card(page).locator('[data-perm="once"]').click();
  await waitFor('the once reply', () => fake.replies().find((r) => r.session === session && r.reply === 'once' && !r.local));
  await expect(record(page, 'once')).toBeVisible({ timeout: 15_000 });
  await expect(agentMessages(page)).toHaveCount(1, { timeout: 30_000 });
  expect(fake.serves()).toHaveLength(serves);
  expect(serverOf(launchId).pid).toBe(server.pid);
});

test('Stop ends the turn, the server and the command it ran; a reply starts a new server on the same session; Delete ends it all and deletes the session', async () => {
  const { page, fake } = world;
  fake.configure({ prompts: [], hold: true });
  const { threadId, launchId } = await launchFrom(page, 'Drop the unused export.', world.projects.plannotator);
  const p = pane(page);
  await expect(p.locator('[data-run="working"]')).toBeVisible({ timeout: 20_000 });
  const first = serverOf(launchId);
  const session = await sessionOf(page, threadId);
  expect(fake.childOf(first.pid)?.alive).toBe(true);

  // Stop: aborted, the server and its child gone, the file too; "You stopped OpenCode".
  await p.locator('[data-thread-more]').click();
  await page.locator('[data-launch-item="stop"]').click();
  await expect(p.locator('[data-run="stopped"]')).toHaveText(/^You stopped OpenCode at \d{1,2}:\d{2} [AP]M\. Your reply starts it again\.$/, { timeout: 20_000 });
  await waitFor('the abort', () => fake.aborts().includes(session));
  await waitFor('the server and the command it ran ended', () => !fake.processes().find((x) => x.pid === first.pid)?.alive && !fake.childOf(first.pid)?.alive, 10_000);
  expect(existsSync(join(launchDir(launchId), 'server.json'))).toBe(false);

  // A reply: a new server, the same session, the reply delivered, the answer lands.
  fake.configure({ hold: false });
  const serves = fake.serves().length;
  await reply(page, 'And the test that imports it.');
  const again = await waitFor('a new server', () => fake.serves()[serves]);
  expect(again.cwd).toBe(world.projects.plannotator);
  expect(again.values.PLANNOTATOR_LAUNCH).toBe(launchId);
  await waitFor('the reply as a turn', () => fake.prompts().find((x) => x.session === session && x.server === again.pid && x.text.includes('the test that imports it')));
  await expect(agentMessages(page)).toHaveCount(1, { timeout: 30_000 });
  expect(fake.serves()).toHaveLength(serves + 1);

  // Delete: the server and its children end, the session goes from OpenCode's database, launch/<id>/ goes; the thread stays.
  await p.locator('[data-thread-more]').click();
  await page.locator('[data-launch-item="delete"]').click();
  await p.locator('[data-launch-delete]').click();
  await expect(p.locator('[data-launch-confirm]')).toHaveCount(0);
  await waitFor('session delete', () => fake.calls().some((c) => c.argv[0] === 'session' && c.argv[1] === 'delete' && c.argv[2] === session && c.argv.includes('--pure')));
  await waitFor('launch folder removed', () => !existsSync(launchDir(launchId)));
  expect(fake.sessions().some((s) => s.id === session)).toBe(false);
  await waitFor('the new server and its command ended', () => !fake.processes().find((x) => x.pid === again.pid)?.alive && !fake.childOf(again.pid)?.alive, 10_000);
  await expect(p.locator('[data-launched]')).toBeVisible();
});

test('full permissions: the session gets the allow-all ruleset, and the header says so', async () => {
  const { page, fake } = world;
  writeConfig({ inboxLaunch: { enabled: true, fullPermissions: true } });
  try {
    fake.configure({ prompts: [], hold: false });
    const { threadId, launchId } = await launchFrom(page, 'Bump the lockfile.', world.projects.side);
    const session = await waitFor('the session', () => fake.sessions().find((s) => fake.prompts().some((x) => x.session === s.id && x.text.includes('Bump the lockfile'))));
    expect(session.permission).toEqual([{ permission: '*', pattern: '*', action: 'allow' }]);
    await expect(pane(page).locator('[data-launched] [data-launch-full]')).toHaveText('Full permissions');
    await expect(agentMessages(page)).toHaveCount(1, { timeout: 30_000 });
    await pane(page).locator('[data-thread-more]').click();
    await page.locator('[data-launch-item="delete"]').click();
    await pane(page).locator('[data-launch-delete]').click();
    await waitFor('launch folder removed', () => !existsSync(launchDir(launchId)));
    void threadId;
  } finally {
    writeConfig({ inboxLaunch: { enabled: true } });
  }
});

test('Delete leaves no OpenCode process: every launch still there deleted, no server or child of the fake alive', async () => {
  const { page, fake } = world;
  // The launches the earlier tests left resting (a launch's server runs until Stop or Delete).
  const left = world.launches.filter((l) => existsSync(launchDir(l.launchId)));
  expect(left.length).toBeGreaterThan(0);
  expect(fake.processes().some((x) => x.alive)).toBe(true);
  for (const { threadId, launchId } of left) {
    await openThread(page, threadId);
    await pane(page).locator('[data-thread-more]').click();
    await page.locator('[data-launch-item="delete"]').click();
    await pane(page).locator('[data-launch-delete]').click();
    await waitFor(`launch ${launchId} removed`, () => !existsSync(launchDir(launchId)));
  }
  // No orphaned `opencode serve`, and no command one ran; every session gone from OpenCode's database.
  await waitFor('every fake process ended', () => fake.processes().every((x) => !x.alive), 15_000);
  expect(fake.serves().length).toBeGreaterThanOrEqual(5);
  expect(fake.processes().filter((x) => x.kind === 'server')).toHaveLength(fake.serves().length);
  expect(fake.sessions()).toEqual([]);
  expect(world.errors).toEqual([]);
});
