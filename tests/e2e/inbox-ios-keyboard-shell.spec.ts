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
 * - WebKit as an iPhone 15 (portrait, 257 px left; on its side, 140): html and
 *   body are no taller than the visible part, the reply foot ends where it ends,
 *   and Send is inside it, with a long draft, with two attached files and a
 *   pick, and on its side; the reply field shows above the keyboard. A drag on
 *   the header or a short draft is refused (Safari would pan the page); a drag
 *   on the thread, a wide code block or an overflowing draft is not. A field in
 *   the thread (an action item's note) gets the room: the foot steps aside.
 *   With the keyboard down, all is as before.
 * - Chromium as a Pixel 7: the reply foot sits on the keyboard as before, and
 *   nothing is pinned or guarded (Android is unchanged).
 * - Chromium at 1440 x 900: nothing of this applies.
 *
 * What emulation cannot prove: a headless WebKit has no keyboard, no Safari
 * bars and cannot pan its page, so the reset of a pan is proved in
 * packages/inbox/phone.test.ts instead, and only an iPhone shows that Safari
 * keeps the page still. A synthetic touchmove proves the guard's decision, not
 * what iOS does with it.
 *
 * Build the binary first (see inbox.spec.ts). PLANNOTATOR_E2E_SHOTS_DIR names a
 * folder for the pictures (default .local/proof/ios-keyboard-shell), a grey box
 * drawn where the keyboard is.
 */

import { chromium, devices, expect, test, webkit, type Browser, type Locator, type Page } from '@playwright/test';
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
/** An iPhone on its side keeps about 140 px above the keyboard. */
const LANDSCAPE_LEFT = 140;
/** Gboard with its suggestion strip on a Pixel, in CSS px. */
const ANDROID_KEYBOARD = 330;

/** A 1 x 1 PNG, for the attached files. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const PARAGRAPH =
  'The checkout keeps its sticky footer on phones, but the promo field moves under the order summary so the total ' +
  'never jumps when the field opens. Every step was checked at 320, 375 and 430 px, light and dark.';
/** Column-aligned (two spaces between columns), so the block keeps its layout and scrolls sideways (ui's codeBlockKeepsLayout). */
const WIDE_LINE = [
  'breakpoints  width  footer  promo field                         total jumps  checked',
  'phone-s      320    sticky  under the order summary, collapsed  never        light and dark',
  'phone-l      430    sticky  under the order summary, open       never        light and dark',
].join('\n');

interface World {
  url: string;
  reply: string;
  action: string;
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
  // Long enough that the thread scrolls in its own box on a phone, with a code line wider than a phone and a question.
  const body = [
    ...Array.from({ length: 6 }, (_, i) => `${i + 1}. ${PARAGRAPH}`),
    ['```text', WIDE_LINE, '```'].join('\n'),
    ...Array.from({ length: 6 }, (_, i) => `${i + 7}. ${PARAGRAPH}`),
    [':::question', 'Keep the footer sticky on phones?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n'),
  ].join('\n\n');
  // Named threads: without one, both go to the session's default thread, and the question folds behind the newer message.
  const reply = await agent.send({ project_path: project, subject: 'Checkout: the sticky footer on phones', thread: 'checkout-footer', body }, { wakes: true });
  const action = await agent.send({
    project_path: project,
    subject: 'Publish blocked on a token',
    thread: 'publish-token',
    body: [
      'The publish failed with E401.',
      '',
      ':::action',
      'Rotate the npm token',
      'The publish token expired. Make a new automation token and put it in the repo secrets.',
      '',
      'Where: [npm tokens](https://www.npmjs.com/settings/acme/tokens)',
      'Stopped: 4.2 cannot be published until the token is replaced',
      ':::',
    ].join('\n'),
  });
  world = { url: started.stdout.trim(), reply: reply.thread_id as string, action: action.thread_id as string, agent };
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
 * `clientHeight` keeps the full height. Then Safari's pan to the field is replayed (a no-op in a headless page, which
 * cannot pan; the reset is proved in phone.test.ts).
 */
async function iosKeyboardUp(page: Page, keyboard: number): Promise<void> {
  await page.evaluate((keyboard) => {
    const vv = window.visualViewport!;
    const full = window.innerHeight;
    // WebKit keeps innerHeight on the window itself: kept, for keyboardDown.
    (window as unknown as { e2eInnerHeight?: PropertyDescriptor }).e2eInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(vv, 'height', { configurable: true, get: () => full - keyboard });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => full - keyboard });
    vv.dispatchEvent(new Event('resize'));
    window.scrollTo(0, keyboard);
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
    delete (vv as unknown as Record<string, unknown>).height;
    const kept = (window as unknown as { e2eInnerHeight?: PropertyDescriptor }).e2eInnerHeight;
    if (kept) Object.defineProperty(window, 'innerHeight', kept);
    else delete (window as unknown as Record<string, unknown>).innerHeight;
    vv.dispatchEvent(new Event('resize'));
  });
  await frames(page);
  await frames(page);
}

