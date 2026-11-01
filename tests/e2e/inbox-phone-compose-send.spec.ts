/**
 * New message on a phone (approval .product/approved/inbox-phone-compose-send, option C): Send sits at the bottom right
 * on the row with attachments and mic, and with the keyboard up the head folds to one line, To in the top bar.
 *
 * The keyboard cannot exist in a headless browser, so it is a stand-in: WebKit replays the owner's iOS 26 readings
 * (the visual viewport loses the keyboard, `innerHeight` follows it, `clientHeight` does not), Chromium the Android
 * ones (only the visual viewport shrinks), as inbox-ios-keyboard-shell.spec.ts does. 390 x 660 less 403 is the owner's
 * iPhone; 320 x 568 less 353 is the same ~100 px past a 253 px keyboard. Nothing here shows what a real iPhone does.
 *
 * Proved here, against the compiled binary under a temp PLANNOTATOR_DATA_DIR (PLANNOTATOR_INBOX_CONNECT=0, no browser),
 * at 320 and 390 px in WebKit and Chromium:
 *
 * - One Send, in the foot, on screen and on top at its own centre with the keyboard up or down, at least 12 px from the
 *   buttons on its left; a tap on it with the keyboard up sends.
 * - To is on screen in every state, in the top bar's line with the keyboard up, clear of Cancel and Save draft.
 * - No gap: the message field runs to the foot, and the foot to the keyboard (or the sheet's bottom).
 * - The head steps aside for the words, but a Thread row in use or saying something, and a refused file, do not.
 * - Save draft is at the top right only while nothing can be sent. Delete draft is off the sheet and on the Drafts page.
 * - A draft to an ended session keeps To's chevron clear of Save draft and says "ended" whole.
 * - Under the fold's threshold Send still stays on screen: a strip of 78 px, and a browser that resizes the layout.
 * - While dictating the row stays one row with the clip and mic where they were.
 * - Chromium at 1440 x 900: none of it applies.
 *
 * Voice is never on in the server (/voice/status would start a real Codex): the page is told it is on, answered here.
 *
 * Build the binary first (see inbox.spec.ts). PLANNOTATOR_E2E_SHOTS_DIR names a folder for the pictures (default
 * .local/proof/phone-compose-send), the keyboard's stand-in drawn in grey.
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
import { png } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/phone-compose-send'));

const SIZES = [
  { width: 390, height: 660, keyboard: 403 },
  { width: 320, height: 568, keyboard: 353 },
] as const;
type Size = (typeof SIZES)[number];

const SESSION = 'ses-phone-compose';
const MESSAGE = 'Rename the Quiet section to Done? Quiet reads like muted to me.';
const LINES = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: the promo field moves under the order summary.`).join('\n');
const LONG_NAME = 'Keep the checkout total from jumping when the promo field opens on the smallest phones';

let world: { url: string; agent: SimAgent; project: string; port: number; token: string; stop: boolean; loop: Promise<void> | null };

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-phone-compose-send-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  markTourDecided(dataDir);
  const env = {
    PATH: process.env.PATH ?? '',
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
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const project = scratchProject(join(root, 'src'), 'fernway-checkout-platform');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: project, subject: 'Checkout: the sticky footer', body: 'The checkout on a phone.' }, { wakes: true });
  const { port, token } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  world = { url: started.stdout.trim(), agent, project, port, token, stop: false, loop: null };

  // One live session, as the mod's connection holds it.
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

/** The browser is told voice is on, so the mic is on the row. The server's voice stays off. */
async function voiceOn(page: Page): Promise<void> {
  await page.route('**/api/inbox/settings*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, voice: { ...(body.voice as object), on: true, phones_only: false, intro_due: false } } });
  });
  await page.route('**/api/inbox/voice/status*', (route) => route.fulfill({ json: { state: 'ready' } }));
  await page.route('**/api/inbox/voice/intro*', (route) => route.fulfill({ json: { show: false } }));
}

/** The stand-in for the keyboard: what each browser reports with one up. */
type Keyboard = (page: Page, height: number) => Promise<void>;

