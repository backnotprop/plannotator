/**
 * Launch, PR 3 (.ops/work/launch-plan/PLAN.md "Scratch folders"): "New scratch
 * folder" in compose's folder menu, proved in a real browser against the
 * compiled binary and its real launch endpoint. As in inbox-launch-claude.spec.ts,
 * the only fakes are the programs launch runs (tests/helpers/fake-claude/), here
 * with Claude's folder trust on (`trustCheck`: `--bg` fails in a folder that
 * HOME's .claude.json does not trust, itself or above). Temp HOME and
 * PLANNOTATOR_DATA_DIR, PLANNOTATOR_INBOX_CONNECT=0, NO_BROWSER; the real Claude
 * Code, the real home and the person's Inbox are never touched.
 *
 *  1. Send to a new scratch folder: it is made under the root (default
 *     `<dataDir>/scratch`), named by the thread's name, `-2` on a clash; Claude
 *     Code starts there and the project appears.
 *  2. Delete removes the folder and runs `claude purge` for it only: the other
 *     scratch folder and its session stay. A deleted launch's path is never
 *     given again, and a second Delete of it (a stale window) does nothing, so
 *     a folder made there later is never purged or removed. A Send the Inbox
 *     refuses leaves no folder and no project behind.
 *  3. A moved root (Settings → Agents) is used for the next launch. It is not
 *     trusted yet, so the row reads "trust it once"; the start fails as
 *     untrusted, Open in Terminal runs `claude` in the root, and once the person
 *     trusted it, Try again starts it and the row reads plain again.
 *  4. Scratch folders are plain folders, never repositories, so the root's trust
 *     covers them. One the agent made a repository needs its own trust (Claude keys
 *     trust on a repository's root, and checks it before a restart): the reply's
 *     restart is refused, Open in Terminal runs `claude` in that folder, Try again.
 *  5. A link never lets a scratch folder leave the root: a link already at the
 *     name is skipped (`-2`), and a folder swapped for a link to a folder outside
 *     is neither purged nor removed by Delete.
 *  6. Delete acts on the folder the Inbox made, once, and never purges past it:
 *     another folder made at the same path is kept; a double-click Delete purges
 *     once and answers both alike; a folder made a linked git worktree (its
 *     `.git` a file, which Claude's purge maps to the main repository, dropping
 *     that project's own entry) is removed but never purged.
 *
 * Pictures: LAUNCH_PR3_SHOTS_DIR (default .local/proof/launch-pr3), wide light at 2x.
 * Build the binary first, then `bunx playwright test -c tests/e2e/playwright.config.ts inbox-launch-scratch.spec.ts`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { installFakeClaude, type FakeClaude } from '../helpers/fake-claude';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.LAUNCH_PR3_SHOTS_DIR ?? join(repo, '.local/proof/launch-pr3'));
const WIDE = { width: 1440, height: 900 };

interface World {
  root: string;
  home: string;
  dataDir: string;
  url: string;
  port: number;
  fake: FakeClaude;
  project: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
  /** Threads the tests launched: name → { thread, launch, folder }. */
  launched: Record<string, { threadId: string; launchId: string; folder: string }>;
}
let world: World;

function git(dir: string): string {
  mkdirSync(dir, { recursive: true });
  spawnSync('/usr/bin/git', ['init', '-q'], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: world.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return realpathSync(dir);
}

/** Claude Code's trust record (HOME's .claude.json), as the person accepting its trust prompt writes it. */
function trust(folders: string[]): void {
  const projects = Object.fromEntries(folders.map((f) => [f, { hasTrustDialogAccepted: true }]));
  writeFileSync(join(world.home, '.claude.json'), JSON.stringify({ projects }));
}

async function agentWrites(project: string, session: string, body: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${world.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { body, project_path: project, agent_session: session, agent_host: 'claude-code' } } }),
  });
  expect(response.status).toBe(200);
  await response.text();
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `${name}.png`) });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const dialog = (page: Page) => page.locator('dialog[data-compose]');
const pane = (page: Page) => page.locator('section.ib-pane');

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** New message → To → "Claude Code New session" → the folder menu, open. */
async function openFolderMenu(page: Page, words: string, threadName: string): Promise<void> {
  await page.goto(world.url);
  await page.locator('.ib-side [data-open-compose]').click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.getByRole('textbox', { name: 'Message' }).fill(words);
  await d.getByRole('textbox', { name: 'Thread name' }).fill(threadName);
  await d.locator('[data-compose-to]').click();
  await d.locator('[data-compose-start="claude-code"]').click();
  await d.locator('[data-compose-folder]').click();
  await expect(d.locator('[data-compose-folders]')).toBeVisible();
}

