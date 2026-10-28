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
 * - One file open: its tools sit in the tab row (no bar under it). A second
 *   file: a tab to the right and the tools drop to a bar with the path.
 *   Closing a tab shows its right neighbour, else its left, else Artifacts.
 * - The panel is the same on every tab: a folder opened beside a file is
 *   still open on Artifacts.
 * - The changes toggle: no M/A marks while off; on, totals.ts reads M.
 * - The tree's keys stay in the tree: ArrowDown moves in it, and j, k and /
 *   change nothing outside it.
 * - Full screen stays as it was: no tab row.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-files.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

interface World {
  url: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
  contentPaths: string[];
  threadId: string;
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
  // Nothing here may reach a real gh or tailscale.
  for (const name of ['gh', 'tailscale']) {
    writeFileSync(join(trap, name), `#!/bin/sh\necho "inbox-files: ${name} must not run" >&2\nexit 97\n`);
    chmodSync(join(trap, name), 0o755);
  }
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

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  const contentPaths: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const at = new URL(request.url());
    if (at.pathname.endsWith('/files/content') || at.pathname.endsWith('/files/raw')) contentPaths.push(at.searchParams.get('path') ?? '');
  });
  world = { url, context, page, errors, contentPaths, threadId };
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
  if (!(await panel().isVisible())) await page.locator('[data-files-panel-toggle]').click();
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

test('one file keeps its tools in the tab row; a second drops them to a bar', async () => {
  const { page } = world;
  await panel().locator('[role=tree][aria-label="Artifacts"] [role=treeitem]', { hasText: 'totals.ts' }).click();
  await expect(fileTabs()).toHaveCount(1);
  await expect(page.locator('.ib-ftop .ib-vslim')).toHaveCount(0);
  await expect(page.locator('[data-files-tabs]')).toHaveClass(/ib-tabfold/);
  await projectRow('docs').click();
  await projectRow('docs/notes.md').click();
  await expect(fileTabs()).toHaveCount(2);
  await expect(fileTabs().nth(1)).toContainText('notes.md');
  await expect(fileTabs().nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.ib-ftop .ib-vslim')).toBeVisible();
  await expect(page.locator('[data-files-crumbs]')).toContainText('docs');
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