const iosKeyboardUp: Keyboard = async (page, height) => {
  await page.evaluate((height) => {
    const vv = window.visualViewport!;
    const full = window.innerHeight;
    (window as unknown as { e2eInnerHeight?: PropertyDescriptor }).e2eInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
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

const root = (page: Page) => page.locator('html');
const sheetOf = (page: Page) => page.locator('dialog[data-compose]');

async function keyboardUp(page: Page, up: Keyboard, height: number): Promise<void> {
  await up(page, height);
  await expect(root(page)).toHaveAttribute('data-ib-keyboard', '');
}

async function keyboardDown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vv = window.visualViewport!;
    delete (vv as unknown as Record<string, unknown>).height;
    // Only iOS's readings replaced innerHeight; Chromium keeps its own on the window, and a delete would take it away.
    const stored = window as unknown as { e2eInnerHeight?: PropertyDescriptor };
    if (stored.e2eInnerHeight) Object.defineProperty(window, 'innerHeight', stored.e2eInnerHeight);
    vv.dispatchEvent(new Event('resize'));
  });
  await expect(root(page)).not.toHaveAttribute('data-ib-keyboard', /.*/);
}

async function openCompose(page: Page, pick = true): Promise<void> {
  await page.goto(world.url);
  await page.locator('.ib-lhead [data-open-compose]').click();
  const sheet = sheetOf(page);
  await expect(sheet.locator('.ib-cp-tobtn')).not.toHaveAttribute('data-loading', /.*/);
  if (!pick) return;
  await sheet.locator('.ib-cp-tobtn').click();
  await sheet.locator(`[data-compose-session="${SESSION}"]`).click();
  await expect(sheet.locator(`.ib-cp-tobtn[data-compose-to="${SESSION}"]`)).toBeVisible();
}

/** The worst draft, kept once in this Inbox: two files, a long thread name, a long message. */
let draftKept = false;
async function openWorstDraft(page: Page): Promise<void> {
  if (!draftKept) {
    await openCompose(page);
    const sheet = sheetOf(page);
    await sheet.locator('[data-compose-text] textarea').fill(LINES);
    await sheet.locator('.ib-cp-tname-in').fill(LONG_NAME);
    await sheet.locator('input[data-compose-attach]').setInputFiles([
      { name: 'checkout-promo-field-before-and-after.png', mimeType: 'image/png', buffer: png(600, 400, [200, 130, 90]) },
      { name: 'order-summary-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') },
    ]);
    await expect(sheet.locator('[data-compose-file="done"]')).toHaveCount(2);
    await sheet.locator('[data-compose-cancel]').click();
    await sheet.locator('[data-compose-keep]').click();
    await expect(sheet).toHaveCount(0);
    draftKept = true;
  }
  await page.goto(`${world.url}#drafts`);
  await page.locator('[data-draft-id]', { hasText: /Line 1|Keep the checkout total/ }).locator('.ib-draft-open').click();
  await expect(sheetOf(page).locator(`.ib-cp-tobtn[data-compose-to="${SESSION}"]`)).toBeVisible();
  await expect(sheetOf(page).locator('[data-compose-saved]')).toBeVisible();
  await expect(sheetOf(page).locator('[data-voice-mic]')).toBeVisible();
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Layout {
  seen: number;
  width: number;
  sends: number;
  sendOnTop: boolean;
  sheet: Box;
  bar: Box;
  cancel: Box | null;
  to: Box | null;
  chevron: Box | null;
  thread: Box | null;
  text: Box | null;
  foot: Box;
  clip: Box | null;
  mic: Box | null;
  count: Box | null;
  saved: Box | null;
  save: Box | null;
  send: Box;
}

