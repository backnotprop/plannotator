/**
 * A theme switch lands in one frame (owner, 2026-11-02). theme.css gives every
 * element a 150 ms colour transition; a switch changes every colour, so it
 * used to start one transition per element at once, and the page froze for
 * about 0.4 s before the fade even began. ThemeProvider now holds
 * `pn-theme-switching` on <html> while a switch lands, and theme.css sets
 * every transition's duration and delay to 0 s under it.
 *
 * Proved in Chromium by counting `transitionrun` events for colour properties
 * while the theme flips: none, wherever the switch comes from.
 *  - The Inbox (compiled binary, temp PLANNOTATOR_DATA_DIR and HOME): the
 *    sidebar's toggle, Settings' Theme row, Match system and then the
 *    computer's own scheme changing, and the toggle again under reduced motion.
 *  - Plan review and code review (the packed apps from apps/hook/dist, served
 *    on loopback so they show their demo plan and diff), on Match system,
 *    following the computer's scheme both ways.
 * And what must not change with it: a transition already running (here a
 * transform, as a sheet or menu runs) keeps running through the switch, and
 * once it has landed every element has its 150 ms colour transition back, so
 * hovers fade as before.
 *
 * Build first: `bun run --cwd apps/review build && bun run build:hook`, and
 * the binary (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts theme-instant-switch.spec.ts`.
 */

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

/**
 * Counts every colour transition the page starts, from the first script on.
 * Left out: an element styled with Tailwind's `dark:`, which here follows the
 * computer's scheme by media query, not the theme; the browser restyles it
 * when the scheme flips, before any script hears of the change, so no hold
 * can reach it (a separate matter: it ignores an explicit Light or Dark too).
 */
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

/** How many colour transitions `flip` starts, counted until any would have ended. */
async function colourRunsDuring(page: Page, flip: () => Promise<unknown>): Promise<number> {
  await page.evaluate(() => ((window as unknown as { __colourRuns: number }).__colourRuns = 0));
  await flip();
  await page.waitForTimeout(600);
  return page.evaluate(() => (window as unknown as { __colourRuns: number }).__colourRuns);
}

/** A click on the one shown, with no pointer move, so no hover starts a fade of its own. */
const press = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const shown = [...document.querySelectorAll<HTMLElement>(s)].find((el) => el.getClientRects().length > 0 || el.closest('label')?.getClientRects().length);
    if (!shown) throw new Error(`nothing shown for ${s}`);
    shown.click();
  }, selector);
const shownLight = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('light'));

/** Settled: the hold is gone and an ordinary element has theme.css's colour transition again. */
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
      // No Plannotator server: the editor shows its demo plan, the review app its demo diff.
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

/** A fresh Inbox in its own scratch folder, tour decided, on its list. */
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

    // The sidebar's toggle, both ways.
    expect(await colourRunsDuring(page, () => press(page, 'button[data-theme-toggle]'))).toBe(0);
    expect(await shownLight(page)).toBe(false);
    expect(await colourRunsDuring(page, () => press(page, 'button[data-theme-toggle]'))).toBe(0);
    expect(await shownLight(page)).toBe(true);

    // Settings' Theme row: Dark, then Match system (this computer is light).
    await page.evaluate(() => (location.hash = '#settings'));
    await expect(page.locator('[data-settings-theme]')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await colourRunsDuring(page, () => press(page, '[data-settings-theme] input[value="dark"]'))).toBe(0);
    expect(await shownLight(page)).toBe(false);
    expect(await colourRunsDuring(page, () => press(page, '[data-settings-theme] input[value="system"]'))).toBe(0);
    expect(await shownLight(page)).toBe(true);

    // The computer turns dark at sunset, with no click at all.
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
