/**
 * Launch Pi from compose's To, proved in a real browser against the compiled
 * binary and its real launch endpoint. Nothing in the Inbox is mocked; the only
 * fakes are the programs launch runs, on a PATH of their own
 * (tests/helpers/fake-pi/): `pi` (`--version`, `--mode rpc --session-id`, its
 * session file, and Plannotator's Pi extension's bridge poll), `osascript`
 * (recorded, nothing opens) and a stand-in login shell. The real Pi, the real
 * home and the person's Inbox are never touched: temp HOME and
 * PLANNOTATOR_DATA_DIR, PLANNOTATOR_INBOX_CONNECT=0, PLANNOTATOR_UPDATE_CHECK=0,
 * NO_BROWSER.
 *
 *  1. The journey: the Pi row in To, Send starts one `pi --mode rpc
 *     --session-id <uuid>` in the project with the Inbox tool on and this
 *     Inbox's data dir; Working, then Pi's answer and no line; while it runs
 *     ⋯ has no Copy attach command; Stop ends it (stdin closed) and says who
 *     stopped it; a reply starts it again on the same session id and file,
 *     delivered once; Delete ends it and removes launch/<id>/.
 *  2. The Inbox stops: Pi stops with it, and after the restart the line says
 *     plainly that a Pi session runs only while the Inbox runs and a reply
 *     continues it; the reply does.
 *  3. An extension dialog over RPC: answered Cancel at once, and the thread
 *     shows a note from Pi saying so (escaped, one line).
 *     A turn that ends in a provider error: one note from Pi with its words.
 *  4. The way to Terminal for a working Pi: Stop, then ⋯'s Copy attach command
 *     (run here in a plain shell) runs Pi with the Inbox tool on; a reply goes
 *     to that Pi, nothing starts here and ⋯ has no Copy attach command; once it
 *     quit and the bridge lost it, a reply starts Pi here again.
 *  5. A Pi that runs but never connected: Open in Terminal, with Stop not
 *     offered there, ends it only once the Terminal command runs, and that
 *     command waits for it; the Terminal's Pi then takes the message.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-launch-pi.spec.ts`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { installFakePi, type FakePi } from '../helpers/fake-pi';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const WIDE = { width: 1440, height: 900 };
const STOPPED_NOTE = 'A Pi session runs only while the Inbox runs. Your reply continues it.';

interface World {
  root: string;
  home: string;
  /** The fakes' folder (the spec's PATH). */
  bin: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  port: number;
  fake: FakePi;
  project: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

function startInbox(): void {
  const started = spawnSync(binary, ['inbox', '--background'], { env: world.env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(world.dataDir);
  const registry = JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number };
  world.url = started.stdout.trim();
  world.port = registry.port;
}

async function newPage(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: WIDE, deviceScaleFactor: 1, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(world.url).origin });
  const page = await context.newPage();
  page.on('pageerror', (error) => world.errors.push(error.message));
  world.context = context;
  world.page = page;
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

const dialog = (page: Page) => page.locator('dialog[data-compose]');
const pane = (page: Page) => page.locator('section.ib-pane');

/** New message → To → "Pi New session" → words → Send; the thread opened. */
async function launch(page: Page, words: string): Promise<{ threadId: string; launchId: string }> {
  await page.goto(world.url);
  await page.locator('.ib-side [data-open-compose]').click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.locator('[data-compose-to]').click();
  await d.locator('[data-compose-start="pi"]').click();
  await expect(d.locator('[data-compose-to="start"]')).toHaveText(/New Pi session/);
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
    thread: { messages: { id: string; body: string; author: { kind: string; host?: string; session?: string; name?: string }; reply_to?: string | null; delivery?: unknown }[] };
    run?: { state: string; cause: string | null } | null;
  };
}

async function reply(page: Page, words: string): Promise<void> {
  const p = pane(page);
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await p.getByRole('textbox', { name: /^Reply to Pi/ }).fill(words);
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
}

async function menuItems(page: Page): Promise<string[]> {
  await pane(page).locator('[data-thread-more]').click();
  await page.locator('[data-thread-menu] [data-launch-item]').first().waitFor({ state: 'visible', timeout: 10_000 });
  const items = await page.locator('[data-thread-menu] [data-launch-item]').allTextContents();
  await page.keyboard.press('Escape');
  return items;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-launch-pi-e2e-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  for (const dir of [home, bin, dataDir]) mkdirSync(dir, { recursive: true });
  const fake = installFakePi({ bin, state: join(root, 'fake-pi'), home });
  markTourDecided(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxLaunch: { enabled: true } }));
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
  world = { root, home, bin, dataDir, env, url: '', port: 0, fake, project: '', context: undefined as never, page: undefined as never, errors: [] };
  startInbox();
  await fetch(`http://127.0.0.1:${world.port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  const project = join(home, 'notes-app');
  mkdirSync(project, { recursive: true });
  world.project = realpathSync(project);
  // The project exists in the Inbox: an agent wrote from it once.
  const seeded = await fetch(`http://127.0.0.1:${world.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { body: 'The notes app builds again.', project_path: world.project, agent_session: 'ses-seed', agent_host: 'pi' } } }),
  });
  expect(seeded.status).toBe(200);
  await newPage(browser);
});

