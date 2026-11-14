/**
 * New message on a phone: the Thread row (the thread's name, what the owner calls the subject line) stays on screen,
 * with what was typed in it, once an agent is picked (the owner, 2026-11-02: "Whenever I select the agent for creating
 * a new thread I lose the subject line on mobile. This is critical error.").
 *
 * A pick moves focus to the message, so a phone's keyboard comes up, and 0.28.45's fold hid the Thread row for as long
 * as the keyboard stayed up (inbox.css, `:root[data-ib-keyboard] … .ib-cp-thread { display: none }`). Picking the agent
 * was the moment it went.
 *
 * The keyboard cannot exist in a headless browser, so it is a stand-in, as in inbox-phone-compose-send.spec.ts: WebKit
 * replays the owner's iOS readings (390 x 660 less 403), Chromium the Android ones; 320 x 568 less 353 is the narrowest
 * phone. Proved against the compiled binary under a temp PLANNOTATOR_DATA_DIR (PLANNOTATOR_INBOX_CONNECT=0, no browser):
 *
 * - A name typed first, then the agent picked (To is the pill in the foot's row, its list a bottom sheet): the row is on
 *   screen with the keyboard up, under the top bar, over the message, and holds the typed name; To and Send stay in reach.
 * - The agent picked first, then the message typed: the row is on screen with its suggestion.
 * - A narrow desktop window (Chromium, 600 x 800, so the phone's layout): the row and its name survive the pick.
 *
 * Build the binary first (see inbox.spec.ts). PLANNOTATOR_E2E_SHOTS_DIR names a folder for the pictures (default
 * .local/proof/compose-thread-phone), the keyboard's stand-in drawn in grey.
 */

import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/compose-thread-phone'));

const SIZES = [
  { width: 390, height: 660, keyboard: 403 },
  { width: 320, height: 568, keyboard: 353 },
] as const;

const SESSION = 'ses-compose-thread-phone';
const NAME = 'Checkout footer';
const MESSAGE = 'The sticky footer covers the promo field on the smallest phones.';

let world: { url: string; agent: SimAgent; stop: boolean; loop: Promise<void> | null };

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-compose-thread-phone-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  markTourDecided(dataDir);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const project = scratchProject(join(root, 'src'), 'plannotator');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: project, subject: 'Checkout: the sticky footer', body: 'The checkout on a phone.' }, { wakes: true });
  const { port, token } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  world = { url: started.stdout.trim(), agent, stop: false, loop: null };

  // One live Claude Code session in "plannotator", as the mod's connection holds it.
  const startedAt = Date.now() - 45 * 60_000;
  world.loop = (async () => {
    while (!world.stop) {
      await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session: SESSION, host: 'claude-code', waitMs: 1_000, project_path: project, started_at: startedAt, busy: false, idle_since: startedAt }),
      }).catch(() => null);
    }
  })();
});

test.afterAll(async () => {
  try {
    if (world) {
      world.stop = true;
      await world.loop;
      await world.agent.close().catch(() => {});
    }
  } finally {
    await removeInboxScratch();
  }
});

/** The stand-in for the keyboard: what each browser reports with one up. */
type Keyboard = (page: Page, height: number) => Promise<void>;

const iosKeyboardUp: Keyboard = async (page, height) => {
  await page.evaluate((height) => {
    const vv = window.visualViewport!;
    const full = window.innerHeight;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => full - height });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => full - height });
    vv.dispatchEvent(new Event('resize'));
    window.scrollTo(0, height);
    window.dispatchEvent(new Event('scroll'));
  }, height);
};

const androidKeyboardUp: Keyboard = async (page, height) => {
  await page.evaluate((height) => {
    const vv = window.visualViewport!;
    const full = window.innerHeight;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => full - height });
    vv.dispatchEvent(new Event('resize'));
  }, height);
};

const sheetOf = (page: Page) => page.locator('dialog[data-compose]');

async function openCompose(page: Page): Promise<void> {
  await page.goto(world.url);
  await page.locator('[data-open-compose]:visible').first().click();
  await expect(sheetOf(page).locator('[data-compose-to]')).not.toHaveAttribute('data-loading', /.*/);
}

