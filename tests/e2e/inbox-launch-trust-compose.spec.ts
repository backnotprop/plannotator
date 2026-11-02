/**
 * Trust and start in New message (approval "inbox-launch-trust-compose"; docs/agent-guides/inbox-launch.md, "Trusting a
 * folder"), pressed through in a real browser against the compiled binary. The only fake is the program launch runs:
 * tests/helpers/fake-claude/ with Claude's folder trust on, so `--bg` refuses until the key is in
 * `$CLAUDE_CONFIG_DIR/.claude.json` and nothing passes by accident. Temp HOME, CLAUDE_CONFIG_DIR and
 * PLANNOTATOR_DATA_DIR, PLANNOTATOR_INBOX_CONNECT=0, NO_BROWSER; the real Claude Code, the real `~/.claude.json` and the
 * person's Inbox are never touched.
 *
 *  1. A linked worktree with everything: warning circle, details, one press trusts the main checkout and starts once.
 *  2. A clean folder: the button and no circle. Only the whole repository: a quiet circle. Trusted: plain Send.
 *  3. Home: no offer.
 *  4. The folder changed: nothing saved or sent, the details open on what changed, the next press works.
 *  5. A config that isn't JSON: nothing sent, the words stay, it works once fixed.
 *  6. Cmd+Enter does what the button does; Escape closes the details and keeps the words.
 *  7. A phone at 390 and 320 wide: bottom bar, 44 x 44 circle, the bottom sheet, the press.
 *  8. An agent's bare call is refused on the real binary.
 *
 * Pictures: LAUNCH_TRUST_COMPOSE_SHOTS_DIR (default .local/proof/launch-trust-compose), the approved pictures' names.
 * Build the binary first, then `bunx playwright test -c tests/e2e/playwright.config.ts inbox-launch-trust-compose.spec.ts`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { refuseRealClaudeConfig } from '../helpers/real-data-dir';
import { markTourDecided } from '../helpers/tour-decided';
import { installFakeClaude, type FakeClaude } from '../helpers/fake-claude';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.LAUNCH_TRUST_COMPOSE_SHOTS_DIR ?? join(repo, '.local/proof/launch-trust-compose'));

const CIRCLE = '[data-compose-trust-circle]';
const DETAILS = '[data-compose-trust-ask]';
const SEND = '[data-compose-send]';
const GIT_ENV = (home: string) => ({ PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const CONFIG_TEXT = '{\n  "numStartups": 41,\n  "oauthAccount": {"emailAddress": "person@example.com"},\n  "tipsShown": 1.50\n}\n';

interface World {
  home: string;
  config: string;
  url: string;
  port: number;
  fake: FakeClaude;
  context: BrowserContext;
  page: Page;
  errors: string[];
  /** The circle's computed color on a folder with warnings. */
  warmCircle: string;
}
let world: World;

function git(cwd: string, ...args: string[]): void {
  const done = spawnSync('/usr/bin/git', args, { cwd, env: GIT_ENV(world.home), encoding: 'utf8' });
  expect(done.status, done.stderr).toBe(0);
}

/** A repository with a commit, under `code/<name>`, holding `files`. */
function repository(name: string, files: Record<string, unknown> = {}): string {
  const dir = join(world.home, 'code', name);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  git(dir, 'init', '-q');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first');
  for (const [file, value] of Object.entries(files)) writeFileSync(join(dir, file), typeof value === 'string' ? value : JSON.stringify(value));
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

/**
 * A project of its own that is a linked worktree of `main`: a new worktree folds into its repository's project, so,
 * as one kept from before worktrees folded, the project is made while the folder is plain and the worktree comes after.
 */
async function worktreeProject(main: string, name: string): Promise<string> {
  const dir = join(world.home, 'code', name);
  mkdirSync(dir, { recursive: true });
  await agentWrites(dir, `ses-${name}`, 'Ready.');
  git(main, 'worktree', 'add', '-q', dir, '-b', name);
  mkdirSync(join(dir, '.claude'));
  return realpathSync(dir);
}

const dialog = (page: Page) => page.locator('dialog[data-compose]');
const pane = (page: Page) => page.locator('section.ib-pane');
const projects = () => (JSON.parse(readFileSync(world.config, 'utf8')) as { projects?: Record<string, unknown> }).projects ?? {};
const startsIn = (folder: string) => world.fake.starts().filter((s) => s.cwd === folder);

async function shot(page: Page, name: string, scale?: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `${scale ? `${name}-${scale}` : name}.png`) });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** New message to a new Claude Code session in `name`, the words written. */
async function compose(page: Page, name: string, words: string, threadName: string, open = '.ib-side [data-open-compose]'): Promise<void> {
  await page.goto(world.url);
  await page.locator(open).click();
  const d = dialog(page);
  await d.getByRole('textbox', { name: 'Message' }).fill(words);
  await d.getByRole('textbox', { name: 'Thread name' }).fill(threadName);
  await d.locator('[data-compose-to]').click();
  await d.locator('[data-compose-start="claude-code"]').click();
  await d.locator('[data-compose-folder]').click();
  await d.locator('[data-compose-folders] [role="option"]').filter({ hasText: name }).first().click({ timeout: 10_000 });
}

