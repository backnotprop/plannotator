/**
 * The review's own two-pane layout (the overnight "layout" item): tabs live in the header row, so opening a file
 * moves no code; Open to the side makes a second pane; one file can show its original next to its current text;
 * a reload brings the panes back; a phone keeps one pane.
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
  write(repo, 'src/api/routes.ts', 'export const routes = {};\nexport const version = 1;\n');
  write(repo, 'LICENSE', 'MIT\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  git(repo, ['checkout', '-q', '-b', 'feature/sidebar']);
  for (let i = 0; i < 14; i++) write(repo, `src/billing/part${i}.ts`, `export const part${i} = ${i};\n`.repeat(i + 1));
  write(repo, 'src/api/routes.ts', 'export const routes = { billing: true };\nexport const version = 2;\n');
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
  const root = mkdtempSync(join(tmpdir(), 'plannotator-review-layout-'));
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


const firstCodeTop = (page: Page) =>
  page.evaluate(() => {
    const all: Element[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
        all.push(el);
      }
    };
    walk(document);
    const lines = all
      .filter((el) => el.hasAttribute('data-line') && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().top > 0)
      .map((el) => el.getBoundingClientRect().top);
    return lines.length ? Math.round(Math.min(...lines)) : null;
  });
const paneTop = (page: Page) => page.evaluate(() => Math.round(document.querySelector('[data-pane="0"]')!.getBoundingClientRect().top));
const row = (page: Page, name: string) => page.locator(`[data-review-sidebar] [data-changes-tree] [data-type="item"][data-item-path$="${name}"]`).first();

const headerShape = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('header button, header [data-header-branch], header [data-header-totals]')]
      .map((el) => el.getBoundingClientRect())
      .filter((box) => box.width > 0)
      .map((box) => `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)}`)
      .join(' '),
  );

const fileHeaderTop = (page: Page) =>
  page.evaluate(() => Math.round(document.querySelector('[data-pane="0"] [data-pane-panel] [data-file-header]')!.getBoundingClientRect().top));

test('tabs live in the panes: the header never changes, and one tab row from the start keeps the file header and the code still when a file opens or tabs switch', async ({ browser }) => {
  await withReview(browser, 900, async (page) => {
    await expect.poll(() => firstCodeTop(page)).not.toBeNull();
    const header = await headerShape(page);
    const top = await paneTop(page);
    const tabRow = page.locator('[data-pane="0"] [data-pane-tab-row]');
    await expect(tabRow.locator('[data-pane-tab]')).toHaveCount(1);
    const rowBox = (await tabRow.boundingBox())!;
    expect(Math.round(rowBox.height)).toBe(32);
    const below = Math.round(rowBox.y + rowBox.height);
    await expect.poll(() => fileHeaderTop(page)).toBe(below);

    await row(page, 'routes.ts').click();
    await expect(tabRow.locator('[data-pane-tab]')).toHaveCount(2);
    expect(await headerShape(page)).toBe(header);
    expect(await paneTop(page)).toBe(top);
    expect(await tabRow.boundingBox()).toEqual(rowBox);
    await expect.poll(() => fileHeaderTop(page)).toBe(below);
    await expect.poll(() => firstCodeTop(page)).toBe(below + 32);

    await page.locator('[data-pane-tab][aria-selected="true"]').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-pane-tab="review-all-files"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-pane-tab="review-all-files"]')).toBeFocused();
    expect(await tabRow.boundingBox()).toEqual(rowBox);
    await expect.poll(() => fileHeaderTop(page)).toBe(below);
    expect(await headerShape(page)).toBe(header);

    await row(page, 'routes.ts').click();
    await expect(page.locator('[data-pane="0"] [data-pane-tab][aria-selected="true"]')).toHaveText('routes.ts');
    await row(page, 'README.md').click({ button: 'right' });
    await page.locator('[data-tree-open-to-side]').click();
    await expect(page.locator('[data-pane="1"] [data-pane-tab]')).toHaveCount(1);
    await expect(page.locator('[data-pane="1"] [data-pane-tab]')).toHaveText('README.md');
    await expect(page.locator('[data-pane="1"] [data-file-header]').filter({ visible: true }).first()).toContainText('README.md');
    await expect(page.locator('[data-pane="0"] [data-pane-tab][aria-selected="true"]')).toHaveText('routes.ts');
    await expect(page.locator('[data-pane="0"] [data-file-header]').filter({ visible: true }).first()).toContainText('routes.ts');
    expect(await headerShape(page)).toBe(header);
  });
});

test('All changes: after ] and End, Home goes back to the first file', async ({ browser }) => {
  await withReview(browser, 900, async (page) => {
    const activeTab = page.locator('[data-pane="0"] [data-pane-tab][aria-selected="true"]');
    const focusIn = (selector: string) => page.evaluate((within) => !!document.activeElement?.closest(within), selector);
    await page.locator('[data-pane="0"] [data-pane-panel] [data-line]', { hasText: 'export const part0 = 0;' }).first().click();
    await expect.poll(() => focusIn('[data-pane="0"] [data-pane-panel]')).toBe(true);
    await page.keyboard.press(']');
    await expect(activeTab).toHaveText('All changes');
    await page.keyboard.press('End');
    await expect(activeTab).toHaveText('bun.lock');
    await expect.poll(() => focusIn('[data-file-header]')).toBe(true);
    await page.keyboard.press('Home');
    await expect(activeTab).toHaveText('routes.ts');
    await expect(page.locator('[data-pane="0"] [data-file-header]').filter({ visible: true }).first()).toContainText('routes.ts');
  });
});

test('a phone keeps one pane, its tabs in the pane, folds every file from the navigator, and the header never changes', async ({ browser }) => {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  const root = mkdtempSync(join(tmpdir(), 'plannotator-review-layout-phone-'));
  const repo = buildRepo(root);
  const readyFile = join(root, 'ready.jsonl');
  let child: ChildProcess | undefined;
  try {
    child = spawn(binary, ['review'], { env: reviewEnv(root, readyFile), cwd: repo, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url })));
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator('[data-pane="0"]')).toBeVisible();
    const top = await paneTop(page);
    const header = await headerShape(page);
    await expect(page.locator('[data-review-navigation-sheet]')).toBeVisible();
    const fold = page.locator('[data-review-navigation-sheet] [data-tree-collapse-all-files]');
    const foldBox = (await fold.boundingBox())!;
    expect(Math.min(foldBox.width, foldBox.height)).toBeGreaterThanOrEqual(44);
    await fold.tap();
    await expect(fold).toHaveAttribute('data-tree-collapse-all-files', 'collapsed');
    await expect(fold).toHaveAccessibleName('Expand all files');
    await fold.tap();
    await expect(fold).toHaveAttribute('data-tree-collapse-all-files', 'open');
    await page.locator('[data-changes-tree] [data-type="item"][data-item-path$="routes.ts"]').first().tap();
    await expect(page.locator('[data-review-navigation-sheet]')).toHaveCount(0);
    await expect(page.locator('[data-pane="0"] [data-pane-tab][aria-selected="true"]')).toBeVisible();
    expect(await paneTop(page)).toBe(top);
    expect(await headerShape(page)).toBe(header);
    await expect(page.locator('[data-pane]')).toHaveCount(1);
    await context.close();
  } finally {
    await stopReview(child, root);
  }
});

test('two files side by side, the original next to the current, and the layout back after a reload', async ({ browser }) => {
  await withReview(browser, 900, async (page) => {
    await row(page, 'routes.ts').click();
    await page.locator('[data-pane="0"] [data-file-view="whole"]').click();
    await expect(page.locator('[data-pane="0"] [data-whole-file-view]')).toBeVisible();
    await row(page, 'routes.ts').click({ button: 'right' });
    await page.locator('[data-tree-open-to-side]').click();
    await expect(page.locator('[data-pane]')).toHaveCount(2);
    await expect(page.locator('[data-pane-divider]')).toBeVisible();
    await expect(page.locator('[data-pane="1"] [data-file-header]')).toBeVisible();
    const viewMenu = page.locator('[data-pane="1"] [data-file-view-menu]');
    if (await viewMenu.isVisible()) {
      await viewMenu.click();
      await page.locator('[data-file-view-option="original"]').click();
    } else {
      await page.locator('[data-pane="1"] [data-file-view="original"]').click();
    }
    await expect(page.locator('[data-pane="1"] [data-original-file-view]')).toBeVisible();
    await expect(page.locator('[data-pane="0"] [data-whole-file-view]')).toBeVisible();

    const divider = page.locator('[data-pane-divider]');
    await divider.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    const ratio = await divider.getAttribute('aria-valuenow');
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-pane]')).toHaveCount(2);
    await expect(page.locator('[data-pane-divider]')).toHaveAttribute('aria-valuenow', ratio!);
    await expect(page.locator('[data-pane="1"] [data-pane-tab]')).toHaveCount(1);
    await expect(page.locator('[data-pane="0"] [data-pane-tab]')).toHaveCount(2);
  });
});

test('a double click keeps one tab per file, and closing a tab keeps focus in the window: the next tab, or the tree', async ({ browser }) => {
  await withReview(browser, 900, async (page) => {
    const tabs = (name: string) => page.locator('[data-pane-tab]', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) });
    await row(page, 'routes.ts').dblclick();
    await expect(tabs('routes.ts')).toHaveCount(1);
    await expect(page.locator('[data-pane-tab][data-preview-tab]')).toHaveCount(0);
    await row(page, 'README.md').dblclick();
    await expect(tabs('README.md')).toHaveCount(1);
    await expect(tabs('routes.ts')).toHaveCount(1);
    const order = () => page.locator('[data-pane="0"] [data-pane-tab]').allTextContents();
    await row(page, 'billing.test.ts').click();
    await page.locator('[data-tree-scope="all"]').click();
    await page.locator('[data-repo-file-tree] [data-item-path="LICENSE"]').dblclick();
    await expect(tabs('LICENSE')).toHaveCount(1);
    await expect(page.locator('[data-pane-tab][data-preview-tab]')).toHaveCount(0);
    await page.locator('[data-tree-scope="changes"]').click();
    expect(await order()).toEqual(['All changes', 'routes.ts', 'README.md', 'billing.test.ts', 'LICENSE']);
    await row(page, 'billing.test.ts').dblclick();
    await expect(tabs('billing.test.ts')).toHaveCount(1);
    await expect.poll(order).toEqual(['All changes', 'routes.ts', 'README.md', 'billing.test.ts', 'LICENSE']);

    await row(page, 'routes.ts').click();
    await expect(page.locator('[data-pane="0"] [data-pane-tab][aria-selected="true"]')).toHaveText('routes.ts');
    await row(page, 'routes.ts').click({ button: 'right' });
    await page.locator('[data-tree-open-to-side]').click();
    await expect(page.locator('[data-pane="1"] [data-pane-tab][aria-selected="true"]')).toHaveText('routes.ts');
    await expect(page.locator('[data-pane="0"] [data-pane-tab][aria-selected="true"]')).toHaveText('routes.ts');
    await expect.poll(() => page.locator('[data-pane-tab]').count()).toBeGreaterThan(1);
    await page.locator('[data-pane-tab-close]').last().click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? 'BODY')).not.toBe('BODY');
  });
});

test('PR Overview at 820 px: a comment card keeps its time clear of its badge and its author and file whole', async ({ browser }) => {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  const root = mkdtempSync(join(tmpdir(), 'plannotator-review-layout-pr-'));
  const repo = buildRepo(root);
  const readyFile = join(root, 'ready.jsonl');
  let child: ChildProcess | undefined;
  try {
    child = spawn(binary, ['review'], { env: reviewEnv(root, readyFile), cwd: repo, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const context = await browser.newContext({ viewport: { width: 820, height: 900 } });
    await context.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url })));
    const pr = 'https://github.com/acme/payments/pull/42';
    const hoursAgo = new Date(Date.now() - 4 * 3_600_000).toISOString();
    await context.route('**/api/diff', async (route) => {
      const real = await route.fetch();
      await route.fulfill({ response: real, json: { ...(await real.json()), prMetadata: { platform: 'github', host: 'github.com', owner: 'acme', repo: 'payments', number: 42, title: 'Billing', author: 'tomas', baseBranch: 'main', headBranch: 'feature/sidebar', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), url: pr } } });
    });
    await context.route('**/api/pr-context/stream', (route) => route.fulfill({ status: 404, body: '' }));
    await context.route('**/api/pr-context', (route) =>
      route.fulfill({
        json: {
          body: '', state: 'OPEN', isDraft: false, labels: [], reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', comments: [], checks: [], linkedIssues: [],
          reviews: [{ id: 'r1', author: 'priya-raman', state: 'CHANGES_REQUESTED', body: 'The retry waits too long.', submittedAt: hoursAgo, url: `${pr}#r1` }],
          reviewThreads: [{ id: 't1', isResolved: false, isOutdated: false, path: 'src/billing/schedule.ts', line: 17, startLine: null, diffSide: 'RIGHT', comments: [{ id: 'c1', author: 'priya-raman', body: 'Why 17?', createdAt: hoursAgo, url: `${pr}#c1` }] }],
        },
      }),
    );
    const page = await context.newPage();
    await page.goto(url);
    const review = page.locator('[data-comment-id="r1"]');
    const thread = page.locator('[data-comment-id="t1"]');
    await expect(review).toBeVisible({ timeout: 30_000 });
    await expect(thread).toBeVisible();
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const header = (card: typeof review) =>
      card.evaluate((el, boxSource) => {
        const measure = new Function(`return ${boxSource}`)() as (el: Element) => { left: number; right: number; top: number; bottom: number };
        const spans = [...el.querySelectorAll<HTMLElement>(':scope > div:first-child span')];
        const time = spans.find((span) => /ago|now/.test(span.textContent ?? ''))!;
        const badge = spans.find((span) => span.textContent === 'Changes Requested');
        const name = spans.find((span) => span.textContent === 'priya-raman')!;
        const ref = spans.find((span) => (span.textContent ?? '').startsWith('schedule.ts'));
        const t = measure(time);
        const gap = (other?: HTMLElement) => {
          if (!other) return null;
          const o = measure(other);
          const apart = Math.max(o.left - t.right, t.left - o.right, o.top - t.bottom, t.top - o.bottom);
          return Math.floor(apart);
        };
        const whole = (span?: HTMLElement) => (span ? span.scrollWidth <= span.clientWidth : null);
        return { badgeGap: gap(badge) === null ? null : gap(badge)! >= 4, nameWhole: whole(name), refWhole: whole(ref), refGap: gap(ref) === null ? null : gap(ref)! >= 4 };
      }, box.toString());
    expect(await header(review)).toEqual({ badgeGap: true, nameWhole: true, refWhole: null, refGap: null });
    expect(await header(thread)).toEqual({ badgeGap: null, nameWhole: true, refWhole: true, refGap: true });
    await context.close();
  } finally {
    await stopReview(child, root);
  }
});