/** Opens To's sheet from the pill in the foot's row and picks the live session, as a finger does. Focus then goes to the message. */
async function pickAgent(page: Page, tap: boolean): Promise<void> {
  const sheet = sheetOf(page);
  const to = sheet.locator('.ib-cp-foot [data-compose-to]');
  const row = sheet.locator(`[data-compose-to-sheet] [data-compose-session="${SESSION}"]`);
  if (tap) {
    await to.tap();
    await row.tap();
  } else {
    await to.click();
    await row.click();
  }
  await expect(sheet.locator(`.ib-cp-foot [data-compose-to="${SESSION}"]`)).toBeVisible();
  await expect(sheet.locator('[data-compose-text] textarea')).toBeFocused();
}

interface Seen {
  thread: { top: number; bottom: number; height: number } | null;
  chip: { top: number; bottom: number } | null;
  barBottom: number;
  to: { top: number; bottom: number };
  footTop: number;
  footBottom: number;
  seen: number;
  send: { bottom: number; onTop: boolean };
}

/** Where the Thread row, its chip, the top bar, To, the foot and Send are. A part not drawn is null. */
async function read(page: Page): Promise<Seen> {
  return page.evaluate(() => {
    const dialog = document.querySelector('dialog[data-compose]')!;
    const rect = (selector: string) => {
      const box = dialog.querySelector(selector)?.getBoundingClientRect();
      return box && box.width > 0 && box.height > 0 ? box : null;
    };
    const thread = rect('.ib-cp-thread');
    const chip = rect('.ib-cp-tname');
    const send = rect('[data-compose-send]')!;
    const hit = document.elementFromPoint((send.left + send.right) / 2, (send.top + send.bottom) / 2);
    const vv = window.visualViewport!;
    return {
      thread: thread && { top: thread.top, bottom: thread.bottom, height: thread.height },
      chip: chip && { top: chip.top, bottom: chip.bottom },
      barBottom: rect('.ib-cp-bar')!.bottom,
      to: { top: rect('[data-compose-to]')!.top, bottom: rect('[data-compose-to]')!.bottom },
      footTop: rect('.ib-cp-foot')!.top,
      footBottom: rect('.ib-cp-foot')!.bottom,
      seen: vv.offsetTop + vv.height,
      send: { bottom: send.bottom, onTop: !!hit?.closest('[data-compose-send]') },
    };
  });
}

/** The Thread row and its whole chip are on screen, under the top bar and over the foot, where To is. */
function threadOnScreen(l: Seen, name: string): void {
  expect(l.thread, `${name}: the Thread row is drawn`).toBeTruthy();
  expect(l.chip, `${name}: the Thread chip is drawn`).toBeTruthy();
  expect(l.chip!.top, `${name}: the chip is under the top bar`).toBeGreaterThanOrEqual(l.barBottom - 0.5);
  expect(l.to.top, `${name}: To is on the foot's row`).toBeGreaterThanOrEqual(l.footTop - 0.5);
  expect(l.to.bottom, `${name}: To is on the foot's row`).toBeLessThanOrEqual(l.footBottom + 0.5);
  expect(l.to.bottom, `${name}: To ends above the keyboard`).toBeLessThanOrEqual(l.seen + 0.5);
  expect(l.chip!.bottom, `${name}: the chip is over the foot`).toBeLessThanOrEqual(l.footTop + 0.5);
  expect(l.chip!.bottom, `${name}: the chip is inside its row (not cut)`).toBeLessThanOrEqual(l.thread!.bottom + 0.5);
  expect(l.chip!.top, `${name}: the chip is inside its row (not cut)`).toBeGreaterThanOrEqual(l.thread!.top - 0.5);
}

function sendInReach(l: Seen, name: string): void {
  expect(l.send.onTop, `${name}: nothing covers Send`).toBe(true);
  expect(l.send.bottom, `${name}: Send ends above the keyboard`).toBeLessThanOrEqual(l.seen + 0.5);
}

