import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_PULL_REFRESH_SHOTS ?? '/tmp/pull-refresh-shots');

interface World {
  url: string;
  agent: SimAgent;
  path: string;
}

let world: World;
let sent = 0;

async function agentWrites(subject: string): Promise<string> {
  sent += 1;
  const reply = await world.agent.send({ project_path: world.path, subject, body: `${subject}. Nothing to answer.`, agent_session: `ses_pull_${sent}` } as Parameters<SimAgent['send']>[0]);
  return String(reply.thread_id);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-pull-refresh-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const path = scratchProject(join(root, 'src'), 'docs-site');
  world = { url: started.stdout.trim().replace(/\/$/, ''), agent, path };
  for (let i = 1; i <= 16; i++) await agentWrites(`Docs pass ${i}: links checked`);
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const row = (page: Page, id: string) => page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`);
const notice = (page: Page) => page.locator('[data-inbox-notice]');
const live = (page: Page) => page.locator('[data-inbox-live]');
const indicator = (page: Page) => page.locator('[data-pull-indicator]');
const body = (page: Page) => page.locator('.ib-listcol .ib-lbody');

interface Finger {
  down(x: number, y: number): Promise<void>;
  move(x: number, y: number, moves?: number): Promise<boolean | null>;
  up(): Promise<void>;
}

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
        return null;
      },
      async up() {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      },
    };
  }
  const fire = (type: string, x: number, y: number) =>
    page.evaluate(
      ({ type, x, y }) => {
        const w = window as unknown as { __pullTarget?: Element };
        if (type === 'touchstart') w.__pullTarget = document.elementFromPoint(x, y)!;
        const target = w.__pullTarget!;
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
      let cancelled = false;
      for (let i = 1; i <= moves; i++) {
        at = { x: from.x + ((x - from.x) * i) / moves, y: from.y + ((y - from.y) * i) / moves };
        cancelled = (await fire('touchmove', at.x, at.y)) || cancelled;
        await page.waitForTimeout(16);
      }
      return cancelled;
    },
    async up() {
      await fire('touchend', at.x, at.y);
    },
  };
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

for (const phone of [
  { name: 'iPhone 15 (WebKit)', device: devices['iPhone 15'], browserName: 'webkit' as const, tag: 'iphone15' },
  { name: 'Pixel 7 (Chromium)', device: devices['Pixel 7'], browserName: 'chromium' as const, tag: 'pixel7' },
])
  for (const scheme of ['light', 'dark'] as const)
    test(`${phone.name}, ${scheme}: a pull from the top refreshes the list; scrolling and taps work as before`, async () => {
      const { defaultBrowserType: _ignored, ...device } = phone.device;
      const browser: Browser = phone.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
      const tag = `${phone.tag}-${scheme}`;
      try {
        const context = await browser.newContext({ ...device, colorScheme: scheme });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        let holdRead = false;
        let reads = 0;
        await page.route('**/api/inbox/threads?archived=exclude*', async (route) => {
          reads += 1;
          if (holdRead) {
            holdRead = false;
            await new Promise((r) => setTimeout(r, 1200));
          }
          await route.continue();
        });
        await page.goto(world.url);
        await expect(body(page).locator('[data-thread-id]').first()).toBeVisible();
        await expect(indicator(page)).toHaveAttribute('aria-hidden', 'true');

        const late = await agentWrites(`Release notes (${tag})`);
        await expect(notice(page)).toContainText('1 new');
        await expect(row(page, late)).toHaveCount(0);

        const box = (await body(page).boundingBox())!;
        const x = box.x + box.width / 2;
        const y = box.y + 90;
        const touch = await finger(page, phone.browserName);

        let before = reads;
        await touch.down(x, y);
        await touch.move(x, y + 70);
        await expect(indicator(page)).toHaveAttribute('data-state', 'pull');
        await touch.up();
        await expect(indicator(page)).not.toHaveAttribute('data-state', /./);
        await page.waitForTimeout(300);
        expect(reads).toBe(before);
        await expect(notice(page)).toContainText('1 new');

        await touch.down(x, y);
        const cancelled = await touch.move(x, y + 90);
        if (cancelled !== null) expect(cancelled).toBe(true);
        await expect(indicator(page)).toHaveAttribute('data-state', 'pull');
        expect(await body(page).evaluate((el) => (el as HTMLElement).style.transform)).toMatch(/^translate3d\(0px, \d/);
        await page.waitForTimeout(120);
        await shot(page, `${tag}-1-mid-pull`);
        await touch.move(x, y + 260);
        await expect(indicator(page)).toHaveAttribute('data-state', 'ready');
        await page.waitForTimeout(120);
        await shot(page, `${tag}-2-ready`);
        holdRead = true;
        before = reads;
        await touch.up();
        await expect(indicator(page)).toHaveAttribute('data-state', 'refreshing');
        await page.waitForTimeout(450);
        await shot(page, `${tag}-3-spinning`);
        await expect(row(page, late)).toBeVisible();
        await expect(notice(page)).toHaveCount(0);
        await expect(live(page)).toHaveText('Inbox refreshed');
        await expect(indicator(page)).not.toHaveAttribute('data-state', /./);
        expect(await body(page).evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
        expect(reads - before).toBe(1);
        await page.waitForTimeout(200);
        await shot(page, `${tag}-4-after`);

        await touch.down(x, box.y + box.height - 60);
        const upCancelled = await touch.move(x, box.y + 120);
        await touch.up();
        await expect(indicator(page)).not.toHaveAttribute('data-state', /./);
        if (upCancelled !== null) expect(upCancelled).toBe(false);
        if (phone.browserName === 'chromium') {
          await expect.poll(() => body(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
          before = reads;
          await touch.down(x, y);
          await touch.move(x, y + 260);
          await expect(indicator(page)).not.toHaveAttribute('data-state', /./);
          await touch.up();
          await page.waitForTimeout(300);
          expect(reads).toBe(before);
          await body(page).evaluate((el) => (el.scrollTop = 0));
          await page.waitForTimeout(100);
        }

        if (phone.browserName === 'chromium') {
          const start = (await row(page, late).boundingBox())!;
          const fx = start.x + start.width / 2;
          const fy = start.y + start.height / 2;
          await touch.down(fx, fy);
          await touch.move(fx, fy + 260);
          await expect(indicator(page)).toHaveAttribute('data-state', 'ready');
          const old = await row(page, late).elementHandle();
          await world.agent.send({ project_path: world.path, reply_to: late, body: ':::question\nShip it today?\n- Yes\n- No\n:::', agent_session: `ses_pull_ask_${tag}` } as Parameters<SimAgent['send']>[0]);
          await expect(notice(page)).toContainText('1 new');
          await notice(page).evaluate((el) => (el as HTMLElement).click());
          await expect.poll(() => old!.evaluate((el) => el.isConnected)).toBe(false);
          before = reads;
          await touch.up();
          await expect(indicator(page)).not.toHaveAttribute('data-state', /./);
          expect(await body(page).evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
          expect(reads - before).toBe(1);
        }

        await row(page, late).tap();
        await expect(page.locator('section.ib-pane')).toBeVisible();
        expect(page.url()).toContain(late);
        expect(errors).toEqual([]);
        await context.close();
      } finally {
        await browser.close();
      }
    });