/** Where each part is. A part that is not drawn is null. */
async function read(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const dialog = document.querySelector('dialog[data-compose]')!;
    const rect = (selector: string) => {
      const el = dialog.matches(selector) ? dialog : dialog.querySelector(selector);
      const box = el?.getBoundingClientRect();
      return box && box.width > 0 && box.height > 0 ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null;
    };
    const send = rect('.ib-cp-foot [data-compose-send]');
    const vv = window.visualViewport!;
    const hit = send && document.elementFromPoint((send.left + send.right) / 2, (send.top + send.bottom) / 2);
    return {
      seen: vv.offsetTop + vv.height,
      width: document.documentElement.clientWidth,
      sends: dialog.querySelectorAll('[data-compose-send]').length,
      sendOnTop: !!hit?.closest('[data-compose-send]'),
      sheet: rect('dialog')!,
      bar: rect('.ib-cp-bar')!,
      cancel: rect('[data-compose-cancel]'),
      to: rect('.ib-cp-tobtn, .ib-cp-none-to'),
      chevron: rect('.ib-cp-tobtn > svg.ib-ic'),
      thread: rect('.ib-cp-thread'),
      text: rect('[data-compose-text] textarea'),
      foot: rect('.ib-cp-foot')!,
      clip: rect('.ib-cp-clip'),
      mic: rect('[data-voice-mic]'),
      count: rect('[data-compose-file-count]'),
      saved: rect('[data-compose-saved]'),
      save: rect('[data-compose-save]'),
      send: send!,
    };
  }) as Promise<Layout>;
}

/** One Send, on the foot's one row, in reach, and at least 12 px from what is on its left. */
function sendInReach(l: Layout, name: string): void {
  expect(l.sends, `${name}: one Send`).toBe(1);
  expect(l.send, `${name}: Send is drawn`).toBeTruthy();
  expect(l.sendOnTop, `${name}: nothing covers Send`).toBe(true);
  expect(l.send.bottom, `${name}: Send ends above the keyboard`).toBeLessThanOrEqual(l.seen + 0.5);
  expect(l.send.right, `${name}: Send is on screen`).toBeLessThanOrEqual(l.width);
  expect(l.send.bottom - l.send.top, `${name}: Send is 44 px tall`).toBeGreaterThanOrEqual(43.5);
  expect(l.foot.bottom - l.foot.top, `${name}: the foot is one row`).toBeLessThanOrEqual(56);
  const left = Math.max(...[l.clip, l.count, l.mic, l.saved].map((part) => part?.right ?? 0));
  expect(l.send.left - left, `${name}: Send's gap from the left-hand buttons`).toBeGreaterThanOrEqual(11.5);
}

/** To is on screen, whatever else steps aside. */
function toOnScreen(l: Layout, name: string): void {
  expect(l.to, `${name}: To is drawn`).toBeTruthy();
  expect(l.to!.top, `${name}: To starts on screen`).toBeGreaterThanOrEqual(-0.5);
  expect(l.to!.bottom, `${name}: To ends above the foot`).toBeLessThanOrEqual(l.foot.top + 0.5);
  expect(l.to!.right, `${name}: To ends on screen`).toBeLessThanOrEqual(l.width);
}

/** The head is one line: To shares it with Cancel and Save draft, and overlaps neither. */
function headFolded(l: Layout, name: string): void {
  toOnScreen(l, name);
  expect(l.to!.top, `${name}: To is on the top bar's line`).toBeGreaterThanOrEqual(l.bar.top - 0.5);
  expect(l.to!.bottom, `${name}: To is on the top bar's line`).toBeLessThanOrEqual(l.bar.bottom + 0.5);
  expect(l.to!.left, `${name}: To clears Cancel`).toBeGreaterThanOrEqual(l.cancel!.right - 0.5);
  if (l.save) expect(l.to!.right, `${name}: To clears Save draft`).toBeLessThanOrEqual(l.save.left + 0.5);
  // The button's box can stay clear while what it holds runs out of it: the chevron is what would land on Save draft.
  if (l.chevron) expect(l.chevron.right, `${name}: the chevron stays in To`).toBeLessThanOrEqual(l.to!.right + 0.5);
  if (l.chevron && l.save) expect(l.chevron.right, `${name}: the chevron clears Save draft`).toBeLessThanOrEqual(l.save.left + 0.5);
}

/** The owner's gap: the field runs to the foot, the foot to the keyboard or the sheet's bottom. */
function noGap(l: Layout, name: string): void {
  expect(l.text, `${name}: the field is drawn`).toBeTruthy();
  expect(l.foot.top - l.text!.bottom, `${name}: the gap under the field`).toBeLessThanOrEqual(12);
  expect(Math.abs(Math.min(l.seen, l.sheet.bottom) - l.foot.bottom), `${name}: the gap under the foot`).toBeLessThanOrEqual(1);
}

