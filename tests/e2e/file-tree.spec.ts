/**
 * The @plannotator/ui file tree (packages/ui/components/file-tree) in a real
 * Chromium, for what happy-dom cannot lay out:
 *
 * - scroll anchoring: rows are absolutely placed, so the tree keeps the row at
 *   the top of the view by path when rows are added, removed, opened or
 *   closed above it (and does not at the very top, where a new row shows);
 * - row height follows the text: with the browser's minimum font size at
 *   24 px, rows grow so no text box spills into the next row, and every row is
 *   still one height (the window stays exact).
 *
 * The page is the tree's bench page (packages/ui/bench/file-tree, `?mode=live`),
 * built with vite into a temp folder and served from it. No binary, no data
 * dir, no system browser.
 */

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

const repo = resolve(__dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'file-tree-e2e-'));
const dist = join(scratch, 'dist');
let server: Server;
let base = '';

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

test.beforeAll(() => {
  const built = spawnSync('bunx', ['vite', 'build', '--config', 'bench/file-tree/vite.config.ts'], {
    cwd: join(repo, 'packages/ui'),
    env: { ...process.env, BENCH_OUT: dist },
    encoding: 'utf8',
  });
  if (built.status !== 0) throw new Error(`bench build failed:\n${built.stderr}`);
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    try {
      const file = path === '/' ? 'index.html' : path;
      const body = readFileSync(join(dist, file));
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise<void>((done) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      done();
    }),
  );
});

test.afterAll(() => {
  server?.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function open(page: Page) {
  await page.goto(`${base}/?mode=live&theme=light`);
  await page.waitForFunction(() => (window as any).__h?.ready === true);
}

const topPath = (page: Page) => page.evaluate(() => (window as any).__h.topPath() as string | null);
const scrollTop = (page: Page) => page.evaluate(() => (window as any).__h.tree().scrollTop as number);
async function scrollToRow(page: Page, path: string) {
  await page.evaluate((p) => {
    const h = (window as any).__h;
    const tree = h.tree() as HTMLElement;
    const index = h.store.model.indexOf(p);
    const height = (tree.querySelector('[role="treeitem"]') as HTMLElement).offsetHeight;
    tree.scrollTop = index * height;
  }, path);
  await page.waitForTimeout(50);
}
const change = (page: Page, fn: string) => page.evaluate(`(() => { const s = window.__h.store; ${fn}; })()`).then(() => page.waitForTimeout(50));

test('the row at the top of the view stays put when rows change above it', async ({ page }) => {
  await open(page);
  await scrollToRow(page, 'g198.ts');
  expect(await topPath(page)).toBe('g198.ts');
  const before = await scrollTop(page);

  await change(page, "s.add(['c1.ts', 'c2.ts', 'c3.ts', 'c4.ts', 'c5.ts'])");
  expect(await topPath(page)).toBe('g198.ts');
  expect(await scrollTop(page)).toBeGreaterThan(before);

  await change(page, "s.remove(['c1.ts', 'c2.ts', 'c3.ts'])");
  expect(await topPath(page)).toBe('g198.ts');

  await change(page, "s.expand('a')");
  expect(await topPath(page)).toBe('g198.ts');
  await change(page, "s.collapse('a')");
  expect(await topPath(page)).toBe('g198.ts');

  // A change below the view moves nothing.
  const at = await scrollTop(page);
  await change(page, "s.add('g499-after.ts')");
  expect(await scrollTop(page)).toBe(at);
  expect(await topPath(page)).toBe('g198.ts');
});

test('at the very top a new row shows instead of being scrolled past', async ({ page }) => {
  await open(page);
  expect(await scrollTop(page)).toBe(0);
  await change(page, "s.add('aa-first.ts')");
  expect(await scrollTop(page)).toBe(0);
  expect(await topPath(page)).toBe('a');
});

test('with a 24 px minimum font size, rows grow with the text and never overlap', async () => {
  const profile = join(scratch, 'profile');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ webkit: { webprefs: { minimum_font_size: 24, minimum_logical_font_size: 24 } } }));
  let context: BrowserContext | null = null;
  try {
    // Full Chromium in its new headless mode: the headless shell does not read a profile's preferences.
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 900, height: 800 } });
    const page = await context.newPage();
    await open(page);
    await change(page, "s.expand('a')");
    const rows = await page.evaluate(() => {
      const items = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].sort((a, b) => a.offsetTop - b.offsetTop);
      return items.map((r) => {
        const name = r.querySelector<HTMLElement>('span.truncate')!;
        return { top: r.offsetTop, height: r.offsetHeight, textHeight: name.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(name).fontSize) };
      });
    });
    expect(rows.length).toBeGreaterThan(5);
    // The setting took: text is at least 24 px.
    expect(Math.min(...rows.map((r) => r.fontSize))).toBeGreaterThanOrEqual(24);
    const height = rows[0].height;
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].height).toBe(height);
      expect(rows[i].textHeight).toBeLessThanOrEqual(height);
      expect(rows[i].top).toBe(i === 0 ? rows[0].top : rows[i - 1].top + height);
    }
    expect(height).toBeGreaterThan(22);
  } finally {
    await context?.close();
  }
});

test('at the default font, rows are the 22 px the tree asks for', async ({ page }) => {
  await open(page);
  const height = await page.evaluate(() => (document.querySelector('[role="treeitem"]') as HTMLElement).offsetHeight);
  expect(height).toBe(22);
});
