/**
 * On desktop Linux, Inter's stylistic sets reach Inter only (#1961). They are
 * set with `font-feature-settings` on body, which every element inherits,
 * whatever font it renders in: on Linux, code review's diffs and line-number
 * gutters fall back to Ubuntu Mono, whose `ss02` turns digits into
 * superscripts. Under `pn-os-linux` (put on <html> by ThemeProvider, from the
 * navigator) theme.css instead names the sets for Inter's families
 * (`@font-feature-values`) and applies them with `font-variant-alternates`,
 * which a font not named there ignores. macOS, iOS and Windows keep the body
 * rule unchanged (SF Pro, the system-ui themes' font, draws its open 4 and
 * straight 6 and 9 with it).
 *
 * Proved in real browsers against the built apps (apps/hook/dist: run
 * `bun run --cwd apps/review build && bun run build:hook` first), served on
 * loopback so the review app falls back to its demo diff. Each page is told
 * its platform by a navigator stub (init script), so the Linux and macOS
 * paths both run on any host:
 *  - Linux: every monospace surface computes `font-feature-settings: normal`:
 *    the diff's gutter numbers and code inside Pierre's shadow roots, and the
 *    plan's fenced code, `.font-mono` and `kbd`; body asks for Inter's named
 *    sets. (The bundled Inter subset has no ss01, ss02 or cv01 glyphs, so
 *    nothing here claims a pixel difference on Inter.)
 *  - macOS and Windows: body and the monospace text compute the body rule's
 *    `"ss01", "ss02", "cv01"`, exactly as before, with no alternates;
 *  - Linux, with a font whose `ss02` is superscript digits
 *    (PLANNOTATOR_E2E_SS02_FONT: a path to Ubuntu Mono, from google/fonts
 *    `ufl/ubuntumono`) standing in for the monospace font: the gutter and a
 *    fenced code block render exactly as the font does with no features, while
 *    the old body rule, put back, changes them. Skipped when the variable is unset.
 * Browsers: chromium and webkit (what CI installs), or PLANNOTATOR_E2E_FONT_BROWSERS
 * (comma list, e.g. "chromium,firefox,webkit").
 */

