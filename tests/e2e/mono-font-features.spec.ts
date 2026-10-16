/**
 * Inter's stylistic sets reach Inter only (#1961). They used to be set with
 * `font-feature-settings` on body, which every element inherits, whatever font
 * it renders in: on Linux, code review's diffs and line-number gutters fall back
 * to Ubuntu Mono, whose `ss02` turns digits into superscripts. theme.css now
 * names the sets for Inter's families (`@font-feature-values`) and applies them
 * with `font-variant-alternates`, which a font not named there ignores.
 *
 * Proved in real browsers against the built apps (apps/hook/dist: run
 * `bun run --cwd apps/review build && bun run build:hook` first), served on
 * loopback so the review app falls back to its demo diff:
 *  - every monospace surface computes `font-feature-settings: normal`: the
 *    diff's gutter numbers and code inside Pierre's shadow roots, and the plan's
 *    fenced code, `.font-mono` and `kbd`;
 *  - Inter still renders with its sets (prose is pixel-identical to Inter with
 *    `"ss01", "ss02", "cv01"`, and differs from Inter without them);
 *  - with a font whose `ss02` is superscript digits (PLANNOTATOR_E2E_SS02_FONT:
 *    a path to Ubuntu Mono, from google/fonts `ufl/ubuntumono`) standing in for
 *    the monospace font, the gutter and a fenced code block render exactly as
 *    the font does with no features, while the old body rule, put back, changes
 *    them. Skipped when the variable is unset.
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
/** The rule theme.css carried before #1961. */
const OLD_BODY_RULE = 'body { font-feature-settings: "ss01", "ss02", "cv01"; }';
const browsers = (process.env.PLANNOTATOR_E2E_FONT_BROWSERS ?? 'chromium,webkit')
  .split(',')
  .map((name) => name.trim())
  .filter((name): name is 'chromium' | 'firefox' | 'webkit' => ['chromium', 'firefox', 'webkit'].includes(name));

const engines = { chromium, firefox, webkit };

/** A fresh browser of that engine per test (the config's own browser is chromium only). */
async function withPage(name: keyof typeof engines, run: (page: Page) => Promise<void>) {
  const browser = await engines[name].launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
    test('code review: the gutter and diff code inside Pierre get no feature tags', async () => withPage(browserName, async (page) => {
      await openReview(page);
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

    test('plan review: fenced code, .font-mono and kbd get no feature tags', async () => withPage(browserName, async (page) => {
      await openPlan(page);
      const fence = await featureSettings(page, FENCE);
      const mono = await featureSettings(page, '.font-mono, kbd, pre, code');
      expect(fence.length).toBeGreaterThan(0);
      expect(new Set([...fence, ...mono])).toEqual(new Set(['normal']));
    }));

    test('Inter still renders with ss01, ss02 and cv01', async () => withPage(browserName, async (page) => {
      await openPlan(page);
      await page.evaluate(async () => {
        await document.fonts.load('32px "Inter Variable"');
        const holder = document.createElement('div');
        holder.id = 'pn-inter-probe';
        holder.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#fff;color:#000;font-size:32px;line-height:1.2;padding:8px';
        const text = 'Il1 0 4 6 9 Ill1';
        for (const [id, style] of [
          ['inherited', ''],
          ['explicit', 'font-variant-alternates:normal;font-feature-settings:"ss01","ss02","cv01"'],
          ['none', 'font-variant-alternates:normal;font-feature-settings:normal'],
        ]) {
          const line = document.createElement('div');
          line.id = `pn-inter-${id}`;
          line.textContent = text;
          line.setAttribute('style', `display:inline-block;${style}`);
          holder.append(line, document.createElement('br'));
        }
        document.body.append(holder);
        await document.fonts.ready;
      });
      expect(await page.locator('#pn-inter-inherited').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Inter Variable');
      const inherited = await page.locator('#pn-inter-inherited').screenshot();
      const explicit = await page.locator('#pn-inter-explicit').screenshot();
      const none = await page.locator('#pn-inter-none').screenshot();
      expect(inherited.equals(explicit)).toBe(true);
      expect(inherited.equals(none)).toBe(false);
    }));

    test.describe('with a font whose ss02 is superscript digits', () => {
      test.skip(!ss02FontPath, 'set PLANNOTATOR_E2E_SS02_FONT to a font with superscript ss02 (Ubuntu Mono)');

      const useTestFont = `@font-face { font-family: "${TEST_FONT}"; src: url(/test-font); }
:root:root { --diffs-font-family: "${TEST_FONT}" !important; --font-mono: "${TEST_FONT}" !important; }`;

      test('the diff gutter renders plain digits, and the old rule would not', async () => withPage(browserName, async (page) => {
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

      test('monospace text in plan review renders plain digits, and the old rule would not', async () => withPage(browserName, async (page) => {
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
