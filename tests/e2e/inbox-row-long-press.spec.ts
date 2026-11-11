/**
 * A finger held on a thread row opens the row's menu (the right-click menu,
 * RowMenu.tsx, through useContextMenuTrigger's `longPress`), proved against
 * the compiled binary under a temp data dir, with an agent writing through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 * - on an iPhone 15 (WebKit) and a Pixel 7 (Chromium): a hold opens the row's
 *   menu as the bottom sheet (the scrim, the thread's name over the items),
 *   the row keeps its muted look, and the lift opens no thread; a scroll
 *   through the rows is never a press; a tap on a row still opens its thread;
 * - on the Pixel 7, Mark read from the held row's sheet on a thread with an
 *   open question asks first ("Set aside 1 open question?"), as from the
 *   right-click;
 * - on an iPad (Chromium, 820 × 1180, touch): the hold opens the same menu as
 *   the menu under the row, not a sheet.
 *
 * Chromium gets real touches through the DevTools protocol (the browser's own
 * gesture handling runs, its long press included). WebKit has no such channel,
 * so its touch events are dispatched where the finger is, as iOS sends them to
 * the page.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-row-long-press.spec.ts`.
 * PNGs land in PLANNOTATOR_ROW_LONG_PRESS_SHOTS (default /tmp/row-long-press-shots).
 */

import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_ROW_LONG_PRESS_SHOTS ?? '/tmp/row-long-press-shots');

const ASK = ['One call for the docs.', '', ':::question', 'Which search index?', '', '- [ ] Pagefind', '- [ ] Orama', ':::'].join('\n');

let world: { url: string; agent: SimAgent; ask: string };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-row-long-press-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const path = scratchProject(join(root, 'src'), 'docs-site');
  // Enough threads that the list scrolls on a phone.
  for (let i = 1; i <= 16; i++) await agent.send({ project_path: path, subject: `Docs pass ${i}: links checked`, body: `Docs pass ${i}. Nothing to answer.`, agent_session: `ses_hold_${i}` } as Parameters<SimAgent['send']>[0]);
  const ask = await agent.send({ project_path: path, subject: 'Docs search', body: ASK, agent_session: 'ses_hold_ask' } as Parameters<SimAgent['send']>[0]);
  world = { url: started.stdout.trim().replace(/\/$/, ''), agent, ask: String(ask.thread_id) };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const body = (page: Page) => page.locator('.ib-listcol .ib-lbody');
const row = (page: Page, id: string) => body(page).locator(`[data-thread-id="${id}"]`);
const menu = (page: Page) => page.locator('[data-row-menu]');

interface Finger {
  /** Put one finger down at (x, y). */
  down(x: number, y: number): Promise<void>;
  /** Move it to (x, y) in `moves` moves. */
  move(x: number, y: number, moves?: number): Promise<void>;
  /** Lift it. Resolves whether the page cancelled the lift (WebKit only; Chromium: null). */
  up(): Promise<boolean | null>;
}

/** One finger, real (Chromium, the DevTools protocol) or as iOS sends its events to the page (WebKit). */
async function finger(page: Page, browserName: 'chromium' | 'webkit'): Promise<Finger> {
  let at = { x: 0, y: 0 };
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    return {
      async down(x, y) {
        at = { x, y };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
      },
      async move(x, y, moves = 10) {
        const from = at;
        for (let i = 1; i <= moves; i++) {
          at = { x: from.x + ((x - from.x) * i) / moves, y: from.y + ((y - from.y) * i) / moves };
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at] });
          await page.waitForTimeout(16);
        }
      },
      async up() {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        return null;
      },
    };
  }
  const fire = (type: string, x: number, y: number) =>
    page.evaluate(
      ({ type, x, y }) => {
        const w = window as unknown as { __holdTarget?: Element };
        if (type === 'touchstart') w.__holdTarget = document.elementFromPoint(x, y)!;
        const target = w.__holdTarget!;
        const point = { identifier: 1, clientX: x, clientY: y, pageX: x, pageY: y, target };
        const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
        Object.defineProperty(event, 'changedTouches', { value: [point] });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      },
      { type, x, y },
    );
  return {
    async down(x, y) {
      at = { x, y };
      await fire('touchstart', x, y);
    },
    async move(x, y, moves = 10) {
      const from = at;
      for (let i = 1; i <= moves; i++) {
        at = { x: from.x + ((x - from.x) * i) / moves, y: from.y + ((y - from.y) * i) / moves };
        await fire('touchmove', at.x, at.y);
        await page.waitForTimeout(16);
      }
    },
    async up() {
      return fire('touchend', at.x, at.y);
    },
  };
}