test.afterAll(async () => {
  try {
    world?.fake.stopAll();
    await world?.context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the journey: the Pi row, one RPC process per session, Working → answered, Stop, a reply continues it on the same session, Delete', async () => {
  const { page, fake } = world;
  fake.configure({ workMs: 2_500 });
  const { threadId, launchId } = await launch(page, 'Rename the notes folder setting to "vault". Keep the old key working.');
  const p = pane(page);
  await expect(p.locator('[data-launched]')).toHaveText('You started Pi in notes-app');

  const start = await waitFor('pi --mode rpc', () => fake.starts()[0]);
  const session = start.argv[3]!;
  expect(start.argv).toEqual(['--mode', 'rpc', '--session-id', session, '--name', expect.any(String)]);
  expect(session).toMatch(/^[0-9a-f-]{36}$/);
  expect(start.argv.join(' ')).not.toContain('vault');
  expect(start.cwd).toBe(world.project);
  // This Inbox, the Inbox tool on: the only Plannotator names it gets.
  expect(start.dataDir).toBe(world.dataDir);
  expect(start.inboxTool).toBe('1');
  expect(start.env.filter((name) => name.startsWith('PLANNOTATOR_'))).toEqual(['PLANNOTATOR_DATA_DIR', 'PLANNOTATOR_INBOX_TOOL']);

  await expect(p.locator('[data-run="working"]')).toContainText('Pi is working', { timeout: 20_000 });
  // While the Inbox's process runs the session, no attach command: a second Pi on it would write the same file.
  const running = await menuItems(page);
  expect(running).toContain('Stop Pi');
  expect(running).not.toContain('Copy attach command');
  await expect(p.locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(p.locator('[data-run]')).toHaveCount(0);
  const first = (await readThread(page, threadId)).thread.messages.find((m) => m.author.kind === 'agent')!;
  expect(first.author).toMatchObject({ host: 'pi', session, name: 'Pi' });
  expect(first.body).toContain('(context 0)');

  // Stop: the process ends through its stdin; the line says who stopped it.
  await pane(page).locator('[data-thread-more]').click();
  await page.locator('[data-launch-item="stop"]').click();
  await expect(p.locator('[data-run="stopped"]')).toHaveText(/^You stopped Pi at \d{1,2}:\d{2} [AP]M\. Your reply starts it again\.$/);
  await waitFor('the process ended', () => fake.exits().some((exit) => exit.pid === start.pid && exit.why === 'stdin'));
  // Stopped: now the attach command is offered.
  expect(await menuItems(page)).toContain('Copy attach command');

  // A reply continues it: the same session id, the same session file, delivered once.
  await reply(page, 'Also update the README.');
  await expect(p.locator('[data-run="starting"]')).toHaveText('Starting Pi again…');
  await expect(p.locator('article.ib-message[data-author="agent"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(p.locator('[data-run]')).toHaveCount(0, { timeout: 20_000 });
  expect(fake.starts()).toHaveLength(2);
  expect(fake.starts()[1]!.argv.slice(0, 4)).toEqual(['--mode', 'rpc', '--session-id', session]);
  expect(fake.sessionFiles()).toHaveLength(1);
  const read = await readThread(page, threadId);
  const sentReply = read.thread.messages.filter((m) => m.author.kind === 'person').at(-1)!;
  const answers = read.thread.messages.filter((m) => m.author.kind === 'agent' && m.reply_to === sentReply.id);
  expect(answers).toHaveLength(1);
  // It answered with the first turn still in its session: Pi reopened the file.
  expect(answers[0]!.body).toMatch(/\(context [1-9]\d*\)/);

  // Delete: the process ends, the launch folder goes; the thread stays.
  const second = fake.starts()[1]!;
  await pane(page).locator('[data-thread-more]').click();
  await page.locator('[data-launch-item="delete"]').click();
  await p.locator('[data-launch-delete]').click();
  await waitFor('launch folder removed', () => !existsSync(join(world.dataDir, 'inbox', 'launch', launchId)));
  await waitFor('the process ended', () => fake.exits().some((exit) => exit.pid === second.pid));
  await expect(p.locator('[data-launched]')).toBeVisible();
  expect(world.errors).toEqual([]);
});

test('the Inbox stops: Pi stops with it; after the restart the line says so plainly, and a reply continues it', async ({ browser }) => {
  const { fake } = world;
  fake.configure({ workMs: 300 });
  const { threadId } = await launch(world.page, 'Check the sync conflict handling.');
  await expect(pane(world.page).locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
  const start = fake.starts().at(-1)!;
  const session = start.argv[3]!;
  await world.context.close();
  await stopScratchInbox(world.dataDir);
  await waitFor('Pi ended with the Inbox', () => fake.exits().some((exit) => exit.pid === start.pid));
  startInbox();
  await newPage(browser);
  const page = world.page;
  await page.goto(`${world.url}#thread=${threadId}`);
  const p = pane(page);
  await expect(p.locator('[data-run="stopped"]')).toHaveText(`Pi stopped. ${STOPPED_NOTE}`, { timeout: 90_000 });
  const startsBefore = fake.starts().length;
  await reply(page, 'And add a test for it.');
  await expect(p.locator('article.ib-message[data-author="agent"]')).toHaveCount(2, { timeout: 30_000 });
  expect(fake.starts()).toHaveLength(startsBefore + 1);
  expect(fake.starts().at(-1)!.argv.slice(0, 4)).toEqual(['--mode', 'rpc', '--session-id', session]);
});

test('an extension dialog over RPC: answered Cancel at once, and the thread says so', async () => {
  const { page, fake } = world;
  const title = 'Dangerous command:\n\n  rm -rf ./build\n\nAllow?';
  fake.configure({ dialog: { method: 'select', title, options: ['Yes', 'No'] } });
  try {
    const { threadId } = await launch(page, 'Clean the build folder.');
    const p = pane(page);
    // As the person reads it (the renderer curls the apostrophe; no backslash may show).
    const note = p.locator('article.ib-message[data-author="agent"]').filter({ hasText: 'Pi asked something the Inbox can' });
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(note).toContainText('(“Dangerous command: rm -rf ./build Allow?”); answered Cancel.');
    await expect(note).not.toContainText('\\');
    const asked = await waitFor('the dialog answered', () => fake.dialogs().find((d) => d.title === title));
    expect(asked.response).toMatchObject({ cancelled: true });
    // The turn went on with the cancel (the gate's "no"), and Pi answered.
    await expect(p.locator('article.ib-message[data-author="agent"]').filter({ hasText: '[dialog cancelled]' })).toBeVisible({ timeout: 30_000 });
    const read = await readThread(page, threadId);
    expect(read.thread.messages.filter((m) => m.body.startsWith('Pi asked something'))).toHaveLength(1);
  } finally {
    fake.configure({ dialog: null });
  }
});

// Live check: the provider refused the model and the thread said only "Delivered to Pi".
test('a turn that ends in a provider error: the thread shows Pi\'s own error in one note', async () => {
  const { page, fake } = world;
  const error = "Codex error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";
  fake.configure({ turnError: error, retries: 1 });
  try {
    const { threadId } = await launch(page, 'Summarize the open issues.');
    const p = pane(page);
    const note = p.locator('article.ib-message[data-author="agent"]').filter({ hasText: 'turn ended with an error: Codex error' });
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(note).toContainText('model is not supported when using Codex with a ChatGPT account.');
    await expect(p.locator('[data-run]')).toHaveCount(0, { timeout: 20_000 });
    const read = await readThread(page, threadId);
    const agents = read.thread.messages.filter((m) => m.author.kind === 'agent');
    expect(agents.map((m) => m.body)).toEqual([`Pi's turn ended with an error: ${error}`]);
    expect(agents[0]!.author).toMatchObject({ host: 'pi', name: 'Pi' });
  } finally {
    fake.configure({ turnError: null, retries: 0 });
  }
});

test('Stop, then Copy attach command: the Terminal\'s Pi takes the replies through this Inbox, and only once it quit does a reply start Pi here', async () => {
  const { page, fake } = world;
  fake.configure({ hold: true });
  let shell: ChildProcess | null = null;
  try {
    await launch(page, 'Profile the startup.');
    const p = pane(page);
    await expect(p.locator('[data-run="working"]')).toBeVisible({ timeout: 20_000 });
    const start = fake.starts().at(-1)!;
    const session = start.argv[3]!;
    const ours = () => fake.starts().filter((call) => call.argv[3] === session);
    // A running Pi has no attach command: Stop ends it, and Copy attach command comes.
    await p.locator('[data-thread-more]').click();
    await page.locator('[data-launch-item="stop"]').click();
    await expect(p.locator('[data-run="stopped"]')).toBeVisible({ timeout: 20_000 });
    await waitFor('the process ended', () => fake.exits().some((exit) => exit.pid === start.pid));
    fake.configure({ hold: false });
    await p.locator('[data-thread-more]').click();
    await page.locator('[data-launch-item="attach"]').click();
    await expect(page.getByText('the attach command')).toBeVisible();
    const command = await page.evaluate(() => navigator.clipboard.readText());
    expect(command.startsWith('/bin/sh -c ')).toBe(true);
    // What the person runs in Terminal, run here in their shell: the fake on PATH and none of the Inbox's env.
    shell = spawn('/bin/zsh', ['-f', '-c', command], { env: { PATH: `${world.bin}:/usr/bin:/bin`, HOME: world.home }, stdio: 'ignore' });
    const terminal = await waitFor('the Terminal\'s Pi', () => fake.terminals().at(-1));
    expect(terminal).toMatchObject({ argv: ['--session-id', session], cwd: world.project, dataDir: world.dataDir, inboxTool: '1' });
    // A reply goes to the Terminal's Pi: it answers, nothing starts here (no restart line meanwhile), and ⋯
    // offers no second Pi on the session.
    await reply(page, 'Now the cold start.');
    const answered = p.locator('article.ib-message[data-author="agent"]').filter({ hasText: 'Done: Now the cold start.' });
    for (const deadline = Date.now() + 30_000; (await answered.count()) === 0 && Date.now() < deadline; ) {
      await expect(p.locator('[data-run="failed"]')).toHaveCount(0);
      await expect(p.locator('[data-run="starting"]').filter({ hasText: 'again' })).toHaveCount(0);
      await page.waitForTimeout(250);
    }
    await expect(answered).toBeVisible();
    expect(ours()).toHaveLength(1);
    expect(await menuItems(page)).not.toContain('Copy attach command');
    // It quit in Terminal. Once the bridge lost it, a reply starts Pi here again on the same session.
    process.kill(terminal.pid, 'SIGTERM'); // inbox-guard: own child (the fake pi this spec's Terminal command ran)
    await expect(p.locator('[data-run="stopped"]')).toBeVisible({ timeout: 120_000 });
    await reply(page, 'And the warm start.');
    await expect(p.locator('article.ib-message[data-author="agent"]').filter({ hasText: 'Done: And the warm start.' })).toBeVisible({ timeout: 30_000 });
    expect(ours()).toHaveLength(2);
    expect(ours()[1]!.argv.slice(0, 4)).toEqual(['--mode', 'rpc', '--session-id', session]);
  } finally {
    fake.configure({ hold: false });
    shell?.kill();
  }
});

// The one state where Open in Terminal reaches a running Pi: this line offers no Stop, and a running Pi has no attach command.
test('a Pi that runs but never connected: Open in Terminal ends it only once the terminal shows, and the Terminal\'s Pi takes the message', async () => {
  const { page, fake } = world;
  fake.configure({ noConnect: true });
  let shell: ChildProcess | null = null;
  try {
    await launch(page, 'Trace the slow query.');
    const p = pane(page);
    await expect(p.locator('[data-run="failed"]')).toContainText('Started, but not connected', { timeout: 90_000 });
    const start = fake.starts().at(-1)!;
    const session = start.argv[3]!;
    expect(fake.alive(start.pid)).toBe(true);
    // The line's button; ⋯'s item on a branch without it.
    const onLine = p.locator('[data-run-open]');
    if ((await onLine.count()) > 0) await onLine.click();
    else {
      await p.locator('[data-thread-more]').click();
      await page.locator('[data-launch-item="open"]').click();
    }
    const ran = await waitFor('osascript', () => fake.osascript().at(-1));
    const command = ran.at(-1)!;
    expect(command.startsWith('/bin/sh -c ')).toBe(true);
    expect(command).toContain(`kill -0 ${start.pid}`);
    // Terminal has not run it yet: the Inbox's Pi still has the session.
    await page.waitForTimeout(1_000);
    expect(fake.alive(start.pid)).toBe(true);
    shell = spawn('/bin/zsh', ['-f', '-c', command], { env: { PATH: `${world.bin}:/usr/bin:/bin`, HOME: world.home }, stdio: 'ignore' });
    const ended = await waitFor('the Inbox\'s process ended', () => fake.exits().find((exit) => exit.pid === start.pid));
    expect(ended).toMatchObject({ why: 'stdin' });
    const terminal = await waitFor('the Terminal\'s Pi', () => fake.terminals().at(-1));
    expect(terminal).toMatchObject({ argv: ['--session-id', session], cwd: world.project, dataDir: world.dataDir, inboxTool: '1' });
    expect(terminal.at).toBeGreaterThanOrEqual(ended.at);
    await expect(p.locator('article.ib-message[data-author="agent"]').filter({ hasText: 'Done: Trace the slow query.' })).toBeVisible({ timeout: 30_000 });
    process.kill(terminal.pid, 'SIGTERM'); // inbox-guard: own child (the fake pi this spec's Terminal command ran)
  } finally {
    fake.configure({ noConnect: false });
    shell?.kill();
  }
});
