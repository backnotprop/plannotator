/**
 * "Fit the page": the size control on an HTML page on a phone (approval
 * "inbox-html-attachments-phone", part B; packages/inbox/pageSize.ts), proved
 * against the compiled binary under a temp data dir, on an iPhone 15 (WebKit)
 * and a Pixel 7 (Chromium), plus a desktop that does not change.
 *
 * What it proves, with real layout: a page wider than the phone opens on
 * Desktop size by itself (laid out at 1280 px, scaled to the phone's width,
 * the frame under the control's own row so nothing covers it); a page that
 * fits opens on Phone size and one tap fits it; the tap is remembered for the
 * file across a reload; a pin placed with the pen on a fitted page lands on
 * the element under the finger; a desktop shows no control and no scale.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-html-fit.spec.ts`.
 */

import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

/** Made for a laptop: a fixed 1200 px layout, wider than any phone. */
const widePage = `<!doctype html><html><head><meta charset="utf-8"><title>Fleet</title><style>body{margin:0;font:14px system-ui}main{width:1200px;padding:16px;display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.kpi{border:1px solid #ddd;padding:12px;font-size:22px}</style></head><body><main><div class="kpi" id="k0">48,210</div><div class="kpi" id="k1">212 ms</div><div class="kpi" id="k2">0.42%</div><div class="kpi" id="k3">311 / 320</div></main></body></html>`;
/** Squeezes into any width: nothing is wider than the frame. */
const fluidPage = `<!doctype html><html><head><meta charset="utf-8"><title>Costs</title><style>body{margin:16px;font:15px system-ui}.grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}.c{border:1px solid #ddd;padding:6px;overflow-wrap:anywhere}</style></head><body><h1 id="title">Costs</h1><div class="grid"><div class="c">$18,420</div><div class="c">$6,212</div><div class="c">$3,980</div><div class="c">$9,104</div><div class="c">$1,330</div><div class="c">$742</div></div></body></html>`;

const iPhone = (() => {
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  return device;
})();
const pixel = (() => {
  const { defaultBrowserType: _ignored, ...device } = devices['Pixel 7'];
  return device;
})();

interface World {
  root: string;
  url: string;
  agent: SimAgent;
  thread: string;
  ids: Record<string, string>;
}

async function world(): Promise<World> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-html-fit-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'fleet');
  const dir = join(project, 'files');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'wide.html'), widePage);
  writeFileSync(join(dir, 'fluid.html'), fluidPage);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const sent = await agent.send({ project_path: project, subject: 'Two pages', attachments: ['files/wide.html', 'files/fluid.html'], body: 'A wide page and one that fits.' });
  const ids = Object.fromEntries((sent.attachments as { id: string; name: string }[]).map((a) => [a.name, a.id])) as Record<string, string>;
  return { root, url, agent, thread: sent.thread_id as string, ids };
}

async function withBrowser(engine: 'webkit' | 'chromium', device: Record<string, unknown>, run: (w: World, page: Page) => Promise<void>) {
  const w = await world();
  const browser: Browser = engine === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
  try {
    const context = await browser.newContext({ ...device });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await run(w, page);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await w.agent.close().catch(() => {});
    await removeInboxScratch(w.root);
  }
}

const frameBox = (page: Page) => page.locator('.ib-htmlframe');
const frame = (page: Page) => page.frameLocator('.ib-htmlframe iframe');
const toggle = (page: Page) => page.locator('[data-page-size-toggle]');

async function open(w: World, page: Page, name: string, ready: string) {
  await page.goto(`${w.url}#thread=${w.thread}&file=${w.ids[name]}`);
  await expect(page.locator('[data-attachment-pane]')).toHaveAttribute('data-attachment-pane', w.ids[name]!);
  await expect(frame(page).locator(ready)).toBeVisible();
}

