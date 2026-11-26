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
 *  - File filter: narrowing or clearing the list marks no file Viewed; only
 *    the reader's own scrolling does.
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

async function withReview(
  browser: Browser,
  run: (page: Page) => Promise<void>,
  prepare?: (page: Page) => Promise<void>,
  setup: { build?: (root: string) => string; viewport?: { width: number; height: number } } = {},
) {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  const root = mkdtempSync(join(tmpdir(), 'plannotator-review-stays-put-'));
  const repo = (setup.build ?? buildRepo)(root);
  const readyFile = join(root, 'ready.jsonl');
  let child: ChildProcess | undefined;
  try {
    child = spawn(binary, ['review'], { env: reviewEnv(root, readyFile), cwd: repo, stdio: 'ignore' });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    // The issue's window size.
    const context = await browser.newContext({ viewport: setup.viewport ?? { width: 1274, height: 1185 } });
    await context.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url })));
    const page = await context.newPage();
    await prepare?.(page);
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
const mainHeaders = (page: Page, of: string[] = [...MODIFIED, ...ADDED]) =>
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
  }, of);

const headerUnder = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => document.elementFromPoint(px!, py!)?.closest('diffs-container')?.querySelector('span[title]')?.getAttribute('title') ?? null,
    [x, y],
  );

async function openAllChanges(page: Page): Promise<void> {
  const row = page.locator('[data-review-sidebar] [title="Every change of this review in one view"]');
  if (await row.count()) await row.click();
  await expect(page.locator('[data-review-sidebar] [title="Every change of this review in one view"]')).toHaveCount(0);
}

test('All changes: opening a folded file leaves every header where it was', async ({ browser }) => {
  await withReview(browser, async (page) => {
    await openAllChanges(page);
    await page.locator('[data-diff-display-options]').click();
    const foldToggle = page.locator('[data-collapse-all-files]');
    await expect(foldToggle).toBeVisible();
    if ((await foldToggle.textContent())?.includes('Collapse all files')) await foldToggle.click();
    await expect(foldToggle).toHaveText('Expand all files');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mainHeaders(page)).length).toBe(15);
    await expect.poll(async () => (await mainHeaders(page)).filter((h) => h.height > 40).length).toBe(0);

    const before = await mainHeaders(page);
    const target = before[12]!;
    const x = target.nameX;
    const y = target.nameY;
    await page.mouse.move(x, y);
    await expect.poll(() => headerUnder(page, x, y)).toBe(target.path);
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
    expect(await headerUnder(page, x, y)).toBe(target.path);
  });
});

test('All changes: Collapse all files clicked while the code is still loading folds every file once it shows', async ({ browser }) => {
  await withReview(
    browser,
    async (page) => {
      await openAllChanges(page);
      await page.locator('[data-diff-display-options]').click();
      await page.locator('[data-collapse-all-files]').click();
      await expect(page.locator('[data-collapse-all-files]')).toHaveText('Expand all files');
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await mainHeaders(page)).length).toBe(15);
      await expect.poll(async () => (await mainHeaders(page)).filter((h) => h.height > 40).length).toBe(0);
    },
    (page) =>
      page.addInitScript(() => {
        const Base = window.Worker;
        const until = performance.now() + 3_000;
        window.Worker = class extends Base {
          override postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
            setTimeout(() => super.postMessage(message, options as StructuredSerializeOptions), Math.max(0, until - performance.now()));
          }
        } as typeof Worker;
      }),
  );
});

test('Hide viewed: the file you leave keeps its row while the pointer is in the list', async ({ browser }) => {
  await withReview(browser, async (page) => {
    await page.getByRole('button', { name: 'Hide viewed files' }).click();
    const row = (path: string) => page.locator(`[data-review-sidebar] [data-item-type="file"][title="${path}"]`);
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
    await expect(page.locator('[data-panel-viewed-controls]')).toHaveText(/^1\/15$/);

    // The row you left is still there, and nothing moved under the pointer.
    await expect(first).toHaveCount(1);
    expect((await next.boundingBox())!.y).toBe(box.y);
    const underTitle = await page.evaluate(([px, py]) => {
      const outer = document.elementFromPoint(px!, py!);
      const inner = outer?.shadowRoot?.elementFromPoint(px!, py!) ?? outer;
      return inner?.closest('[data-type="item"]')?.getAttribute('title') ?? null;
    }, [x, y]);
    expect(underTitle).toBe('src/services/service.hpp');

    // Leaving the list hides it.
    await page.mouse.move(800, 600);
    await expect(first).toHaveCount(0);
  });
});