/** Pick "New scratch folder" in the open menu and Send. Returns what the Send answered. */
async function sendToScratch(page: Page): Promise<{ thread_id: string; launch: { id: string }; project: { name: string; root: string } }> {
  const d = dialog(page);
  await d.locator('[data-compose-folder-option="scratch"]').click();
  await expect(d.locator('[data-compose-folder]')).toHaveText('New scratch folder');
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/inbox/messages') && r.request().method() === 'POST');
  await d.locator('[data-compose-send]').click();
  const body = (await (await answer).json()) as { thread_id: string; launch: { id: string }; project: { name: string; root: string } };
  expect(body.launch?.id).toMatch(/^lch_/);
  await expect(d).toHaveCount(0);
  return body;
}

async function openThread(page: Page, threadId: string): Promise<void> {
  await page.goto(`${world.url}#thread=${threadId}`);
  await page.reload();
  await expect(pane(page).locator('[data-launched]')).toBeVisible();
}

async function deleteFromMenu(page: Page, threadId: string, shotName?: string): Promise<void> {
  await openThread(page, threadId);
  const p = pane(page);
  await p.locator('[data-thread-more]').click();
  await page.locator('[data-launch-item="delete"]').click();
  await expect(p.locator('[data-launch-confirm]')).toBeVisible();
  if (shotName) await shot(page, shotName);
  const answer = page.waitForResponse((r) => /\/api\/inbox\/launch\/lch_[^/]+\/delete$/.test(r.url()));
  await p.locator('[data-launch-delete]').click();
  expect((await answer).status()).toBe(200);
  await expect(p.locator('[data-launch-confirm]')).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  if (existsSync(shots)) for (const name of readdirSync(shots)) if (name.endsWith('.png')) rmSync(join(shots, name));
  const root = inboxScratch('plannotator-inbox-launch-scratch-e2e-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  for (const dir of [home, bin, dataDir]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const fake = installFakeClaude({ bin, state: join(root, 'fake-claude'), config: { trustCheck: true, workMs: 300 } });
  world = { root, home, dataDir, url: '', port: 0, fake, project: '', context: undefined as never, page: undefined as never, errors: [], launched: {} };
  markTourDecided(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxLaunch: { enabled: true, fullPermissions: false } }));
  // The default scratch root is trusted through a folder above it (the data dir), as a child inherits a trusted parent's trust.
  trust([dataDir]);
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
    PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number };
  world.url = started.stdout.trim();
  world.port = registry.port;
  await fetch(`http://127.0.0.1:${world.port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  // One project the Inbox knows (the folder menu lists it above the scratch row).
  // Not under ~/plannotator: on a case-insensitive disk that would be ~/Plannotator, the moved root's parent.
  world.project = git(join(home, 'code', 'plannotator'));
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

test('Send to a new scratch folder: made under the root, named by the thread, -2 on a clash; Claude Code starts there and the project appears', async () => {
  const { page, fake } = world;
  const scratchRoot = join(world.dataDir, 'scratch');
  await openFolderMenu(page, 'Make the Settings search fuzzy, like the command palette.', 'Settings search');
  const row = dialog(page).locator('[data-compose-folder-option="scratch"]');
  // Trusted through the data dir above it: the plain row, with the folder a Send would make.
  await expect(row).toContainText('New scratch folder');
  await expect(row).not.toContainText('trust it once');
  await expect(row).toContainText(`${scratchRoot}/settings-search`);
  const first = await sendToScratch(page);
  const folder = join(scratchRoot, 'settings-search');
  expect(first.project).toMatchObject({ root: folder, name: 'settings-search' });
  expect(lstatSync(folder).isDirectory()).toBe(true);
  // A plain folder, never a repository: Claude's trust of the root (or a folder above) covers it.
  expect(existsSync(join(folder, '.git'))).toBe(false);
  // Claude Code started in that folder, and its answer came back to the thread.
  const start = await waitFor('claude --bg', () => fake.starts().at(-1));
  expect(start.cwd).toBe(folder);
  await openThread(page, first.thread_id);
  await expect(pane(page).locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(pane(page).locator('[data-launched]')).toContainText('settings-search');
  // The project appears in the sidebar.
  await expect(page.locator('.ib-side').getByText('settings-search', { exact: true })).toBeVisible();
  world.launched.first = { threadId: first.thread_id, launchId: first.launch.id, folder };

  // The same name again: the folder is taken, so it gets -2.
  await openFolderMenu(page, 'Try the other scorer in a second folder.', 'Settings search');
  const second = await sendToScratch(page);
  expect(second.project.root).toBe(`${folder}-2`);
  expect(lstatSync(`${folder}-2`).isDirectory()).toBe(true);
  await waitFor('the second session', () => fake.agents().some((a) => a.cwd === `${folder}-2`));
  world.launched.second = { threadId: second.thread_id, launchId: second.launch.id, folder: `${folder}-2` };
  expect(world.errors).toEqual([]);
});

test('Delete removes the scratch folder and runs claude purge for it only', async () => {
  const { page, fake } = world;
  const { first, second } = world.launched;
  await waitFor('the first session listed', () => fake.agents().some((a) => a.cwd === first!.folder));
  await deleteFromMenu(page, first!.threadId, 'delete-confirm-scratch');
  await waitFor('the folder removed', () => !existsSync(first!.folder));
  const purges = fake.calls().filter((c) => c.argv[0] === 'purge');
  // A dry run first: purge runs only when its plan names this folder alone.
  expect(purges.map((c) => c.argv)).toEqual([
    ['purge', '--dry-run', first!.folder],
    ['purge', '--yes', first!.folder],
  ]);
  expect(existsSync(join(world.dataDir, 'inbox', 'launch', first!.launchId))).toBe(false);
  // The other scratch folder and its session stay; the thread stays too.
  expect(lstatSync(second!.folder).isDirectory()).toBe(true);
  expect(fake.agents().some((a) => a.cwd === second!.folder)).toBe(true);
  await expect(pane(page).locator('[data-launched]')).toBeVisible();

  // The same name once more: the deleted launch's path is never given again (one path, one launch), so it is -3.
  await openFolderMenu(page, 'Once more, in a third folder.', 'Settings search');
  const third = await sendToScratch(page);
  const thirdFolder = `${first!.folder}-3`;
  expect(third.project.root).toBe(thirdFolder);
  await waitFor('the third session', () => fake.agents().some((a) => a.cwd === thirdFolder));
  // A folder made at the first's path later, then a second Delete of the first (a stale window): nothing is
  // stopped, purged or removed, and the other launches keep their folders and sessions.
  mkdirSync(first!.folder);
  writeFileSync(join(first!.folder, 'keep.txt'), 'made later');
  const callsBefore = fake.calls().length;
  const again = await page.evaluate(async (id) => {
    const response = await fetch(new URL(`/api/inbox/launch/${id}/delete`, location.href), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return { status: response.status, body: await response.json() };
  }, first!.launchId);
  expect(again).toEqual({ status: 200, body: { ok: true } });
  expect(fake.calls()).toHaveLength(callsBefore);
  expect(readdirSync(first!.folder)).toEqual(['keep.txt']);
  for (const folder of [second!.folder, thirdFolder]) {
    expect(lstatSync(folder).isDirectory()).toBe(true);
    expect(fake.agents().some((a) => a.cwd === folder)).toBe(true);
  }
  rmSync(first!.folder, { recursive: true });

  // A Send the Inbox refuses after the folder was made (a thread name too long): no folder and no project stay.
  const refused = await page.evaluate(async () => {
    const response = await fetch(new URL('/api/inbox/messages', location.href), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'scratch-too-long', body: 'A name too long.', thread_name: 'x'.repeat(5000), to: { launch: { agent: 'claude-code', scratch: true } } }),
    });
    return response.status;
  });
  expect(refused).toBe(422);
  expect(readdirSync(join(world.dataDir, 'scratch')).filter((name) => name.startsWith('xxx'))).toEqual([]);
  const sessions = (await page.evaluate(async () => (await fetch(new URL('/api/inbox/sessions', location.href))).json())) as { launch: { projects: { root: string }[] } };
  expect(sessions.launch.projects.filter((p) => p.root.includes('xxxxxxxx'))).toEqual([]);

  // Then the second and the third: each its own folder, purged once; the folder menu offers no removed folder again.
  await deleteFromMenu(page, second!.threadId);
  await waitFor('the second folder removed', () => !existsSync(second!.folder));
  await deleteFromMenu(page, third.thread_id);
  await waitFor('the third folder removed', () => !existsSync(thirdFolder));
  expect(fake.calls().filter((c) => c.argv[0] === 'purge' && c.argv[1] === '--yes').map((c) => c.argv)).toEqual([
    ['purge', '--yes', first!.folder],
    ['purge', '--yes', second!.folder],
    ['purge', '--yes', thirdFolder],
  ]);
  await openFolderMenu(page, 'Anything.', 'Anything');
  await expect(dialog(page).locator('[data-compose-folder-option]')).toHaveCount(2);
  await expect(dialog(page).locator('[data-compose-folders]')).not.toContainText('settings-search');
  await page.keyboard.press('Escape');
});

test('a moved root is used for the next launch; untrusted, the row reads "trust it once" and Open in Terminal trusts the root', async () => {
  const { page, fake } = world;
  const moved = join(world.home, 'Plannotator', 'scratch');
  // Settings → Agents: Scratch folders → Change → ~/Plannotator/scratch → Save.
  await page.goto(`${world.url}#settings/agents`);
  await page.reload();
  const settingsRow = page.locator('[data-launch-scratch-row]');
  await expect(settingsRow.locator('[data-launch-scratch-dir]')).toHaveText(join(world.dataDir, 'scratch'));
  await settingsRow.locator('[data-launch-scratch-change]').click();
  await settingsRow.locator('[data-launch-scratch-input]').fill('~/Plannotator/scratch');
  await settingsRow.locator('[data-launch-scratch-save]').click();
  await expect(settingsRow.locator('[data-launch-scratch-dir]')).toHaveText('~/Plannotator/scratch');
  expect((JSON.parse(readFileSync(join(world.dataDir, 'config.json'), 'utf8')) as { inboxLaunch: { scratchDir?: string } }).inboxLaunch.scratchDir).toBe(moved);
  await settingsRow.scrollIntoViewIfNeeded();
  await shot(page, 'settings-scratch-folders');

  // Not trusted yet (only the data dir is): the row says so.
  await openFolderMenu(page, 'Sketch the onboarding checklist as a small prototype.', 'Onboarding checklist');
  const row = dialog(page).locator('[data-compose-folder-option="scratch"]');
  await expect(row).toHaveAttribute('data-untrusted', '');
  await expect(row).toContainText('New scratch folder · trust it once');
  // It names the root (the folder to trust), and says under it what the first start asks.
  await expect(row).toContainText('~/Plannotator/scratch');
  await expect(row).not.toContainText('onboarding-checklist');
  await expect(dialog(page).locator('[data-compose-scratch-hint]')).toHaveText(
    "Claude Code doesn't trust ~/Plannotator/scratch yet. Your first Send asks you to open it in Terminal once; after that every scratch folder there starts.",
  );
  await row.hover();
  await shot(page, 'trust-once-row');
  const sent = await sendToScratch(page);
  const folder = join(moved, 'onboarding-checklist');
  expect(sent.project.root).toBe(folder);
  expect(existsSync(join(world.dataDir, 'scratch', 'onboarding-checklist'))).toBe(false);

  // The start fails as untrusted, naming the root; Open in Terminal runs claude there, so one trust covers every scratch folder.
  await openThread(page, sent.thread_id);
  const line = pane(page).locator('[data-run="failed"]');
  await expect(line).toContainText("~/Plannotator/scratch isn't a trusted folder yet. Open it once in Terminal and accept Claude Code's trust prompt, then try again.");
  const opened = fake.osascript().length;
  await line.locator('[data-run-open]').click();
  const ran = await waitFor('osascript', () => fake.osascript()[opened]);
  expect(ran.at(-1)).toBe(`cd '${moved}' && claude`);
  // The person accepts the trust prompt in Terminal; Try again starts it in the scratch folder.
  trust([world.dataDir, moved]);
  await line.locator('[data-run-retry]').click();
  await expect(pane(page).locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
  expect(fake.starts().at(-1)!.cwd).toBe(folder);
  world.launched.moved = { threadId: sent.thread_id, launchId: sent.launch.id, folder };

  // Trusted now: the row reads plain (screen 03 with scratch).
  await openFolderMenu(page, 'Make the Settings search fuzzy, like the command palette.', 'Settings search');
  const plain = dialog(page).locator('[data-compose-folder-option="scratch"]');
  await expect(plain).not.toHaveAttribute('data-untrusted', '');
  await expect(plain).toHaveText(/New scratch folder~\/Plannotator\/scratch\/settings-search/);
  await plain.hover();
  await shot(page, '03-new-session-where-scratch');
  await page.keyboard.press('Escape');
  expect(world.errors).toEqual([]);
});

