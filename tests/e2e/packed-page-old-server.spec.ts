import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UPDATED_WHILE_OPEN_MESSAGE } from '../../build/pack-app';
import { openPackedApp } from '../../packages/shared/packed-app';

const repo = resolve(__dirname, '../..');
const builds = ['index.html', 'review.html'].map((name) => join(repo, 'apps/hook/dist', name));

type Handler = (path: string, method: string) => { status: number; headers: Record<string, string>; body: string | Buffer } | Promise<{ status: number; headers: Record<string, string>; body: string | Buffer }>;

async function serve(handle: { current: Handler }): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const answer = await handle.current(path, req.method ?? 'GET');
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

const oldServer = (bundle: string): Handler => (path) =>
  path.startsWith('/api/')
    ? { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Not found', path }) }
    : { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: bundle };

const currentServer = (bundle: string): Handler => {
  const app = openPackedApp(bundle);
  return (path, method) =>
    path.startsWith('/api/')
      ? { status: 404, headers: { 'Content-Type': 'application/json' }, body: '{}' }
      : app.answer(path, method, null, false);
};

for (const file of builds) {
  const name = file.split('/').pop();

  test(`${name} served whole by an old server says it was updated, and renders none of the pack`, async ({ page }) => {
    test.skip(!existsSync(file), 'build the apps first');
    const bundle = readFileSync(file, 'utf8');
    const { server, url } = await serve({ current: oldServer(bundle) });
    try {
      await page.goto(url);
      await expect(page.locator('#plannotator-updated')).toHaveText(UPDATED_WHILE_OPEN_MESSAGE);
      await expect(page.locator('#plannotator-updated')).toBeVisible();
      await expect(page.locator('plaintext')).toBeHidden();
      const text = await page.evaluate(() => document.body.innerText);
      expect(text.trim()).toBe(UPDATED_WHILE_OPEN_MESSAGE);
      expect(await page.locator('#root').innerHTML()).toBe('');
    } finally {
      server.close();
    }
  });

  test(`${name} served whole by an old server keeps the scheme of the user's theme when the message shows`, async ({ browser }) => {
    test.skip(!existsSync(file), 'build the apps first');
    const bundle = readFileSync(file, 'utf8');
    const { server, url } = await serve({ current: oldServer(bundle) });
    const context = await browser.newContext({ colorScheme: 'light' });
    try {
      await context.addCookies([{ name: 'plannotator-theme', value: 'dark', url }]);
      const page = await context.newPage();
      await page.goto(url);
      const message = page.locator('#plannotator-updated');
      await expect(message).toHaveText(UPDATED_WHILE_OPEN_MESSAGE);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
      const [bg, fg] = await message.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
      expect(luminance(bg)).toBeLessThan(64);
      expect(luminance(fg)).toBeGreaterThan(192);
    } finally {
      await context.close();
      server.close();
    }
  });

  test(`${name} served by a current server loads without the message; a lazy chunk failure shows it only once an old server answers`, async ({ page }) => {
    test.skip(!existsSync(file), 'build the apps first');
    const bundle = readFileSync(file, 'utf8');
    const handle = { current: currentServer(bundle) };
    const { server, url } = await serve(handle);
    try {
      await page.goto(url);
      await expect(page.locator('#root > *').first()).toBeAttached();
      await preloadErrorChecked(page);
      await expect(page.locator('#plannotator-updated')).toHaveCount(0);
      handle.current = oldServer(bundle);
      await page.evaluate(() => dispatchEvent(new Event('vite:preloadError')));
      await expect(page.locator('#plannotator-updated')).toHaveText(UPDATED_WHILE_OPEN_MESSAGE);
    } finally {
      server.close();
    }
  });

  test(`${name} behind a proxy that answers 502 (the session ended) says nothing`, async ({ page }) => {
    test.skip(!existsSync(file), 'build the apps first');
    const app = openPackedApp(readFileSync(file, 'utf8'));
    const badGateway: Handler = () => ({ status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: '<h1>502 Bad Gateway</h1>' });
    const handle = { current: ((path) => (path === '/' ? { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: app.html } : badGateway(path, 'GET'))) as Handler };
    const { server, url } = await serve(handle);
    try {
      const checked = page.waitForResponse((r) => r.request().method() === 'HEAD');
      await page.goto(url);
      await checked;
      await page.waitForTimeout(300);
      await expect(page.locator('#plannotator-updated')).toHaveCount(0);
      handle.current = badGateway;
      await preloadErrorChecked(page);
      await expect(page.locator('#plannotator-updated')).toHaveCount(0);
    } finally {
      server.close();
    }
  });
}

function luminance(color: string): number {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

async function preloadErrorChecked(page: import('@playwright/test').Page) {
  const checked = page.waitForResponse((r) => r.request().method() === 'HEAD');
  await page.evaluate(() => dispatchEvent(new Event('vite:preloadError')));
  await checked;
  await page.waitForTimeout(300);
}