import { chromium, expect, firefox, test, webkit, type Locator, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(__dirname, '../..');
const pages: Record<string, string> = {
  '/review': join(repo, 'apps/hook/dist/review.html'),
  '/plan': join(repo, 'apps/hook/dist/index.html'),
};
const ss02FontPath = process.env.PLANNOTATOR_E2E_SS02_FONT;
const TEST_FONT = 'PN SS02 Test';
/**
 * The body rule: what theme.css carried everywhere before #1961, and still
 * carries outside Linux. Put back on a Linux page, so `!important` to beat
 * `:root.pn-os-linux body`.
 */
const OLD_BODY_RULE = 'body { font-feature-settings: "ss01", "ss02", "cv01" !important; }';
const browsers = (process.env.PLANNOTATOR_E2E_FONT_BROWSERS ?? 'chromium,webkit')
  .split(',')
  .map((name) => name.trim())
  .filter((name): name is 'chromium' | 'firefox' | 'webkit' => ['chromium', 'firefox', 'webkit'].includes(name));

const engines = { chromium, firefox, webkit };

/** What each platform's browser reports; the page's CSS keys off the class rootPlatform derives from it. */
const NAVIGATORS = {
  linux: { platform: 'Linux x86_64', hint: 'Linux', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' },
  mac: { platform: 'MacIntel', hint: 'macOS', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' },
  windows: { platform: 'Win32', hint: 'Windows', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' },
};
type Os = keyof typeof NAVIGATORS;
/** The tags macOS, iOS and Windows keep. */
const KEPT_FEATURES = ['cv01', 'ss01', 'ss02'];
/** A computed font-feature-settings as its sorted tags (Chromium sorts them, WebKit keeps the authored order). */
const tags = (value: string) => (value === 'normal' ? [] : value.split(',').map((tag) => tag.trim().replace(/^"|"$/g, '')).sort());

/**
 * A fresh browser of that engine per test (the config's own browser is chromium only).
 * The config's launch args are Chromium's (`--use-mock-keychain`, `--password-store=basic`),
 * and WebKit and Firefox refuse to start with them, so the other engines get none.
 */
async function withPage(name: keyof typeof engines, os: Os, run: (page: Page) => Promise<void>) {
  const browser = await engines[name].launch(name === 'chromium' ? { headless: true } : { headless: true, args: [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript((nav) => {
      const define = (key: string, value: unknown) => Object.defineProperty(Navigator.prototype, key, { configurable: true, get: () => value });
      define('platform', nav.platform);
      define('userAgent', nav.userAgent);
      define('userAgentData', { platform: nav.hint, brands: [], mobile: false });
    }, NAVIGATORS[os]);
    await run(page);
  } finally {
    await browser.close();
  }
}

let server: Server;
let origin = '';

test.beforeAll(async () => {
  for (const file of Object.values(pages)) {
    if (!existsSync(file)) throw new Error(`${file} is missing: run bun run --cwd apps/review build && bun run build:hook`);
  }
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/test-font' && ss02FontPath) {
      res.writeHead(200, { 'content-type': 'font/ttf' });
      res.end(readFileSync(ss02FontPath));
      return;
    }
    const file = pages[path];
    if (!file) {
      // No Plannotator server: the review app shows its demo diff, the editor its demo plan.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server?.close(() => done()));
});

const GUTTER = 'diffs-container [data-column-number]';
const FENCE = 'pre > code.pn-code';

/** Click through the first-run announcements (a fresh browser sees them all), so nothing covers the page. */
async function dismissFirstRun(page: Page) {
  await page.waitForTimeout(1500);
  for (let i = 0; i < 10; i++) {
    const buttons = page.getByRole('button', { name: /^(Got it|Continue|Done)$/ });
    let clicked = false;
    for (let k = 0; k < (await buttons.count()); k++) {
      if (await buttons.nth(k).isVisible()) {
        await buttons.nth(k).click();
        clicked = true;
        await page.waitForTimeout(700);
        break;
      }
    }
    if (!clicked) return;
  }
}

async function openReview(page: Page) {
  await page.goto(`${origin}/review`);
  await expect(page.locator(GUTTER).first()).toBeVisible();
  await dismissFirstRun(page);
  await page.evaluate(() => document.fonts.ready);
}

async function openPlan(page: Page) {
  await page.goto(`${origin}/plan`);
  await expect(page.locator(FENCE).first()).toBeVisible();
  await dismissFirstRun(page);
  await page.evaluate(() => document.fonts.ready);
}

/** What the browser paints at the element's place once the page has settled (Pierre re-renders on a font change). */
async function paintedAt(page: Page, locator: Locator): Promise<Buffer> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('element not on screen');
  return page.screenshot({ clip: box, animations: 'disabled', caret: 'hide' });
}

/** Computed font-feature-settings of every match, shadow roots included. */
async function featureSettings(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const visit = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll(sel)) out.push(getComputedStyle(el).fontFeatureSettings);
      for (const host of root.querySelectorAll('*')) if (host.shadowRoot) visit(host.shadowRoot);
    };
    visit(document);
    return out;
  }, selector);
}

/** Selector inside Pierre's shadow roots: `diffs-container X` → X under each root. */
async function shadowSettings(page: Page, inner: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const host of document.querySelectorAll('diffs-container')) {
      const root = host.shadowRoot;
      if (!root) continue;
      for (const el of root.querySelectorAll(sel)) out.push(getComputedStyle(el).fontFeatureSettings);
    }
    return out;
  }, inner);
}

async function addStyle(page: Page, css: string): Promise<() => Promise<void>> {
  const handle = await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  return async () => {
    await handle.evaluate((el) => el.remove());
  };
}