test('a scratch folder the agent made its own git repository needs its own trust: the restart is refused, Open in Terminal runs claude in that folder, and Try again restarts it', async () => {
  const { page, fake } = world;
  const { moved } = world.launched;
  await openThread(page, moved!.threadId);
  const p = pane(page);
  // Stop it, then the agent's folder becomes a repository (as `git init` there would): Claude keys its trust on
  // that root now, and the scratch root's trust no longer covers it.
  await p.locator('[data-thread-more]').click();
  await page.locator('[data-launch-item="stop"]').click();
  await expect(p.locator('[data-run="stopped"]')).toBeVisible();
  git(moved!.folder);
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await p.getByRole('textbox', { name: /^Reply to Claude Code/ }).fill('Add a README to the prototype.');
  await p.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  const line = p.locator('[data-run="failed"]');
  await expect(line).toContainText("~/Plannotator/scratch/onboarding-checklist isn't a trusted folder yet.", { timeout: 30_000 });
  const opened = fake.osascript().length;
  await line.locator('[data-run-open]').click();
  const ran = await waitFor('osascript', () => fake.osascript()[opened]);
  expect(ran.at(-1)).toBe(`cd '${moved!.folder}' && claude`);
  trust([world.dataDir, join(world.home, 'Plannotator', 'scratch'), moved!.folder]);
  await line.locator('[data-run-retry]').click();
  await expect(p.locator('article.ib-message[data-author="agent"]')).toHaveCount(2, { timeout: 30_000 });
  expect(fake.calls().filter((c) => c.argv[0] === 'respawn')).toHaveLength(2);
  expect(world.errors).toEqual([]);
});