/** A picture of the whole window, with a grey box for the stand-in. In the dialog: a modal dialog is the top layer. */
async function shot(page: Page, name: string, keyboard: boolean): Promise<void> {
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
  { name: 'chromium', title: 'Chromium as a Pixel', device: devices['Pixel 7'], launch: () => chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }), up: androidKeyboardUp },
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

    async function phone(size: Size): Promise<Page> {
      const { userAgent, deviceScaleFactor, isMobile, hasTouch } = engine.device;
      const context = await browser.newContext({
        userAgent,
        deviceScaleFactor,
        isMobile,
        hasTouch,
        viewport: { width: size.width, height: size.height },
        colorScheme: 'dark',
        reducedMotion: 'reduce',
        ...(engine.name === 'chromium' ? { permissions: ['microphone'] } : {}),
      });
      const page = await context.newPage();
      await voiceOn(page);
      return page;
    }

    for (const size of SIZES) {
      const at = `${size.width} px`;

      test(`${at}: Send at the bottom right, the head folds with the keyboard up, no gap, and a tap sends`, async () => {
        const page = await phone(size);
        await openCompose(page);
        const sheet = sheetOf(page);
        const field = sheet.locator('[data-compose-text] textarea');
        await field.focus();
        await field.fill(MESSAGE);

        const closed = await read(page);
        sendInReach(closed, 'keyboard closed');
        noGap(closed, 'keyboard closed');
        toOnScreen(closed, 'keyboard closed');
        expect(closed.to!.top, 'To is under the top bar').toBeGreaterThanOrEqual(closed.bar.bottom - 0.5);
        expect(closed.thread, 'Thread is drawn').toBeTruthy();
        await expect(sheet.locator('.ib-cp-bar h2')).toBeVisible();
        await expect(sheet.locator('.ib-cp-bar [data-compose-send]')).toHaveCount(0);
        await shot(page, `${engine.name}-${size.width}-keyboard-closed`, false);

        await keyboardUp(page, engine.up, size.keyboard);
        const open = await read(page);
        sendInReach(open, 'keyboard open');
        headFolded(open, 'keyboard open');
        noGap(open, 'keyboard open');
        expect(open.thread, 'Thread stepped aside').toBeNull();
        await shot(page, `${engine.name}-${size.width}-keyboard-open`, true);

        // Back as it was.
        await keyboardDown(page);
        const again = await read(page);
        noGap(again, 'keyboard closed again');
        expect(again.thread, 'Thread is back').toBeTruthy();
        expect(again.to!.top, 'To is back under the top bar').toBeGreaterThanOrEqual(again.bar.bottom - 0.5);

        // A finger on Send, with the keyboard up: it goes.
        await keyboardUp(page, engine.up, size.keyboard);
        await sheet.locator('.ib-cp-foot [data-compose-send]').tap();
        await expect(sheet).toHaveCount(0);
        await page.context().close();
      });

      test(`${at}: the worst draft: Send keeps its place, the tiles step aside and say how many, Delete draft stays on the Drafts page`, async () => {
        const page = await phone(size);
        await openWorstDraft(page);
        const sheet = sheetOf(page);
        await sheet.locator('[data-compose-text] textarea').focus();
        await expect(sheet.locator('[data-compose-delete]')).toHaveCount(0);
        await expect(sheet.locator('[data-compose-file="done"]')).toHaveCount(2);
        // The foot's end of a long draft, where the tiles are.
        await sheet.locator('.ib-cp-body').evaluate((body) => {
          body.scrollTop = body.scrollHeight;
        });
        sendInReach(await read(page), 'draft, keyboard closed');
        await expect(sheet.locator('[data-compose-file-count]')).toBeHidden();
        await shot(page, `${engine.name}-${size.width}-worst-keyboard-closed`, false);

        await keyboardUp(page, engine.up, size.keyboard);
        const open = await read(page);
        sendInReach(open, 'draft, keyboard open');
        headFolded(open, 'draft, keyboard open');
        await expect(sheet.locator('[data-compose-file]').first()).toBeHidden();
        await expect(sheet.locator('[data-compose-file-count]')).toHaveText('2 attached');
        await shot(page, `${engine.name}-${size.width}-worst-keyboard-open`, true);

        await keyboardDown(page);
        await expect(sheet.locator('[data-compose-file]').first()).toBeVisible();
        await expect(sheet.locator('[data-compose-file-count]')).toBeHidden();

        await sheet.locator('[data-compose-cancel]').click();
        await expect(sheet).toHaveCount(0);
        await expect(page.locator('[data-draft-id] .ib-draft-del').first()).toBeVisible();
        await page.context().close();
      });

      test(`${at}: nothing can be sent: Save draft at the top right beside To, and the status for a screen reader only`, async () => {
        const page = await phone(size);
        await openCompose(page, false);
        const sheet = sheetOf(page);
        const field = sheet.locator('[data-compose-text] textarea');
        const status = sheet.locator('[data-compose-status]');
        await expect(status).toHaveText('Choose an agent to send it.');
        await expect(field).toHaveAttribute('aria-describedby', (await status.getAttribute('id'))!);
        expect((await status.boundingBox())!.width, 'the status line is not on screen').toBeLessThanOrEqual(1);
        // Nothing written: nothing to save, and Send says it cannot go.
        await expect(sheet.locator('[data-compose-save]')).toHaveCount(0);
        await expect(sheet.locator('[data-compose-send]')).toHaveAttribute('aria-disabled', 'true');

        await field.focus();
        await field.fill(MESSAGE);
        await expect(sheet.locator('.ib-cp-bar [data-compose-save]')).toHaveText('Save draft');
        await keyboardUp(page, engine.up, size.keyboard);
        const open = await read(page);
        sendInReach(open, 'nobody in To');
        headFolded(open, 'nobody in To');

        // A pick: Save draft goes, Send can.
        await sheet.locator('.ib-cp-tobtn').tap();
        await sheet.locator(`[data-compose-session="${SESSION}"]`).tap();
        await expect(sheet.locator('[data-compose-save]')).toHaveCount(0);
        await expect(sheet.locator('[data-compose-send]')).not.toHaveAttribute('aria-disabled', /.*/);
        await page.context().close();
      });

      test(`${at}: no agent running: the note steps aside for the words, To says so`, async () => {
        const page = await phone(size);
        await page.route('**/api/inbox/sessions*', (route) => route.fulfill({ json: { projects: [] } }));
        await page.goto(world.url);
        await page.locator('.ib-lhead [data-open-compose]').click();
        const sheet = sheetOf(page);
        await expect(sheet.locator('[data-compose-note="none"]')).toBeVisible();
        const field = sheet.locator('[data-compose-text] textarea');
        await field.focus();
        await field.fill(MESSAGE);
        sendInReach(await read(page), 'no agent, keyboard closed');

        await keyboardUp(page, engine.up, size.keyboard);
        await expect(sheet.locator('[data-compose-note="none"]')).toBeHidden();
        await expect(sheet.locator('[data-compose-to="none"]')).toHaveText('No agent is running');
        const open = await read(page);
        sendInReach(open, 'no agent, keyboard open');
        headFolded(open, 'no agent, keyboard open');
        noGap(open, 'no agent, keyboard open');
        await page.context().close();
      });

      test(`${at}: a draft to an ended session, Save draft beside To: To keeps its chevron and says "ended" whole`, async () => {
        const page = await phone(size);
        const words = `To an ended session, ${engine.name} ${size.width}`;
        await openCompose(page);
        const sheet = sheetOf(page);
        const field = sheet.locator('[data-compose-text] textarea');
        await field.fill(words);
        await sheet.locator('[data-compose-cancel]').click();
        await sheet.locator('[data-compose-keep]').click();
        await expect(sheet).toHaveCount(0);

        // The session is gone when the draft comes back.
        await page.route('**/api/inbox/sessions*', (route) => route.fulfill({ json: { projects: [] } }));
        await page.goto(`${world.url}#drafts`);
        await page.locator('[data-draft-id]', { hasText: words }).locator('.ib-draft-open').click();
        const to = sheet.locator('.ib-cp-tobtn[data-compose-to="ended"]');
        await expect(to).toBeVisible();
        await expect(sheet.locator('[data-compose-note="ended"]')).toBeVisible();
        await field.focus();
        await field.fill(`${words}, and one more thought`);
        await expect(sheet.locator('.ib-cp-bar [data-compose-save]')).toBeVisible();
        await shot(page, `${engine.name}-${size.width}-ended-keyboard-closed`, false);

        await keyboardUp(page, engine.up, size.keyboard);
        await expect(sheet.locator('[data-compose-note="ended"]')).toBeHidden();
        const open = await read(page);
        sendInReach(open, 'ended, keyboard open');
        headFolded(open, 'ended, keyboard open');
        const detail = to.locator('[data-compose-detail]');
        await expect(detail).toHaveText('· ended', { useInnerText: true });
        const ended = await detail.evaluate((el) => ({ whole: el.scrollWidth <= el.clientWidth, right: el.getBoundingClientRect().right }));
        expect(ended.whole, '"ended" is not cut').toBe(true);
        expect(ended.right, '"ended" stops short of the chevron').toBeLessThanOrEqual(open.chevron!.left + 0.5);
        if (size.width === 320) await expect(to.locator('s'), 'no sliver of a name at 320').toBeHidden();
        await expect(to).toHaveAttribute('aria-label', /ended/);
        await shot(page, `${engine.name}-${size.width}-ended-keyboard-open`, true);

        await keyboardDown(page);
        await expect(sheet.locator('[data-compose-note="ended"]')).toBeVisible();
        await page.context().close();
      });

      test(`${at}: a strip too small to fold for (a hardware keyboard's bar): the sheet ends above it with Send in reach`, async () => {
        const page = await phone(size);
        await openCompose(page);
        const sheet = sheetOf(page);
        const field = sheet.locator('[data-compose-text] textarea');
        await field.focus();
        await field.fill(MESSAGE);
        await engine.up(page, 78);
        await expect.poll(async () => (await sheet.boundingBox())!.height).toBe(size.height - 78);
        await expect(root(page)).not.toHaveAttribute('data-ib-keyboard', /.*/);
        const strip = await read(page);
        sendInReach(strip, 'a strip');
        toOnScreen(strip, 'a strip');
        expect(strip.thread, 'nothing folds for a strip').toBeTruthy();

        await keyboardDown(page);
        await expect.poll(async () => (await sheet.boundingBox())!.height).toBe(size.height);
        await page.context().close();
      });
    }

    test('844 x 200, a browser that resizes the layout for the keyboard: the head folds with Send in reach', async () => {
      const page = await phone({ width: 844, height: 390, keyboard: 0 });
      await openCompose(page);
      const sheet = sheetOf(page);
      const field = sheet.locator('[data-compose-text] textarea');
      await field.focus();
      await field.fill(MESSAGE);
      await page.setViewportSize({ width: 844, height: 200 });
      await expect(root(page)).toHaveAttribute('data-ib-keyboard', '');
      const short = await read(page);
      sendInReach(short, 'a short window');
      headFolded(short, 'a short window');
      await page.setViewportSize({ width: 844, height: 390 });
      await expect(root(page)).not.toHaveAttribute('data-ib-keyboard', /.*/);
      await expect(sheet.locator('.ib-cp-thread')).toBeVisible();
      await page.context().close();
    });

    test('320 px: a failed send says so on screen with the keyboard up, To and Send in reach', async () => {
      const size = SIZES[1];
      const page = await phone(size);
      await openCompose(page);
      await page.route('**/api/inbox/messages*', (route) =>
        route.request().method() === 'POST' ? route.fulfill({ status: 500, json: { error: { code: 'server_error', message: 'The Inbox could not take it.' } } }) : route.fallback(),
      );
      const sheet = sheetOf(page);
      const field = sheet.locator('[data-compose-text] textarea');
      await field.fill(MESSAGE);
      await field.focus();
      await keyboardUp(page, engine.up, size.keyboard);
      await sheet.locator('.ib-cp-foot [data-compose-send]').tap();
      const error = sheet.locator('[data-compose-error]');
      await expect(error).toBeVisible();
      const l = await read(page);
      sendInReach(l, 'a failed send');
      headFolded(l, 'a failed send');
      const box = (await error.boundingBox())!;
      expect(box.y, 'the error is under the head').toBeGreaterThanOrEqual(l.bar.bottom - 0.5);
      expect(box.y + box.height, 'the error is over the foot').toBeLessThanOrEqual(l.foot.top + 0.5);
      expect(box.height, 'the error has room to say it').toBeGreaterThanOrEqual(18);
      await page.context().close();
    });

    test('320 px: the Board card line steps aside with the keyboard up and is back when it closes', async () => {
      const size = SIZES[1];
      const post = (path: string, body: object) =>
        fetch(`http://127.0.0.1:${world.port}/api/inbox/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${world.token}` },
          body: JSON.stringify(body),
        });
      const board = (on: boolean) => post('settings', { board: { on } });
      // Only for this test: with the Board on the Thread row grows a chip the others do not expect.
      expect((await board(true)).ok).toBe(true);
      try {
        // The first visit's dialog, claimed here so no page waits on it.
        expect((await post('board/intro', {})).ok).toBe(true);
        const made = await world.agent.card({ op: 'create', project_path: world.project, title: `The promo field, ${engine.name}` });
        const id = (made.card as { id: string }).id;
        const page = await phone(size);
        await page.goto(`${world.url}#board`);
        await page.locator(`[data-card-id="${id}"] [data-card-open]`).filter({ visible: true }).first().tap();
        await page.locator('[data-card-create-thread]').filter({ visible: true }).first().tap();
        const sheet = sheetOf(page);
        const line = sheet.locator(`[data-compose-card="${id}"]`);
        await expect(line).toBeVisible();
        await sheet.locator('[data-compose-text] textarea').focus();
        await keyboardUp(page, engine.up, size.keyboard);
        await expect(line).toBeHidden();
        const open = await read(page);
        sendInReach(open, 'a card, keyboard open');
        headFolded(open, 'a card, keyboard open');
        await keyboardDown(page);
        await expect(line).toBeVisible();
        await page.context().close();
      } finally {
        expect((await board(false)).ok).toBe(true);
      }
    });

    test('320 px: what needs saying does not step aside: Thread in use, a name refused, a file refused', async () => {
      const size = SIZES[1];
      const name = `Promo field ${engine.name}`;
      const page = await phone(size);
      await openCompose(page);
      const sheet = sheetOf(page);
      const field = sheet.locator('[data-compose-text] textarea');
      const chip = sheet.locator('.ib-cp-tname-in');
      await field.fill(MESSAGE);
      await chip.fill(name);
      await field.focus();
      await keyboardUp(page, engine.up, size.keyboard);
      await sheet.locator('.ib-cp-foot [data-compose-send]').tap();
      await expect(sheet).toHaveCount(0);
      await keyboardDown(page);

      // The same name again: the Send is refused beside the chip, and the chip's row comes back to say so.
      await openCompose(page);
      await field.fill(MESSAGE);
      await chip.focus();
      await keyboardUp(page, engine.up, size.keyboard);
      const typing = await read(page);
      expect(typing.thread, 'the chip keeps its row while it has focus').toBeTruthy();
      sendInReach(typing, 'typing the name');
      headFolded(typing, 'typing the name');
      await chip.fill(name);
      await field.focus();
      await expect(sheet.locator('.ib-cp-thread')).toBeHidden();
      await sheet.locator('.ib-cp-foot [data-compose-send]').tap();
      await expect(sheet.locator('[data-compose-thread-name-error]')).toBeVisible();
      const refused = await read(page);
      sendInReach(refused, 'a name refused');
      toOnScreen(refused, 'a name refused');

      await sheet.locator('input[data-compose-attach]').setInputFiles({ name: '.env', mimeType: 'text/plain', buffer: Buffer.from('A=1\n') });
      await expect(sheet.locator('[data-compose-file="refused"]')).toBeVisible();
      await expect(sheet.locator('[data-compose-file-count]')).toHaveCount(0);
      await page.context().close();
    });

    if (engine.name === 'chromium') {
      for (const size of SIZES) {
        test(`${size.width} px: dictating keeps one row, with the clip and mic where they were`, async () => {
          const page = await phone(size);
          await openWorstDraft(page);
          const before = await read(page);
          await sheetOf(page).locator('[data-voice-mic]').tap();
          await expect(page.locator('[data-voice-line]')).toBeVisible();
          const after = await read(page);
          expect(after.mic, 'the mic stays under the finger').toEqual(before.mic);
          expect(after.clip, 'the clip stays').toEqual(before.clip);
          expect(after.foot.bottom - after.foot.top, 'the foot is one row').toBeLessThanOrEqual(56);
          expect(after.send.right, 'Send is on screen').toBeLessThanOrEqual(after.width);
          const line = (await page.locator('[data-voice-line]').boundingBox())!;
          expect(line.x + line.width, 'the status stops short of Send').toBeLessThanOrEqual(after.send.left + 0.5);
          const send = sheetOf(page).getByRole('button', { name: 'Send' });
          await expect(send).toBeDisabled();
          if (size.width === 320) expect(after.send.right - after.send.left, 'the bare arrow').toBeLessThanOrEqual(44.5);
          await sheetOf(page).locator('[data-voice-cancel]').click();
          await expect(page.locator('[data-voice-line]')).toHaveCount(0);
          await page.context().close();
        });
      }
    }
  });
}