/** A picture of the window, with a grey box for the keyboard's stand-in. In the dialog: a modal dialog is the top layer. */
async function shot(page: Page, name: string): Promise<void> {
  const keyboard = await page.evaluate(() => document.documentElement.hasAttribute('data-ib-keyboard'));
  if (keyboard) {
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'e2e-keyboard';
      box.textContent = 'keyboard stand-in';
      box.style.cssText = `position:fixed;left:0;right:0;top:${window.visualViewport!.height}px;bottom:0;z-index:2147483647;pointer-events:none;background:rgb(120,120,128);color:#fff;font:600 15px system-ui;display:grid;place-items:center`;
      document.querySelector('dialog[data-compose]')!.appendChild(box);
    });
  }
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  if (keyboard) await page.evaluate(() => document.getElementById('e2e-keyboard')?.remove());
}

const ENGINES = [
  { name: 'webkit', title: 'WebKit as an iPhone', device: devices['iPhone 15'], launch: () => webkit.launch({ args: [] }), up: iosKeyboardUp },
  { name: 'chromium', title: 'Chromium as a Pixel', device: devices['Pixel 7'], launch: () => chromium.launch(), up: androidKeyboardUp },
] as const;

for (const engine of ENGINES) {
  test.describe(engine.title, () => {
    let browser: Browser;

    test.beforeAll(async () => {
      browser = await engine.launch();
    });

    test.afterAll(async () => {
      await browser?.close();
    });

    async function phone(size: (typeof SIZES)[number]): Promise<Page> {
      const { userAgent, deviceScaleFactor, isMobile, hasTouch } = engine.device;
      const context = await browser.newContext({ userAgent, deviceScaleFactor, isMobile, hasTouch, viewport: { width: size.width, height: size.height }, colorScheme: 'dark', reducedMotion: 'reduce' });
      return context.newPage();
    }

    for (const size of SIZES) {
      const at = `${size.width} px`;

      test(`${at}: a name typed, then the agent picked: the Thread row stays with its name while the keyboard is up`, async () => {
        const page = await phone(size);
        await openCompose(page);
        const sheet = sheetOf(page);
        const chip = sheet.locator('.ib-cp-tname-in');
        await chip.tap();
        await chip.fill(NAME);
        await shot(page, `${engine.name}-${size.width}-1-name-typed`);

        await pickAgent(page, true);
        // Focus is in the message now, so the phone's keyboard comes up.
        await engine.up(page, size.keyboard);
        await expect(page.locator('html')).toHaveAttribute('data-ib-keyboard', '');
        await sheet.locator('[data-compose-text] textarea').fill(MESSAGE);
        await shot(page, `${engine.name}-${size.width}-2-agent-picked-keyboard-up`);

        await expect(chip).toBeVisible();
        await expect(chip).toHaveValue(NAME);
        const l = await read(page);
        threadOnScreen(l, 'after the pick');
        sendInReach(l, 'after the pick');
        await page.context().close();
      });

      test(`${at}: the agent picked first, then the message: the Thread row shows its suggestion with the keyboard up`, async () => {
        const page = await phone(size);
        await openCompose(page);
        const sheet = sheetOf(page);
        await pickAgent(page, true);
        await engine.up(page, size.keyboard);
        await expect(page.locator('html')).toHaveAttribute('data-ib-keyboard', '');
        await sheet.locator('[data-compose-text] textarea').fill(MESSAGE);
        const chip = sheet.locator('.ib-cp-tname-in');
        // The suggestion follows the message 250 ms after typing stops.
        await expect(chip).not.toHaveValue('');
        await shot(page, `${engine.name}-${size.width}-3-picked-first-keyboard-up`);
        await expect(chip).toBeVisible();
        const l = await read(page);
        threadOnScreen(l, 'picked first');
        sendInReach(l, 'picked first');
        await page.context().close();
      });
    }
  });
}

test('a narrow desktop window: the Thread row and its name survive the pick', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 800 }, colorScheme: 'dark' });
    await openCompose(page);
    const sheet = sheetOf(page);
    const chip = sheet.locator('.ib-cp-tname-in');
    await chip.click();
    await chip.fill(NAME);
    await shot(page, 'desktop-600-1-name-typed');
    await pickAgent(page, false);
    await sheet.locator('[data-compose-text] textarea').fill(MESSAGE);
    await shot(page, 'desktop-600-2-agent-picked');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveValue(NAME);
    threadOnScreen(await read(page), 'narrow desktop');
  } finally {
    await browser.close();
  }
});
