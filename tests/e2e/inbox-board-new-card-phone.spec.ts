import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/new-card-phone'));
const HEIGHT = 760;

let url = '';
let claude: SimAgent | null = null;

test.describe.configure({ mode: 'serial' });

async function post(path: string, body: object): Promise<void> {
  const res = await fetch(new URL(`/api/inbox/${path}`, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, await res.clone().text()).toBe(200);
}

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-new-card-phone-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  markTourDecided(env.PLANNOTATOR_DATA_DIR);
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(env.PLANNOTATOR_DATA_DIR);
  url = started.stdout.trim();
  await post('settings', { board: { on: true } });
  await post('board/intro', {});
  claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await claude.send({ project_path: scratchProject(join(root, 'src'), 'plannotator'), subject: 'Checkout drawer', thread: 'drawer', body: 'Starting on the drawer.' });
});

test.afterAll(async () => {
  try {
    await claude?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

async function phone(browser: Browser, width: number, colorScheme: 'light' | 'dark'): Promise<BrowserContext> {
  const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'] as (typeof devices)['Pixel 7'] & { defaultBrowserType?: string };
  return browser.newContext({ ...pixel, viewport: { width, height: HEIGHT }, colorScheme, reducedMotion: 'reduce' });
}

async function openNewCard(page: Page): Promise<void> {
  await page.goto(`${url}#board`);
  const open = page.locator('[data-board-new]');
  await expect(open).toBeEnabled();
  await open.click();
  await expect(page.locator('dialog[data-dialog="new-card"] [data-new-card-title]')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function readWindow(page: Page) {
  return page.locator('dialog[data-dialog="new-card"]').evaluate((dialog) => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      dialog: box(dialog)!,
      bar: [...dialog.querySelectorAll<HTMLElement>('.ib-ncd-head .ib-ncd-bar')].map((b) => ({ name: b.textContent?.trim() ?? '', ...box(b)! })),
      title: box(dialog.querySelector('[data-new-card-title]'))!,
      notes: box(dialog.querySelector('[data-new-card-notes]'))!,
      scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

for (const size of [14, 15]) {
  for (const width of [320, 360, 375, 390, 430]) {
    const scheme = (width + size) % 2 === 0 ? 'light' : 'dark';
    test(`${width} px, text ${size}: New card is the whole screen`, async ({ browser }) => {
      await post('settings', { text_size: size });
      const context = await phone(browser, width, scheme);
      try {
        const page = await context.newPage();
        await openNewCard(page);
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--inbox-text-size').trim())).toBe(size === 14 ? '' : '15');
        await expect(page.locator('dialog[data-dialog="new-card"]')).toHaveClass(/ib-ncd-phone/);
        for (const shotScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: shotScheme });
          await page.waitForTimeout(150);
          await page.screenshot({ path: join(shotsDir, `${width}-text${size}-${shotScheme}.png`) });
        }
        await page.emulateMedia({ colorScheme: scheme });

        const m = await readWindow(page);
        const d = m.dialog;
        expect(d.x, `the window starts at ${d.x}`).toBeCloseTo(0, 0);
        expect(d.y, `the window's top is at ${d.y}`).toBeCloseTo(0, 0);
        expect(d.w, `the window is ${d.w} px wide on a ${m.vw} px screen`).toBeCloseTo(m.vw, 0);
        expect(d.h, `the window is ${d.h} px tall on a ${m.vh} px screen`).toBeCloseTo(m.vh, 0);
        expect(m.scrollX, 'nothing scrolls sideways').toBeLessThanOrEqual(0);
        expect(m.bar.map((b) => b.name)).toEqual(['Cancel', 'Add']);
        for (const b of m.bar) {
          expect(b.x, `${b.name} starts inside the screen`).toBeGreaterThanOrEqual(0);
          expect(b.right, `${b.name} ends inside the screen`).toBeLessThanOrEqual(m.vw + 0.5);
          expect(b.h, `${b.name} is ${Math.round(b.h)} px tall`).toBeGreaterThanOrEqual(43.9);
        }
        expect(m.title.right, 'the title field reaches the right side').toBeGreaterThan(m.vw - 40);
        expect(m.notes.right, 'the notes field reaches the right side').toBeGreaterThan(m.vw - 40);
      } finally {
        await context.close();
      }
    });
  }
}

test('with a keyboard up the window ends at its top, the title and notes above it', async ({ browser }) => {
  await post('settings', { text_size: 14 });
  for (const width of [320, 390]) {
    const context = await phone(browser, width, 'light');
    try {
      const page = await context.newPage();
      await openNewCard(page);
      const visible = 420;
      await page.evaluate((h) => document.documentElement.style.setProperty('--ib-vvh', `${h}px`), visible);
      await page.waitForTimeout(100);
      const m = await readWindow(page);
      expect(m.dialog.y).toBeCloseTo(0, 0);
      expect(m.dialog.w).toBeCloseTo(m.vw, 0);
      expect(m.dialog.h, `the window is ${m.dialog.h} px tall above a keyboard at ${visible}`).toBeCloseTo(visible, 0);
      expect(m.title.bottom, 'the title is above the keyboard').toBeLessThanOrEqual(visible);
      expect(m.notes.y + 40, 'the notes start above the keyboard').toBeLessThanOrEqual(visible);
      await page.screenshot({ path: join(shotsDir, `${width}-keyboard-light.png`) });
    } finally {
      await context.close();
    }
  }
});

test('a desktop New card is unchanged: 760 px wide and centred', async ({ browser }) => {
  await post('settings', { text_size: 14 });
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await openNewCard(page);
      await expect(page.locator('dialog[data-dialog="new-card"]')).not.toHaveClass(/ib-ncd-phone/);
      await page.mouse.move(10, 890);
      await page.waitForTimeout(150);
      await page.screenshot({ path: join(shotsDir, `1440-${scheme}.png`) });
      const m = await readWindow(page);
      expect(m.dialog.w).toBeCloseTo(760, 0);
      expect(m.dialog.x).toBeCloseTo((1440 - 760) / 2, 0);
      expect(m.dialog.h, 'the desktop window fits its content, not the screen').toBeLessThan(900 - 48);
      expect(m.dialog.y).toBeGreaterThan(24);
      expect(m.bar, 'no phone bar on a desktop').toEqual([]);
    } finally {
      await context.close();
    }
  }
});