for (const browserName of browsers) {
  test.describe(browserName, () => {
    for (const os of ['mac', 'windows'] as const) {
      test(`${os}: body keeps "ss01", "ss02", "cv01" and everything inherits it, as before`, async () => withPage(browserName, os, async (page) => {
        await openReview(page);
        expect(await page.evaluate(() => document.documentElement.className)).toContain(os === 'mac' ? 'pn-os-apple' : 'pn-os-windows');
        const body = await page.evaluate(() => {
          const style = getComputedStyle(document.body);
          return { alternates: style.fontVariantAlternates, features: style.fontFeatureSettings };
        });
        expect(body.alternates).toBe('normal');
        expect(tags(body.features)).toEqual(KEPT_FEATURES);
        const gutter = await shadowSettings(page, '[data-column-number]');
        expect(gutter.length).toBeGreaterThan(0);
        for (const value of gutter) expect(tags(value)).toEqual(KEPT_FEATURES);

        await openPlan(page);
        const mono = await featureSettings(page, '.font-mono:not(pre, code, pre *, code *)');
        expect(mono.length).toBeGreaterThan(0);
        for (const value of mono) expect(tags(value)).toEqual(KEPT_FEATURES);
      }));
    }

    test('linux: code review: the gutter and diff code inside Pierre get no feature tags', async () => withPage(browserName, 'linux', async (page) => {
      await openReview(page);
      expect(await page.evaluate(() => document.documentElement.className)).toContain('pn-os-linux');
      const gutter = await shadowSettings(page, '[data-column-number]');
      const code = await shadowSettings(page, '[data-line], [data-line] *');
      expect(gutter.length).toBeGreaterThan(0);
      expect(code.length).toBeGreaterThan(0);
      expect(new Set([...gutter, ...code])).toEqual(new Set(['normal']));
      // The prose around them still asks Inter for its sets.
      const body = await page.evaluate(() => {
        const style = getComputedStyle(document.body);
        return { alternates: style.fontVariantAlternates, features: style.fontFeatureSettings, family: style.fontFamily };
      });
      expect(body.features).toBe('normal');
      expect(body.alternates).toContain('pn-inter');
      expect(body.family).toContain('Inter Variable');
    }));

    test('linux: plan review: fenced code, .font-mono and kbd get no feature tags', async () => withPage(browserName, 'linux', async (page) => {
      await openPlan(page);
      const fence = await featureSettings(page, FENCE);
      const mono = await featureSettings(page, '.font-mono, kbd, pre, code');
      expect(fence.length).toBeGreaterThan(0);
      expect(new Set([...fence, ...mono])).toEqual(new Set(['normal']));
    }));

    test.describe('with a font whose ss02 is superscript digits', () => {
      test.skip(!ss02FontPath, 'set PLANNOTATOR_E2E_SS02_FONT to a font with superscript ss02 (Ubuntu Mono)');

      const useTestFont = `@font-face { font-family: "${TEST_FONT}"; src: url(/test-font); }
:root:root { --diffs-font-family: "${TEST_FONT}" !important; --font-mono: "${TEST_FONT}" !important; }`;

      test('linux: the diff gutter renders plain digits, and the old rule would not', async () => withPage(browserName, 'linux', async (page) => {
        await openReview(page);
        await addStyle(page, useTestFont);
        await page.evaluate(() => document.fonts.load('20px "PN SS02 Test"'));
        const gutter = page.locator(GUTTER).filter({ hasText: /^\d{2,}$/ }).first();
        await expect(gutter).toBeVisible();
        expect(await gutter.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(TEST_FONT);
        const fixed = await paintedAt(page, gutter);
        const removeOld = await addStyle(page, OLD_BODY_RULE);
        const old = await paintedAt(page, gutter);
        await removeOld();
        const removePlain = await addStyle(page, ':root:root { --diffs-font-features: normal !important; }');
        const explicitNormal = await paintedAt(page, gutter);
        await removePlain();
        // The test font does turn these digits into superscripts under the old rule...
        expect(old.equals(fixed)).toBe(false);
        // ...and now they render exactly as the font draws them with no features.
        expect(fixed.equals(explicitNormal)).toBe(true);
      }));

      test('linux: monospace text in plan review renders plain digits, and the old rule would not', async () => withPage(browserName, 'linux', async (page) => {
        await openPlan(page);
        await addStyle(page, useTestFont);
        await page.evaluate(() => document.fonts.load('16px "PN SS02 Test"'));
        // Fenced code was already shielded (Tailwind's preflight resets code and pre),
        // so the old rule reached `.font-mono` text outside them: the plan's own.
        const mono = page.locator('.font-mono:not(pre, code, pre *, code *)').filter({ visible: true }).first();
        await mono.evaluate((el) => {
          el.textContent = '0123456789';
        });
        expect(await mono.evaluate((el) => getComputedStyle(el).fontFamily)).toContain(TEST_FONT);
        const fixed = await paintedAt(page, mono);
        const removeOld = await addStyle(page, OLD_BODY_RULE);
        const old = await paintedAt(page, mono);
        await removeOld();
        const removePlain = await addStyle(page, '.font-mono { font-feature-settings: normal !important; font-variant-alternates: normal !important; }');
        const explicitNormal = await paintedAt(page, mono);
        await removePlain();
        expect(old.equals(fixed)).toBe(false);
        expect(fixed.equals(explicitNormal)).toBe(true);

        // The fence, with digits, renders as the font draws them too.
        const fence = page.locator(FENCE).first();
        await fence.evaluate((el) => {
          el.textContent = '0123456789 = 42';
        });
        const fenceNow = await paintedAt(page, fence);
        const removeFencePlain = await addStyle(page, `${FENCE} { font-feature-settings: normal !important; font-variant-alternates: normal !important; }`);
        const fenceNormal = await paintedAt(page, fence);
        await removeFencePlain();
        expect(fenceNow.equals(fenceNormal)).toBe(true);
      }));
    });
  });
}