test('All changes: Collapse all files at the top right, left of Split/Unified, folds every file and keeps the file you read in view', async ({ browser }) => {
  await withReview(browser, async (page) => {
    await openAllChanges(page);
    await expect.poll(async () => (await mainHeaders(page)).filter((h) => h.height > 200).length).toBeGreaterThan(0);
    const listTop = (await mainHeaders(page))[0]!.top;
    const x = (await mainHeaders(page))[0]!.nameX;
    await page.mouse.move(x, listTop + 300);
    await page.mouse.wheel(0, 1_200);
    await expect.poll(() => headerUnder(page, x, listTop + 40)).not.toBe(MODIFIED[0]);
    await page.waitForTimeout(300);
    const reading = (await headerUnder(page, x, listTop + 40))!;
    expect(reading).toBeTruthy();
    const top = async () => (await mainHeaders(page)).find((h) => h.path === reading)?.top ?? Number.NaN;

    await expect(page.locator('[data-review-sticky-tools]').getByRole('button', { name: /all files/ })).toHaveCount(0);
    const tools = page.locator('header [data-review-diff-controls]');
    await expect(tools.locator('[data-header-collapse-all-files] + [data-diff-layout-toggle]')).toHaveCount(1);
    await tools.getByRole('button', { name: 'Collapse all files' }).click();
    await expect(tools.getByRole('button', { name: 'Expand all files' })).toBeVisible();
    await expect.poll(async () => (await mainHeaders(page)).length).toBe(15);
    await expect.poll(async () => (await mainHeaders(page)).filter((h) => h.height > 40).length).toBe(0);
    const folded = await top();
    expect(folded).toBeGreaterThanOrEqual(listTop - 1);
    expect(folded).toBeLessThan(page.viewportSize()!.height - 40);

    await tools.getByRole('button', { name: 'Expand all files' }).click();
    await expect(tools.getByRole('button', { name: 'Collapse all files' })).toBeVisible();
    await expect.poll(async () => (await mainHeaders(page)).find((h) => h.path === reading)?.height ?? 0).toBeGreaterThan(200);
    await expect.poll(async () => Math.abs((await top()) - listTop)).toBeLessThan(3);
  });
});

test('File header: hover shows Open in on the left of its actions, and nothing in the header moves', async ({ browser }) => {
  await withReview(browser, async (page) => {
    await openAllChanges(page);
    const header = page.locator('[data-file-header]').first();
    await expect(header).toBeVisible();
    const viewed = header.locator('[data-file-header-viewed]');
    const comment = header.getByRole('button', { name: 'Comment on this file' });
    const openIn = header.locator('[data-open-in-quiet]');
    await page.mouse.move(5, 5);
    await expect.poll(() => openIn.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    const boxes = async () => ({ header: (await header.boundingBox())!, viewed: (await viewed.boundingBox())!, comment: (await comment.boundingBox())!, openIn: (await openIn.boundingBox())! });
    const rest = await boxes();
    expect(rest.header.x + rest.header.width - (rest.comment.x + rest.comment.width)).toBeLessThan(16);
    expect(rest.openIn.x + rest.openIn.width).toBeLessThanOrEqual(rest.viewed.x);

    await header.hover({ position: { x: 40, y: rest.header.height / 2 } });
    await expect.poll(() => openIn.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const hovered = await boxes();
    for (const key of ['viewed', 'comment', 'openIn'] as const) {
      expect(hovered[key].x, `${key} moved`).toBe(rest[key].x);
      expect(hovered[key].y, `${key} moved`).toBe(rest[key].y);
    }
  });
});

/**
 * Release QA on 0.29.2: a file filter remounts the list and puts the reader
 * back on their file; on a shorter list that restore lands at the end by
 * itself, and Viewed as you scroll marked the last file, which nobody had
 * read. Four long files, then b/head.ts and two short files (b/one.ts,
 * b/two.ts), then a long c/last.ts so the full list never ends at b/.
 */
const LONG = ['a/long1.ts', 'a/long2.ts', 'a/long3.ts', 'a/long4.ts'];
const FILTERED = ['b/head.ts', 'b/one.ts', 'b/two.ts'];
const LAST = 'c/last.ts';
const FILTER_FILES = [...LONG, ...FILTERED, LAST];
function buildFilterRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  write(repo, 'README.md', 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  git(repo, ['checkout', '-q', '-b', 'feature/short-files']);
  for (const path of LONG) write(repo, path, lines(path, 60, 'new'));
  write(repo, 'b/head.ts', lines('b/head.ts', 18, 'new'));
  write(repo, 'b/one.ts', lines('b/one.ts', 6, 'new'));
  write(repo, 'b/two.ts', lines('b/two.ts', 6, 'new'));
  write(repo, LAST, lines(LAST, 40, 'new'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'files']);
  return repo;
}

/**
 * Scroll All changes until `path`'s header sits at the top of the list.
 *
 * One scroll step per evaluate, each bounded: a step waits two frames for the
 * list to draw what the scroll brought in, but never more than 250 ms, and the
 * evaluate itself gets 5 s. The whole walk gets 20 s. One evaluate that awaited
 * frames in a loop once never returned when the page drew no frame, and the
 * test spent its 240 s there with no word of why (CI, main, ef530d029).
 */
async function bringToTop(page: Page, path: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  const seen: Record<string, number> = {};
  while (Date.now() < deadline) {
    const step = page.evaluate(async (target) => {
      const first = document.querySelector('diffs-container');
      let scroller = first?.parentElement ?? null;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      if (!scroller) return 'no scroller yet';
      const item = document.querySelector(`diffs-container span[title="${CSS.escape(target)}"]`)?.closest('diffs-container');
      if (item) {
        const delta = item.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        if (Math.abs(delta) < 2) return 'at top';
        scroller.scrollTop += delta;
      } else {
        scroller.scrollTop += 600;
      }
      const framed = await Promise.race([
        new Promise<boolean>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))),
        new Promise<boolean>((done) => setTimeout(() => done(false), 250)),
      ]);
      return framed ? 'scrolled' : 'scrolled, no frame in 250 ms';
    }, path).catch((error: Error) => `evaluate failed: ${error.message.split('\n')[0]}`);
    const result = await Promise.race([step, new Promise<string>((done) => setTimeout(() => done('page did not answer in 5 s'), 5_000))]);
    if (result === 'at top') return;
    seen[result] = (seen[result] ?? 0) + 1;
  }
  throw new Error(`${path} never reached the top of the list in 20 s: ${JSON.stringify(seen)}`);
}

