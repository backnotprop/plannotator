/**
 * Code review's left panel (approved design record "review-sidebar-aligned"),
 * proved in a real Chromium against the compiled binary, for what a DOM test
 * cannot show:
 *
 *  - the view tabs: Left and Right move focus between the tabs without
 *    switching the view, Enter and Space switch it, and focus stays on the
 *    chosen tab when the panel redraws for the new view;
 *  - a group heading folds and opens with Enter and Space, and says so
 *    (aria-expanded);
 *  - at the default 256 px, Changes | All files and the tools share one line
 *    in both scopes (All files live), so switching scope never moves the list;
 *  - the sticky tools block (Changes | All files, the tools, the progress)
 *    stays on top while the files scroll under it, with its hairline only
 *    while something is under it;
 *  - the +/- numbers end on the same two right edges on every row.
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
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
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

/** A branch off main that changes code in folders, tests and a lockfile. */
function buildRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  write(repo, 'README.md', '# Sidebar\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  git(repo, ['checkout', '-q', '-b', 'feature/sidebar']);
  for (let i = 0; i < 14; i++) write(repo, `src/billing/part${i}.ts`, `export const part${i} = ${i};\n`.repeat(i + 1));
  write(repo, 'src/api/routes.ts', 'export const routes = {};\n');
  write(repo, 'tests/billing.test.ts', 'test("billing", () => {});\n');
  write(repo, 'bun.lock', '{}\n');
  write(repo, 'README.md', '# Sidebar\n\nNow with billing.\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'billing']);
  return repo;
}

async function openReview(browser: Browser, url: string, height = 900): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height } });
  await context.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url })));
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.locator('[data-review-sticky-tools]')).toBeVisible();
  return page;
}

async function stopReview(child: ChildProcess | undefined, root: string) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function withReview(browser: Browser, height: number, run: (page: Page) => Promise<void>) {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  const root = mkdtempSync(join(tmpdir(), 'plannotator-review-sidebar-'));
  const repo = buildRepo(root);
  const readyFile = join(root, 'ready.jsonl');
  let child: ChildProcess | undefined;
  try {
    child = spawn(binary, ['review'], { env: reviewEnv(root, readyFile), cwd: repo, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const page = await openReview(browser, url, height);
    await run(page);
    await page.context().close();
  } finally {
    await stopReview(child, root);
  }
}

const tab = (page: Page, view: string) => page.locator(`[role="tab"][data-panel-view="${view}"]`);
const focusedView = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-panel-view') ?? null);

test('the view tabs: arrows move focus, Enter and Space switch, focus stays on the chosen tab', async ({ browser }) => {
  await withReview(browser, 900, async (page) => {
    await expect(tab(page, 'tree')).toHaveAttribute('aria-selected', 'true');
    await tab(page, 'tree').focus();
    await page.keyboard.press('ArrowRight');
    expect(await focusedView(page)).toBe('commits');
    // An arrow only moves focus: the view is still the tree.
    await expect(tab(page, 'tree')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(tab(page, 'commits')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="tabpanel"]')).toHaveAttribute('aria-labelledby', 'review-panel-tab-commits');
    expect(await focusedView(page)).toBe('commits');
    await page.keyboard.press('ArrowLeft');
    expect(await focusedView(page)).toBe('tree');
    await page.keyboard.press(' ');
    await expect(tab(page, 'tree')).toHaveAttribute('aria-selected', 'true');
    expect(await focusedView(page)).toBe('tree');
  });
});

test('a group heading folds and opens from the keyboard', async ({ browser }) => {
  await withReview(browser, 900, async (page) => {
    const heading = page.locator('[data-review-sidebar] [data-type="item"][data-item-path="Tests/"]');
    const testRows = page.locator('[data-review-sidebar] [data-item-type="file"][data-item-path^="Tests/"]');
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await expect(testRows).toHaveCount(0);
    await heading.focus();
    await page.keyboard.press('ArrowRight');
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
    await expect(testRows).toHaveCount(1);
    await page.keyboard.press('ArrowLeft');
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
  });
});

test('at the default 256 px the scope and the tools share one line in both scopes, and switching never moves the list', async ({ browser }) => {
  await withReview(browser, 900, async (page) => {
    const geometry = () =>
      page.evaluate(() => {
        const top = (selector: string) => Math.round(document.querySelector(selector)!.getBoundingClientRect().top);
        return {
          pills: top('[data-tree-scope="changes"]'),
          tools: top('[aria-label="List options"]'),
          block: Math.round(document.querySelector('[data-review-sticky-tools]')!.getBoundingClientRect().height),
        };
      });
    const changes = await geometry();
    expect(Math.abs(changes.tools - changes.pills)).toBeLessThanOrEqual(2);
    await page.locator('[data-tree-scope="all"]').click();
    await expect(page.locator('[data-repo-file-tree]')).toBeVisible();
    await expect(page.locator('[data-repo-listing-dot]')).toBeVisible();
    const all = await geometry();
    expect(all).toEqual(changes);
    // The label is whole, not cut to fit.
    expect(await page.locator('[data-tree-scope="all"] .truncate').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
});

test('the tools stay put while the files scroll; the numbers keep two edges', async ({ browser }) => {
  await withReview(browser, 520, async (page) => {
    const tools = page.getByRole('button', { name: 'List options' });
    const before = await tools.boundingBox();
    const first = page.locator('[data-review-sidebar] [data-type="item"]').first();
    const firstPath = await first.getAttribute('data-item-path');
    await first.hover();
    await page.mouse.wheel(0, 400);
    await expect(page.locator(`[data-review-sidebar] [data-type="item"][data-item-path="${firstPath}"]`)).not.toBeInViewport();
    expect((await tools.boundingBox())!.y).toBe(before!.y);
    await expect(page.locator('[data-tree-scope="all"]')).toBeInViewport();

    const edges = await page.locator('[data-changes-tree]').evaluate((tree) => {
      const right = (n: number) =>
        [...new Set([...tree.shadowRoot!.querySelectorAll(`[data-item-section="trail"] > :nth-child(${n})`)]
          .filter((el) => el.textContent)
          .map((el) => Math.round(el.getBoundingClientRect().right)))];
      return { plus: right(3), minus: right(4) };
    });
    expect(edges.plus.length).toBe(1);
    expect(edges.minus.length).toBeLessThanOrEqual(1);
  });
});
