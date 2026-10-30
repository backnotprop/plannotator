/**
 * The Files viewer beside a thread (approval "inbox-files-tabs", round 3,
 * Tabs in the title row), proved in a real browser against the compiled
 * binary under a temp data dir. An agent sends two messages from a git
 * project; after the first, a file is committed (A) and one edited (M).
 *
 * - The thread header's folder button opens the pane on the Artifacts tab,
 *   with the files panel: the project is listed like VS Code (no .git,
 *   ignored folders dimmed, a folder opened later dims its rows too, .env
 *   locked). A locked row never asks the server for its contents.
 * - Tabs are always tabs (amendment 2026-10-30): one file open shows the tab
 *   row and, under it, the file's tools in their own bar with the path, as
 *   with two. Counts once: no number on the Artifacts tab, the open-tabs menu
 *   a plain ⌄. Closing a tab shows its right neighbour, else its left, else
 *   Artifacts.
 * - The folder button is the pane's toggle: closed, it carries the thread's
 *   file count beside the header's icons and the thread's × shows; open, it
 *   sits lit (pressed, expanded, "Hide files") where the × was, without the
 *   count, and the × is gone. The folder or the pane's own × closes the pane,
 *   and the thread's × comes back, focus on the folder.
 * - The panel is the same on every tab: a folder opened beside a file is
 *   still open on Artifacts.
 * - The changes toggle: no M/A marks while off; on, totals.ts reads M.
 * - The tree's keys stay in the tree: ArrowDown moves in it, and j, k and /
 *   change nothing outside it.
 * - Full screen stays as it was: no tab row.
 * - Beside the thread the header's line stays ("from <agent> in <project>",
 *   "in <project>" for a file of the folder); Escape beside the thread does
 *   not close a file (as before tabs: an open file owns Escape), and on an
 *   HTML page in Annotate it leaves Annotate and keeps the page; Close all
 *   goes back to the thread; the folder button keeps a panel the person
 *   closed closed; the panel's open folders survive a full-screen round
 *   trip; a project HTML file opens full screen.
 * - The panel reads nothing while the pane is closed: stepping through
 *   threads with the panel and the change marks left on sends no listing
 *   and no change read, past a refresh's interval; opening the pane does.
 * - Which folder (PROJECT-FOLDER definition, owner 2026-10-27): a thread
 *   with no artifact in a project still has the button, named for the
 *   folder with no count, and it opens the pane on the folder; a thread
 *   whose agent works in the home folder has none.
 * - This computer only: with "Over your tailnet" on, every Files route asked
 *   through the tailnet listener answers 403 local_only, while the thread
 *   itself still answers there (a scripted `tailscale` that keeps its serve
 *   mapping in a file, as inbox-tailscale.spec.ts's does).
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-files.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const MAGIC = 'studio.tail0000.ts.net';
const OWNER = 'owner@example.com';
/** The scripted tailscale (run by this Node): `status --json`, `serve status --json`, serve on and off, the mapping kept in a file. */
const FAKE_TAILSCALE = `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const state = process.argv[2];
const args = process.argv.slice(3);
const out = (text) => { process.stdout.write(text); process.exit(0); };
const serve = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {};
if (args[0] === "status") out(JSON.stringify({ Self: { DNSName: "${MAGIC}.", UserID: 1 }, User: { "1": { LoginName: "${OWNER}" } } }));
if (args[0] === "serve" && args[1] === "status") {
  const ports = Object.keys(serve);
  if (ports.length === 0) out("{}");
  out(JSON.stringify({ TCP: Object.fromEntries(ports.map((p) => [p, { HTTPS: true }])), Web: Object.fromEntries(ports.map((p) => ["${MAGIC}:" + p, { Handlers: { "/": { Proxy: serve[p] } } }])) }));
}
const port = (/--https=(\\d+)/.exec(args.join(" ")) || [])[1];
if (args[0] === "serve" && port && args.includes("off")) { delete serve[port]; writeFileSync(state, JSON.stringify(serve)); out(""); }
if (args[0] === "serve" && port && args.includes("--bg")) { serve[port] = args[args.length - 1]; writeFileSync(state, JSON.stringify(serve)); out("https://${MAGIC}:" + port + "/\\n"); }
process.exit(2);
`;
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

