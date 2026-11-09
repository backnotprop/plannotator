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
 * under a temp PLANNOTATOR_DATA_DIR and HOME, with a PATH of its own (no agent
 * CLI), and opens no browser. Build the
 * binary first (see inbox.spec.ts). Screenshots land in
 * .local/proof/review-explorer/ (or $PLANNOTATOR_E2E_PROOF_DIR/review-explorer).
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';

const repoRoot = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repoRoot, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repoRoot, '.local/proof')), 'review-explorer');

/** The first-run dialogs a fresh browser would show, already answered. */
const FIRST_RUN: Record<string, string> = {
  'plannotator-announce-agent-tool-seen': '1',
  'plannotator-announce-ask-session-seen': '1',
  'plannotator-announce-inbox-seen': '1',
  'plannotator-announce-tui-herdr-seen': '1',
  'plannotator-auto-viewed-notice-seen': '1',
  'plannotator-edit-mode-announcement-seen': '3',
  'plannotator-guide-hint-acked': 'true',
  'plannotator-guide-intro-seen': '2',
  'plannotator-plan-look-choice-resolved': 'true',
  'plannotator-review-dest-spotlight-seen': '1',
  'plannotator-token-hover-announcement-seen': '1',
};

/**
 * The review server's own PATH: links to git and ripgrep (Go to Definition), then /usr/bin:/bin. Never the
 * runner's PATH: on its first /api/ai/capabilities the server lists Ask AI models by running `<engine> models`
 * for every engine CLI it finds there (discoverMarkerModels in packages/server/agent-jobs.ts), which on a
 * computer with Cursor, OpenCode, Pi or Copilot is the real CLI (tests/e2e/agent-cli-stubs.ts).
 */
function ownPath(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of ['git', 'rg']) {
    const found = (process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, tool))
      .find((file) => {
        try {
          accessSync(file, constants.X_OK);
          return statSync(file).isFile();
        } catch {
          return false;
        }
      });
    if (found) symlinkSync(found, join(bin, tool));
  }
  return [bin, '/usr/bin', '/bin'].join(delimiter);
}

