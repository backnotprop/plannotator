/**
 * Swipe a thread row on a phone (packages/inbox/rowSwipe.ts; the owner's
 * answer: "Right marks read, left archives; a long swipe or flick acts at
 * once (like Mail)"), proved against the compiled binary under a temp data
 * dir, on an iPhone 15 (WebKit) and a Pixel 7 (Chromium), with an agent
 * writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 * - a vertical drag over the rows never swipes one (Chromium's real touch
 *   scrolls the list), and a swipe that starts at the screen's side (Safari's
 *   Back) moves nothing;
 * - a short slow swipe left rests open on Archive; a tap on it archives the
 *   row (the "Archived" toast), and Undo puts it back ("Unarchived.");
 * - a long swipe left archives at once; a flick right marks read at once (the
 *   toast, and Undo: "Moved back.");
 * - a long swipe right on a thread with two open questions shows the warning
 *   ("Set aside 2 open questions?"); Cancel leaves the row at rest where it
 *   was, with nothing marked;
 * - a pull down from the list's top still refreshes it, and a tap on a row
 *   still opens its thread.
 *
 * Chromium gets real touches through the DevTools protocol (the browser's own
 * gesture handling runs). WebKit has no such channel, so its touch events are
 * dispatched where the finger is, as iOS sends them to the page.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-row-swipe.spec.ts`.
 */

import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

interface World {
  url: string;
  agent: SimAgent;
  path: string;
}

let world: World;
let sent = 0;

async function agentWrites(subject: string, body = `${subject}. Nothing to answer.`): Promise<string> {
  sent += 1;
  const reply = await world.agent.send({ project_path: world.path, subject, body, agent_session: `ses_swipe_${sent}` } as Parameters<SimAgent['send']>[0]);
  return String(reply.thread_id);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-row-swipe-e2e-');
  // Every e2e world starts with the Mark read warning off (inbox-scratch.ts E2E_LAUNCH_OFF); this spec proves a swipe asks.
  const config = join(root, 'data', 'config.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), inboxMarkReadWarning: true }));
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const path = scratchProject(join(root, 'src'), 'docs-site');
  world = { url: started.stdout.trim().replace(/\/$/, ''), agent, path };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const row = (page: Page, id: string) => page.locator(`.ib-listcol .ib-lbody .ib-mrow[data-thread-id="${id}"]`);
const layer = (page: Page) => page.locator('[data-row-swipe-layer]');
const toast = (page: Page) => page.locator('[data-inbox-toast]');
const live = (page: Page) => page.locator('[data-inbox-live]');
const body = (page: Page) => page.locator('.ib-listcol .ib-lbody');
const warning = (page: Page) => page.locator('[data-dialog="mark-read-warning"]');
const offset = (page: Page, id: string) => row(page, id).evaluate((el) => (el as HTMLElement).style.transform);

interface Finger {
  down(x: number, y: number): Promise<void>;
  /** Move to (x, y) in `moves` moves, `gap` ms apart. */
  move(x: number, y: number, moves?: number, gap?: number): Promise<void>;
  up(): Promise<void>;
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
      async move(x, y, moves = 10, gap = 16) {
        const from = at;
        for (let i = 1; i <= moves; i++) {
          at = { x: from.x + ((x - from.x) * i) / moves, y: from.y + ((y - from.y) * i) / moves };
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at] });
          await page.waitForTimeout(gap);
        }
      },
      async up() {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      },
    };
  }
  const fire = (type: string, x: number, y: number) =>
    page.evaluate(
      ({ type, x, y }) => {
        const w = window as unknown as { __swipeTarget?: Element };
        if (type === 'touchstart') w.__swipeTarget = document.elementFromPoint(x, y)!;
        const target = w.__swipeTarget!;
        const point = { identifier: 1, clientX: x, clientY: y, pageX: x, pageY: y, target };
        const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
        Object.defineProperty(event, 'changedTouches', { value: [point] });
        target.dispatchEvent(event);
      },
      { type, x, y },
    );
  return {
    async down(x, y) {
      at = { x, y };
      await fire('touchstart', x, y);
    },
    async move(x, y, moves = 10, gap = 16) {
      const from = at;
      for (let i = 1; i <= moves; i++) {
        at = { x: from.x + ((x - from.x) * i) / moves, y: from.y + ((y - from.y) * i) / moves };
        await fire('touchmove', at.x, at.y);
        await page.waitForTimeout(gap);
      }
    },
    async up() {
      await fire('touchend', at.x, at.y);
    },
  };
}

