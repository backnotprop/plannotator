/**
 * Code review's All files (approved design record "review-explorer", step 1),
 * proved in a real Chromium against the compiled binary:
 *
 *  - a review opens on Changes; picking All files lists the repository at the
 *    diff's new side (`.gitignore` respected), opens on the folders that lead
 *    to changes, and is remembered for the browser (a reload opens on it);
 *  - a file written on disk while the review is open appears in the tree with
 *    the "changed on disk" mark, and the diff does not redraw by itself: the
 *    review's "Diff out of date" banner offers Refresh.
 *
 * Nothing is mocked: `plannotator review` runs in a scratch git repository
 * under a temp PLANNOTATOR_DATA_DIR and HOME, and opens no browser. Build the
 * binary first (see inbox.spec.ts). Screenshots land in
 * .local/proof/review-explorer/ (or $PLANNOTATOR_E2E_PROOF_DIR/review-explorer).
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';

const repoRoot = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repoRoot, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repoRoot, '.local/proof')), 'review-explorer');

/** The first-run dialogs a fresh browser would show, already answered. */
const FIRST_RUN: Record<string, string> = {
  'plannotator-announce-agent-tool-seen': '1',
  'plannotator-announce-ask-session-seen': '1',
  'plannotator-announce-tui-herdr-seen': '1',
  'plannotator-auto-viewed-notice-seen': '1',
  'plannotator-edit-mode-announcement-seen': '3',
  'plannotator-guide-hint-acked': 'true',
  'plannotator-guide-intro-seen': '2',
  'plannotator-plan-look-choice-resolved': 'true',
  'plannotator-review-dest-spotlight-seen': '1',
  'plannotator-token-hover-announcement-seen': '1',
};

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function buildRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  write(repo, '.gitignore', 'dist/\n.env\n');
  write(repo, 'README.md', '# Explorer\n');
  write(repo, 'apps/web/index.ts', 'export const web = 1;\n');
  write(repo, 'packages/review-editor/utils/fileKindTree.ts', 'export function kindFolderPath(kind: string, path: string) {\n  return `${kind}:${path}`;\n}\n');
  write(repo, 'packages/review-editor/utils/buildFileTree.ts', 'export const build = true;\n');
  write(repo, 'packages/shared/review-core.ts', 'export const core = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  write(repo, 'packages/review-editor/utils/fileKindTree.ts', "export function kindFolderPath(kind: string, path: string) {\n  if (path === '') return kind;\n  return `${kind}:${path}`;\n}\n");
  write(repo, 'packages/review-editor/utils/explorerTree.ts', 'export const EXPLORER_ROW_HEIGHT = 28;\n');
  write(repo, 'dist/bundle.js', 'built\n');
  write(repo, '.env', 'SECRET=1\n');
  return repo;
}

async function openReview(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url })));
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('[data-tree-scope-row]')).toBeVisible();
  return page;
}

/** Stops the review server and waits for it, so its data folder can go. */
async function stopReview(child: ChildProcess | undefined, root: string) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const treeRows = (page: Page) =>
  page.locator('[data-repo-file-tree] [role="treeitem"]').evaluateAll((rows) =>
    rows.map((row) => {
      const folder = row.querySelector<HTMLElement>('[data-repo-folder]');
      if (folder) return `dir:${folder.dataset.repoFolder}`;
      const file = row.querySelector<HTMLElement>('[data-repo-file]');
      return `${file?.hasAttribute('data-repo-changed') ? 'changed' : 'file'}:${file?.dataset.repoFile}`;
    }),
  );

test('All files: the repository at the diff, remembered, and following the disk while the diff waits for Refresh', async ({ browser }) => {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  mkdirSync(proofDir, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'plannotator-review-explorer-'));
  const repo = buildRepo(root);
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    NO_BROWSER,
    PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  let child: ChildProcess | undefined;
  try {
    child = spawn(binary, ['review', '--diff-type', 'uncommitted'], { env, cwd: repo, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;

    const page = await openReview(browser, url);
    // A review opens on Changes, as before: the repository is not listed.
    await expect(page.locator('[data-tree-scope="changes"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-tree-scope="changes"]')).toContainText('2');
    await expect(page.locator('[data-repo-file-tree]')).toHaveCount(0);
    await page.screenshot({ path: join(proofDir, '02-changes.png') });

    await page.locator('[data-tree-scope="all"]').click();
    await expect(page.locator('[data-repo-file-tree]')).toBeVisible();
    await expect(page.locator('[data-tree-scope="all"]')).toContainText('All files7');
    expect(await treeRows(page)).toEqual([
      'dir:apps',
      'dir:packages',
      'dir:packages/review-editor',
      'dir:packages/review-editor/utils',
      'file:packages/review-editor/utils/buildFileTree.ts',
      'changed:packages/review-editor/utils/explorerTree.ts',
      'changed:packages/review-editor/utils/fileKindTree.ts',
      'dir:packages/shared',
      'file:.gitignore',
      'file:README.md',
    ]);
    await expect(page.locator('[data-repo-folder="packages"] [data-repo-folder-changes]')).toHaveText('2');
    await page.screenshot({ path: join(proofDir, '01-tree.png') });

    // Remembered for this browser: a reload opens on All files.
    await page.reload();
    await expect(page.locator('[data-tree-scope="all"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-repo-file-tree]')).toBeVisible();
    await expect(page.locator('[data-repo-listing-status]')).toContainText('Live');

    // An agent writes files: the tree follows, the diff does not.
    await page.waitForTimeout(1500); // the server's watcher starts off the request path
    const diffFilesBefore = await page.locator('[data-tree-scope="changes"]').textContent();
    write(repo, 'packages/review-editor/utils/newFromAgent.ts', 'export const fromAgent = true;\n');
    write(repo, 'packages/review-editor/utils/fileKindTree.ts', "export function kindFolderPath(kind: string, path: string) {\n  if (path === '') return kind;\n  return `${kind}/${path}`;\n}\n");
    await expect(page.locator('[data-repo-file="packages/review-editor/utils/newFromAgent.ts"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-repo-file="packages/review-editor/utils/newFromAgent.ts"] [data-repo-on-disk="A"]')).toBeVisible();
    await expect(page.locator('[data-repo-file="packages/review-editor/utils/fileKindTree.ts"] [data-repo-on-disk="M"]')).toBeVisible();
    await expect(page.locator('[data-repo-listing-status]')).toContainText('1 added, 1 edited');
    // The diff is still the snapshot: same changed files, and the banner offers Refresh.
    await expect(page.locator('[data-tree-scope="changes"]')).toHaveText(diffFilesBefore ?? '');
    await expect(page.getByText('Diff out of date')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: join(proofDir, '09-live.png') });

    // Back to Changes, and that is remembered too.
    await page.locator('[data-tree-scope="changes"]').click();
    await page.reload();
    await expect(page.locator('[data-tree-scope="changes"]')).toHaveAttribute('aria-pressed', 'true');
    await page.context().close();
  } finally {
    await stopReview(child, root);
  }
});