interface Reading {
  vvBottom: number;
  htmlHeight: number;
  bodyHeight: number;
  bodyScrollHeight: number;
  footBottom: number;
  vvh: string;
  keyboard: string | null;
  pin: string | null;
}

async function read(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const vv = window.visualViewport!;
    const root = document.documentElement;
    const foot = document.querySelector('section.ib-pane .ib-pfoot');
    return {
      vvBottom: vv.offsetTop + vv.height,
      htmlHeight: root.getBoundingClientRect().height,
      bodyHeight: document.body.getBoundingClientRect().height,
      bodyScrollHeight: document.body.scrollHeight,
      footBottom: foot ? foot.getBoundingClientRect().bottom : Number.NaN,
      vvh: root.style.getPropertyValue('--ib-vvh'),
      keyboard: root.getAttribute('data-ib-keyboard'),
      pin: root.getAttribute('data-ib-keyboard-pin'),
    };
  });
}

/** Whether a one-finger drag that starts on `target` is refused (its first touchmove's default prevented). */
async function dragRefused(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const touch = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{}] });
      el.dispatchEvent(event);
      return event;
    };
    touch('touchstart');
    const move = touch('touchmove');
    touch('touchend');
    return move.defaultPrevented;
  });
}

/** The box is drawn, starts on screen and ends at or above the keyboard. */
async function aboveKeyboard(page: Page, part: Locator, name: string): Promise<void> {
  const { vvBottom } = await read(page);
  const box = await part.boundingBox();
  expect(box, `${name} is drawn`).not.toBeNull();
  expect.soft(box!.y, `${name} starts on screen`).toBeGreaterThanOrEqual(-0.5);
  expect.soft(box!.y + box!.height, `${name} ends above the keyboard (at ${vvBottom})`).toBeLessThanOrEqual(vvBottom + 0.5);
}

/** A grey box where the keyboard is, for the picture only. */
async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'e2e-keyboard';
    box.textContent = 'keyboard';
    const top = window.visualViewport!.height;
    box.style.cssText = `position:fixed;left:0;right:0;top:${top}px;height:${Math.max(0, screen.height)}px;z-index:2147483647;pointer-events:none;background:rgba(120,120,128,0.92);color:#fff;font:600 15px system-ui;display:grid;place-items:start center;padding-top:24px`;
    document.body.appendChild(box);
  });
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  await page.evaluate(() => document.getElementById('e2e-keyboard')?.remove());
}

/** Opens a thread and its reply box. Returns the reply field. */
async function openReply(page: Page, thread: string): Promise<Locator> {
  await page.goto(`${world.url}#thread=${thread}`);
  const pane = page.locator('section.ib-pane');
  const box = pane.locator('.ib-pfoot textarea');
  const open = pane.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
  await expect(box.or(open).first()).toBeVisible();
  // A saved draft can open the box by itself just after "Edit draft" showed: then there is nothing left to click.
  await expect(async () => {
    if (!(await box.isVisible())) await open.click({ timeout: 2_000 });
    await expect(box).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return box;
}

const send = (page: Page) => page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^Send/ }).first();

/** The field shows above the keyboard: some of it is between the screen's top and Send's top. */
async function fieldShows(page: Page, field: Locator): Promise<void> {
  // iOS scrolls the field's own scroller to the caret as the keyboard comes up; a headless page does not.
  await field.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  const f = (await field.boundingBox())!;
  const s = (await send(page).boundingBox())!;
  expect.soft(f.y + f.height, 'the reply field reaches below the screen top').toBeGreaterThan(0);
  expect.soft(f.y, "the reply field starts above Send's row").toBeLessThan(s.y - 8);
}

