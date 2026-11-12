import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openPackedApp, type PackedApp } from '../../packages/shared/packed-app';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const pages: Record<string, string> = {
  '/plan': join(repo, 'apps/hook/dist/index.html'),
  '/review': join(repo, 'apps/hook/dist/review.html'),
};

function countColourTransitions(): void {
  const w = window as unknown as { __colourRuns: number };
  w.__colourRuns = 0;
  document.addEventListener(
    'transitionrun',
    (event) => {
      const { propertyName, target } = event as TransitionEvent;
      if (target instanceof Element && target.getAttribute('class')?.includes('dark:')) return;
      if (/color|shadow|fill|stroke|gradient/.test(propertyName)) w.__colourRuns++;
    },
    true,
  );
}

async function colourRunsDuring(page: Page, flip: () => Promise<unknown>): Promise<number> {
  await page.evaluate(() => ((window as unknown as { __colourRuns: number }).__colourRuns = 0));
  await flip();
  await page.waitForTimeout(600);
  return page.evaluate(() => (window as unknown as { __colourRuns: number }).__colourRuns);
}

const press = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const shown = [...document.querySelectorAll<HTMLElement>(s)].find((el) => el.getClientRects().length > 0 || el.closest('label')?.getClientRects().length);
    if (!shown) throw new Error(`nothing shown for ${s}`);
    shown.click();
  }, selector);
const shownLight = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('light'));

async function expectHoverFadesBack(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('pn-theme-switching'))).toBe(false);
  expect(await page.evaluate(() => getComputedStyle(document.body).transitionDuration)).toBe('0.15s');
}

let server: Server | null = null;
let origin = '';

test.beforeAll(async () => {
  for (const file of Object.values(pages)) {
    if (!existsSync(file)) throw new Error(`${file} is missing: run bun run --cwd apps/review build && bun run build:hook`);
  }
  const apps: PackedApp[] = Object.values(pages).map((file) => openPackedApp(readFileSync(file, 'utf8')));
  server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path.startsWith('/assets/')) {
      for (const app of apps) {
        const asset = await app.answer(path, req.method, null, false);
        if (asset.status !== 200) continue;
        res.writeHead(200, asset.headers);
        res.end(asset.body);
        return;
      }
    }
    const index = Object.keys(pages).indexOf(path);
    if (index < 0) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(apps[index]!.html);
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  await removeInboxScratch();
});

async function openInbox(browser: Browser, options: BrowserContextOptions) {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-theme-instant-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_TEST_SANDBOX: '1' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await context.addInitScript(countColourTransitions);
  const page = await context.newPage();
  await page.goto(started.stdout.trim());
  await expect(page.locator('button[data-theme-toggle]:visible')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('transitions-ready'))).toBe(true);
  return { context, page };
}

test('the Inbox: the toggle, Settings, Match system and the computer changing scheme start no colour fade', async ({ browser }) => {
  const { context, page } = await openInbox(browser, { colorScheme: 'light' });
  try {
    expect(await shownLight(page)).toBe(true);

    expect(await colourRunsDuring(page, () => press(page, 'button[data-theme-toggle]'))).toBe(0);
    expect(await shownLight(page)).toBe(false);
    expect(await colourRunsDuring(page, () => press(page, 'button[data-theme-toggle]'))).toBe(0);
    expect(await shownLight(page)).toBe(true);

    await page.evaluate(() => (location.hash = '#settings'));
    await expect(page.locator('[data-settings-theme]')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await colourRunsDuring(page, () => press(page, '[data-settings-theme] input[value="dark"]'))).toBe(0);
    expect(await shownLight(page)).toBe(false);
    expect(await colourRunsDuring(page, () => press(page, '[data-settings-theme] input[value="system"]'))).toBe(0);
    expect(await shownLight(page)).toBe(true);

    expect(await colourRunsDuring(page, () => page.emulateMedia({ colorScheme: 'dark' }))).toBe(0);
    expect(await shownLight(page)).toBe(false);

    await expectHoverFadesBack(page);
  } finally {
    await context.close();
  }
});

test('the Inbox under reduced motion still lands in one frame', async ({ browser }) => {
  const { context, page } = await openInbox(browser, { colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    expect(await colourRunsDuring(page, () => press(page, 'button[data-theme-toggle]'))).toBe(0);
    expect(await shownLight(page)).toBe(false);
    await expectHoverFadesBack(page);
  } finally {
    await context.close();
  }
});

test('a transition already running (a transform, as a sheet slides) keeps running through a switch', async ({ browser }) => {
  const { context, page } = await openInbox(browser, { colorScheme: 'light' });
  try {
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.id = 'motion-probe';
      probe.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;transition:transform 2000ms linear';
      document.body.appendChild(probe);
      void probe.getBoundingClientRect();
      probe.style.transform = 'translateX(200px)';
    });
    await page.waitForTimeout(200);
    await press(page, 'button[data-theme-toggle]');
    await page.waitForTimeout(200);
    const running = await page.evaluate(() =>
      document
        .getElementById('motion-probe')!
        .getAnimations()
        .map((a) => ({ state: a.playState, property: (a as CSSTransition).transitionProperty })),
    );
    expect(await shownLight(page)).toBe(false);
    expect(running).toEqual([{ state: 'running', property: 'transform' }]);
  } finally {
    await context.close();
  }
});

for (const [surface, path] of [['plan review', '/plan'], ['code review', '/review']] as const) {
  test(`${surface} on Match system follows the computer's scheme with no colour fade`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    try {
      await context.addCookies([{ name: 'plannotator-theme', value: 'system', url: origin }]);
      await context.addInitScript(countColourTransitions);
      const page = await context.newPage();
      await page.goto(`${origin}${path}`);
      await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('transitions-ready'))).toBe(true);
      await page.waitForTimeout(1500);
      expect(await shownLight(page)).toBe(true);

      expect(await colourRunsDuring(page, () => page.emulateMedia({ colorScheme: 'dark' }))).toBe(0);
      expect(await shownLight(page)).toBe(false);
      expect(await colourRunsDuring(page, () => page.emulateMedia({ colorScheme: 'light' }))).toBe(0);
      expect(await shownLight(page)).toBe(true);
      await expectHoverFadesBack(page);
    } finally {
      await context.close();
    }
  });
}