const sendAnswer = (page: Page) => page.waitForResponse((r) => r.url().endsWith('/api/inbox/messages') && r.request().method() === 'POST', { timeout: 15_000 });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  if (existsSync(shots)) for (const name of readdirSync(shots)) if (name.endsWith('.png')) rmSync(join(shots, name));
  const root = inboxScratch('plannotator-inbox-trust-compose-e2e-');
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  const configDir = refuseRealClaudeConfig(join(root, 'claude-config'), 'inbox-launch-trust-compose.spec');
  for (const dir of [join(root, 'home'), bin, dataDir, configDir]) mkdirSync(dir, { recursive: true });
  const home = realpathSync(join(root, 'home'));
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const config = join(configDir, '.claude.json');
  writeFileSync(config, CONFIG_TEXT);
  const fake = installFakeClaude({ bin, state: join(root, 'fake-claude'), config: { trustCheck: true, workMs: 300 } });
  world = { home, config, url: '', port: 0, fake, context: undefined as never, page: undefined as never, errors: [], warmCircle: '' };
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

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
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

test('a linked worktree with everything: the warning circle, the details, and one press trusts the main checkout and starts once', async () => {
  const { page, fake } = world;
  const hook = { hooks: [{ type: 'command', command: 'echo hi' }] };
  const main = repository('billing-platform');
  const linked = await worktreeProject(main, 'billing-worktree');
  writeFileSync(
    join(linked, '.claude/settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [hook, hook], Stop: [hook, hook] }, apiKeyHelper: './key.sh', env: { STAGE: 'dev' }, permissions: { allow: ['Bash(ls)'], additionalDirectories: ['/elsewhere'] } }),
  );
  writeFileSync(join(linked, '.mcp.json'), JSON.stringify({ mcpServers: { billing: { command: 'node' }, ledger: { command: 'node' } } }));
  writeFileSync(join(linked, '.claude/settings.local.json'), 'not json');

  await compose(page, 'billing-worktree', 'Add the refund report to the billing dashboard.', 'Refund report');
  const d = dialog(page);
  const button = d.locator(SEND);
  await expect(button).toContainText('Trust and start');
  const circle = d.locator(CIRCLE);
  await expect(circle).toHaveAccessibleName('What trusting this folder means');
  await expect(circle).toHaveAttribute('data-warning', '');
  await expect(d.locator('[data-compose-status]')).toHaveCount(0);
  const warm = await circle.evaluate((el) => getComputedStyle(el).color);
  await shot(page, 'd-rest-warning');

  await circle.click();
  const details = d.locator(DETAILS);
  await expect(details.locator('h5')).toHaveText('Trust ~/code/billing-platform?');
  await expect(details.locator('p span')).toHaveText([
    'Whole repository, not just billing-worktree',
    'Runs 4 hooks, 2 MCP servers, 1 helper command, env settings',
    'Uses tools without asking, reaches outside folders',
    "1 file couldn't be read",
  ]);
  await expect(details.locator('button')).toHaveCount(0);
  await shot(page, 'd-open');
  await circle.click();
  await expect(details).toHaveCount(0);

  await circle.click();
  await expect(details).toBeVisible();
  await d.locator('.ib-cp-body').click({ position: { x: 20, y: 20 } });
  await expect(details).toHaveCount(0);

  expect(projects()).toEqual({});
  const answer = sendAnswer(page);
  await button.click();
  const sent = (await (await answer).json()) as { thread_id: string };
  await expect(d).toHaveCount(0);
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  await page.reload();
  await expect(pane(page).locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });

  // The key is the main checkout's, the folder the details named; the rest of the file is byte for byte what it was.
  expect(projects()).toEqual({ [main]: { hasTrustDialogAccepted: true } });
  const saved = readFileSync(world.config, 'utf8');
  expect(saved).toContain('"oauthAccount": {"emailAddress": "person@example.com"}');
  expect(saved).toContain('"tipsShown": 1.50');
  expect(startsIn(linked)).toHaveLength(1);
  expect(fake.agents().filter((a) => a.cwd === linked)).toHaveLength(1);
  world.warmCircle = warm;
  expect(world.errors).toEqual([]);
});