interface World {
  url: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
  contentPaths: string[];
  threadId: string;
  /** A thread with no artifact, in the same project. */
  plainThread: string;
  /** A thread whose agent works in the home folder. */
  homeThread: string;
  /** The scripted tailscale's serve mapping (`{ "<https port>": "<proxy URL>" }`). */
  serveState: string;
}
let world: World;

// One window walked through in order: a step builds on the one before.
test.describe.configure({ mode: 'serial' });

const put = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-files-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  // Nothing here may reach a real gh or tailscale: gh is a trap, tailscale a script.
  writeFileSync(join(trap, 'gh'), `#!/bin/sh\necho "inbox-files: gh must not run" >&2\nexit 97\n`);
  chmodSync(join(trap, 'gh'), 0o755);
  const serveState = join(root, 'serve.json');
  writeFileSync(join(root, 'fake-tailscale.cjs'), FAKE_TAILSCALE);
  writeFileSync(join(trap, 'tailscale'), `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'fake-tailscale.cjs')}' '${serveState}' "$@"\n`);
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0',
    NO_BROWSER,
    PLANNOTATOR_BROWSER: NO_BROWSER,
  };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dana', GIT_AUTHOR_EMAIL: 'dana@example.com', GIT_COMMITTER_NAME: 'Dana', GIT_COMMITTER_EMAIL: 'dana@example.com' },
    });
    expect(r.status, r.stderr).toBe(0);
  };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'ledger');
  put(project, '.gitignore', 'dist/\nnode_modules/\n.env\n');
  put(project, 'README.md', '# Ledger\n');
  put(project, 'src/api/totals.ts', 'export const total = (lines: number[]) => lines.reduce((a, b) => a + b, 0);\n');
  put(project, 'docs/plan.md', '# Plan\n\nRound once per invoice.\n');
  put(project, 'docs/notes.md', '# Notes\n\nNothing yet.\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'First cut');
  put(project, '.env', 'STRIPE_KEY=sk_test_never_shown\n');
  put(project, 'node_modules/left-pad/index.js', 'module.exports = (s) => s;\n');

  const claude = await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code', cwd: project });
  const first = await claude.send({ project_path: project, subject: 'Invoice totals', body: 'The plan, attached.', attachments: ['docs/plan.md'] });
  const threadId = first.thread_id as string;
  const firstId = ((first as any).message?.id ?? (first as any).message_id) as string;
  // After the thread started: a commit (A) and an edit (M).
  await new Promise((r) => setTimeout(r, 1200));
  put(project, 'docs/mock.html', '<!doctype html><title>Mock</title><h1>Mock</h1>\n');
  git(project, 'add', 'docs/mock.html');
  git(project, 'commit', '-q', '-m', 'Mock');
  put(project, 'src/api/totals.ts', 'export const total = (lines: number[]) => lines.map((l) => Math.round(l * 100) / 100).reduce((a, b) => a + b, 0);\n');
  await claude.send({ project_path: project, reply_to: firstId, body: 'I changed `totals.ts` to round each line.', attachments: ['src/api/totals.ts'] });
  await claude.close();
  // Another session in the same project, with nothing attached; and one working in the home folder.
  const codex = await SimAgent.connect({ binary: builtBinary, env, name: 'Codex', host: 'codex', cwd: project });
  const plain = await codex.send({ project_path: project, subject: 'Rounding question', body: 'Should rounding stay per line?' });
  await codex.close();
  const pi = await SimAgent.connect({ binary: builtBinary, env, name: 'Pi', host: 'pi', cwd: home });
  const fromHome = await pi.send({ project_path: home, subject: 'From the home folder', body: 'Working in the home folder.' });
  await pi.close();
  expect(plain.thread_id).not.toBe(threadId);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  const contentPaths: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const at = new URL(request.url());
    if (at.pathname.endsWith('/files/content') || at.pathname.endsWith('/files/raw')) contentPaths.push(at.searchParams.get('path') ?? '');
  });
  world = { url, context, page, errors, contentPaths, threadId, plainThread: plain.thread_id as string, homeThread: fromHome.thread_id as string, serveState };
});