for (const phone of [
  { name: 'iPhone 15 (WebKit)', device: devices['iPhone 15'], browserName: 'webkit' as const, tag: 'iphone15' },
  { name: 'Pixel 7 (Chromium)', device: devices['Pixel 7'], browserName: 'chromium' as const, tag: 'pixel7' },
])
  test(`${phone.name}: a row swipes to Quiet or Archive, through the same actions, warning and Undo`, async () => {
    const { defaultBrowserType: _ignored, ...device } = phone.device;
    // (WebKit launches without the config's Chromium flags, which Linux WebKit exits on.)
    const browser: Browser = phone.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
    const tag = phone.tag;
    try {
      const asked = await agentWrites(`Two questions (${tag})`, ':::question\nShip it today?\n- Yes\n- No\n:::\n\n:::question\nTag the release?\n- Yes\n- No\n:::');
      const plain: string[] = [];
      for (let i = 1; i <= 14; i++) plain.push(await agentWrites(`Docs pass ${i} (${tag}): links checked`));
      const context = await browser.newContext({ ...device });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(world.url);
      await expect(row(page, plain[13]!)).toBeVisible();
      const touch = await finger(page, phone.browserName);
      const width = (await body(page).boundingBox())!.width;
      const centre = async (id: string) => {
        await row(page, id).scrollIntoViewIfNeeded({ timeout: 30_000 });
        const box = (await row(page, id).boundingBox())!;
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      /** A swipe by `dx`: slow (held before the lift, so no flick) or a flick. */
      const swipe = async (id: string, dx: number, how: 'slow' | 'flick' = 'slow', from?: { x: number; y: number }) => {
        const at = from ?? (await centre(id));
        await touch.down(at.x, at.y);
        if (how === 'flick') await touch.move(at.x + dx, at.y, 4, 8);
        else {
          await touch.move(at.x + dx, at.y, 12, 20);
          await page.waitForTimeout(200);
        }
        await touch.up();
      };

      // A vertical drag over the rows never swipes one.
      const a = await centre(plain[12]!);
      await touch.down(a.x, a.y + 120);
      await touch.move(a.x + 8, a.y - 80);
      await touch.up();
      await expect(layer(page)).not.toHaveAttribute('data-side', /./);
      for (const id of plain.slice(10)) expect(await offset(page, id)).toBe('');
      if (phone.browserName === 'chromium') {
        await expect.poll(() => body(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await body(page).evaluate((el) => (el.scrollTop = 0));
      }

      // From the screen's left side (Safari's Back): no swipe.
      const edge = await centre(plain[12]!);
      await swipe(plain[12]!, 220, 'slow', { x: 10, y: edge.y });
      await expect(layer(page)).not.toHaveAttribute('data-side', /./);
      expect(await offset(page, plain[12]!)).toBe('');

      // A short slow swipe left rests open on Archive; its tap archives the row, and Undo puts it back.
      await swipe(plain[12]!, -100);
      await expect(layer(page)).toHaveAttribute('data-side', 'trail');
      await expect.poll(() => offset(page, plain[12]!)).toMatch(/^translate3d\(-96(\.\d+)?px/);
      const archive = page.getByRole('button', { name: `Archive: Docs pass 13 (${tag}): links checked`, exact: true });
      await expect(archive).toBeVisible();
      // The button spans the row; only its right end (SWIPE_ROW_REVEAL_PX) shows past the moved row, where a finger taps it.
      const shown = (await archive.boundingBox())!;
      await archive.tap({ position: { x: shown.width - 48, y: shown.height / 2 }, timeout: 30_000 });
      await expect(toast(page)).toContainText('Archived');
      await expect.poll(() => offset(page, plain[12]!)).toBe('');
      await expect(row(page, plain[12]!)).toBeVisible();
      await toast(page).locator('[data-toast-undo]').tap({ timeout: 30_000 });
      await expect(live(page)).toHaveText('Unarchived.');
      await expect(toast(page)).toHaveCount(0);

      // A long swipe left archives at once.
      await swipe(plain[11]!, -(width * 0.7));
      await expect(toast(page)).toContainText('Archived');
      await toast(page).locator('[data-toast-undo]').tap({ timeout: 30_000 });
      await expect(live(page)).toHaveText('Unarchived.');
      await expect(toast(page)).toHaveCount(0);

      // A flick right marks read at once; Undo moves it back.
      await swipe(plain[10]!, 110, 'flick');
      await expect(toast(page)).toContainText(/read/i);
      await expect.poll(() => offset(page, plain[10]!)).toBe('');
      await toast(page).locator('[data-toast-undo]').tap({ timeout: 30_000 });
      await expect(live(page)).toHaveText('Moved back.');
      await expect(toast(page)).toHaveCount(0);

      // A long swipe right on the thread with open questions asks first; Cancel leaves the row where it was.
      const before = (await row(page, asked).boundingBox())!;
      await swipe(asked, width * 0.7);
      await expect(warning(page)).toBeVisible();
      await expect(warning(page)).toContainText('Set aside 2 open questions?');
      await warning(page).locator('[data-mark-read-warning-cancel]').tap({ timeout: 30_000 });
      await expect(warning(page)).toHaveCount(0);
      await expect.poll(() => offset(page, asked)).toBe('');
      const after = (await row(page, asked).boundingBox())!;
      expect(Math.round(after.y)).toBe(Math.round(before.y));
      await expect(row(page, asked)).toHaveClass(/ib-u/);

      // A pull down from the list's top still refreshes it.
      await body(page).evaluate((el) => (el.scrollTop = 0));
      const box = (await body(page).boundingBox())!;
      await touch.down(box.x + box.width / 2, box.y + 90);
      await touch.move(box.x + box.width / 2, box.y + 350);
      await expect(page.locator('[data-pull-indicator]')).toHaveAttribute('data-state', 'ready');
      await touch.up();
      await expect(live(page)).toHaveText('Inbox refreshed');

      // A tap on a row still opens its thread.
      await row(page, plain[9]!).tap({ timeout: 30_000 });
      await expect(page.locator('section.ib-pane')).toBeVisible();
      expect(page.url()).toContain(plain[9]!);
      expect(errors).toEqual([]);
      await context.close();
    } finally {
      await browser.close();
    }
  });
