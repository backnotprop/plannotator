/**
 * The window stays put on an iPhone while the keyboard is up (the owner's
 * iPhone, iOS 26 Safari, Inbox 0.28.42: "the top and bottom of the entire app
 * are like scrollable now", "still blank space ... when typing").
 *
 * The keyboard is simulated as the owner's probe recorded it on iOS 26
 * (.ops/work/mobile-keyboard-gap/probe/readings.jsonl): the visual viewport
 * loses the keyboard's 403 px, and once Safari has panned the page to the field,
 * `window.innerHeight` reads the visual viewport's height too, while
 * `document.documentElement.clientHeight` keeps the full height. phone.ts once
 * measured the keyboard as `innerHeight - visualViewport.height`, which reads 0
 * there: the window lost `--ib-vvh`, went back to its full height, and Safari
 * let the whole page pan under the keyboard.
 *
 * Proved here, against the compiled binary under a temp PLANNOTATOR_DATA_DIR
 * (PLANNOTATOR_INBOX_CONNECT=0, no browser):
 *
 * - WebKit as an iPhone 15, a thread's reply: with the keyboard up and Safari's
 *   pan replayed, the document does not scroll (scrollTop 0), html and body are
 *   no taller than the visual viewport, the reply foot's bottom is the visual
 *   viewport's bottom, and a drag on the header does not pan the page while a
 *   drag on the thread still scrolls it. With the keyboard down, all is as before.
 * - Chromium as a Pixel 7 (Chrome shrinks only the visual viewport): the reply
 *   foot still sits on the keyboard.
 * - Chromium at 1440 x 900: nothing of this applies (no `--ib-vvh`, full height,
 *   no drag guard).
 *
 * What emulation cannot prove: a headless WebKit has no keyboard, no Safari
 * bars and no real pan. Only an iPhone shows that Safari keeps the page still.
 *
 * Build the binary first (see inbox.spec.ts). PLANNOTATOR_E2E_SHOTS_DIR names a
 * folder for the pictures (default .local/proof/ios-keyboard-shell), a grey box
 * drawn where the keyboard is.
 */

import { chromium, devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/ios-keyboard-shell'));

/** The owner's iPhone, iOS 26: the keyboard with its suggestion bar took 403 of 660 px (probe readings). */
const IOS_KEYBOARD = 403;
/** Gboard with its suggestion strip on a Pixel, in CSS px. */
const ANDROID_KEYBOARD = 330;

const PARAGRAPH =
  'The checkout keeps its sticky footer on phones, but the promo field moves under the order summary so the total ' +
  'never jumps when the field opens. Every step was checked at 320, 375 and 430 px, light and dark.';

interface World {
  url: string;
  threadId: string;
  agent: SimAgent;
}

let world: World;

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-ios-keyboard-shell-');
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
  const project = scratchProject(join(root, 'src'), 'fernway');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  // Long enough that the thread scrolls in its own box on a phone.
  const body = Array.from({ length: 14 }, (_, i) => `${i + 1}. ${PARAGRAPH}`).join('\n\n');
  const sent = await agent.send({ project_path: project, subject: 'Checkout: the sticky footer on phones', body });
  world = { url: started.stdout.trim(), threadId: sent.thread_id as string, agent };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

/** Two frames: phone.ts applies a viewport change on the next one, the layout follows. */
const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/**
 * iOS 26 Safari's keyboard, as the probe read it: the visual viewport loses `keyboard` px, `innerHeight` follows it,
 * `clientHeight` keeps the full height, and the visual viewport's offset is the page's scroll. Then Safari's pan to
 * the field (the page scrolled by the keyboard's height) is replayed.
 */
async function iosKeyboardUp(page: Page, keyboard: number): Promise<void> {
  await page.evaluate((keyboard) => {
    const vv = window.visualViewport!;
    const full = window.innerHeight;
    // WebKit keeps innerHeight on the window itself: kept, for keyboardDown.
    (window as unknown as { e2eInnerHeight?: PropertyDescriptor }).e2eInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(vv, 'height', { configurable: true, get: () => full - keyboard });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => window.scrollY });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => full - keyboard });
    vv.dispatchEvent(new Event('resize'));
    window.scrollTo(0, keyboard);
    vv.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
  }, keyboard);
  await frames(page);
  await frames(page);
}

