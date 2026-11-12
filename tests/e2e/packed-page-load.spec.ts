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
      const fontsLoaded = ['inter-latin-wght-normal-', 'geist-mono-latin-wght-normal-'].map((font) =>
        page.waitForResponse((r) => r.url().includes(`/assets/${font}`) && r.url().endsWith('.woff2') && r.ok()),
      );
      await page.goto(url, { waitUntil: 'commit' });
      await cssLoaded;
      await Promise.all(fontsLoaded);
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
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('root')!).height)).toBe(`${page.viewportSize()!.height}px`);
        await page.waitForTimeout(300);
        await expect(page.locator('#plannotator-load-failed')).toHaveCount(0);
        expect(requests).toBe(2);
      } finally {
        await context.close();
        server.close();
      }
    });
  }
}