/** `plannotator review`'s environment: scratch HOME and data dir, no browser, a PATH of its own. */
function reviewEnv(root: string, readyFile: string): NodeJS.ProcessEnv {
  return {
    PATH: ownPath(root),
    HOME: root,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    NO_BROWSER,
    PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
}

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
  const env = reviewEnv(root, readyFile);
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
    await page.screenshot({ path: join(proofDir, '01-tree.png') });

    // Remembered for this browser: a reload opens on All files.
    await page.reload();
    await expect(page.locator('[data-tree-scope="all"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-repo-file-tree]')).toBeVisible();
    await expect(page.locator('[data-repo-listing-status]')).toContainText('is live');

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

test('Any file in a tab: preview, keep, Whole file with change bars, and a comment outside the diff reaching the agent', async ({ browser }) => {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  mkdirSync(proofDir, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'plannotator-review-explorer-'));
  const repo = buildRepo(root);
  // A long file the review does not change (keeping a preview tab keeps its scroll).
  write(repo, 'packages/shared/long.ts', `${Array.from({ length: 600 }, (_, n) => `export const line${n + 1} = ${n + 1};`).join('\n')}\n`);
  git(repo, ['add', 'packages/shared/long.ts']);
  git(repo, ['commit', '-q', '-m', 'long', '--', 'packages/shared/long.ts']);
  const readyFile = join(root, 'ready.jsonl');
  const env = reviewEnv(root, readyFile);
  let child: ChildProcess | undefined;
  let stdout = '';
  try {
    child = spawn(binary, ['review', '--diff-type', 'uncommitted'], { env, cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const page = await openReview(browser, url);
    await page.locator('[data-tree-scope="all"]').click();
    await expect(page.locator('[data-repo-file-tree]')).toBeVisible();

    // A single click previews an unchanged file: italic tab, "Not in this review".
    await page.locator('button[data-repo-file="packages/review-editor/utils/buildFileTree.ts"]').click();
    const view = page.locator('[data-repo-file-view="packages/review-editor/utils/buildFileTree.ts"]');
    await expect(view).toBeVisible();
    await expect(view.locator('[data-not-in-review]')).toHaveText('Not in this review');
    await expect(view.locator('[data-repo-file-revision]')).toHaveText('at working tree');
    await expect(page.locator('[data-preview-tab]')).toHaveCount(1);
    await expect(page.locator('[data-preview-tab] .dv-review-tab-label')).toHaveText('buildFileTree.ts');

    // The next single click replaces the preview: still one preview tab.
    await page.locator('button[data-repo-file="README.md"]').click();
    await expect(page.locator('[data-repo-file-view="README.md"]')).toBeVisible();
    await expect(page.locator('[data-preview-tab]')).toHaveCount(1);
    await expect(page.locator('[data-preview-tab] .dv-review-tab-label')).toHaveText('README.md');
    await expect(page.locator('.dv-review-tab', { hasText: 'buildFileTree.ts' })).toHaveCount(0);

    // A double click on the tab keeps it.
    await page.locator('[data-preview-tab]').dblclick();
    await expect(page.locator('[data-preview-tab]')).toHaveCount(0);
    await expect(page.locator('.dv-review-tab', { hasText: 'README.md' })).toHaveCount(1);
    await expect(page.locator('[data-repo-file-view="README.md"] [data-preview-hint]')).toHaveCount(0);

    // A changed file: Changes | Whole file, the new side with change bars.
    await page.locator('[data-repo-file="packages/review-editor/utils/fileKindTree.ts"] button').first().click();
    await expect(page.locator('[data-file-view-switch]')).toBeVisible();
    await page.locator('[data-file-view="whole"]').click();
    const whole = page.locator('[data-whole-file-view="packages/review-editor/utils/fileKindTree.ts"]');
    await expect(whole).toBeVisible();
    await expect(whole).toContainText("if (path === '') return kind;");
    await page.screenshot({ path: join(proofDir, '05-whole.png') });
    await page.locator('[data-file-view="changes"]').click();
    await expect(whole).toHaveCount(0);

    // Commenting in a preview tab keeps that same tab: its place in the strip
    // and the line on screen (it is not closed and opened again).
    await page.locator('[data-repo-folder="packages/shared"]').click();
    await page.locator('button[data-repo-file="packages/shared/long.ts"]').click();
    const longView = page.locator('[data-repo-file-view="packages/shared/long.ts"]');
    await expect(longView.locator('[data-line="401"]').first()).toBeAttached();
    // The file draws, then draws again highlighted: scroll once it settles.
    await expect(async () => {
      const top = await longView.evaluate((view) => {
        const scroller = view.querySelector<HTMLElement>('.overflow-auto');
        const line = view.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line="401"]');
        if (!scroller || !line) return 0;
        scroller.scrollTop += line.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 200;
        return scroller.scrollTop;
      });
      expect(top).toBeGreaterThan(5_000);
    }).toPass({ timeout: 10_000 });
    await page.waitForTimeout(300);
    const tabOrder = () => page.locator('.dv-review-tab-label').allTextContents();
    const tabsBefore = await tabOrder();
    // The same view, scrolled where it was: not remounted at line 1.
    await longView.evaluate((el) => { (window as Window & { __longView?: Element }).__longView = el; });
    const scrollTop = () => longView.evaluate((el) => el.querySelector('.overflow-auto')?.scrollTop ?? 0);
    const topBefore = await scrollTop();
    expect(topBefore).toBeGreaterThan(5_000);
    await longView.locator('[data-line="401"]').first().click();
    const longComposer = page.getByRole('textbox', { name: 'Add a comment...' });
    await longComposer.fill('Does line 401 still matter?');
    await longComposer.press('ControlOrMeta+Enter');
    await expect(longView.locator('[data-code-annotation-outside-diff]')).toHaveText('not in the diff');
    await expect(page.locator('[data-preview-tab]')).toHaveCount(0);
    expect(await tabOrder()).toEqual(tabsBefore);
    expect(Math.abs((await scrollTop()) - topBefore)).toBeLessThan(200);
    expect(await longView.evaluate((el) => el === (window as Window & { __longView?: Element }).__longView)).toBe(true);
    // Back to the kept tab from the tree after another file: where it was, not line 1.
    const keptTop = await scrollTop();
    await page.locator('button[data-repo-file="README.md"]').click();
    await expect(page.locator('[data-repo-file-view="README.md"]')).toBeVisible();
    await page.locator('button[data-repo-file="packages/shared/long.ts"]').click();
    await expect(longView).toBeVisible();
    await expect.poll(scrollTop).toBeGreaterThan(keptTop - 200);

    // A comment on a file the review does not change keeps the preview tab
    // and reaches the agent labelled, with the code.
    await page.locator('button[data-repo-file="packages/shared/review-core.ts"]').click();
    const coreView = page.locator('[data-repo-file-view="packages/shared/review-core.ts"]');
    await expect(coreView).toBeVisible();
    await coreView.locator('[data-line="1"]').first().click();
    const composer = page.getByRole('textbox', { name: 'Add a comment...' });
    await composer.fill('Is this constant still used?');
    await composer.press('ControlOrMeta+Enter');
    await expect(coreView.locator('[data-code-annotation-outside-diff]')).toHaveText('not in the diff');
    await expect(page.locator('[data-preview-tab]')).toHaveCount(0);
    await expect(page.locator('button[data-repo-file="packages/shared/review-core.ts"]')).toContainText('1');
    await page.screenshot({ path: join(proofDir, '08-comment.png') });

    await page.getByRole('button', { name: /Send Feedback/ }).first().click();
    await expect.poll(() => stdout, { timeout: 20_000 }).toContain('(not in the diff)');
    expect(stdout).toContain('packages/shared/review-core.ts');
    expect(stdout).toContain('Is this constant still used?');
    expect(stdout).toContain('export const core = 1;');
    await page.context().close();
  } finally {
    await stopReview(child, root);
  }
});

test('Go to File, Go to Definition and References into tabs, Back / Forward, next change', async ({ browser }) => {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  test.skip(spawnSync('rg', ['--version']).status !== 0, 'Go to Definition searches with ripgrep');
  mkdirSync(proofDir, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'plannotator-review-explorer-'));
  const repo = buildRepo(root);
  // A symbol the changed lines use, defined in a file the review does not change.
  write(repo, 'packages/shared/kinds.ts', '// Labels for file kinds.\n\nexport function kindLabel(kind: string): string {\n  return kind.toUpperCase();\n}\n');
  // A long file with many changes, taller than the screen, for Next change.
  const longLines = Array.from({ length: 600 }, (_, i) => `export const line${i + 1} = ${i + 1};`);
  write(repo, 'packages/shared/long.ts', `${longLines.join('\n')}\n`);
  git(repo, ['add', 'packages/shared/kinds.ts', 'packages/shared/long.ts']);
  git(repo, ['commit', '-q', '-m', 'kinds', '--', 'packages/shared/kinds.ts', 'packages/shared/long.ts']);
  write(repo, 'packages/shared/long.ts', `${longLines.map((line, i) => (i % 20 === 10 ? `${line} // changed` : line)).join('\n')}\n`);
  write(repo, 'packages/review-editor/utils/fileKindTree.ts', "import { kindLabel } from '../../shared/kinds';\nimport { line2 } from '../../shared/long';\n\nexport function kindFolderPath(kind: string, path: string) {\n  if (path === '') return kindLabel(kind);\n  return `${kind}:${path}:${line2}`;\n}\n");
  const readyFile = join(root, 'ready.jsonl');
  const env = reviewEnv(root, readyFile);
  // VS Code's Back / Forward differ per system; headless Chromium reports the host's.
  const back = process.platform === 'darwin' ? 'Control+Minus' : process.platform === 'win32' ? 'Alt+ArrowLeft' : 'Control+Alt+Minus';
  const forward = process.platform === 'darwin' ? 'Control+Shift+Minus' : process.platform === 'win32' ? 'Alt+ArrowRight' : 'Control+Shift+Minus';
  let child: ChildProcess | undefined;
  try {
    child = spawn(binary, ['review', '--diff-type', 'uncommitted'], { env, cwd: repo, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const page = await openReview(browser, url);
    const activeTab = page.locator('.dv-active-tab .dv-review-tab-label').first();

    // With no symbol under the pointer F12 is left to the browser (developer tools).
    expect(await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'F12', code: 'F12', bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(false);
    await expect(page.locator('[data-code-nav-location]')).toHaveCount(0);

    // The changed file on its diff.
    await page.locator('.file-tree-item', { hasText: 'fileKindTree.ts' }).first().click();
    await expect(page.locator('[data-file-view-switch]')).toBeVisible();

    // Go to File (Mod+P): fuzzy over the whole repository; the changed file is marked.
    await page.keyboard.press('ControlOrMeta+p');
    await expect(page.locator('[data-go-to-file]')).toBeVisible();
    await page.keyboard.type('bft');
    await expect(page.locator('[data-goto-path]').first()).toHaveAttribute('data-goto-path', 'packages/review-editor/utils/buildFileTree.ts');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('fkt');
    await expect(page.locator('[data-goto-path="packages/review-editor/utils/fileKindTree.ts"] [data-goto-status]')).toHaveText('M');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('readme');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-go-to-file]')).toHaveCount(0);
    await expect(page.locator('[data-repo-file-view="README.md"]')).toBeVisible();
    await expect(page.locator('[data-repo-file-view="README.md"] [data-jump-crumb]')).toContainText('From fileKindTree.ts · Go to File');

    // Back returns to the diff; Forward to the file.
    await page.keyboard.press(back);
    await expect(activeTab).toHaveText('fileKindTree.ts');
    await page.keyboard.press(forward);
    await expect(page.locator('[data-repo-file-view="README.md"]')).toBeVisible();
    await page.keyboard.press(back);
    await expect(activeTab).toHaveText('fileKindTree.ts');

    // F12 on a symbol of the diff: its one definition opens in a tab at its line.
    const token = page.locator('[data-char]', { hasText: /^kindLabel$/ }).last();
    await token.hover();
    await page.keyboard.press('F12');
    const kinds = page.locator('[data-repo-file-view="packages/shared/kinds.ts"]');
    await expect(kinds).toBeVisible({ timeout: 20_000 });
    await expect(kinds.locator('[data-jump-crumb]')).toContainText('From fileKindTree.ts:5 · Go to Definition (F12)');
    await expect(kinds.locator('[data-line="3"][data-selected-line]').first()).toBeAttached();
    await page.screenshot({ path: join(proofDir, '07-definition.png') });

    // A definition on a changed file's line outside its hunks opens its Whole
    // file view; Back puts the file back on Changes.
    await page.keyboard.press(back);
    await expect(activeTab).toHaveText('fileKindTree.ts');
    await page.locator('[data-char]', { hasText: /^line2$/ }).last().hover();
    await page.keyboard.press('F12');
    const longWhole = page.locator('[data-whole-file-view="packages/shared/long.ts"]');
    await expect(longWhole).toBeVisible({ timeout: 20_000 });
    await expect(longWhole.locator('[data-line="2"][data-selected-line]').first()).toBeAttached();
    await page.keyboard.press(back);
    await expect(activeTab).toHaveText('fileKindTree.ts');
    await page.locator('.file-tree-item', { hasText: 'long.ts' }).first().click();
    await expect(page.locator('[data-file-view="changes"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.file-tree-item', { hasText: 'fileKindTree.ts' }).first().click();
    await expect(activeTab).toHaveText('fileKindTree.ts');
    await page.locator('[data-char]', { hasText: /^kindLabel$/ }).last().hover();
    await page.keyboard.press('F12');
    await expect(kinds).toBeVisible({ timeout: 20_000 });

    // Shift+F12 on the definition: the references panel; a result opens in a tab.
    await kinds.locator('[data-line="3"] [data-char]', { hasText: /^kindLabel$/ }).first().hover();
    await page.keyboard.press('Shift+F12');
    const reference = page.locator('[data-code-nav-location^="packages/review-editor/utils/fileKindTree.ts:"]').first();
    await expect(reference).toBeVisible({ timeout: 20_000 });
    await reference.click();
    await expect(page.locator('[data-jump-crumb]', { hasText: 'References' }).first()).toBeVisible();
    await expect(page.locator('[data-nav-history="back"]').first()).toBeEnabled();
    await page.screenshot({ path: join(proofDir, '07-refs.png') });

    // Next change: this diff fits the screen, so on to the next changed file.
    await page.locator('.file-tree-item', { hasText: 'fileKindTree.ts' }).first().click();
    await expect(activeTab).toHaveText('fileKindTree.ts');
    await page.keyboard.press('Alt+F5');
    await expect(activeTab).toHaveText('long.ts');
    // In a diff taller than the screen it walks the runs of changes, down and back up.
    const scrollTop = () => page.evaluate(() => {
      const host = document.querySelector('.dv-active-group diffs-container');
      let node: Element | null = host;
      while (node) {
        if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node.scrollTop;
        node = node.parentElement;
      }
      return -1;
    });
    await expect.poll(scrollTop).toBeGreaterThan(-1);
    const first = await scrollTop();
    await page.keyboard.press('Alt+F5');
    await expect.poll(scrollTop).toBeGreaterThan(first);
    const second = await scrollTop();
    await page.keyboard.press('Alt+F5');
    await expect.poll(scrollTop).toBeGreaterThan(second);
    await page.keyboard.press('Shift+Alt+F5');
    await expect.poll(scrollTop).toBe(second);
    await expect(activeTab).toHaveText('long.ts');
    await page.context().close();
  } finally {
    await stopReview(child, root);
  }
});

test('Go to File from a text field on macOS needs ⌘ (⌃P stays the field\'s)', async ({ browser }) => {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  const root = mkdtempSync(join(tmpdir(), 'plannotator-review-explorer-'));
  const repo = buildRepo(root);
  const readyFile = join(root, 'ready.jsonl');
  const env = reviewEnv(root, readyFile);
  let child: ChildProcess | undefined;
  try {
    child = spawn(binary, ['review', '--diff-type', 'uncommitted'], { env, cwd: repo, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // The page reads the system from navigator.platform when it loads.
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
    await context.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url })));
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator('[data-tree-scope-row]')).toBeVisible();
    await page.evaluate(() => {
      const field = document.createElement('textarea');
      field.setAttribute('data-test-field', '');
      document.body.appendChild(field);
      field.focus();
    });
    await page.keyboard.press('Control+p');
    await page.waitForTimeout(300);
    await expect(page.locator('[data-go-to-file]')).toHaveCount(0);
    await page.locator('[data-test-field]').focus();
    await page.keyboard.press('Meta+p');
    await expect(page.locator('[data-go-to-file]')).toBeVisible();
    // Escape puts focus back in the field it came from.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-go-to-file]')).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-test-field'))).toBe(true);
    await context.close();
  } finally {
    await stopReview(child, root);
  }
});