test.describe('WebKit as an iPhone 15 (iOS 26 keyboard)', () => {
  let browser: Browser;

  test.beforeAll(async () => {
    browser = await webkit.launch({ args: [] });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  async function phone(device: 'iPhone 15' | 'iPhone 15 landscape' = 'iPhone 15'): Promise<Page> {
    const { userAgent, deviceScaleFactor, isMobile, hasTouch, viewport } = devices[device];
    const context = await browser.newContext({ userAgent, deviceScaleFactor, isMobile, hasTouch, viewport, colorScheme: 'dark', reducedMotion: 'reduce' });
    return context.newPage();
  }

  test('a reply: nothing is taller than the visible part, the reply foot sits on the keyboard, a drag pans nothing', async () => {
    const page = await phone();
    const field = await openReply(page, world.reply);
    await field.focus();
    await field.fill('The promo field under the summary, yes.');
    await iosKeyboardUp(page, IOS_KEYBOARD);
    await shot(page, 'iphone-reply-keyboard');
    const r = await read(page);
    expect(r.pin, 'iOS pins the page, tight at 257 px').toBe('tight');
    expect.soft(r.htmlHeight, 'html is no taller than the visible part').toBeLessThanOrEqual(r.vvBottom + 0.5);
    expect.soft(r.bodyHeight, 'body is no taller than the visible part').toBeLessThanOrEqual(r.vvBottom + 0.5);
    expect.soft(r.bodyScrollHeight, "body's content is no taller than the visible part").toBeLessThanOrEqual(r.vvBottom + 0.5);
    expect.soft(Math.abs(r.footBottom - r.vvBottom), `the reply foot's bottom (${r.footBottom}) is the keyboard's top (${r.vvBottom})`).toBeLessThanOrEqual(1);
    await aboveKeyboard(page, send(page), 'Send');

    const pane = page.locator('section.ib-pane');
    // A drag on what does not scroll would pan the page in Safari: refused.
    expect.soft(await dragRefused(pane.locator('.ib-phead')), 'a drag on the header').toBe(true);
    expect.soft(await dragRefused(field), 'a drag on a short draft').toBe(true);
    // What scrolls keeps its drag: the thread, a code line wider than the phone, an overflowing draft.
    expect.soft(await dragRefused(pane.locator('.ib-pbody').first()), 'a drag on the thread').toBe(false);
    // The innermost box a finger lands on: the code's text, inside the block that scrolls.
    const code = pane.locator('.ib-pbody pre code').filter({ hasText: 'breakpoints' }).first();
    const codeScrolls = await code.evaluate((el) => {
      for (let n: HTMLElement | null = el as HTMLElement; n && !n.classList.contains('ib-pbody'); n = n.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(n).overflowX) && n.scrollWidth > n.clientWidth + 1) return true;
      }
      return false;
    });
    expect(codeScrolls, 'the code block scrolls sideways').toBe(true);
    expect.soft(await dragRefused(code), 'a sideways drag on a wide code block').toBe(false);

    await field.fill(Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long reply.`).join('\n'));
    await frames(page);
    await shot(page, 'iphone-long-reply-keyboard');
    expect.soft(await dragRefused(field), 'a drag on a draft longer than its box').toBe(false);
    await aboveKeyboard(page, send(page), 'Send with a long draft');
    await fieldShows(page, field);
    await field.fill('The promo field under the summary, yes.');

    await keyboardDown(page);
    const down = await read(page);
    const full = await page.evaluate(() => window.innerHeight);
    expect(down.vvh, 'no keyboard height kept').toBe('');
    expect(down.pin, 'not pinned').toBeNull();
    expect(down.htmlHeight, 'html is the full height again').toBe(full);
    expect(Math.abs(down.footBottom - full), 'the reply foot is at the bottom again').toBeLessThanOrEqual(1);
    expect(await dragRefused(pane.locator('.ib-phead')), 'no drag is refused with the keyboard down').toBe(false);
    await page.screenshot({ path: join(shotsDir, 'iphone-reply-no-keyboard.png') });
    await page.context().close();
  });

  test('two attached files and a pick: Send stays above the keyboard, and the reply field shows', async () => {
    const page = await phone();
    await page.goto(`${world.url}#thread=${world.reply}`);
    const pane = page.locator('section.ib-pane');
    await pane.locator('fieldset[data-question-key] [data-question-option]').filter({ hasText: 'Yes' }).first().click();
    const field = await openReply(page, world.reply);
    await expect(pane.locator('[data-picks-chip]')).toBeVisible();
    const attach = pane.locator('.ib-rbox .ib-rfoot [data-reply-attach]');
    await attach.setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: PNG });
    await expect(pane.locator('.ib-rbox [data-compose-file="done"]')).toHaveCount(1);
    await attach.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('The header on my phone.\n') });
    await expect(pane.locator('.ib-rbox [data-compose-file="done"]')).toHaveCount(2);
    await field.focus();
    await iosKeyboardUp(page, IOS_KEYBOARD);
    await field.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
    await shot(page, 'iphone-files-pick-keyboard');
    const r = await read(page);
    expect.soft(Math.abs(r.footBottom - r.vvBottom), "the reply foot's bottom is the keyboard's top").toBeLessThanOrEqual(1);
    await aboveKeyboard(page, send(page), 'Send with two files and a pick');
    await fieldShows(page, field);
    await page.context().close();
  });

  test('on its side (140 px left): Send stays above the keyboard, and the reply field shows', async () => {
    const page = await phone('iPhone 15 landscape');
    const field = await openReply(page, world.reply);
    await field.focus();
    const full = await page.evaluate(() => window.innerHeight);
    await iosKeyboardUp(page, full - LANDSCAPE_LEFT);
    await shot(page, 'iphone-landscape-keyboard');
    const r = await read(page);
    expect(r.pin).toBe('tight');
    expect.soft(r.htmlHeight, 'html is no taller than the visible part').toBeLessThanOrEqual(r.vvBottom + 0.5);
    await aboveKeyboard(page, send(page), 'Send on its side');
    await fieldShows(page, field);
    // After the foot scrolled to the field, as iOS does for the caret.
    await shot(page, 'iphone-landscape-keyboard-field');
    await page.context().close();
  });

  test("an action item's note in the thread: the foot steps aside and the note shows above the keyboard", async () => {
    const page = await phone();
    const field = await openReply(page, world.action);
    await field.fill('Working on it.');
    const card = page.locator('section.ib-pane [data-action-card]');
    await card.locator('[data-action-done]').click();
    const note = card.locator('[data-action-draft-note]');
    await note.focus();
    await iosKeyboardUp(page, IOS_KEYBOARD);
    // iOS scrolls the note's scroller to it as the keyboard comes up.
    await note.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
    await shot(page, 'iphone-action-note-keyboard');
    await expect(page.locator('section.ib-pane .ib-pfoot')).toBeHidden();
    await aboveKeyboard(page, note, 'the note');
    // A drag on the note scrolls the thread it sits in: never refused.
    expect.soft(await dragRefused(note), 'a drag on a field in the thread').toBe(false);
    await note.fill('New automation token is in the secrets.');
    await note.blur();
    await keyboardDown(page);
    // The draft is where it was.
    await expect(page.locator('section.ib-pane .ib-pfoot textarea')).toHaveValue('Working on it.');
    await page.context().close();
  });
});

