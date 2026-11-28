/**
 * Reviews' "On this computer" + (approval "reviews-open-any-branch-a", option A, and its addendum "Another folder…"),
 * in a real browser against the compiled binary: the + at the right of the heading opens the Inbox's own picker, a
 * project, then its worktree folders and branches; what is picked opens as a review and stays in the group.
 *
 * What regresses if these fail:
 *  1. The + missing from the heading, or its name and tooltip not "Open branch or folder" (A1).
 *  2. The picker's steps: the projects, then a project's folders and branches, titled as approved (a folder by the
 *     branch checked out, its own name quiet; a detached one by its name, its short commit quiet; "same as main"
 *     dimmed, still listed), typing not finding a branch (A3).
 *  3. A picked worktree folder not opening its whole work (uncommitted and new files too), or anything sent; the row
 *     not staying in the group after a reload (A5).
 *  4. A folder with nothing beyond main opening anything but "Same as main.".
 *  5. "Another folder…" not opening New message's folder opener, or the folder it picks not opening as a review.
 *  6. On a phone (390), the picker not a full-screen sheet with its own head (A8); dark (A9).
 *  7. With no row, the heading and its + not drawn alone (B1): a clean checkout with no way to open a branch.
 *  Also shot: the picker's "Another folder…" (B2) and the folder opener it opens (B3).
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/reviews-open-any-branch, named after the approved pictures. HOME is a scratch
 * folder, and the sandbox env keeps the binary off the person's agents. Build the binary first (see inbox.spec.ts),
 * then `bunx playwright test -c tests/e2e/playwright.config.ts inbox-reviews-open-any-branch.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { E2E_GROUP_TIP_SEEN, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'reviews-open-any-branch');

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** git in a folder, at a given time (seconds before now), as Charlie Dunn. */
function gitIn(cwd: string, args: string[], secondsAgo = 40 * DAY): string {
  const date = `@${Math.floor(Date.now() / 1000) - secondsAgo} +0000`;
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Charlie Dunn', GIT_AUTHOR_EMAIL: 'charlie@example.com', GIT_COMMITTER_NAME: 'Charlie Dunn', GIT_COMMITTER_EMAIL: 'charlie@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}

function commitIn(cwd: string, file: string, text: string, secondsAgo: number): void {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), text);
  gitIn(cwd, ['add', '-A'], secondsAgo);
  gitIn(cwd, ['commit', '-q', '-m', file], secondsAgo);
}

/** A project folder on main, its first commit 40 days ago. */
function gitProject(parent: string, name: string): string {
  const path = scratchProject(parent, name);
  commitIn(path, 'src/auth/redirect.ts', 'export const next = (url: string) => {\n  return url || "/";\n};\n', 40 * DAY);
  gitIn(path, ['branch', '-M', 'main']);
  return path;
}

/** A branch off main with `count` commits, the newest `secondsAgo`; main stays checked out. */
function branchWith(path: string, name: string, count: number, secondsAgo: number): void {
  gitIn(path, ['checkout', '-q', '-b', name, 'main']);
  for (let i = count; i >= 1; i--) commitIn(path, `notes/${name.replace(/\W/g, '-')}-${i}.md`, `# ${name} ${i}\n`, secondsAgo + (i - 1) * MINUTE);
  gitIn(path, ['checkout', '-q', 'main']);
}

interface World {
  browser: Browser;
  url: string;
  harbor: string;
  harborId: string;
  /** The folders of harbor's worktrees, by their own names. */
  folders: { login: string; spike: string; onboarding: string };
  /** A folder in the sandbox's home that is no project: "Another folder…" picks it. */
  notes: string;
  context: BrowserContext;
  page: Page;
}

let world: World;