test.afterAll(async () => {
  try {
    if (world) await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

const panel = () => world.page.locator('[data-files-panel]');
const projectRow = (path: string) => panel().locator(`[role=tree][aria-label="ledger"] [role=treeitem][data-path="${path}"]`);
const fileTabs = () => world.page.locator('[data-file-tab]');

test('the folder button opens Artifacts with the project listed like VS Code', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.locator('[data-artifacts-button]').click();
  await expect(page.locator('[data-files-pane="artifacts"]')).toBeVisible();
  await expect(page.locator('[data-artifacts-tab]')).toHaveAttribute('aria-selected', 'true');
  // The panel starts as the person left it (closed, the first time): the button never opens it for them.
  await expect(panel()).toHaveCount(0);
  await page.locator('[data-files-panel-toggle]').click();
  await expect(projectRow('README.md')).toBeVisible();
  await expect(projectRow('.git')).toHaveCount(0);
  await expect(projectRow('node_modules')).toHaveAttribute('data-dimmed', 'true');
  await expect(projectRow('src')).not.toHaveAttribute('data-dimmed', 'true');
  await expect(projectRow('.env')).toHaveAttribute('data-locked', 'true');
  // A folder opened later dims its own rows as soon as they show.
  await projectRow('node_modules').click();
  await expect(projectRow('node_modules/left-pad')).toHaveAttribute('data-dimmed', 'true', { timeout: 3000 });
  // A locked row says why and never asks for its contents.
  await projectRow('.env').click({ force: true });
  await expect(page.getByText('.env files may hold secrets').filter({ visible: true }).first()).toBeVisible();
  expect(world.contentPaths.filter((p) => p.endsWith('.env'))).toEqual([]);
});

test('one file shows a tab row and its tools in a row of their own, as two do', async () => {
  const { page } = world;
  await panel().locator('[role=tree][aria-label="Artifacts"] [role=treeitem]', { hasText: 'totals.ts' }).click();
  await expect(fileTabs()).toHaveCount(1);
  // Tabs are always tabs: the row holds tabs and the pane's controls, never the file's tools.
  const row = page.locator('[data-files-header] [data-files-tabs]');
  const bar = page.locator('[data-files-header] .ib-vslim');
  await expect(bar).toBeVisible();
  await expect(row.locator('[data-header-from]')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Side by side' })).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Side by side' })).toBeVisible();
  // The tools row sits under the tab row.
  const rowBox = (await row.boundingBox())!;
  const barBox = (await bar.boundingBox())!;
  expect(barBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1);
  // The header's line stays beside the thread, in the bar.
  await expect(bar.locator('[data-header-from]')).toHaveText('from Claude Code in ledger');
  // Counts once: no number on the Artifacts tab.
  await expect(page.locator('[data-artifacts-tab]')).toHaveText('Artifacts');
  await projectRow('docs').click();
  await projectRow('docs/notes.md').click();
  await expect(fileTabs()).toHaveCount(2);
  await expect(fileTabs().nth(1)).toContainText('notes.md');
  await expect(fileTabs().nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.ib-ftop .ib-vslim')).toBeVisible();
  // The open-tabs menu is a plain ⌄: no count on it.
  await expect(page.locator('[data-tabs-menu]')).toHaveText('');
  await expect(page.locator('[data-tabs-menu]')).toHaveAccessibleName('Open files, 2');
  await expect(page.locator('[data-files-crumbs]')).toContainText('docs');
  // With two, in the bar under the tabs; a file of the folder was sent by nobody.
  await expect(page.locator('.ib-ftop .ib-vslim [data-header-from]')).toHaveText('in ledger');
  expect(world.contentPaths).toContain('docs/notes.md');
  // Closing the open tab shows its left neighbour (none to its right), then the last one shows Artifacts.
  await page.locator('[data-tab-close]').nth(1).click({ force: true });
  await expect(fileTabs()).toHaveCount(1);
  await expect(fileTabs().first()).toContainText('totals.ts');
  await expect(fileTabs().first()).toHaveAttribute('aria-selected', 'true');
  await page.locator('[data-tab-close]').first().click({ force: true });
  await expect(fileTabs()).toHaveCount(0);
  await expect(page.locator('[data-artifacts-tab]')).toHaveAttribute('aria-selected', 'true');
  // One panel for every tab: the folder opened beside a file is still open on Artifacts.
  await expect(projectRow('docs')).toHaveAttribute('aria-expanded', 'true');
});

test('Escape keeps the file beside the thread; Close all goes back to the thread; the button keeps a closed panel closed', async () => {
  const { page } = world;
  await projectRow('README.md').click();
  await projectRow('docs/plan.md').click();
  await expect(fileTabs()).toHaveCount(2);
  // Escape beside the thread closes nothing, as before tabs (an open file owns Escape; no new Inbox key).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expect(fileTabs()).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('file=');
  // Close all: back to the thread alone.
  await page.locator('[data-tabs-menu]').click();
  await page.getByRole('menuitem', { name: 'Close all' }).click();
  await expect(page.locator('[data-files-pane]')).toHaveCount(0);
  await expect(page.locator('[data-attachment-pane]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash)).not.toMatch(/artifacts|file=/);
  // The person hides the panel; the button opens the pane without it, and it comes back only when asked for.
  const door = page.locator('[data-artifacts-button]');
  await door.click();
  await expect(panel()).toBeVisible();
  await page.locator('[data-files-panel-toggle]').click();
  await expect(panel()).toHaveCount(0);
  await door.click();
  await expect(page.locator('[data-files-pane]')).toHaveCount(0);
  await door.click();
  await expect(page.locator('[data-files-pane="artifacts"]')).toBeVisible();
  await expect(panel()).toHaveCount(0);
  await page.locator('[data-files-panel-toggle]').click();
  await expect(panel()).toBeVisible();
});

test("the folder button is the pane's toggle: lit where the thread's × was while open, its count only while closed", async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const head = page.locator('section.ib-pane .ib-phead');
  const door = head.locator('[data-artifacts-button]');
  const count = door.locator('[data-files-count]');
  const closeThread = head.getByRole('button', { name: 'Close the thread' });
  const lastButton = () => head.evaluate((h) => [...h.querySelectorAll('button')].pop()?.getAttribute('aria-label') ?? null);
  const shut = async () => {
    await expect(page.locator('[data-files-tabs]')).toHaveCount(0);
    await expect(closeThread).toBeVisible();
    await expect(door).toHaveAttribute('aria-pressed', 'false');
    await expect(door).toHaveAttribute('aria-expanded', 'false');
    await expect(door).toHaveAccessibleName(/^Show files \(\d+\)$/);
    const n = /\((\d+)\)/.exec((await door.getAttribute('aria-label'))!)![1];
    await expect(count).toHaveText(n);
    expect(await lastButton()).toBe('Close the thread');
  };
  const open = async () => {
    // The pane's tab row: on Artifacts and over a file alike.
    await expect(page.locator('[data-files-tabs]')).toBeVisible();
    await expect(closeThread).toHaveCount(0);
    await expect(door).toHaveAttribute('aria-pressed', 'true');
    await expect(door).toHaveAttribute('aria-expanded', 'true');
    await expect(door).toHaveAccessibleName('Hide files');
    await expect(count).toHaveCount(0);
    // Where the thread's × was: the header's last control.
    expect(await lastButton()).toBe('Hide files');
  };
  await shut();
  // The folder opens the pane and takes the ×'s place, lit, with no count (the "1 of N" under a file says it).
  await door.click();
  await open();
  // The folder closes it: the × comes back.
  await door.click();
  await shut();
  // Focus follows the folder to its place, never onto the × that took the old one (Enter there would close the thread).
  await expect(door).toBeFocused();
  // The pane's own × closes it too, and brings the thread's × back.
  await door.click();
  await open();
  await page.locator('[data-files-close]').click();
  await shut();
  // With a file open beside the thread the folder stays lit at the end; it closes the file's pane.
  await door.click();
  if ((await panel().count()) === 0) await page.locator('[data-files-panel-toggle]').click();
  await panel().locator('[role=tree][aria-label="Artifacts"] [role=treeitem]', { hasText: 'totals.ts' }).click();
  await expect(fileTabs()).toHaveCount(1);
  await open();
  await door.click();
  await expect(page.locator('[data-attachment-pane]')).toHaveCount(0);
  await shut();
  // Left open on Artifacts with the panel, for the tests after this one.
  await door.click();
  await expect(panel()).toBeVisible();
  expect(world.errors).toEqual([]);
});

test('change marks show only while the changes toggle is on', async () => {
  const { page } = world;
  const toggle = page.locator('[data-files-changes]');
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  await projectRow('src').click();
  await projectRow('src/api').click();
  await expect(projectRow('src/api/totals.ts')).toBeVisible();
  await expect(projectRow('src/api/totals.ts')).not.toContainText('Modified');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(projectRow('src/api/totals.ts')).toContainText('M');
  await expect(projectRow('src/api/totals.ts')).toContainText('Modified');
  if ((await projectRow('docs').getAttribute('aria-expanded')) !== 'true') await projectRow('docs').click();
  await expect(projectRow('docs/mock.html')).toContainText('Added');
  await toggle.click();
  await expect(projectRow('src/api/totals.ts')).not.toContainText('Modified');
});

test("the tree's keys stay in the tree", async () => {
  const { page } = world;
  await projectRow('README.md').click();
  await expect(fileTabs()).toHaveCount(1);
  const hash = await page.evaluate(() => location.hash);
  const tree = panel().locator('[role=tree][aria-label="ledger"]');
  await tree.focus();
  // The focused row: the tree's active descendant.
  const active = () => page.evaluate(() => {
    const id = document.activeElement?.getAttribute('aria-activedescendant');
    return id ? document.getElementById(id)?.getAttribute('data-path') ?? null : null;
  });
  const before = await active();
  await page.keyboard.press('ArrowUp');
  expect(await active()).not.toBe(before);
  for (const key of ['j', 'k', '/']) await page.keyboard.press(key);
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  expect(await page.evaluate(() => document.activeElement?.closest('[role=tree]') != null)).toBe(true);
});

test('full screen stays as it was: no tab row', async () => {
  const { page } = world;
  await page.getByRole('button', { name: 'Full screen' }).first().click();
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('view=full');
  await expect(page.locator('[data-files-tabs]')).toHaveCount(0);
  await expect(page.locator('[data-files-panel]')).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test('a thread with no artifact: the button opens its project folder; none for the home folder', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.plainThread}`);
  const door = page.locator('[data-artifacts-button]');
  await expect(door).toHaveAttribute('aria-label', 'Show files: project folder, ledger');
  await expect(door.locator('.ib-artbtn-n')).toHaveCount(0);
  await door.click();
  // The pane opens on the folder: the panel lists it, focus in its filter, the empty grid points there.
  await expect(projectRow('README.md')).toBeVisible();
  await expect(page.locator('[data-files-filter]')).toBeFocused();
  await expect(page.locator('[data-artifacts-empty-folder]')).toHaveText('Open a file from ledger in the files panel.');
  // A file opens from it (full screen here: the step before chose full screen, and that choice is remembered).
  await projectRow('README.md').click();
  await expect(page.locator('[data-attachment-pane]').getByRole('heading', { name: 'Ledger' })).toBeVisible();
  await expect(page).toHaveURL(/file=pf/);

  // The agent works in the home folder: no folder, so no button (nothing in it is listed).
  await page.goto(`${world.url}#thread=${world.homeThread}`);
  await expect(page.locator('section.ib-pane [data-archive]')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator('[data-artifacts-button]')).toHaveCount(0);
  const answer = await page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}/files/folder`)).json(), world.homeThread);
  expect(answer).toMatchObject({ folder: null, reason: 'home' });
  expect(world.errors).toEqual([]);
});

test('the panel keeps its open folders through full screen; a project HTML file opens full screen', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.locator('[data-artifacts-button]').click();
  await expect(panel()).toBeVisible();
  if ((await projectRow('docs').getAttribute('aria-expanded')) !== 'true') await projectRow('docs').click();
  await expect(projectRow('docs/mock.html')).toBeVisible();
  // An HTML page of the folder opens full screen, as an attached one does, and renders.
  await projectRow('docs/mock.html').click();
  const view = page.locator('[data-attachment-pane]');
  await expect(view).toHaveClass(/ib-full/);
  await expect(view.frameLocator('iframe').first().getByRole('heading', { name: 'Mock' })).toBeVisible();
  await expect(panel()).toHaveCount(0);
  // Back beside the thread: the panel is the same one, its folder still open.
  await view.getByRole('button', { name: 'Side by side' }).click();
  await expect(view).not.toHaveClass(/ib-full/);
  await expect(projectRow('docs')).toHaveAttribute('aria-expanded', 'true');
  await expect(projectRow('docs/mock.html')).toBeVisible();
  // Escape on the page in Annotate (focus outside its frame): Annotate turns off and the page stays, as before tabs.
  const pen = view.locator('[data-html-annotate-toggle]');
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(pen).toHaveAttribute('aria-pressed', 'false');
  await expect(view).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('file=');
  expect(world.errors).toEqual([]);
});

test('the panel reads nothing while the pane is closed; opening the pane reads the folder', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const door = page.locator('[data-artifacts-button]');
  await door.click();
  await expect(panel()).toBeVisible();
  // The panel and the change marks both left on, then the pane closed.
  const toggle = page.locator('[data-files-changes]');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await door.click();
  await expect(page.locator('[data-files-pane]')).toHaveCount(0);
  const reads: string[] = [];
  const onRequest = (request: { url(): string }) => {
    const path = new URL(request.url()).pathname;
    if (/\/files(\/(levels|changed|content|raw))?$/.test(path)) reads.push(path);
  };
  page.on('request', onRequest);
  try {
    // Stepping through threads (the folder button's own question, `files/folder`, is the only Files request).
    await page.goto(`${world.url}#thread=${world.plainThread}`);
    await expect(page.locator('[data-artifacts-button]')).toBeVisible();
    await page.goto(`${world.url}#thread=${world.threadId}`);
    await expect(page.locator('[data-artifacts-button]')).toBeVisible();
    // Past a relist (5 s) and the change read's first chance.
    await page.waitForTimeout(6_500);
    expect(reads).toEqual([]);
    await page.locator('[data-artifacts-button]').click();
    await expect(panel()).toBeVisible();
    await expect.poll(() => reads.some((path) => path.endsWith('/files'))).toBe(true);
    await expect.poll(() => reads.some((path) => path.endsWith('/files/changed'))).toBe(true);
  } finally {
    page.off('request', onRequest);
    // The marks back off (only reachable with the pane open).
    if (await toggle.isVisible()) await toggle.click();
  }
  expect(world.errors).toEqual([]);
});