/** Chrome on Android: only the visual viewport shrinks (`interactive-widget=resizes-visual`, its default). */
async function androidKeyboardUp(page: Page, keyboard: number): Promise<void> {
  await page.evaluate((keyboard) => {
    const vv = window.visualViewport!;
    const full = window.innerHeight;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => full - keyboard });
    vv.dispatchEvent(new Event('resize'));
  }, keyboard);
  await frames(page);
  await frames(page);
}

async function keyboardDown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vv = window.visualViewport!;
    // Back to the browser's own readings.
    delete (vv as unknown as Record<string, unknown>).height;
    delete (vv as unknown as Record<string, unknown>).offsetTop;
    const kept = (window as unknown as { e2eInnerHeight?: PropertyDescriptor }).e2eInnerHeight;
    if (kept) Object.defineProperty(window, 'innerHeight', kept);
    else delete (window as unknown as Record<string, unknown>).innerHeight;
    vv.dispatchEvent(new Event('resize'));
  });
  await frames(page);
  await frames(page);
}

interface Reading {
  scrollTop: number;
  vvTop: number;
  vvBottom: number;
  htmlHeight: number;
  bodyHeight: number;
  bodyScrollHeight: number;
  footBottom: number;
  vvh: string;
}

async function read(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const vv = window.visualViewport!;
    const foot = document.querySelector('section.ib-pane .ib-pfoot')!.getBoundingClientRect();
    return {
      scrollTop: document.scrollingElement!.scrollTop,
      vvTop: vv.offsetTop,
      vvBottom: vv.offsetTop + vv.height,
      htmlHeight: document.documentElement.getBoundingClientRect().height,
      bodyHeight: document.body.getBoundingClientRect().height,
      bodyScrollHeight: document.body.scrollHeight,
      footBottom: foot.bottom,
      vvh: document.documentElement.style.getPropertyValue('--ib-vvh'),
    };
  });
}