test('a link never takes a scratch folder out of the root: one at the name is skipped, and Delete leaves a folder swapped for a link alone', async () => {
  const { page, fake } = world;
  const moved = join(world.home, 'Plannotator', 'scratch');
  const outside = join(world.root, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'keep.txt'), 'not the Inbox’s');
  // A link already at the name the thread would take: never followed, the folder is -2.
  symlinkSync(outside, join(moved, 'release-notes'));
  await openFolderMenu(page, 'Draft the release notes for 0.26.', 'Release notes');
  const sent = await sendToScratch(page);
  expect(sent.project.root).toBe(join(moved, 'release-notes-2'));
  expect(readdirSync(outside)).toEqual(['keep.txt']);
  const folder = sent.project.root;
  await waitFor('the session in -2', () => fake.agents().some((a) => a.cwd === folder));

  // Its folder is swapped for a link to a folder outside the root: Delete removes the session but never purges or removes there.
  renameSync(folder, `${folder}.moved`);
  symlinkSync(outside, folder);
  const before = fake.calls().filter((c) => c.argv[0] === 'purge').length;
  // The route answers after stop and rm.
  await deleteFromMenu(page, sent.thread_id);
  // The toast says the folder was kept.
  await expect(page.getByText('its scratch folder was kept')).toBeVisible();
  expect(fake.calls().filter((c) => c.argv[0] === 'purge')).toHaveLength(before);
  expect(lstatSync(folder).isSymbolicLink()).toBe(true);
  expect(readdirSync(outside)).toEqual(['keep.txt']);
  expect(fake.agents().some((a) => a.cwd === folder)).toBe(false);
  expect(world.errors).toEqual([]);
});