test('File filter: narrowing or clearing the list marks nothing Viewed; only scrolling by hand does', async ({ browser }) => {
  await withReview(
    browser,
    async (page) => {
      const viewedCount = page.locator('[data-panel-viewed-controls]');
      const viewed = async () => Number(((await viewedCount.textContent()) ?? '').split('/')[0]);
      await openAllChanges(page);
      await expect.poll(async () => (await mainHeaders(page, FILTER_FILES)).length).toBeGreaterThan(0);

      // The reader is on b/one.ts, a file the filter keeps.
      await bringToTop(page, 'b/one.ts');
      await page.waitForTimeout(1_500);
      const before = await viewed();

      // Narrowing to b/: the restore puts b/one.ts back, clamped at the end
      // of the short list. Nobody scrolled; nothing becomes Viewed.
      await page.getByRole('button', { name: 'Filter files', exact: true }).click();
      const include = page.getByLabel('Include');
      await include.fill('b/**');
      await expect.poll(async () => (await mainHeaders(page, FILTER_FILES)).map((h) => h.path)).toEqual(FILTERED);
      await page.waitForTimeout(1_500);
      expect(await viewed()).toBe(before);

      // The reader's own wheel, up and back to the end, marks the last file there.
      const top = (await mainHeaders(page, FILTER_FILES))[0]!;
      await page.mouse.move(top.nameX, Math.max(top.nameY, 120) + 60);
      await page.mouse.wheel(0, -900);
      await page.waitForTimeout(400);
      await page.mouse.wheel(0, 900);
      await expect.poll(viewed, { timeout: 5_000 }).toBe(before + 1);

      // Emptying the field as a person does: the full list comes back with
      // b/two.ts, the file being read, in view, and nothing newly Viewed.
      await include.press('ControlOrMeta+a');
      await include.press('Backspace');
      await expect.poll(async () => (await mainHeaders(page, FILTER_FILES)).map((h) => h.path)).toContain(LAST);
      await page.waitForTimeout(1_500);
      expect(await viewed()).toBe(before + 1);
      const two = (await mainHeaders(page, FILTER_FILES)).find((h) => h.path === 'b/two.ts');
      expect(two, 'b/two.ts is drawn').toBeTruthy();
      expect(two!.top).toBeGreaterThanOrEqual(0);
      expect(two!.top).toBeLessThan(page.viewportSize()!.height - 40);
    },
    undefined,
    { build: buildFilterRepo, viewport: { width: 1274, height: 640 } },
  );
});