test.describe('Chromium at 1440 x 900 (the desktop)', () => {
  test('none of it applies: the foot keeps Send with its keycap, Save draft and the status line; a draft keeps Delete draft', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto(world.url);
    await page.locator('[data-open-compose]').first().click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('.ib-cp-tobtn')).not.toHaveAttribute('data-loading', /.*/);
    await expect(sheet.locator('.ib-cp-head, .ib-cp-bar')).toHaveCount(0);
    await expect(sheet.locator('[data-compose-status]')).toBeVisible();
    await expect(sheet.locator('[data-compose-status]')).toHaveClass('ib-cp-status');
    await sheet.locator('[data-compose-text] textarea').fill(MESSAGE);
    await expect(sheet.locator('.ib-cp-foot [data-compose-save]')).toBeVisible();

    await sheet.locator('.ib-cp-tobtn').click();
    await sheet.locator(`[data-compose-session="${SESSION}"]`).click();
    const send = sheet.locator('.ib-cp-foot [data-compose-send]');
    await expect(send).toHaveClass('ib-btn ib-pri');
    await expect(send.locator('[data-shortcut-hint]')).toBeVisible();
    await expect(sheet.locator('.ib-cp-sendl')).toHaveCount(0);

    // What reads as a keyboard on a phone is nothing here: To and Thread stay put.
    const to = await sheet.locator('.ib-cp-to').boundingBox();
    await androidKeyboardUp(page, 403);
    await expect.poll(() => page.evaluate(() => window.visualViewport!.height)).toBe(497);
    await expect(root(page)).not.toHaveAttribute('data-ib-keyboard', /.*/);
    await expect(sheet.locator('.ib-cp-to')).toHaveCSS('position', 'relative');
    await expect(sheet.locator('.ib-cp-thread')).toBeVisible();
    expect(await sheet.locator('.ib-cp-to').boundingBox()).toEqual(to);
    await keyboardDown(page);

    await send.click();
    await expect(sheet).toHaveCount(0);

    // A reopened draft keeps Delete draft.
    await page.locator('[data-open-compose]').first().click();
    await sheet.locator('[data-compose-text] textarea').fill('A draft to delete.');
    await page.keyboard.press('Escape');
    await sheet.locator('[data-compose-keep]').click();
    await expect(sheet).toHaveCount(0);
    await page.goto(`${world.url}#drafts`);
    await page.locator('[data-draft-id] .ib-draft-open').first().click();
    await expect(sheet.locator('.ib-cp-foot [data-compose-delete]')).toBeVisible();
  });
});