async function centre(page: Page, id: string) {
  const box = (await row(page, id).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

for (const phone of [
  { name: 'iPhone 15 (WebKit)', device: devices['iPhone 15'], browserName: 'webkit' as const, tag: 'iphone15' },
  { name: 'Pixel 7 (Chromium)', device: devices['Pixel 7'], browserName: 'chromium' as const, tag: 'pixel7' },
])
  test(`${phone.name}: a held row opens its menu as the sheet; the lift opens nothing; a scroll is no press; a tap opens`, async () => {
    const { defaultBrowserType: _ignored, ...device } = phone.device;
    // (WebKit launches without the config's Chromium flags, which Linux WebKit exits on.)
    const browser: Browser = phone.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
    try {
      const context = await browser.newContext({ ...device, colorScheme: 'light' });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      // Mark read's warning is on once the window has read its settings (until then a Mark read asks nothing).
      const settingsRead = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/inbox/settings' && r.ok());
      await page.goto(world.url);
      await expect(row(page, world.ask)).toBeVisible();
      await settingsRead;
      const touch = await finger(page, phone.browserName);

      // The hold: the sheet, the row's muted look, the thread's name over the items.
      const at = await centre(page, world.ask);
      await touch.down(at.x, at.y);
      await page.waitForTimeout(700);
      await expect(menu(page)).toHaveAttribute('data-row-menu', world.ask);
      await expect(page.locator('.ib-pm-pos[data-phone] [data-row-menu]')).toBeVisible();
      await expect(page.locator('.ib-pm-scrim')).toBeVisible();
      await expect(menu(page).locator('.ib-pm-title')).toHaveText('Docs search');
      await expect(menu(page).locator('[data-row-action="archive"]')).toBeVisible();
      await expect(row(page, world.ask)).toHaveAttribute('data-menu', '');
      // The lift: no thread opens, the sheet stays.
      const cancelled = await touch.up();
      if (cancelled !== null) expect(cancelled).toBe(true);
      await page.waitForTimeout(500);
      await expect(menu(page)).toBeVisible();
      expect(page.url()).not.toContain('#thread=');
      await expect(page.locator('section.ib-pane')).toHaveCount(0);
      await page.screenshot({ path: join(shots, `${phone.tag}-held-sheet.png`) });

      if (phone.browserName === 'chromium') {
        // Mark read from the sheet on a thread with an open question asks first, as the right-click's does.
        await menu(page).locator('[data-row-action="read"]').tap();
        await expect(page.locator('[data-dialog="mark-read-warning"] h2')).toHaveText('Set aside 1 open question?');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-dialog="mark-read-warning"]')).toHaveCount(0);
      } else {
        await page.keyboard.press('Escape');
      }
      await expect(menu(page)).toHaveCount(0);

      // A scroll through the rows, slow enough to outlast the hold's time: never a press.
      const box = (await body(page).boundingBox())!;
      const x = box.x + box.width / 2;
      await touch.down(x, box.y + box.height - 80);
      await touch.move(x, box.y + 120, 40);
      await page.waitForTimeout(200);
      await touch.up();
      await page.waitForTimeout(300);
      await expect(menu(page)).toHaveCount(0);
      expect(page.url()).not.toContain('#thread=');

      // A tap still opens the thread.
      await body(page).evaluate((el) => (el.scrollTop = 0));
      await row(page, world.ask).tap();
      await expect(page.locator('section.ib-pane')).toBeVisible();
      expect(page.url()).toContain(world.ask);
      await expect(menu(page)).toHaveCount(0);
      expect(errors).toEqual([]);
      await context.close();
    } finally {
      await browser.close();
    }
  });

test('iPad (Chromium, touch): a held row opens the menu under the row, not a sheet', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: 'light' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(world.url);
    await expect(row(page, world.ask)).toBeVisible();
    const touch = await finger(page, 'chromium');
    const at = await centre(page, world.ask);
    await touch.down(at.x, at.y);
    await page.waitForTimeout(700);
    await expect(menu(page)).toHaveAttribute('data-row-menu', world.ask);
    await expect(page.locator('.ib-pm-pos[data-phone]')).toHaveCount(0);
    await expect(page.locator('.ib-pm-scrim')).toHaveCount(0);
    await touch.up();
    await page.waitForTimeout(500);
    await expect(menu(page)).toBeVisible();
    // Under the row: the menu's top is at or below the row's middle, never over the finger.
    const top = (await menu(page).boundingBox())!.y;
    expect(top).toBeGreaterThan(at.y);
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    await page.screenshot({ path: join(shots, 'ipad-held-menu.png') });
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
  }
});