test('a clean folder: the button and no circle. Only the whole repository: a quiet circle. Trusted: plain Send', async () => {
  const { page } = world;
  const notes = repository('notes');
  await agentWrites(notes, 'ses-notes', 'The notes are sorted.');
  await compose(page, 'notes', 'Sort the notes by date.', 'Sort notes');
  const d = dialog(page);
  await expect(d.locator(SEND)).toContainText('Trust and start');
  await expect(d.locator(CIRCLE)).toHaveCount(0);

  // billing-platform's folder is trusted now; a new repository's linked worktree brings nothing else.
  const atlas = repository('atlas');
  await worktreeProject(atlas, 'atlas-maps');
  await compose(page, 'atlas-maps', 'Label the maps.', 'Label maps');
  const quiet = dialog(page).locator(CIRCLE);
  await expect(quiet).toBeVisible();
  await expect(quiet).not.toHaveAttribute('data-warning', '');
  expect(await quiet.evaluate((el) => getComputedStyle(el).color)).not.toBe(world.warmCircle);
  await quiet.click();
  await expect(dialog(page).locator(`${DETAILS} p span`)).toHaveText(['Whole repository, not just atlas-maps']);
  await expect(dialog(page).locator(`${DETAILS} h5`)).toHaveText(`Trust ~/code/${basename(atlas)}?`);

  await compose(page, 'billing-worktree', 'Write the release note.', 'Release note');
  await expect(dialog(page).locator(SEND)).toContainText('Send');
  await expect(dialog(page).locator(SEND)).not.toContainText('Trust');
  await expect(dialog(page).locator(CIRCLE)).toHaveCount(0);
  await shot(page, 'd-trusted');
});

test('home: no offer, whatever it holds', async () => {
  const { page, home } = world;
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: { one: { command: 'node' } } }));
  await agentWrites(home, 'ses-home', 'A note from home.');
  await compose(page, basename(home), 'Look around.', 'Look around');
  await expect(dialog(page).locator(SEND)).toContainText('Send');
  await expect(dialog(page).locator(SEND)).not.toContainText('Trust');
  await expect(dialog(page).locator(CIRCLE)).toHaveCount(0);
  // Every folder below reads a `.mcp.json` above it.
  rmSync(join(home, '.mcp.json'));
});