/** A GET as tailscale serve hands it on: to the tailnet listener, with the served Host and the owner's login. */
function throughTailnet(listener: number, served: string, path: string): Promise<{ status: number; code: string | null }> {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port: listener, path, headers: { Host: `${MAGIC}:${served}`, 'Tailscale-User-Login': OWNER } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let code: string | null = null;
        try {
          code = (JSON.parse(text) as { code?: string }).code ?? null;
        } catch {}
        done({ status: res.statusCode ?? 0, code });
      });
    });
    req.on('error', fail);
    req.end();
  });
}

test('over the tailnet every Files route answers local_only; the thread still answers there', async () => {
  const { page } = world;
  await page.goto(`${world.url}#settings/devices`);
  const toggle = page.locator('[data-settings-tailscale]').getByRole('switch', { name: 'Reach the Inbox over Tailscale' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
  try {
    const mapping = () => (existsSync(world.serveState) ? (JSON.parse(readFileSync(world.serveState, 'utf8')) as Record<string, string>) : {});
    await expect.poll(() => Object.keys(mapping()).length, { timeout: 20_000 }).toBe(1);
    const [served, proxy] = Object.entries(mapping())[0]!;
    const listener = Number(new URL(proxy).port);
    const base = `/api/inbox/threads/${world.threadId}/files`;
    for (const path of [base, `${base}/folder`, `${base}/levels?dir=`, `${base}/content?path=README.md`, `${base}/raw?path=README.md`, `${base}/changed`]) {
      expect(await throughTailnet(listener, served, path), path).toEqual({ status: 403, code: 'local_only' });
    }
    expect((await throughTailnet(listener, served, `/api/inbox/threads/${world.threadId}`)).status).toBe(200);
    // This computer still reads the folder.
    expect((await page.request.get(new URL(`${base}/folder`, world.url).href)).status()).toBe(200);
  } finally {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 });
  }
  expect(world.errors).toEqual([]);
});
