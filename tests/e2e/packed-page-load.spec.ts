/**
 * How a packed page (#1618) paints while it loads, and what it does when one
 * of its own two requests fails. The page's stylesheet lands before its entry
 * script has run, so for that long the browser shows the empty page.
 *
 * Proved against the built apps (apps/hook/dist: run
 * `bun run --cwd apps/review build && bun run build:hook` first), served by a
 * current server, in headless Chromium:
 *  - with the OS dark and no saved theme (the app default is dark), no frame
 *    before the entry script runs is white: the page's head sets the dark
 *    scheme before anything can paint;
 *  - the first text's fonts (Inter, Geist Mono) load while the entry script
 *    is still on its way, so text never paints in the fallback font first;
 *  - a saved light theme keeps the light canvas;
 *  - the stylesheet or the entry script failing twice shows "Plannotator
 *    couldn't finish loading." with Reload, and only that (the app root is
 *    hidden), instead of an unstyled or blank page forever;
 *  - failing once is retried, and the app loads with no line.
 */

import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { LOAD_FAILED_MESSAGE } from '../../build/pack-app';
import { openPackedApp } from '../../packages/shared/packed-app';

const repo = resolve(__dirname, '../..');
const builds = ['index.html', 'review.html'].map((name) => join(repo, 'apps/hook/dist', name));

async function serve(bundle: string): Promise<{ server: Server; url: string; entry: RegExp; css: RegExp }> {
  const app = openPackedApp(bundle);
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const answer = path.startsWith('/api/')
      ? { status: 404, headers: { 'Content-Type': 'application/json' }, body: '{}' }
      : await app.answer(path, req.method, null, false);
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const entryPath = /<script type="module"[^>]*\ssrc="(\/assets\/[^"]+)"/.exec(app.html)![1];
  const cssPath = /<link rel="stylesheet"[^>]*\shref="(\/assets\/[^"]+)"/.exec(app.html)![1];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
    entry: new RegExp(`${escape(entryPath)}(\\?.*)?$`),
    css: new RegExp(`${escape(cssPath)}(\\?.*)?$`),
  };
}

/** The RGB of one screen pixel. A 1x1 PNG has one scanline, which every PNG filter leaves as is. */
async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 }, animations: 'allow' });
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const row = inflateSync(Buffer.concat(idat));
  return [row[1]!, row[2]!, row[3]!];
}

const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

for (const file of builds) {
  const name = file.split('/').pop();

  test(`${name}: with the OS dark and no saved theme, no frame before the entry script runs is white`, async ({ browser }) => {
    test.skip(!existsSync(file), 'build the apps first');
    const { server, url, entry, css } = await serve(readFileSync(file, 'utf8'));
    const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 800, height: 600 } });
    try {
      let releaseEntry!: () => void;
      const entryHeld = new Promise<void>((done) => (releaseEntry = done));
      await context.route(entry, async (route) => {
        await entryHeld;
        await route.continue();
      });
      const page = await context.newPage();
      const cssLoaded = page.waitForResponse(css);
      // The first text's fonts are preloaded from the head, so they do not wait for the app to render text.
      const fontsLoaded = ['inter-latin-wght-normal-', 'geist-mono-latin-wght-normal-'].map((font) =>
        page.waitForResponse((r) => r.url().includes(`/assets/${font}`) && r.url().endsWith('.woff2') && r.ok()),
      );
      await page.goto(url, { waitUntil: 'commit' });
      await cssLoaded;
      await Promise.all(fontsLoaded);
      // The stylesheet is in and the app has not run: what the user sees for as long as the entry takes.
      const samples: number[] = [];
      for (let i = 0; i < 6; i++) {
        samples.push(luminance(await pixel(page, 400, 300)));
        await page.waitForTimeout(100);
      }
      expect(await page.locator('#root > *').count()).toBe(0);
      expect(Math.max(...samples)).toBeLessThan(64);
      releaseEntry();
      await expect(page.locator('#root > *').first()).toBeAttached();
      await page.waitForTimeout(200);
      expect(luminance(await pixel(page, 400, 300))).toBeLessThan(64);
    } finally {
      await context.close();
      server.close();
    }
  });

  test(`${name}: a saved light theme keeps the light canvas while the entry script loads`, async ({ browser }) => {
    test.skip(!existsSync(file), 'build the apps first');
    const { server, url, entry, css } = await serve(readFileSync(file, 'utf8'));
    const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 800, height: 600 } });
    try {
      await context.addCookies([{ name: 'plannotator-theme', value: 'light', url }]);
      let releaseEntry!: () => void;
      const entryHeld = new Promise<void>((done) => (releaseEntry = done));
      await context.route(entry, async (route) => {
        await entryHeld;
        await route.continue();
      });
      const page = await context.newPage();
      const cssLoaded = page.waitForResponse(css);
      await page.goto(url, { waitUntil: 'commit' });
      await cssLoaded;
      expect(luminance(await pixel(page, 400, 300))).toBeGreaterThan(192);
      releaseEntry();
    } finally {
      await context.close();
      server.close();
    }
  });

  for (const which of ['stylesheet', 'entry script'] as const) {
    test(`${name}: the ${which} failing twice shows the reload line`, async ({ browser }) => {
      test.skip(!existsSync(file), 'build the apps first');
      const { server, url, entry, css } = await serve(readFileSync(file, 'utf8'));
      const context = await browser.newContext({ colorScheme: 'dark' });
      try {
        let aborted = 0;
        await context.route(which === 'stylesheet' ? css : entry, async (route) => {
          // GETs only: the pages' HEAD checks of the entry (is this an old server?) are not loads.
          if (route.request().method() === 'GET') aborted++;
          await route.abort('connectionreset');
        });
        const page = await context.newPage();
        await page.goto(url);
        const line = page.locator('#plannotator-load-failed');
        await expect(line).toBeVisible();
        await expect(line).toContainText(LOAD_FAILED_MESSAGE);
        const reload = line.getByRole('button', { name: 'Reload', exact: true });
        await expect(reload).toBeVisible();
        expect((await reload.boundingBox())!.height).toBeGreaterThanOrEqual(24);
        // Only the line: an app that ran without its stylesheet is hidden, not drawn unstyled under it.
        await expect(page.locator('#root')).toBeHidden();
        expect(aborted).toBe(2);
        await expect(page.locator('#plannotator-updated')).toHaveCount(0);
      } finally {
        await context.close();
        server.close();
      }
    });

    test(`${name}: the ${which} failing once is retried and the app loads`, async ({ browser }) => {
      test.skip(!existsSync(file), 'build the apps first');
      const { server, url, entry, css } = await serve(readFileSync(file, 'utf8'));
      const context = await browser.newContext({ colorScheme: 'dark' });
      try {
        let requests = 0;
        await context.route(which === 'stylesheet' ? css : entry, async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          if (requests++ === 0) await route.abort('connectionreset');
          else await route.continue();
        });
        const page = await context.newPage();
        await page.goto(url);
        await expect(page.locator('#root > *').first()).toBeAttached();
        // Styled: the app's stylesheet applied (Tailwind's `h-full` on #root).
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('root')!).height)).toBe(`${page.viewportSize()!.height}px`);
        await page.waitForTimeout(300);
        await expect(page.locator('#plannotator-load-failed')).toHaveCount(0);
        // Two loads, no third: a retry under another URL would make the lazy chunks load a second copy of the app.
        expect(requests).toBe(2);
      } finally {
        await context.close();
        server.close();
      }
    });
  }
}