test('Delete acts on the folder the Inbox made, once, and never purges past it: another folder at the path, a double click, a linked worktree', async () => {
  const { page, fake } = world;
  const purges = () => fake.calls().filter((c) => c.argv[0] === 'purge').map((c) => c.argv);
  const launch = async (words: string, name: string) => {
    await openFolderMenu(page, words, name);
    const sent = await sendToScratch(page);
    const folder = sent.project.root;
    // Started and answered (so the start is done, and Delete does the folder's part itself).
    await openThread(page, sent.thread_id);
    await expect(pane(page).locator('article.ib-message[data-author="agent"]')).toHaveCount(1, { timeout: 30_000 });
    return { ...sent, folder };
  };

  // Another folder at the same path (the first removed by hand, a new one made there): kept, never purged.
  const swapped = await launch('Check the inode guard.', 'Inode check');
  rmSync(swapped.folder, { recursive: true });
  mkdirSync(swapped.folder);
  writeFileSync(join(swapped.folder, 'keep.txt'), 'another folder');
  let before = purges().length;
  await deleteFromMenu(page, swapped.thread_id);
  await expect(page.getByText('its scratch folder was kept')).toBeVisible();
  expect(purges()).toHaveLength(before);
  expect(readdirSync(swapped.folder)).toEqual(['keep.txt']);
  expect(fake.agents().some((a) => a.cwd === swapped.folder)).toBe(false);

  // A double click: both Deletes answer alike, and the folder is purged and removed once.
  const twice = await launch('Delete me twice at once.', 'Double click');
  before = purges().length;
  const answers = await page.evaluate(async (id) => {
    const remove = async () => {
      const response = await fetch(new URL(`/api/inbox/launch/${id}/delete`, location.href), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return { status: response.status, body: await response.json() };
    };
    return Promise.all([remove(), remove()]);
  }, twice.launch.id);
  expect(answers).toEqual([
    { status: 200, body: { ok: true, scratch_removed: true } },
    { status: 200, body: { ok: true, scratch_removed: true } },
  ]);
  expect(purges().slice(before)).toEqual([
    ['purge', '--dry-run', twice.folder],
    ['purge', '--yes', twice.folder],
  ]);
  expect(existsSync(twice.folder)).toBe(false);

  // The agent made its folder a linked worktree of a project (`git worktree add` writes a `.git` file): Claude's purge
  // would drop that project's entry, so it is never purged; the folder itself goes as Delete says.
  const main = git(join(world.home, 'code', 'app'));
  const worktree = await launch('Work in a worktree of the app.', 'Worktree notes');
  writeFileSync(join(worktree.folder, '.git'), `gitdir: ${main}/.git/worktrees/worktree-notes\n`);
  before = purges().length;
  await deleteFromMenu(page, worktree.thread_id);
  await waitFor('the worktree folder removed', () => !existsSync(worktree.folder));
  expect(purges()).toHaveLength(before);
  expect(existsSync(join(main, '.git'))).toBe(true);
  expect(fake.agents().some((a) => a.cwd === worktree.folder)).toBe(false);
  expect(world.errors).toEqual([]);
});
