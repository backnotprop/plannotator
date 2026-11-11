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
    // DIAG (temporary): where the WebKit run stops.
    const t0 = Date.now();
    const step = (what: string) => console.log(`LP-STEP ${tag} +${Date.now() - t0}ms ${what}`);
    try {
      step("L163 const asked = await agentWrites(`Two questions (${tag})`, ':::question\\nShip it ");
      const asked = await agentWrites(`Two questions (${tag})`, ':::question\nShip it today?\n- Yes\n- No\n:::\n\n:::question\nTag the release?\n- Yes\n- No\n:::');
      const plain: string[] = [];
      step("L165 for (let i = 1; i <= 14; i++) plain.push(await agentWrites(`Docs pass ${i} (${ta");
      for (let i = 1; i <= 14; i++) plain.push(await agentWrites(`Docs pass ${i} (${tag}): links checked`));
      step("L166 const context = await browser.newContext({ ...device });");
      const context = await browser.newContext({ ...device });
      step("L167 const page = await context.newPage();");
      const page = await context.newPage();
      page.on('console', (m) => console.log(`LP-CONSOLE ${tag} ${m.type()} ${m.text().slice(0, 200)}`));
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      step("L171 await page.goto(world.url);");
      await page.goto(world.url);
      step("L172 await expect(row(page, plain[13]!)).toBeVisible();");
      await expect(row(page, plain[13]!)).toBeVisible();
      step("L173 const touch = await finger(page, phone.browserName);");
      const touch = await finger(page, phone.browserName);
      step("L174 const width = (await body(page).boundingBox())!.width;");
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
      step("L193 const a = await centre(plain[12]!);");
      const a = await centre(plain[12]!);
      step("L194 await touch.down(a.x, a.y + 120);");
      await touch.down(a.x, a.y + 120);
      step("L195 await touch.move(a.x + 8, a.y - 80);");
      await touch.move(a.x + 8, a.y - 80);
      step("L196 await touch.up();");
      await touch.up();
      step("L197 await expect(layer(page)).not.toHaveAttribute('data-side', /./);");
      await expect(layer(page)).not.toHaveAttribute('data-side', /./);
      step("L198 for (const id of plain.slice(10)) expect(await offset(page, id)).toBe('');");
      for (const id of plain.slice(10)) expect(await offset(page, id)).toBe('');
      if (phone.browserName === 'chromium') {
        await expect.poll(() => body(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await body(page).evaluate((el) => (el.scrollTop = 0));
      }

      // From the screen's left side (Safari's Back): no swipe.
      step("L205 const edge = await centre(plain[12]!);");
      const edge = await centre(plain[12]!);
      step("L206 await swipe(plain[12]!, 220, 'slow', { x: 10, y: edge.y });");
      await swipe(plain[12]!, 220, 'slow', { x: 10, y: edge.y });
      step("L207 await expect(layer(page)).not.toHaveAttribute('data-side', /./);");
      await expect(layer(page)).not.toHaveAttribute('data-side', /./);
      step("L208 expect(await offset(page, plain[12]!)).toBe('');");
      expect(await offset(page, plain[12]!)).toBe('');

      // A short slow swipe left rests open on Archive; its tap archives the row, and Undo puts it back.
      step("L211 await swipe(plain[12]!, -100);");
      await swipe(plain[12]!, -100);
      step("L212 await expect(layer(page)).toHaveAttribute('data-side', 'trail');");
      await expect(layer(page)).toHaveAttribute('data-side', 'trail');
      step("L213 await expect.poll(() => offset(page, plain[12]!)).toMatch(/^translate3d\\(-96(\\.\\");
      await expect.poll(() => offset(page, plain[12]!)).toMatch(/^translate3d\(-96(\.\d+)?px/);
      const archive = page.getByRole('button', { name: `Archive: Docs pass 13 (${tag}): links checked`, exact: true });
      step("L215 await expect(archive).toBeVisible();");
      await expect(archive).toBeVisible();
      step("L216 await archive.tap({ timeout: 30_000 });");
      await archive.tap({ timeout: 30_000 });
      step("L217 await expect(toast(page)).toContainText('Archived');");
      await expect(toast(page)).toContainText('Archived');
      step("L218 await expect.poll(() => offset(page, plain[12]!)).toBe('');");
      await expect.poll(() => offset(page, plain[12]!)).toBe('');
      step("L219 await expect(row(page, plain[12]!)).toBeVisible();");
      await expect(row(page, plain[12]!)).toBeVisible();
      step("L220 await toast(page).locator('[data-toast-undo]').tap({ timeout: 30_000 });");
      await toast(page).locator('[data-toast-undo]').tap({ timeout: 30_000 });
      step("L221 await expect(live(page)).toHaveText('Unarchived.');");
      await expect(live(page)).toHaveText('Unarchived.');
      step("L222 await expect(toast(page)).toHaveCount(0);");
      await expect(toast(page)).toHaveCount(0);

      // A long swipe left archives at once.
      step("L225 await swipe(plain[11]!, -(width * 0.7));");
      await swipe(plain[11]!, -(width * 0.7));
      step("L226 await expect(toast(page)).toContainText('Archived');");
      await expect(toast(page)).toContainText('Archived');
      step("L227 await toast(page).locator('[data-toast-undo]').tap({ timeout: 30_000 });");
      await toast(page).locator('[data-toast-undo]').tap({ timeout: 30_000 });
      step("L228 await expect(live(page)).toHaveText('Unarchived.');");
      await expect(live(page)).toHaveText('Unarchived.');
      step("L229 await expect(toast(page)).toHaveCount(0);");
      await expect(toast(page)).toHaveCount(0);

      // A flick right marks read at once; Undo moves it back.
      step("L232 await swipe(plain[10]!, 110, 'flick');");
      await swipe(plain[10]!, 110, 'flick');
      step("L233 await expect(toast(page)).toContainText(/read/i);");
      await expect(toast(page)).toContainText(/read/i);
      step("L234 await expect.poll(() => offset(page, plain[10]!)).toBe('');");
      await expect.poll(() => offset(page, plain[10]!)).toBe('');
      step("L235 await toast(page).locator('[data-toast-undo]').tap({ timeout: 30_000 });");
      await toast(page).locator('[data-toast-undo]').tap({ timeout: 30_000 });
      step("L236 await expect(live(page)).toHaveText('Moved back.');");
      await expect(live(page)).toHaveText('Moved back.');
      step("L237 await expect(toast(page)).toHaveCount(0);");
      await expect(toast(page)).toHaveCount(0);

      // A long swipe right on the thread with open questions asks first; Cancel leaves the row where it was.
      step("L240 const before = (await row(page, asked).boundingBox())!;");
      const before = (await row(page, asked).boundingBox())!;
      step("L241 await swipe(asked, width * 0.7);");
      await swipe(asked, width * 0.7);
      step("L242 await expect(warning(page)).toBeVisible();");
      await expect(warning(page)).toBeVisible();
      step("L243 await expect(warning(page)).toContainText('Set aside 2 open questions?');");
      await expect(warning(page)).toContainText('Set aside 2 open questions?');
      step("L244 await warning(page).locator('[data-mark-read-warning-cancel]').tap({ timeout: 30_000 });");
      await warning(page).locator('[data-mark-read-warning-cancel]').tap({ timeout: 30_000 });
      step("L245 await expect(warning(page)).toHaveCount(0);");
      await expect(warning(page)).toHaveCount(0);
      step("L246 await expect.poll(() => offset(page, asked)).toBe('');");
      await expect.poll(() => offset(page, asked)).toBe('');
      step("L247 const after = (await row(page, asked).boundingBox())!;");
      const after = (await row(page, asked).boundingBox())!;
      step("L248 expect(Math.round(after.y)).toBe(Math.round(before.y));");
      expect(Math.round(after.y)).toBe(Math.round(before.y));
      step("L249 await expect(row(page, asked)).toHaveClass(/ib-u/);");
      await expect(row(page, asked)).toHaveClass(/ib-u/);

      // A pull down from the list's top still refreshes it.
      step("L252 await body(page).evaluate((el) => (el.scrollTop = 0));");
      await body(page).evaluate((el) => (el.scrollTop = 0));
      step("L253 const box = (await body(page).boundingBox())!;");
      const box = (await body(page).boundingBox())!;
      step("L254 await touch.down(box.x + box.width / 2, box.y + 90);");
      await touch.down(box.x + box.width / 2, box.y + 90);
      step("L255 await touch.move(box.x + box.width / 2, box.y + 350);");
      await touch.move(box.x + box.width / 2, box.y + 350);
      step("L256 await expect(page.locator('[data-pull-indicator]')).toHaveAttribute('data-state'");
      await expect(page.locator('[data-pull-indicator]')).toHaveAttribute('data-state', 'ready');
      step("L257 await touch.up();");
      await touch.up();
      step("L258 await expect(live(page)).toHaveText('Inbox refreshed');");
      await expect(live(page)).toHaveText('Inbox refreshed');

      // A tap on a row still opens its thread.
      step("L261 await row(page, plain[9]!).tap({ timeout: 30_000 });");
      await row(page, plain[9]!).tap({ timeout: 30_000 });
      step("L262 await expect(page.locator('section.ib-pane')).toBeVisible();");
      await expect(page.locator('section.ib-pane')).toBeVisible();
      step("L263 expect(page.url()).toContain(plain[9]!);");
      expect(page.url()).toContain(plain[9]!);
      step("L264 expect(errors).toEqual([]);");
      expect(errors).toEqual([]);
      step("L265 await context.close();");
      await context.close();
    } finally {
      await browser.close();
    }
  });