test('the folder changed after its reading: nothing is saved or sent, the details open on what changed, and the next press works', async () => {
  const { page } = world;
  const folder = repository('orchard');
  await agentWrites(folder, 'ses-orchard', 'The orchard map is drawn.');
  await compose(page, 'orchard', 'Map the apple rows.', 'Apple rows');
  const d = dialog(page);
  await expect(d.locator(SEND)).toContainText('Trust and start');
  await expect(d.locator(CIRCLE)).toHaveCount(0);
  writeFileSync(join(folder, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo pulled' }] }] } }));
  const refused = sendAnswer(page);
  await d.locator(SEND).click();
  expect((await refused).status()).toBe(409);
  await expect(d.locator(`${DETAILS} p span`)).toHaveText(['Runs 1 hook']);
  await expect(d.locator(`${DETAILS} [data-compose-error]`)).toContainText('This folder changed.');
  await expect(d.locator(CIRCLE)).toHaveAttribute('data-warning', '');
  await shot(page, 'changed-folder');
  expect(projects()[folder]).toBeUndefined();
  expect(startsIn(folder)).toHaveLength(0);
  await expect(d.getByRole('textbox', { name: 'Message' })).toHaveValue('Map the apple rows.');

  await page.waitForTimeout(700);
  // A real press: the pointer goes down, the details close on it, and the button has not moved when it comes up.
  const answer = sendAnswer(page);
  await d.locator(SEND).click();
  expect((await answer).status()).toBe(200);
  await expect(d).toHaveCount(0);
  expect(projects()[folder]).toEqual({ hasTrustDialogAccepted: true });
  expect(world.errors).toEqual([]);
});

test('a config that is not JSON: nothing is sent, the words stay, and it works once fixed', async () => {
  const { page } = world;
  const folder = repository('recipes');
  await agentWrites(folder, 'ses-recipes', 'The recipes are in order.');
  await compose(page, 'recipes', 'Group the recipes by season.', 'Group recipes');
  const d = dialog(page);
  await expect(d.locator(SEND)).toContainText('Trust and start');
  const good = readFileSync(world.config, 'utf8');
  const bad = '{ "oauthAccount": ';
  writeFileSync(world.config, bad);
  const refused = sendAnswer(page);
  await d.locator(SEND).click();
  await refused;
  await expect(d.locator('[data-compose-error]')).toContainText('it is not plain JSON. Nothing was changed.');
  await expect(d.getByRole('textbox', { name: 'Message' })).toHaveValue('Group the recipes by season.');
  expect(readFileSync(world.config, 'utf8')).toBe(bad);
  expect(startsIn(folder)).toHaveLength(0);

  writeFileSync(world.config, good);
  const answer = sendAnswer(page);
  await d.locator(SEND).click();
  expect((await answer).status()).toBe(200);
  await expect(d).toHaveCount(0);
  expect(projects()[folder]).toEqual({ hasTrustDialogAccepted: true });
});

test('Escape closes the details and keeps the words; Cmd+Enter does what the button does, warnings included', async () => {
  const { page } = world;
  const folder = repository('garden', { '.mcp.json': { mcpServers: { soil: { command: 'node' } } } });
  await agentWrites(folder, 'ses-garden', 'The garden plan is ready.');
  await compose(page, 'garden', 'Plan the spring beds.', 'Spring beds');
  const d = dialog(page);
  await d.locator(CIRCLE).click();
  await expect(d.locator(DETAILS)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(d.locator(DETAILS)).toHaveCount(0);
  await expect(d).toBeVisible();
  await expect(d.locator('[data-compose-question]')).toHaveCount(0);
  await expect(d.getByRole('textbox', { name: 'Message' })).toHaveValue('Plan the spring beds.');

  await d.getByRole('textbox', { name: 'Message' }).focus();
  const answer = sendAnswer(page);
  await page.keyboard.press('ControlOrMeta+Enter');
  expect((await answer).status()).toBe(200);
  await expect(d).toHaveCount(0);
  expect(projects()[folder]).toEqual({ hasTrustDialogAccepted: true });
  await expect.poll(() => startsIn(folder).length, { timeout: 30_000 }).toBe(1);
});

for (const width of [390, 320]) {
  test(`a phone, ${width} wide: the button and a 44 x 44 circle in the bottom bar, Cancel and the title on top, the details in the bottom sheet`, async ({ browser }) => {
    const name = `phone-${width}`;
    const folder = repository(name, { '.mcp.json': { mcpServers: { soil: { command: 'node' }, seed: { command: 'node' } } }, '.claude/settings.json': { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } } });
    await agentWrites(folder, `ses-${name}`, 'The plan is ready.');
    const phone = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
    const page = await phone.newPage();
    try {
      await compose(page, name, 'Plan the spring beds.', 'Spring beds', '.ib-lhead [data-open-compose]');
      const d = dialog(page);
      await expect(d.locator(`.ib-cp-foot ${SEND}`)).toHaveText('Trust and start');
      await expect(d.locator(`.ib-cp-bar ${SEND}`)).toHaveCount(0);
      await expect(d.locator('.ib-cp-bar [data-compose-cancel]')).toBeVisible();
      await expect(d.locator('.ib-cp-bar h2')).toHaveText('New message');
      const circle = d.locator(`.ib-cp-foot ${CIRCLE}`);
      const box = (await circle.boundingBox())!;
      expect([box.width, box.height]).toEqual([44, 44]);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      const title = (await d.locator('.ib-cp-bar h2').boundingBox())!;
      expect(Math.abs(title.x + title.width / 2 - width / 2)).toBeLessThan(2);
      const overflow = await d.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await shot(page, 'd-phone', width === 390 ? undefined : `${width}`);

      await circle.tap();
      const details = d.locator(DETAILS);
      await expect(details.locator('h5')).toHaveText(`Trust ~/code/${name}?`);
      const sheet = (await details.boundingBox())!;
      expect(sheet.x).toBe(0);
      expect(sheet.width).toBe(width);
      expect(Math.round(sheet.y + sheet.height)).toBe(844);
      await shot(page, 'd-phone-open', width === 390 ? undefined : `${width}`);
      await page.keyboard.press('Escape');
      await expect(details).toHaveCount(0);

      const answer = sendAnswer(page);
      await d.locator(SEND).tap();
      expect((await answer).status()).toBe(200);
      await expect.poll(() => projects()[folder]).toEqual({ hasTrustDialogAccepted: true });
    } finally {
      await phone.close();
    }
  });
}

test('an agent on this computer cannot press it: a bare call with no window is refused, and nothing is trusted', async () => {
  const folder = repository('ledger', { '.mcp.json': { mcpServers: { one: { command: 'node' } } } });
  await agentWrites(folder, 'ses-ledger', 'The ledger is closed.');
  const base = `http://127.0.0.1:${world.port}/api/inbox`;
  const { launch } = (await (await fetch(`${base}/sessions`)).json()) as { launch: { projects: { id: string; name: string }[] } };
  const project = launch.projects.find((p) => p.name === 'ledger')!;
  const to = { launch: { agent: 'claude-code', project_id: project.id, trust: { folder, facts: ['Runs 1 MCP server'] } } };
  const refused = await fetch(`${base}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, body: 'Trust this for me.', idempotency_key: crypto.randomUUID() }) });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { code: string }).code).toBe('window_only');
  expect(projects()[folder]).toBeUndefined();
  expect(startsIn(folder)).toHaveLength(0);
});
