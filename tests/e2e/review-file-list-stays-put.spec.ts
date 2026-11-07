/**
 * #2713: opening a file in code review must not move the list under the
 * pointer, or the next click opens another file. Proved in a real Chromium,
 * against the compiled binary, because only real layout shows it:
 *
 *  - All changes, every file folded: opening one leaves every header where it
 *    was. Pierre laid each open file out 8px taller per separator gap than it
 *    draws, and its sticky window sat at the bottom of that room, below the
 *    first header's place.
 *  - Hide viewed on: the file you leave (auto-marked viewed) keeps its row
 *    while the pointer is in the panel, and goes once the pointer leaves.
 *
 * Nothing is mocked: `plannotator review` runs in a scratch git repository
 * under a temp PLANNOTATOR_DATA_DIR and HOME, with a PATH of its own (no agent
 * CLI), and opens no browser. Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';

const repoRoot = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repoRoot, '.local/plannotator'));

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

/** The review server's own PATH: a link to git, then /usr/bin:/bin. Never the runner's PATH (see review-explorer.spec.ts). */
function ownPath(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const found = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, 'git'))
    .find((file) => {
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (found) symlinkSync(found, join(bin, 'git'));
  return [bin, '/usr/bin', '/bin'].join(delimiter);
}

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

const MODIFIED = [
  'docs/architecture.md',
  'src/core/protocol/opcodes/parameters.md',
  'src/services/bridge/README.md',
  'src/services/parameters/README.md',
  'src/services/session/access.hpp',
  'src/services/session/session.hpp',
  'src/services/CMakeLists.txt',
  'src/services/service.hpp',
  'src/transport/README.md',
  'README.md',
];
const ADDED = [
  'src/services/points/README.md',
  'src/services/transaction/README.md',
  'src/services/transaction/transaction.cpp',
  'src/services/transaction/transaction.hpp',
  'src/services/operation.hpp',
];
const lines = (path: string, count: number, word: string) =>
  Array.from({ length: count }, (_, i) => `// ${word} line ${i} of ${path}`).join('\n') + '\n';

/** The issue's shape: 15 files in nested folders; each modified file has three hunks (four separators). */
function buildRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  for (const path of MODIFIED) write(repo, path, lines(path, 60, 'base'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  git(repo, ['checkout', '-q', '-b', 'feature/services']);
  for (const path of MODIFIED) {
    const next = lines(path, 60, 'base').split('\n');
    for (const at of [5, 25, 45]) next[at] = next[at]!.replace('base', 'changed');
    write(repo, path, next.join('\n'));
  }
  for (const path of ADDED) write(repo, path, lines(path, 30, 'new'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'services']);
  return repo;
}

async function stopReview(child: ChildProcess | undefined, root: string) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function withReview(browser: Browser, run: (page: Page) => Promise<void>) {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  const root = mkdtempSync(join(tmpdir(), 'plannotator-review-stays-put-'));
  const repo = buildRepo(root);
  const readyFile = join(root, 'ready.jsonl');
  let child: ChildProcess | undefined;
  try {
    child = spawn(binary, ['review'], { env: reviewEnv(root, readyFile), cwd: repo, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    // The issue's window size.
    const context = await browser.newContext({ viewport: { width: 1274, height: 1185 } });
    await context.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url })));
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator('[data-review-sticky-tools]')).toBeVisible();
    await run(page);
    await context.close();
  } finally {
    await stopReview(child, root);
  }
}

/**
 * Each file of the All changes list, top to bottom: the box of its item (one
 * `diffs-container` per file) and of its path in the header (`span[title]`,
 * the one header part every mode draws; the action buttons change with the
 * session, e.g. "Choose app to open in" on a live checkout).
 */
const mainHeaders = (page: Page) =>
  page.evaluate((paths) => {
    const out: { path: string; top: number; height: number; nameX: number; nameY: number }[] = [];
    for (const path of paths) {
      const name = document.querySelector(`diffs-container span[title="${CSS.escape(path)}"]`);
      const item = name?.closest('diffs-container');
      if (!name || !item) continue;
      const box = item.getBoundingClientRect();
      const nameBox = name.getBoundingClientRect();
      out.push({ path, top: box.top, height: box.height, nameX: nameBox.left + nameBox.width / 2, nameY: nameBox.top + nameBox.height / 2 });
    }
    return out.sort((a, b) => a.top - b.top);
  }, [...MODIFIED, ...ADDED]);

test('All changes: opening a folded file leaves every header where it was', async ({ browser }) => {
  await withReview(browser, async (page) => {
    await page.locator('[data-review-sidebar] [title="Every change of this review in one view"]').click();
    // Fold every file (the dock button reads "Expand all files" once they all are).
    const foldToggle = page.getByRole('button', { name: /^(Collapse|Expand) all files$/ });
    await expect(foldToggle).toBeVisible();
    if ((await foldToggle.getAttribute('aria-label')) === 'Collapse all files') await foldToggle.click();
    await expect(page.getByRole('button', { name: 'Expand all files' })).toBeVisible();
    await expect.poll(async () => (await mainHeaders(page)).length).toBe(15);
    await expect.poll(async () => (await mainHeaders(page)).filter((h) => h.height > 40).length).toBe(0);

    const before = await mainHeaders(page);
    const target = before[12]!;
    const x = target.nameX;
    const y = target.nameY;
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    const opened = async () => (await mainHeaders(page)).find((h) => h.path === target.path)!.height;
    // Open: its code drawn, then two frames for Pierre's sticky window to settle.
    await expect.poll(opened).toBeGreaterThan(200);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.waitForTimeout(300);

    const after = await mainHeaders(page);
    for (const was of before.slice(0, 13)) {
      const now = after.find((h) => h.path === was.path)!;
      expect(Math.abs(now.top - was.top), `${was.path} moved`).toBeLessThan(0.5);
    }
    // The pointer is still on the header it clicked.
    const underPath = await page.evaluate(
      ([px, py]) => document.elementFromPoint(px!, py!)?.closest('diffs-container')?.querySelector('span[title]')?.getAttribute('title') ?? null,
      [x, y],
    );
    expect(underPath).toBe(target.path);
  });
});

test('Hide viewed: the file you leave keeps its row while the pointer is in the list', async ({ browser }) => {
  await withReview(browser, async (page) => {
    await page.getByRole('button', { name: 'Hide viewed files' }).click();
    const row = (path: string) => page.locator(`[data-review-sidebar] .file-tree-item[title="${path}"]`);
    const first = row('src/services/operation.hpp');
    const next = row('src/services/service.hpp');
    await first.click();
    // Auto-mark viewed marks the file you leave once it has been open 1 s.
    await page.waitForTimeout(1_500);

    const box = (await next.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await expect(page.locator('[data-panel-viewed-controls]')).toHaveText(/^1 of 15 viewed$/);

    // The row you left is still there, and nothing moved under the pointer.
    await expect(first).toHaveCount(1);
    expect((await next.boundingBox())!.y).toBe(box.y);
    const underTitle = await page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.closest('.file-tree-item')?.getAttribute('title') ?? null, [x, y]);
    expect(underTitle).toBe('src/services/service.hpp');

    // Leaving the list hides it.
    await page.mouse.move(800, 600);
    await expect(first).toHaveCount(0);
  });
});