for (const phone of [
  { name: 'iPhone 15 (WebKit)', engine: 'webkit' as const, device: iPhone },
  { name: 'Pixel 7 (Chromium)', engine: 'chromium' as const, device: pixel },
]) {
  test(`${phone.name}: a wide page opens fitted under the control's row; the other size is one tap and is remembered`, async () => {
    await withBrowser(phone.engine, phone.device, async (w, page) => {
      await open(w, page, 'wide.html', '#k0');
      await expect(frameBox(page)).toHaveAttribute('data-page-size', 'desktop');
      await expect(toggle(page)).toHaveText('Phone size');
      // Laid out at 1280 and drawn at the phone's width.
      const viewport = page.viewportSize()!;
      const scaled = await frameBox(page).locator(':scope > div').first().boundingBox();
      expect(Math.abs(scaled!.width - viewport.width)).toBeLessThanOrEqual(2);
      expect(await frame(page).locator('body').evaluate(() => document.documentElement.clientWidth)).toBe(1280);
      // The control is in its own row: the page starts below it.
      const row = (await page.locator('[data-page-size-row]').boundingBox())!;
      const pageTop = (await frameBox(page).boundingBox())!.y;
      expect(pageTop).toBeGreaterThanOrEqual(row.y + row.height - 1);

      await toggle(page).tap();
      await expect(frameBox(page)).toHaveAttribute('data-page-size', 'phone');
      await expect(toggle(page)).toHaveText('Desktop size');
      await page.reload();
      await expect(frame(page).locator('#k0')).toBeVisible();
      await expect(frameBox(page)).toHaveAttribute('data-page-size', 'phone');
    });
  });

  test(`${phone.name}: a page that fits opens on Phone size; one tap fits it`, async () => {
    await withBrowser(phone.engine, phone.device, async (w, page) => {
      await open(w, page, 'fluid.html', '#title');
      await page.waitForTimeout(600);
      await expect(frameBox(page)).toHaveAttribute('data-page-size', 'phone');
      await toggle(page).tap();
      await expect(frameBox(page)).toHaveAttribute('data-page-size', 'desktop');
      await expect.poll(() => frame(page).locator('body').evaluate(() => document.documentElement.clientWidth)).toBe(1280);
    });
  });

  test(`${phone.name}: a pin on a fitted page lands on the element under the finger`, async () => {
    await withBrowser(phone.engine, phone.device, async (w, page) => {
      await open(w, page, 'wide.html', '#k1');
      await expect(frameBox(page)).toHaveAttribute('data-page-size', 'desktop');
      await page.locator('[data-full-view-bar] button[aria-pressed]').first().tap();
      // Where #k1 is drawn on screen: its box in the page, through the frame's scale.
      const scale = Number(await frameBox(page).evaluate((el) => (el as HTMLElement).style.getPropertyValue('--ib-fit-scale')));
      expect(scale).toBeGreaterThan(0.2);
      expect(scale).toBeLessThan(0.5);
      const iframe = (await page.locator('.ib-htmlframe iframe').boundingBox())!;
      const local = await frame(page).locator('#k1').evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      const tap = { x: iframe.x + local.x * scale, y: iframe.y + local.y * scale };
      await page.touchscreen.tap(tap.x, tap.y);
      await expect(page.locator('[data-html-comment-target]')).toHaveText('212 ms');
      const pin = await frame(page).locator('body').evaluate(() => {
        const host = document.querySelector('[data-plannotator-overlay-host]');
        const el = document.querySelector('[data-plannotator-pinpoint-box][data-pinned]') ?? host?.shadowRoot?.querySelector('[data-plannotator-pinpoint-box][data-pinned]');
        const r = el?.getBoundingClientRect();
        return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
      });
      expect(pin).not.toBeNull();
      const onScreen = { x: iframe.x + pin!.x * scale, y: iframe.y + pin!.y * scale, w: pin!.w * scale, h: pin!.h * scale };
      expect(tap.x).toBeGreaterThanOrEqual(onScreen.x);
      expect(tap.x).toBeLessThanOrEqual(onScreen.x + onScreen.w);
      expect(tap.y).toBeGreaterThanOrEqual(onScreen.y);
      expect(tap.y).toBeLessThanOrEqual(onScreen.y + onScreen.h);
    });
  });
}

test('desktop: no size control and no scale, even on a wide page', async () => {
  await withBrowser('chromium', { viewport: { width: 1440, height: 900 } }, async (w, page) => {
    await open(w, page, 'wide.html', '#k0');
    await page.waitForTimeout(600);
    await expect(page.locator('[data-page-size-row]')).toHaveCount(0);
    await expect(toggle(page)).toHaveCount(0);
    await expect(frameBox(page)).not.toHaveAttribute('data-page-size', /.+/);
    expect(await frameBox(page).locator(':scope > div').first().evaluate((el) => getComputedStyle(el).transform)).toBe('none');
  });
});
