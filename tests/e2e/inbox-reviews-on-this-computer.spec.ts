/**
 * Reviews' "On this computer" (approval "inbox-reviews-compact-list", part 2), in a real browser against the compiled
 * binary: this computer's work in no pull request sits in a folded group at the foot of the Reviews list, for every
 * project, and a click opens its diff beside the list with no agent involved.
 *
 * What regresses if these fail:
 *  1. The group missing at the foot of the list, open at first, or its count wrong (01).
 *  2. Open, a row missing or wrong: each branch with work of its own and its project and age, the folder's
 *     "Uncommitted on main"; the default branch or a branch with nothing of its own listed (02).
 *  3. A branch row's click not opening that branch's whole diff, read by ref (the folder stays on main, its changes
 *     untouched), or sending anything anywhere (03).
 *  4. The Uncommitted row not opening the folder's own changes, new files too (04); Close not returning to the list
 *     with the group still open.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/reviews-on-this-computer, light and dark at 1440. HOME is a scratch folder,
 * and the sandbox env keeps the binary off the person's agents. Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-reviews-on-this-computer.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { E2E_GROUP_TIP_SEEN, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'reviews-on-this-computer');

const MINUTE = 60;
const BRANCH = 'fix/guide-global-comment-keep-words';

/** A project folder with main, and git run in it at a given time (seconds before now). */
function gitProject(parent: string, name: string) {
  const path = scratchProject(parent, name);
  const git = (args: string[], secondsAgo = 3 * 86_400) => {
    const date = `@${Math.floor(Date.now() / 1000) - secondsAgo} +0000`;
    const run = spawnSync('git', args, { cwd: path, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Charlie Dunn', GIT_AUTHOR_EMAIL: 'charlie@example.com', GIT_COMMITTER_NAME: 'Charlie Dunn', GIT_COMMITTER_EMAIL: 'charlie@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  const commit = (file: string, text: string, secondsAgo?: number) => {
    mkdirSync(join(path, file, '..'), { recursive: true });
    writeFileSync(join(path, file), text);
    git(['add', '-A'], secondsAgo);
    git(['commit', '-q', '-m', file], secondsAgo);
  };
  commit('src/comments.ts', 'export const keep = false;\n', 20 * 86_400);
  git(['branch', '-M', 'main']);
  return { path, git, commit };
}

interface World {
  url: string;
  plannotator: string;
  plannotatorId: string;
  git: (args: string[]) => string;
  context: BrowserContext;
  page: Page;
}

let world: World;

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-reviews-local-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const configFile = join(dataDir, 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(configFile, JSON.stringify({ ...config, inboxCodeReview: true, inboxReveals: { ...E2E_GROUP_TIP_SEEN, code_review: { shownAt: '2026-10-24T00:00:00.000Z' } } }));
  // Signed out: no forge is asked and Reviews lists no PRs. Nothing else here may reach glab or tailscale.
  const fakes = join(root, 'fakes');
  mkdirSync(fakes);
  writeFileSync(join(fakes, 'gh'), '#!/bin/sh\necho "You are not logged into any GitHub hosts." >&2\nexit 1\n');
  for (const name of ['glab', 'tailscale']) writeFileSync(join(fakes, name), `#!/bin/sh\necho "reviews-local: ${name} must not run" >&2\nexit 97\n`);
  for (const name of ['gh', 'glab', 'tailscale']) chmodSync(join(fakes, name), 0o755);
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
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();

  // plannotator: Ada's branch with work of its own (not checked out), a branch with nothing of its own, and changes
  // on main in the folder, one of them a new file. spaces-site: Bob's branch.
  const src = join(root, 'src');
  const plannotator = gitProject(src, 'plannotator');
  plannotator.git(['checkout', '-q', '-b', BRANCH]);
  plannotator.commit('src/comments.ts', 'export const keep = true;\nexport const words = "kept";\n', 12 * MINUTE);
  plannotator.git(['checkout', '-q', 'main']);
  plannotator.git(['branch', 'same-as-main']);
  writeFileSync(join(plannotator.path, 'src/comments.ts'), 'export const keep = false;\nexport const draft = "Ada Novak";\n');
  writeFileSync(join(plannotator.path, 'NOTES.md'), '# Notes\n\nBob Tully asked for this.\n');
  const spaces = gitProject(src, 'spaces-site');
  spaces.git(['checkout', '-q', '-b', 'feat/spaces-share-link']);
  spaces.commit('share.ts', 'export const share = true;\n', 2 * 3600);
  spaces.git(['checkout', '-q', 'main']);

  // Both folders are Inbox projects: an agent wrote from each. One review thread, so the list has a row above the group.
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number };
  const client = new Client({ name: 'reviews-local', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${registry.port}/mcp`)));
  const patch = 'diff --git a/src/comments.ts b/src/comments.ts\n--- a/src/comments.ts\n+++ b/src/comments.ts\n@@ -1 +1 @@\n-export const keep = false;\n+export const keep = true;\n';
  const guide = { title: 'Keep a global comment', intent: 'A failed add keeps the words.', sections: [{ title: 'The keep', overview: 'One line.', diffs: [{ file: 'src/comments.ts', summary: 'Keep.' }] }], review: { gitRef: 'main...HEAD', base: 'main' }, generator: { engine: 'claude-code', model: 'claude-opus-5' } };
  const sent = (await client.callTool({ name: 'submit_guide', arguments: { project_path: plannotator.path, guide, patch, review: true, subject: 'Keep a global comment', body: 'Ready for review.', agent_session: 'ses-local', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[] };
  if (sent.isError) throw new Error(sent.content?.map((c) => c.text).join(' '));
  const note = (await client.callTool({ name: 'send_message', arguments: { project_path: spaces.path, subject: 'Share links', body: 'Started on share links.', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[] };
  if (note.isError) throw new Error(note.content?.map((c) => c.text).join(' '));
  await client.close().catch(() => {});

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const projects = (await (await page.request.get(`${url}api/inbox/projects`)).json()) as { projects?: { id: string; root: string }[] };
  const plannotatorId = projects.projects?.find((p) => p.root === plannotator.path)?.id ?? '';
  expect(plannotatorId).toBeTruthy();
  world = { url, plannotator: plannotator.path, plannotatorId, git: (args) => plannotator.git(args), context, page };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

const group = (page: Page) => page.locator('[data-pulls-group="local"]');
const row = (page: Page, key: string) => group(page).locator(`[data-local-row="${key}"]`);

test('the group sits folded at the foot of the list, with its count', async () => {
  const { page } = world;
  await page.goto(`${world.url}#reviews`);
  await expect(page.locator('[data-reviews-row]').first()).toBeVisible();
  const toggle = group(page).locator('[data-reviews-fold="local"]');
  await expect(toggle).toHaveText('On this computer 3');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(group(page).locator('[data-local-row]')).toHaveCount(0);
  // The last group of the list.
  expect(await page.locator('.ib-lbody [role="group"]').last().getAttribute('data-pulls-group')).toBe('local');
  await shot(page, '01-group-folded');
});

test('open, each row is one line: its work, its project, its age', async () => {
  const { page } = world;
  await group(page).locator('[data-reviews-fold="local"]').click();
  const rows = group(page).locator('[data-local-row]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Uncommitted on main');
  await expect(rows.nth(0)).toContainText('plannotator');
  await expect(rows.nth(1)).toContainText(BRANCH);
  await expect(rows.nth(1)).toContainText('12m');
  await expect(rows.nth(2)).toContainText('feat/spaces-share-link');
  await expect(rows.nth(2)).toContainText('spaces-site');
  await expect(rows.nth(2)).toContainText('2h');
  await expect(group(page).locator('[data-local-row$=":same-as-main"], [data-local-row$=":main"]')).toHaveCount(0);
  // One line each.
  for (let i = 0; i < 3; i++) expect((await rows.nth(i).boundingBox())!.height).toBeLessThan(46);
  await shot(page, '02-group-open');
});

test("a branch row opens that branch's whole diff beside the list; nothing is sent, the folder is untouched", async () => {
  const { page } = world;
  const writes: string[] = [];
  const watch = (request: { method: () => string; url: () => string }) => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
  };
  page.on('request', watch);
  const status = world.git(['status', '--porcelain']);
  await row(page, `${world.plannotatorId}:${BRANCH}`).click();
  const pane = page.locator('[data-local-diff="branch"]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('[data-local-title]')).toHaveText(BRANCH);
  await expect(pane.locator('[data-local-facts]')).toContainText('against main');
  const file = pane.locator('[data-guide-file-shell="src/comments.ts"]');
  await expect(file).toBeVisible({ timeout: 30_000 });
  await expect(file.locator('[data-line-type="change-addition"]').first()).toBeVisible();
  // The branch's work only: the folder's own changes are not in it.
  await expect(pane.locator('[data-guide-file-shell="NOTES.md"]')).toHaveCount(0);
  await expect(row(page, `${world.plannotatorId}:${BRANCH}`)).toHaveAttribute('aria-current', 'true');
  await shot(page, '03-branch-diff');
  page.off('request', watch);
  expect(writes).toEqual([]);
  // Read by ref: still on main, its own changes as they were.
  expect(world.git(['symbolic-ref', '--short', 'HEAD'])).toBe('main');
  expect(world.git(['status', '--porcelain'])).toBe(status);
});

test("the Uncommitted row opens the folder's own changes; Close returns to the list with the group open", async () => {
  const { page } = world;
  await row(page, `${world.plannotatorId}:`).click();
  const pane = page.locator('[data-local-diff="uncommitted"]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('[data-local-title]')).toHaveText('Uncommitted on main');
  await expect(pane.locator('[data-guide-file-shell="NOTES.md"]')).toBeVisible({ timeout: 30_000 });
  await expect(pane.locator('[data-guide-file-shell="src/comments.ts"]')).toBeVisible();
  await shot(page, '04-uncommitted-diff');
  await pane.locator('[data-local-close]').click();
  await expect(page.locator('[data-local-diff]')).toHaveCount(0);
  await expect(group(page).locator('[data-reviews-fold="local"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(group(page).locator('[data-local-row]')).toHaveCount(3);
});