test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-reviews-open-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const configFile = join(dataDir, 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  // Launch on: "Another folder…" is New message's folder opener, which reads folders only while it is.
  writeFileSync(configFile, JSON.stringify({ ...config, inboxLaunch: { enabled: true }, inboxCodeReview: true, inboxReveals: { ...E2E_GROUP_TIP_SEEN, code_review: { shownAt: '2026-10-24T00:00:00.000Z' } } }));
  const fakes = join(root, 'fakes');
  mkdirSync(fakes);
  writeFileSync(join(fakes, 'gh'), '#!/bin/sh\necho "You are not logged into any GitHub hosts." >&2\nexit 1\n');
  for (const name of ['glab', 'tailscale', 'claude', 'codex']) writeFileSync(join(fakes, name), `#!/bin/sh\necho "reviews-open: ${name} must not run" >&2\nexit 97\n`);
  for (const name of ['gh', 'glab', 'tailscale', 'claude', 'codex']) chmodSync(join(fakes, name), 0o755);
  for (const dir of ['claude', 'codex', 'xdg', 'opencode', 'home']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${fakes}:/usr/bin:/bin`,
    HOME: join(root, 'home'),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    PLANNOTATOR_TEST_LAUNCH_PATH: fakes,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
  };

  // harbor: branches of every kind, and three worktree folders (the approved pictures' own).
  const src = join(root, 'src');
  const harbor = gitProject(src, 'harbor');
  branchWith(harbor, 'fix/export-dialog-focus', 1, 12 * MINUTE);
  branchWith(harbor, 'chore/logging-levels', 2, 2 * DAY);
  branchWith(harbor, 'charlie/search-ranking', 6, 21 * DAY);
  branchWith(harbor, 'ada/csv-import', 3, 22 * DAY);
  branchWith(harbor, 'bob/changelog-2-4', 1, 32 * DAY);
  gitIn(harbor, ['branch', 'release/2.4', 'main']);
  const trees = join(src, 'harbor-trees');
  mkdirSync(trees, { recursive: true });
  // wt-login: fix/login-redirect-loop, nothing committed of its own; a changed line and a new file uncommitted.
  gitIn(harbor, ['worktree', 'add', '-q', '-b', 'fix/login-redirect-loop', join(trees, 'wt-login'), 'main'], HOUR);
  writeFileSync(join(trees, 'wt-login', 'src/auth/redirect.ts'), 'export const next = (url: string) => {\n  if (url === "/login") return "/";\n  return url || "/";\n};\n');
  writeFileSync(join(trees, 'wt-login', 'src/auth/redirect.test.ts'), 'export const loops = "/login";\nexport const home = "/";\n');
  // bob-spike: no branch, one commit of its own.
  gitIn(harbor, ['worktree', 'add', '-q', '--detach', join(trees, 'bob-spike'), 'main'], 2 * HOUR);
  commitIn(join(trees, 'bob-spike'), 'spike/cache.ts', 'export const cache = new Map();\n', HOUR);
  // wt-onboarding: feat/onboarding-v2, the same as main.
  gitIn(harbor, ['worktree', 'add', '-q', '-b', 'feat/onboarding-v2', join(trees, 'wt-onboarding'), 'main'], 5 * HOUR);
  const spaces = gitProject(src, 'spaces-site');
  branchWith(spaces, 'feat/spaces-share-link', 1, 2 * HOUR);

  // "Another folder…": a repository in the sandbox's home (the folder opener reads the agents' home under test).
  const notes = join(dataDir, 'agents-home', 'code', 'notes-app');
  mkdirSync(join(dataDir, 'agents-home', 'code'), { recursive: true });
  scratchProject(join(dataDir, 'agents-home', 'code'), 'notes-app');
  commitIn(notes, 'README.md', '# Notes\n', 10 * DAY);
  gitIn(notes, ['branch', '-M', 'main']);
  gitIn(notes, ['checkout', '-q', '-b', 'ada/tags'], 3 * HOUR);
  commitIn(notes, 'src/tags.ts', 'export const tags = ["Ada Novak", "Bob Tully"];\n', 3 * HOUR);

  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();

  // Both folders are Inbox projects: an agent wrote from each, one of them a review, so the list has a row above the group.
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number };
  const client = new Client({ name: 'reviews-open', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${registry.port}/mcp`)));
  const patch = 'diff --git a/src/auth/redirect.ts b/src/auth/redirect.ts\n--- a/src/auth/redirect.ts\n+++ b/src/auth/redirect.ts\n@@ -1 +1 @@\n-export const next = (url: string) => {\n+export const next = (url: string): string => {\n';
  const guide = { title: 'Tighten the export dialog', intent: 'Focus stays in the dialog.', sections: [{ title: 'Focus', overview: 'One line.', diffs: [{ file: 'src/auth/redirect.ts', summary: 'Focus.' }] }], review: { gitRef: 'main...HEAD', base: 'main' }, generator: { engine: 'claude-code', model: 'claude-opus-5' } };
  const sent = (await client.callTool({ name: 'submit_guide', arguments: { project_path: harbor, guide, patch, review: true, subject: 'Tighten the export dialog', body: 'Ready for review.', agent_session: 'ses-open', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[] };
  if (sent.isError) throw new Error(sent.content?.map((c) => c.text).join(' '));
  const note = (await client.callTool({ name: 'send_message', arguments: { project_path: spaces, subject: 'Share links', body: 'Started on share links.', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[] };
  if (note.isError) throw new Error(note.content?.map((c) => c.text).join(' '));
  await client.close().catch(() => {});

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const projects = (await (await page.request.get(`${url}api/inbox/projects`)).json()) as { projects?: { id: string; root: string }[] };
  const harborId = projects.projects?.find((p) => p.root === harbor)?.id ?? '';
  expect(harborId).toBeTruthy();
  world = { browser, url, harbor, harborId, folders: { login: join(trees, 'wt-login'), spike: join(trees, 'bob-spike'), onboarding: join(trees, 'wt-onboarding') }, notes, context, page };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

const group = (page: Page) => page.locator('[data-pulls-group="local"]');
const plus = (page: Page) => group(page).locator('[data-local-open]');
const picker = (page: Page) => page.locator('[data-local-picker]');
/** A picker row by the end of its key: a branch's `:<name>`, a folder's `/<its own name>`. */
const pick = (page: Page, end: string) => picker(page).locator(`[data-local-pick$="${end}"]`);

async function openGroup(page: Page): Promise<void> {
  const fold = group(page).locator('[data-reviews-fold="local"]');
  await expect(fold).toBeVisible();
  if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
}

/** The + open, past the projects step to harbor's folders and branches. */
async function toHarbor(page: Page): Promise<void> {
  await plus(page).click();
  await expect(picker(page)).toHaveAttribute('data-local-picker', 'projects');
  await picker(page).locator(`[data-local-pick-project="${world.harborId}"]`).click();
  await expect(picker(page)).toHaveAttribute('data-local-picker', 'refs');
  await expect(pick(page, '/wt-login')).toBeVisible();
}

// Desktop, phone and dark are apart: a failure in one never skips the others' shots. Each shot is taken before its checks.
test.describe('desktop at 1440', () => {
  test.describe.configure({ mode: 'serial' });

  test('A1: the + sits at the right of the heading, named "Open branch or folder"', async () => {
    const { page } = world;
    await page.goto(`${world.url}#reviews`);
    await openGroup(page);
    await plus(page).hover();
    await expect(page.getByRole('tooltip').or(page.locator('[data-pn-tooltip]')).first()).toContainText('Open branch or folder');
    await page.screenshot({ path: join(proofDir, 'A1-rest-light.png') });
    await expect(plus(page)).toHaveAccessibleName('Open branch or folder');
    // At the heading's right end, on its line.
    const head = (await group(page).locator('.ib-pr-foldhead').boundingBox())!;
    const box = (await plus(page).boundingBox())!;
    expect(head.x + head.width - (box.x + box.width)).toBeLessThan(16);
    expect(box.y).toBeGreaterThanOrEqual(head.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(head.y + head.height + 1);
  });

  test("A3: a project's folders and branches, titled as approved, found by typing", async () => {
    const { page } = world;
    await plus(page).click();
    const projects = picker(page).locator('[data-local-pick-project]');
    await expect(projects).toHaveCount(2);
    await expect(picker(page).locator(`[data-local-pick-project="${world.harborId}"]`)).toContainText('harbor');
    await expect(picker(page).locator('[data-local-pick-other]')).toHaveText('Another folder…');
    await picker(page).locator(`[data-local-pick-project="${world.harborId}"]`).click();
    await expect(pick(page, '/wt-login')).toBeVisible();
    await page.mouse.move(1300, 880);
    await page.screenshot({ path: join(proofDir, 'A3-pick-branch-light.png') });
    await expect(picker(page).locator('[data-local-picker-back]')).toHaveText('harbor');
    await expect(picker(page).locator('[data-local-picker-filter]')).toHaveAttribute('placeholder', 'Branch or folder');
    // Folders: the branch checked out, its own name quiet; detached, its name and short commit; same as main, dimmed.
    const folders = picker(page).locator('[data-local-kind="folder"]');
    await expect(folders).toHaveCount(3);
    await expect(pick(page, '/wt-login').locator('.ib-lp-op')).toHaveText('fix/login-redirect-loop');
    await expect(pick(page, '/wt-login').locator('.ib-lp-of')).toHaveText('wt-login');
    await expect(pick(page, '/wt-login').locator('.ib-lp-r')).toContainText('uncommitted');
    await expect(pick(page, '/bob-spike').locator('.ib-lp-op')).toHaveText('bob-spike');
    await expect(pick(page, '/bob-spike').locator('.ib-lp-of')).toHaveText(/^[0-9a-f]{7,}$/);
    await expect(pick(page, '/bob-spike').locator('.ib-lp-r')).toContainText('1 commit');
    await expect(pick(page, '/wt-onboarding').locator('.ib-lp-op')).toHaveText('feat/onboarding-v2');
    await expect(pick(page, '/wt-onboarding').locator('.ib-lp-dim')).toHaveText('same as main');
    // Branches: newest first, each with its commits; a branch checked out in a folder offered once, as the folder.
    const branches = picker(page).locator('[data-local-kind="branch"] .ib-lp-op');
    await expect(branches).toHaveText(['fix/export-dialog-focus', 'chore/logging-levels', 'charlie/search-ranking', 'ada/csv-import', 'bob/changelog-2-4', 'release/2.4']);
    await expect(pick(page, ':charlie/search-ranking').locator('.ib-lp-r')).toContainText('6 commits');
    await expect(pick(page, ':release/2.4').locator('.ib-lp-dim')).toHaveText('same as main');
    await expect(picker(page).locator('.ib-cp-cap')).toHaveText(['Folders 3', 'Branches 6']);
    // Typing finds a branch or folder by name, the match in bold.
    await picker(page).locator('[data-local-picker-filter]').fill('log');
    await expect(picker(page).locator('[data-local-pick] .ib-lp-op')).toHaveText(['fix/login-redirect-loop', 'fix/export-dialog-focus', 'chore/logging-levels', 'bob/changelog-2-4']);
    await expect(pick(page, ':chore/logging-levels').locator('.ib-lp-op b')).toHaveText('log');
    await page.keyboard.press('Escape');
    await expect(picker(page)).toHaveCount(0);
  });

  test("A5: a picked worktree folder opens its whole work; nothing is sent; it stays in the group", async () => {
    const { page } = world;
    const writes: string[] = [];
    const watch = (request: { method: () => string; url: () => string }) => {
      if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
    };
    page.on('request', watch);
    const status = gitIn(world.folders.login, ['status', '--porcelain']);
    await toHarbor(page);
    await pick(page, '/wt-login').click();
    await expect(picker(page)).toHaveCount(0);
    const pane = page.locator('[data-local-diff="folder"]');
    await expect(pane.locator('[data-guide-file-shell="src/auth/redirect.test.ts"]')).toBeVisible({ timeout: 30_000 });
    await expect(pane.locator('[data-guide-file-shell="src/auth/redirect.ts"]')).toBeVisible();
    await page.mouse.move(1300, 880);
    await page.screenshot({ path: join(proofDir, 'A5-opened-worktree-light.png') });
    await expect(pane.locator('[data-local-title]')).toHaveText('fix/login-redirect-loop');
    await expect(pane.locator('[data-local-facts]')).toContainText('harbor');
    await expect(pane.locator('[data-local-facts]')).toContainText('wt-login');
    await expect(pane.locator('[data-local-facts]')).toContainText('uncommitted');
    // It joined the group, titled as in the picker, and is the open one.
    const kept = group(page).locator('[data-local-row$="/wt-login"]');
    await expect(kept).toContainText('fix/login-redirect-loop');
    await expect(kept).toContainText('wt-login');
    await expect(kept).toHaveAttribute('aria-current', 'true');
    page.off('request', watch);
    expect(writes).toEqual([]);
    expect(gitIn(world.folders.login, ['status', '--porcelain'])).toBe(status);
    // Kept: after a reload, closed, it is still in the group.
    await page.goto(`${world.url}#reviews`);
    await page.reload();
    await openGroup(page);
    await expect(group(page).locator('[data-local-row$="/wt-login"]')).toContainText('fix/login-redirect-loop');
  });

  test('a folder with nothing beyond main opens as "Same as main."; it shows in the group only while open', async () => {
    const { page } = world;
    await toHarbor(page);
    await pick(page, '/wt-onboarding').click();
    const pane = page.locator('[data-local-diff="folder"]');
    await expect(pane.locator('[data-local-same]')).toHaveText('Same as main.', { timeout: 30_000 });
    await expect(pane.locator('[data-local-title]')).toHaveText('feat/onboarding-v2');
    await expect(group(page).locator('[data-local-row$="/wt-onboarding"]')).toBeVisible();
    await pane.locator('[data-local-close]').click();
    await expect(group(page).locator('[data-local-row$="/wt-onboarding"]')).toHaveCount(0);
  });

  test('"Another folder…" opens New message\'s folder opener; the folder it picks opens as a review', async () => {
    const { page } = world;
    await plus(page).click();
    await expect(picker(page).locator('[data-local-pick-other]')).toBeVisible();
    await page.mouse.move(1300, 880);
    await page.screenshot({ path: join(proofDir, 'B2-another-folder-light.png') });
    await expect(picker(page).locator('[data-local-pick-other]')).toHaveText('Another folder…');
    await picker(page).locator('[data-local-pick-other]').click();
    await expect(picker(page)).toHaveAttribute('data-local-picker', 'folder');
    const field = page.locator('[data-home-folders-path]');
    await expect(field).toBeFocused();
    await field.fill('~/code/');
    await expect(page.locator('[data-home-folder-option="notes-app"]')).toBeVisible();
    await page.screenshot({ path: join(proofDir, 'B3-another-folder-opener-light.png') });
    await page.locator('[data-home-folder-option="notes-app"]').click();
    await page.locator('[data-home-folder-start="~/code/notes-app"]').click();
    await expect(picker(page)).toHaveCount(0);
    const pane = page.locator('[data-local-diff="folder"]');
    await expect(pane.locator('[data-guide-file-shell="src/tags.ts"]')).toBeVisible({ timeout: 30_000 });
    await expect(pane.locator('[data-local-title]')).toHaveText('ada/tags');
    await expect(group(page).locator('[data-local-row$="/notes-app"]')).toContainText('ada/tags');
  });
});

test.describe('no row at 1440', () => {
  test('B1: with no row, the heading and its + alone; the + still opens the picker', async () => {
    const context = await world.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      // A clean checkout: the list's read answers no row (this world has rows, so the read is answered here); the
      // picker's own reads go to the Inbox.
      await page.route(/\/api\/inbox\/reviews\/local(\?.*)?$/, (route) => route.fulfill({ json: { serverSession: 'e2e', unread: 0, items: [] } }));
      await page.goto(`${world.url}#reviews`);
      await expect(plus(page)).toBeVisible();
      await page.mouse.move(1300, 880);
      await page.screenshot({ path: join(proofDir, 'B1-empty-group-plus-light.png') });
      const fold = group(page).locator('[data-reviews-fold="local"]');
      await expect(fold).toHaveText('On this computer');
      await expect(group(page).locator('[data-local-row], [data-local-none], [data-local-unread]')).toHaveCount(0);
      // One line: the heading's height, open or folded.
      const folded = (await group(page).boundingBox())!.height;
      expect(folded).toBeLessThan(48);
      await fold.click();
      expect((await group(page).boundingBox())!.height).toBe(folded);
      await plus(page).click();
      await expect(picker(page).locator(`[data-local-pick-project="${world.harborId}"]`)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe('phone at 390', () => {
  test("A8: the picker is the screen's sheet, its head back to the projects", async () => {
    const context = await world.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(`${world.url}#reviews`);
      await openGroup(page);
      await group(page).scrollIntoViewIfNeeded();
      await plus(page).click();
      await expect(picker(page)).toHaveAttribute('data-local-picker', 'projects');
      await expect(picker(page).locator('.ib-cp-pickhead')).toContainText('Open');
      await picker(page).locator(`[data-local-pick-project="${world.harborId}"]`).click();
      await expect(pick(page, '/wt-login')).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(proofDir, 'A8-phone-pick-branch-light.png') });
      await expect(picker(page)).toHaveAttribute('data-phone', '');
      await expect(picker(page).locator('[data-local-picker-back]')).toHaveText('Projects');
      await expect(picker(page).locator('.ib-cp-pickhead')).toContainText('harbor');
      expect((await picker(page).boundingBox())!.width).toBeGreaterThan(380);
      // Two lines a row: the name, then its folder and what it holds; a finger's height.
      const row = (await pick(page, '/wt-login').boundingBox())!;
      expect(row.height).toBeGreaterThanOrEqual(43.5);
      await expect(pick(page, '/wt-login').locator('.ib-lp-of')).toHaveText('wt-login · uncommitted');
      await picker(page).locator('[data-local-picker-back]').click();
      await expect(picker(page)).toHaveAttribute('data-local-picker', 'projects');
    } finally {
      await context.close();
    }
  });
});

test.describe('dark at 1440', () => {
  test("A9: a project's folders and branches, dark", async () => {
    const context = await world.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(`${world.url}#reviews`);
      await openGroup(page);
      await toHarbor(page);
      await page.mouse.move(1300, 880);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(proofDir, 'A9-pick-branch-dark.png') });
      await expect(pick(page, '/wt-onboarding').locator('.ib-lp-dim')).toHaveText('same as main');
    } finally {
      await context.close();
    }
  });
});