test.describe('Chromium as a Pixel 7 (Android keyboard)', () => {
  let browser: Browser;

  test.beforeAll(async () => {
    browser = await chromium.launch();
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('a reply: the reply foot sits on the keyboard as before; nothing is pinned or guarded', async () => {
    const { userAgent, deviceScaleFactor, isMobile, hasTouch, viewport } = devices['Pixel 7'];
    const context = await browser.newContext({ userAgent, deviceScaleFactor, isMobile, hasTouch, viewport, colorScheme: 'dark', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const field = await openReply(page, world.reply);
    await field.focus();
    await field.fill('The promo field under the summary, yes.');
    await page.screenshot({ path: join(shotsDir, 'android-reply-no-keyboard.png') });
    await androidKeyboardUp(page, ANDROID_KEYBOARD);
    await shot(page, 'android-reply-keyboard');
    const r = await read(page);
    const full = await page.evaluate(() => document.documentElement.clientHeight);
    expect(r.keyboard, 'the keyboard is read, as on main').toBe('');
    expect(r.pin, 'no pin on Android').toBeNull();
    expect(r.htmlHeight, 'html keeps its full height').toBe(full);
    expect(Math.abs(r.footBottom - r.vvBottom), `the reply foot's bottom (${r.footBottom}) is the keyboard's top (${r.vvBottom})`).toBeLessThanOrEqual(1);
    expect(await dragRefused(page.locator('section.ib-pane .ib-phead')), 'no drag guard on Android').toBe(false);
    await keyboardDown(page);
    expect((await read(page)).vvh).toBe('');
    await context.close();
  });
});

test.describe('Chromium at 1440 x 900 (the desktop)', () => {
  test('nothing changes: full height, no keyboard height, no pin, no drag guard', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto(`${world.url}#thread=${world.reply}`);
    await expect(page.locator('section.ib-pane .ib-pfoot')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe('loaded');
    await frames(page);
    await page.screenshot({ path: join(shotsDir, 'desktop-thread.png') });
    const r = await read(page);
    expect(r.vvh).toBe('');
    expect(r.keyboard).toBeNull();
    expect(r.pin).toBeNull();
    expect(r.htmlHeight).toBe(900);
    expect(await dragRefused(page.locator('section.ib-pane .ib-pfoot'))).toBe(false);
  });
});
