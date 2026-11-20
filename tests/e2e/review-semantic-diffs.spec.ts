/**
 * Code review draws semantic diffs: moved, renamed and reformatted code is
 * labelled in the diff, listed in the Semantic diff tab and in each file
 * header's sem menu, with the engine's
 * parsers served by the review server and loaded only for the languages the
 * diff holds. Proved in a real Chromium against the compiled binary, on a
 * scratch git repository under a temp PLANNOTATOR_DATA_DIR and HOME.
 *
 * Screenshots go to PLANNOTATOR_REVIEW_SEMANTIC_SHOTS when it is set.
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_REVIEW_SEMANTIC_SHOTS ?? '';

const USERS_BEFORE = `import { db } from './db';

export function loadUser(id: string) {
  const row = db.users.find(id);
  if (!row) throw new Error('no user ' + id);
  return { id: row.id, name: row.name, email: row.email };
}

export function listUsers() {
  return db.users.all().map((row) => ({ id: row.id, name: row.name }));
}

export function saveUser(user: { id: string; name: string }) {
  db.users.upsert(user.id, user);
  return user;
}

export function deleteUser(id: string) {
  db.users.remove(id);
}
`;

const USERS_AFTER = `import { db } from './db';

export function saveUser(user: { id: string; name: string }) {
  db.users.upsert(user.id, user);
  return user;
}

export function deleteUser(id: string) {
  db.users.remove(id, { soft: true });
}

export function loadUser(id: string) {
  const row = db.users.find(id);
  if (!row) throw new Error('no user ' + id);
  return { id: row.id, name: row.name, email: row.email };
}

export function listUsers() {
  return db.users.all().map((row) => ({ id: row.id, name: row.name }));
}
`;

const TAX_BEFORE = `export function addTax(amount: number, region: string) {
  const rate = region === 'EU' ? 0.2 : 0.08;
  log('tax', region, rate);
  if (rate > 0.15) warn('high tax', rate);
  return amount + amount * rate;
}
`;

const CONFIG_BEFORE = `export const config = {
  retries: 3,
  timeoutMs: 5000,
};
`;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

function makeRepo(root: string): string {
  const dir = join(root, 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@example.com');
  git(dir, 'config', 'user.name', 'e2e');
  writeFileSync(join(dir, 'src/users.ts'), USERS_BEFORE);
  writeFileSync(join(dir, 'src/tax.ts'), TAX_BEFORE);
  writeFileSync(join(dir, 'src/config.ts'), CONFIG_BEFORE);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  writeFileSync(join(dir, 'src/users.ts'), USERS_AFTER);
  writeFileSync(join(dir, 'src/tax.ts'), TAX_BEFORE.replace(/\brate\b/g, 'taxRate'));
  writeFileSync(join(dir, 'src/config.ts'), CONFIG_BEFORE.replace('retries: 3', 'retries: 5'));
  return dir;
}

async function review(): Promise<{ url: string; close: () => Promise<void> }> {
  const root = inboxScratch('review-semantic');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const cwd = makeRepo(root);
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_AI: 'disabled',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_GIT_REMOTE_CHECK: '0',
  };
  const child: ChildProcess = spawn(binary, ['review'], { env, cwd, stdio: 'ignore' });
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
  const close = async () => {
    await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the review CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await removeInboxScratch(root);
  };
  return { url, close };
}

async function open(browser: Browser, url: string, viewport = { width: 1280, height: 900 }, touch = false) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...(touch ? { hasTouch: true, isMobile: true } : {}) });
  const seen = [
    ['plannotator-plan-look-choice-resolved', 'true'],
    ['plannotator-edit-mode-announcement-seen', '3'],
    ['plannotator-announce-tui-herdr-seen', '1'],
    ['plannotator-announce-inbox-seen', '1'],
    ['plannotator-announce-ask-session-seen', '1'],
    ['plannotator-announce-agent-tool-seen', '1'],
    ['plannotator-guide-intro-seen', '2'],
    ['plannotator-guide-hint-acked', 'true'],
    ['plannotator-review-dest-spotlight-seen', '1'],
    ['plannotator-auto-viewed-notice-seen', '1'],
  ];
  await context.addCookies(seen.map(([name, value]) => ({ name: name!, value: value!, url })));
  const page = await context.newPage();
  const parsers: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/assets/sem-diff/')) parsers.push(path);
  });
  await page.goto(url);
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(400);
    if ((await page.locator('.fixed.inset-0.z-\\[100\\]').count()) === 0) break;
    await page.keyboard.press('Escape');
  }
  return { context, page, parsers };
}

const note = (page: Page, state: string) => page.locator(`[data-semantic-note="${state}"]`);
const kinds = (page: Page, said: string) => page.locator(`[data-semantic-note="semantic"][aria-label$=": ${said}"]`);

async function flip(page: Page, chip: Locator) {
  await chip.click();
  await page.locator('[data-semantic-file-popover]').last().getByRole('switch', { name: 'Show in the diff' }).click();
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function headerShot(page: Page, header: Locator, name: string) {
  await page.waitForTimeout(300);
  const boxes = [(await header.boundingBox())!];
  const popover = page.locator('[data-semantic-file-popover]');
  if (await popover.count()) boxes.push((await popover.last().boundingBox())!);
  const view = page.viewportSize()!;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 12);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 12);
  const right = Math.min(view.width, Math.max(...boxes.map((b) => b.x + b.width)) + 12);
  const bottom = Math.min(view.height, Math.max(...boxes.map((b) => b.y + b.height)) + 12);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), clip: { x, y, width: right - x, height: bottom - y } });
}

const struck = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[data-file-header] *')].filter((el) => getComputedStyle(el).textDecorationLine.includes('line-through')).length);
const outlined = (chip: Locator) => chip.locator('span').last().evaluate((el) => getComputedStyle(el).boxShadow !== 'none');

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

test('moved and renamed code is labelled in plain words, and only the TypeScript parser is fetched', async () => {
  const session = await review();
  try {
    const advert = ((await (await fetch(new URL('/api/diff', session.url))).json()) as { semDiff?: { runtime: string; grammars: Record<string, string> } }).semDiff;
    expect(advert?.runtime).toMatch(/^\/assets\/sem-diff\/web-tree-sitter-[0-9a-f]{16}\.wasm$/);
    const { context, page, parsers } = await open(browser, session.url);
    await expect(note(page, 'semantic')).toHaveCount(2, { timeout: 30_000 });
    await expect(kinds(page, '1 renamed')).toBeVisible();
    await expect(kinds(page, '1 moved, 1 moved & edited')).toBeVisible();
    await expect(page.getByText('Moved 4 lines').first()).toBeAttached();
    expect(parsers.some((path) => path.includes('tree-sitter-typescript-'))).toBe(true);
    expect(parsers.filter((path) => /tree-sitter-(python|go|rust|java|c_sharp|php|ruby|kotlin)-/.test(path))).toEqual([]);
    await shot(page, 'labelled');
    await context.close();
  } finally {
    await session.close();
  }
});

test('the Semantic diff row opens its own tab that lists what the diff labels, previews it on hover, and a click lands in the diff', async () => {
  const session = await review();
  try {
    const { context, page } = await open(browser, session.url);
    await expect(note(page, 'semantic')).toHaveCount(2, { timeout: 30_000 });
    await page.getByText('Semantic diff', { exact: true }).first().click();
    await expect(page.locator('[data-pane-tab="review-semantic-diff"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-review-sidebar-tab="changes"]')).toHaveCount(0);
    const tab = page.locator('[data-pane] .semantic-diff-panel');
    await expect(tab.getByText('rate -> taxRate')).toBeVisible({ timeout: 15_000 });
    const entry = tab.locator('.semantic-diff-row').filter({ hasText: 'saveUser' }).first();
    await entry.hover();
    const preview = page.locator('[data-code-snippet-preview="src/users.ts"]');
    await expect(preview).toContainText('export function saveUser');
    await expect(preview.locator('[data-snippet-open-file]')).toBeVisible();
    await shot(page, 'changes-hover');
    await preview.locator('[data-snippet-line="4"]').click();
    await expect(preview).toHaveCount(0);
    await expect(page.locator('[data-pane-tab="review-all-files"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-file-header]').filter({ hasText: 'users.ts' }).first()).toBeInViewport({ timeout: 10_000 });
    await context.close();
  } finally {
    await session.close();
  }
});

test("a file header's sem menu lists that file's changes on hover, and a row lands on the change", async () => {
  const session = await review();
  try {
    const { context, page } = await open(browser, session.url);
    await expect(note(page, 'semantic')).toHaveCount(2, { timeout: 30_000 });
    const header = page.locator('[data-file-header]').filter({ hasText: 'users.ts' }).first();
    const badge = header.locator('[data-semantic-file-badge]');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await badge.hover();
    const menu = page.locator('[data-semantic-file-popover]');
    await expect(menu.locator('.semantic-diff-row').filter({ hasText: 'saveUser' })).toBeVisible();
    await expect(menu.getByRole('switch', { name: 'Show in the diff' })).toHaveAttribute('aria-checked', 'true');
    await shot(page, 'file-menu');
    await menu.locator('.semantic-diff-row').filter({ hasText: 'saveUser' }).first().click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator('[data-line][data-selected-line]').filter({ hasText: 'saveUser' }).first()).toBeInViewport({ timeout: 10_000 });
    await context.close();
  } finally {
    await session.close();
  }
});

test("the diff display switch and a file's switch in its sem chip each bring back the plain diff", async () => {
  const session = await review();
  try {
    const { context, page } = await open(browser, session.url);
    await expect(note(page, 'semantic')).toHaveCount(2, { timeout: 30_000 });
    await flip(page, kinds(page, '1 renamed'));
    await expect(note(page, 'off')).toHaveCount(1);
    await expect(note(page, 'semantic')).toHaveCount(1);
    await expect(page.locator('[data-file-header] .line-through')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-semantic-file-popover]')).toHaveCount(0);
    await flip(page, note(page, 'off'));
    await expect(note(page, 'semantic')).toHaveCount(2);
    await page.locator('[data-diff-display-options]').first().click();
    await page.getByText('Show moved & renamed code').click();
    await page.keyboard.press('Escape');
    await expect(note(page, 'off')).toHaveCount(0);
    await expect(note(page, 'semantic')).toHaveCount(0);
    await expect(page.getByText('Moved 4 lines')).toHaveCount(0);
    await context.close();
  } finally {
    await session.close();
  }
});

test("a file's sem chip keeps its popover open while its switch flips the file, by mouse and by a tap on a phone", async () => {
  const session = await review();
  try {
    const { context, page } = await open(browser, session.url);
    await expect(note(page, 'semantic')).toHaveCount(2, { timeout: 30_000 });
    const header = page.locator('[data-file-header]').filter({ hasText: 'users.ts' }).first();
    const chip = header.locator('[data-semantic-note]');
    const popover = page.locator('[data-semantic-file-popover]');
    const toggle = popover.getByRole('switch', { name: 'Show in the diff' });
    await chip.scrollIntoViewIfNeeded();
    expect(await outlined(chip)).toBe(false);
    await expect(chip.locator('svg')).toBeVisible();
    await expect(page.locator('[data-semantic-file-badge="0"]').first()).toBeVisible();
    await expect(page.locator('[data-semantic-file-badge="0"] svg')).toHaveCount(0);
    await headerShot(page, header, 'chip-a-on');
    await chip.hover();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await headerShot(page, header, 'chip-b-popover-switch-on');
    await toggle.click();
    await expect(chip).toHaveAttribute('data-semantic-note', 'off');
    await page.waitForTimeout(600);
    await expect(popover).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await outlined(chip)).toBe(true);
    expect(await struck(page)).toBe(0);
    await headerShot(page, header, 'chip-c-flipped-popover-open-switch-off');
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await chip.hover();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.mouse.move(5, 895);
    await expect(popover).toHaveCount(0);
    await context.close();

    const phone = await open(browser, session.url, { width: 390, height: 844 }, true);
    await phone.page.locator('[data-changes-tree] [data-type="item"][data-item-path$="users.ts"]').first().tap({ timeout: 10_000 });
    await phone.page.getByText('All changes', { exact: true }).first().tap({ timeout: 10_000 });
    const small = phone.page.locator('[data-file-header]').filter({ hasText: 'users.ts' }).first();
    const tapped = small.locator('[data-semantic-note]');
    await expect(tapped).toHaveAttribute('data-semantic-note', /^(semantic|off)$/, { timeout: 30_000 });
    const was = await tapped.getAttribute('data-semantic-note');
    await tapped.scrollIntoViewIfNeeded();
    await tapped.tap();
    const phoneToggle = phone.page.locator('[data-semantic-file-popover]').getByRole('switch', { name: 'Show in the diff' });
    await expect(phoneToggle).toHaveAttribute('aria-checked', String(was === 'semantic'));
    await phoneToggle.tap();
    await expect(tapped).toHaveAttribute('data-semantic-note', was === 'semantic' ? 'off' : 'semantic');
    await phone.page.waitForTimeout(600);
    await expect(phoneToggle).toHaveAttribute('aria-checked', String(was !== 'semantic'));
    expect(await struck(phone.page)).toBe(0);
    await headerShot(phone.page, small, 'chip-d-phone-390-popover-open');
    await phone.context.close();
  } finally {
    await session.close();
  }
});

test('on a 390 px phone nothing semantic runs past the window, and the Semantic diff tab still lists the changes', async () => {
  const session = await review();
  try {
    const { context, page } = await open(browser, session.url, { width: 390, height: 844 });
    await expect(page.getByText('Moved 4 lines').first()).toBeAttached({ timeout: 30_000 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('[data-semantic-note]')].filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.right > window.innerWidth + 1;
    }).length);
    expect(overflow).toBe(0);
    await shot(page, 'phone');
    const openNavigator = page.getByRole('button', { name: 'Open review navigation' });
    if (await openNavigator.count()) await openNavigator.click();
    await page.locator('[data-review-sidebar]').getByText('Semantic diff', { exact: true }).first().click();
    await expect(page.locator('[data-pane-tab="review-semantic-diff"]')).toHaveAttribute('aria-selected', 'true');
    const tab = page.locator('[data-pane] .semantic-diff-panel');
    await expect(tab.locator('.semantic-diff-row').filter({ hasText: 'saveUser' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(tab.getByText('rate -> taxRate')).toBeVisible();
    await context.close();
  } finally {
    await session.close();
  }
});
