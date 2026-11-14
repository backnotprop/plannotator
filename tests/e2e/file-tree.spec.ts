/**
 * The @plannotator/ui file tree (packages/ui/components/file-tree) in a real
 * Chromium, for what happy-dom cannot lay out:
 *
 * - scroll anchoring: rows are absolutely placed, so the tree keeps the row at
 *   the top of the view by path when rows are added, removed, opened or
 *   closed above it (and does not at the very top, where a new row shows);
 * - row height follows the text: with the browser's minimum font size at
 *   24 px, rows grow so no text box spills into the next row, and every row is
 *   still one height (the window stays exact); a change of row height while
 *   scrolled keeps the same row at the top and rows on screen;
 * - a host that sets scrollTop and changes the tree in one task keeps its
 *   scrollTop;
 * - file and folder icons line up, and right-to-left pages mirror the indent.
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

const rowsOnScreen = (page: Page) =>
  page.evaluate(() => {
    const tree = (window as any).__h.tree() as HTMLElement;
    const top = tree.scrollTop;
    const bottom = top + tree.clientHeight;
    return [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((r) => r.offsetTop + r.offsetHeight > top && r.offsetTop < bottom).length;
  });

test('a row height change while scrolled keeps the top row and rows on screen', async ({ page }) => {
  await open(page);
  await scrollToRow(page, 'g300.ts');
  expect(await topPath(page)).toBe('g300.ts');
  // Larger text (as text-only zoom or a minimum font size does): the probe grows, rows grow.
  await page.addStyleTag({ content: '[data-file-tree] [role="treeitem"], [data-ft-probe] { font-size: 22px !important; }' });
  await page.waitForTimeout(100);
  const height = await page.evaluate(() => (document.querySelector('[role="treeitem"]') as HTMLElement).offsetHeight);
  expect(height).toBeGreaterThan(22);
  expect(await topPath(page)).toBe('g300.ts');
  expect(await rowsOnScreen(page)).toBeGreaterThan(10);
  // And back.
  await page.evaluate(() => document.querySelectorAll('style').forEach((s) => { if (s.textContent?.includes('22px !important')) s.remove(); }));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (document.querySelector('[role="treeitem"]') as HTMLElement).offsetHeight)).toBe(22);
  expect(await topPath(page)).toBe('g300.ts');
  expect(await rowsOnScreen(page)).toBeGreaterThan(10);
});

test('a host that scrolls and changes the tree in one task keeps its scrollTop', async ({ page }) => {
  await open(page);
  await scrollToRow(page, 'g300.ts');
  const target = await page.evaluate(() => {
    const h = (window as any).__h;
    const tree = h.tree() as HTMLElement;
    const y = h.store.model.indexOf('g100.ts') * 22;
    tree.scrollTop = y;
    h.store.add('c1.ts');
    return y;
  });
  await page.waitForTimeout(80);
  expect(await scrollTop(page)).toBe(target);
  expect(await rowsOnScreen(page)).toBeGreaterThan(10);
});

async function iconEdges(page: Page) {
  await change(page, "s.expand('a')");
  return page.evaluate(() => {
    const row = (p: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-path="${p}"]`)!;
    const folderIcon = row('a').querySelectorAll('svg')[1].getBoundingClientRect();
    const fileIcon = row('g000.ts').querySelector('svg')!.getBoundingClientRect();
    const childIcon = row('a/one.ts').querySelector('svg')!.getBoundingClientRect();
    const guides = row('a/one.ts').querySelector<HTMLElement>('[data-guides]')!.getBoundingClientRect();
    const r = row('a').getBoundingClientRect();
    return { folderIcon: { left: folderIcon.left, right: folderIcon.right }, fileIcon: { left: fileIcon.left, right: fileIcon.right }, childIcon: { left: childIcon.left, right: childIcon.right }, guides: { left: guides.left, right: guides.right }, row: { left: r.left, right: r.right } };
  });
}

test('file and folder icons line up, and a right-to-left page mirrors the indent', async ({ page }) => {
  await open(page);
  const ltr = await iconEdges(page);
  expect(ltr.fileIcon.left).toBe(ltr.folderIcon.left);
  expect(ltr.childIcon.left).toBe(ltr.folderIcon.left + 8);
  expect(ltr.guides.left - ltr.row.left).toBeLessThan(ltr.childIcon.left - ltr.row.left);

  await page.goto(`${base}/?mode=live&theme=light`);
  await page.waitForFunction(() => (window as any).__h?.ready === true);
  await page.evaluate(() => { document.getElementById('live')!.dir = 'rtl'; });
  const rtl = await iconEdges(page);
  expect(rtl.fileIcon.right).toBe(rtl.folderIcon.right);
  expect(rtl.childIcon.right).toBe(rtl.folderIcon.right - 8);
  // Mirrored: the indent sits on the right, measured from the row's right edge as LTR measures from its left.
  expect(rtl.row.right - rtl.folderIcon.right).toBe(ltr.folderIcon.left - ltr.row.left);
  expect(rtl.row.right - rtl.guides.right).toBe(ltr.guides.left - ltr.row.left);
});

// Several trees in one host scroll (`scrollParent`), the host's section headers between them (?mode=sections).
async function openSections(page: Page) {
  await page.goto(`${base}/?mode=sections&theme=light`);
  await page.waitForFunction(() => (window as any).__h?.ready === true);
}

/** Rows of the second tree ("Folder") inside the scroller's view, by path. */
const folderRowsInView = (page: Page) =>
  page.evaluate(() => {
    const h = (window as any).__h;
    const box = (h.scroller() as HTMLElement).getBoundingClientRect();
    const tree = h.trees()[1] as HTMLElement;
    return [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .filter((r) => {
        const b = r.getBoundingClientRect();
        return b.bottom > box.top && b.top < box.bottom;
      })
      .map((r) => r.dataset.path!)
      .sort();
  });

test('trees in one host scroll draw the rows that show in it, below the host header', async ({ page }) => {
  await openSections(page);
  const mounted = await page.evaluate(() => (window as any).__h.trees()[1].querySelectorAll('[role="treeitem"]').length);
  // A window, not 500 rows, even though the tree is its full height in the scroll.
  expect(mounted).toBeLessThan(80);
  const first = await folderRowsInView(page);
  expect(first[0]).toBe('g000.ts');
  // The view is filled under the first tree and the two headers: 600 - 2 × 40 - 12 × 22 = 256 px of the second.
  expect(first.length).toBeGreaterThanOrEqual(11);

  // Scrolled far down in the host's element: the rows there are drawn, the first ones are not.
  await page.evaluate(() => {
    const h = (window as any).__h;
    const s = h.scroller() as HTMLElement;
    const tree = h.trees()[1] as HTMLElement;
    s.scrollTop = tree.offsetTop + 300 * 22;
  });
  await page.waitForTimeout(80);
  const later = await folderRowsInView(page);
  expect(later).toContain('g300.ts');
  expect(later.length).toBeGreaterThan(20);
  expect(await page.evaluate(() => !!(window as any).__h.trees()[1].querySelector('[data-path="g000.ts"]'))).toBe(false);
});

test('keys in a tree in a host scroll scroll that element to the focused row', async ({ page }) => {
  await openSections(page);
  await page.evaluate(() => (window as any).__h.trees()[1].focus());
  await page.keyboard.press('End');
  await page.waitForTimeout(80);
  expect(await folderRowsInView(page)).toContain('g499.ts');
  await page.keyboard.press('Home');
  await page.waitForTimeout(80);
  expect(await folderRowsInView(page)).toContain('g000.ts');
  // The first row is fully in view (its top at or below the scroller's top).
  const rowTop = await page.evaluate(() => {
    const h = (window as any).__h;
    return h.trees()[1].querySelector('[data-path="g000.ts"]').getBoundingClientRect().top - (h.scroller() as HTMLElement).getBoundingClientRect().top;
  });
  expect(rowTop).toBeGreaterThanOrEqual(0);
});