/** Whether a one-finger drag that starts on `selector` is refused (its touchmove's default prevented). */
async function dragRefused(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((selector) => {
    const target = document.querySelector(selector)!;
    const event = new Event('touchmove', { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(event, 'touches', { value: [{}] });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, selector);
}

/** A grey box where the keyboard is, for the picture only. */
async function shot(page: Page, name: string, keyboard: number): Promise<void> {
  await page.evaluate((keyboard) => {
    const box = document.createElement('div');
    box.id = 'e2e-keyboard';
    box.textContent = 'keyboard';
    // From the visual viewport's bottom down.
    box.style.cssText = `position:fixed;left:0;right:0;top:${window.visualViewport!.height}px;height:${keyboard}px;z-index:2147483647;pointer-events:none;background:rgba(120,120,128,0.92);color:#fff;font:600 15px system-ui;display:grid;place-items:center`;
    document.body.appendChild(box);
  }, keyboard);
  await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: false });
  await page.evaluate(() => document.getElementById('e2e-keyboard')?.remove());
}

/** Opens the thread and its reply box, and focuses it. */
async function openReply(page: Page): Promise<void> {
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const pane = page.locator('section.ib-pane');
  const box = pane.locator('.ib-pfoot textarea');
  const open = pane.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
  await expect(box.or(open).first()).toBeVisible();
  if (!(await box.isVisible())) await open.click();
  await box.focus();
  await box.fill('The promo field under the summary, yes.');
  await frames(page);
}

test.describe('WebKit as an iPhone 15 (iOS 26 keyboard)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async () => {
    browser = await webkit.launch({ args: [] });
    const { userAgent, deviceScaleFactor, isMobile, hasTouch, viewport } = devices['iPhone 15'];
    context = await browser.newContext({ userAgent, deviceScaleFactor, isMobile, hasTouch, viewport, colorScheme: 'dark', reducedMotion: 'reduce' });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('a reply: the page cannot scroll, nothing is taller than the visible part, the reply foot sits on the keyboard', async () => {
    await openReply(page);
    await iosKeyboardUp(page, IOS_KEYBOARD);
    await shot(page, 'iphone-reply-keyboard', IOS_KEYBOARD);
    const r = await read(page);
    expect.soft(r.scrollTop, 'the document is not scrolled').toBe(0);
    expect.soft(r.vvTop, 'the visible part starts at the top').toBe(0);
    expect.soft(r.htmlHeight, 'html is no taller than the visible part').toBeLessThanOrEqual(r.vvBottom + 0.5);
    expect.soft(r.bodyHeight, 'body is no taller than the visible part').toBeLessThanOrEqual(r.vvBottom + 0.5);
    expect.soft(r.bodyScrollHeight, "body's content is no taller than the visible part").toBeLessThanOrEqual(r.vvBottom + 0.5);
    expect.soft(Math.abs(r.footBottom - r.vvBottom), `the reply foot's bottom (${r.footBottom}) is the keyboard's top (${r.vvBottom})`).toBeLessThanOrEqual(1);
    // A drag on what does not scroll would pan the page in Safari: refused. The thread still scrolls under a finger.
    expect.soft(await dragRefused(page, 'section.ib-pane .ib-phead'), 'a drag on the header does not pan the page').toBe(true);
    expect.soft(await dragRefused(page, 'section.ib-pane .ib-pbody'), 'a drag on the thread scrolls it').toBe(false);
    expect.soft(await dragRefused(page, 'section.ib-pane .ib-pfoot textarea'), 'a drag in the reply box is its own').toBe(false);
    // The page no longer pans to what the keyboard covers, so Send must be above it, also with a long draft.
    const send = page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^Send/ }).first();
    expect.soft((await send.boundingBox())!.y + (await send.boundingBox())!.height, 'Send is above the keyboard').toBeLessThanOrEqual(r.vvBottom + 0.5);
    await page.locator('section.ib-pane .ib-pfoot textarea').fill(Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long reply.`).join('\n'));
    await frames(page);
    await shot(page, 'iphone-long-reply-keyboard', IOS_KEYBOARD);
    const long = await read(page);
    const sendBox = (await send.boundingBox())!;
    expect.soft(sendBox.y + sendBox.height, 'Send is above the keyboard with a long draft').toBeLessThanOrEqual(long.vvBottom + 0.5);
    expect.soft(Math.abs(long.footBottom - long.vvBottom), 'the reply foot still sits on the keyboard with a long draft').toBeLessThanOrEqual(1);
    await page.locator('section.ib-pane .ib-pfoot textarea').fill('The promo field under the summary, yes.');

    // Safari pans again (a second field focus, a drag that got through): undone.
    await page.evaluate(() => {
      window.scrollTo(0, 200);
      window.dispatchEvent(new Event('scroll'));
    });
    await frames(page);
    expect.soft((await read(page)).scrollTop, 'a later pan is undone').toBe(0);

    await keyboardDown(page);
    const down = await read(page);
    const full = await page.evaluate(() => window.innerHeight);
    expect(down.vvh, 'no keyboard height kept').toBe('');
    expect(down.htmlHeight, 'html is the full height again').toBe(full);
    expect(Math.abs(down.footBottom - full), 'the reply foot is at the bottom again').toBeLessThanOrEqual(1);
    expect(await dragRefused(page, 'section.ib-pane .ib-phead'), 'no drag is refused with the keyboard down').toBe(false);
    await page.screenshot({ path: join(shotsDir, 'iphone-reply-no-keyboard.png') });
  });
});

test.describe('Chromium as a Pixel 7 (Android keyboard)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    browser = await chromium.launch();
    const { userAgent, deviceScaleFactor, isMobile, hasTouch, viewport } = devices['Pixel 7'];
    const context = await browser.newContext({ userAgent, deviceScaleFactor, isMobile, hasTouch, viewport, colorScheme: 'dark', reducedMotion: 'reduce' });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('a reply: the reply foot sits on the keyboard, as before', async () => {
    await openReply(page);
    await page.screenshot({ path: join(shotsDir, 'android-reply-no-keyboard.png') });
    await androidKeyboardUp(page, ANDROID_KEYBOARD);
    await shot(page, 'android-reply-keyboard', ANDROID_KEYBOARD);
    const r = await read(page);
    expect(r.scrollTop).toBe(0);
    expect(Math.abs(r.footBottom - r.vvBottom), `the reply foot's bottom (${r.footBottom}) is the keyboard's top (${r.vvBottom})`).toBeLessThanOrEqual(1);
    await keyboardDown(page);
    expect((await read(page)).vvh).toBe('');
  });
});

test.describe('Chromium at 1440 x 900 (the desktop)', () => {
  test('nothing changes: full height, no keyboard height, no drag guard', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto(`${world.url}#thread=${world.threadId}`);
    await expect(page.locator('section.ib-pane .ib-pfoot')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotsDir, 'desktop-thread.png') });
    const r = await read(page);
    expect(r.vvh).toBe('');
    expect(r.htmlHeight).toBe(900);
    expect(r.scrollTop).toBe(0);
    expect(await dragRefused(page, 'section.ib-pane .ib-phead, section.ib-pane header')).toBe(false);
  });
});
