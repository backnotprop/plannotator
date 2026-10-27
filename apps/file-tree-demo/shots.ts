/**
 * Headless screenshots and a short video of the file tree demo.
 *
 *   bun run dev:file-tree-demo            (in one terminal)
 *   node apps/file-tree-demo/shots.ts [outDir]   (default /tmp/file-tree-demo)
 *
 * Headless Chromium only; opens no browser on screen.
 */
import { chromium, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NO_BROWSER } from '../../tests/helpers/no-browser.ts';

process.env.PLANNOTATOR_BROWSER = NO_BROWSER;

const BASE = process.env.DEMO_URL ?? 'http://127.0.0.1:5317/';
const out = process.argv[2] ?? '/tmp/file-tree-demo';
mkdirSync(out, { recursive: true });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ready(page: Page): Promise<void> {
  await page.waitForSelector('[role="tree"] [role="treeitem"]');
  await page.waitForFunction(() => {
    const t = document.querySelector('[role="tree"]');
    return t && t.getAttribute('aria-busy') !== 'true';
  });
  await wait(400);
}

async function open(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    const d = (window as any).__demo;
    d.tree.current.revealPath(p);
    d.select(p);
  }, path);
  await wait(300);
}

async function hoverTree(page: Page): Promise<void> {
  const box = await page.locator('[role="tree"]').boundingBox();
  if (box) await page.mouse.move(box.x + box.width * 0.6, box.y + 80);
  await wait(250);
}

async function shot(browser: Browser, name: string, query: string, opts: { width: number; height: number; phone?: boolean }, act?: (page: Page) => Promise<void>): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 2,
    ...(opts.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?${query}`);
  await ready(page);
  if (act) await act(page);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`${name}.png`);
  await ctx.close();
}

const browser = await chromium.launch({ headless: true });
try {
  const repoFile = 'packages/ui/components/file-tree/FileTree.tsx';
  for (const mode of ['light', 'dark'] as const) {
    await shot(browser, `repo-${mode}-1440`, `theme=${mode}`, { width: 1440, height: 900 }, async (page) => {
      await open(page, repoFile);
      await hoverTree(page);
    });
  }
  await shot(browser, 'phone-390', 'set=repo', { width: 390, height: 844, phone: true }, async (page) => {
    await open(page, 'packages/ui/components/file-tree/store.ts');
  });
  await shot(browser, 'phone-preset-1440', 'phone=1&theme=dark', { width: 1440, height: 900 }, async (page) => {
    await open(page, repoFile);
  });
  await shot(browser, 'huge-scrolled-1440', 'set=huge', { width: 1440, height: 900 }, async (page) => {
    await page.click('[data-control="expand-all"]');
    await wait(500);
    await hoverTree(page);
    for (let i = 0; i < 60; i++) {
      await page.mouse.wheel(0, 900);
      await wait(16);
    }
    // Then a jump far down, as a scrollbar drag would.
    await page.evaluate(() => {
      const t = document.querySelector('[role="tree"]')!;
      t.scrollTop = t.scrollHeight * 0.62;
    });
    await wait(700);
    await page.mouse.wheel(0, 300);
    await wait(700);
  });
  await shot(browser, 'worst-light-1440', 'set=worst&guides=always', { width: 1440, height: 900 }, async (page) => {
    await open(page, 'unicode/emoji 🎉/👨‍👩‍👧‍👦 family.txt');
  });
  await shot(browser, 'worst-dark-320', 'set=worst&theme=dark&w=320&guides=always', { width: 1440, height: 900 }, async (page) => {
    await open(page, 'unicode/ドキュメント/とても長い日本語のファイル名がここに続いていきますよ本当に長いです.txt');
  });
  await shot(browser, 'worst-deep-1440', 'set=worst&guides=always', { width: 1440, height: 900 }, async (page) => {
    let deep = 'deep';
    for (let i = 1; i <= 35; i++) deep += `/level-${String(i).padStart(2, '0')}`;
    await open(page, `${deep}/the-bottom.txt`);
  });
  await shot(browser, 'worst-siblings-1440', 'set=worst&filter=many-siblings%2Ffile-49', { width: 1440, height: 900 });

  // Video: keyboard navigation, then live changes.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: join(out, 'video-tmp'), size: { width: 1280, height: 800 } } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?set=repo&guides=always`);
  await ready(page);
  await page.locator('[role="tree"]').focus();
  const key = async (k: string, n = 1, gap = 220) => {
    for (let i = 0; i < n; i++) {
      await page.keyboard.press(k);
      await wait(gap);
    }
  };
  await key('Home');
  await key('ArrowDown', 6);
  await key('ArrowRight');
  await key('ArrowRight');
  await key('ArrowDown', 3);
  await key('ArrowLeft');
  await key('End', 1, 500);
  await key('Home', 1, 500);
  for (const c of 'pack') await key(c, 1, 90);
  await wait(400);
  await key('ArrowRight');
  await key('ArrowDown', 2);
  await key('Enter', 1, 600);
  await key('ArrowDown', 2);
  await key(' ', 1, 700);
  await page.click('[data-control="live"]');
  await wait(900);
  await page.click('[data-control="live"]');
  await wait(900);
  await page.click('[data-control="live"]');
  await wait(1200);
  await ctx.close();
  const dir = join(out, 'video-tmp');
  const file = readdirSync(dir).find((f) => f.endsWith('.webm'));
  if (file) renameSync(join(dir, file), join(out, 'keyboard-and-live-change.webm'));
  rmSync(dir, { recursive: true, force: true });
  console.log('keyboard-and-live-change.webm');
  // An mp4 too, when ffmpeg is installed (plays in more places).
  const mp4 = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(out, 'keyboard-and-live-change.webm'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, 'keyboard-and-live-change.mp4')]);
  if (mp4.status === 0) console.log('keyboard-and-live-change.mp4');
} finally {
  await browser.close();
}
