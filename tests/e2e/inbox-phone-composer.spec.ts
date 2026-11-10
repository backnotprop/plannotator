/**
 * The phone composer and its picker sheet (approval "inbox-phone-composer-picker"): the reply box and New message are
 * one rounded card 8 px from the edges and from the keyboard, with one row (paperclip, Skills, who gets the words, the
 * mic, a round Send), and who gets the words opens a bottom sheet.
 *
 * Proved against the compiled binary under a temp PLANNOTATOR_DATA_DIR, at 390 px in WebKit as an iPhone and Chromium
 * as a Pixel, with three live sessions held by the bridge's real long-poll (two with a long label):
 * - Reply, one agent: no recipient control (as on a computer), the row's order, a 36 px round Send still named
 *   "Send", every control 44 px to press, the card's 8 px margins, nothing scrolling sideways; with the keyboard up
 *   the card ends 8 px over it, Send in reach, and a long reply scrolls inside 40% of what is left.
 * - The sheet (a thread with two agents): a dialog that takes focus from the field and gives it back, a long label
 *   cut on one line, closed by Escape, the scrim and a drag down on its head; with reduced motion it does not slide.
 * - Reply, two agents: the pill is the recipient's mark and a chevron, named for a screen reader; a row picks one, a
 *   circle adds one, and Send reaches both. Two sessions of one agent: the pill also says which, in 14ch at most.
 * - New message: To in the foot's row, its sheet with the filter unfocused, the card 8 px over the keyboard with the
 *   title kept, the dialog's own ground under the keyboard. Chromium at 1440 x 900: none of it applies.
 *
 * What it cannot show. A keyboard cannot exist in automation, so it is a stand-in, as in
 * inbox-phone-compose-send.spec.ts: WebKit replays iOS readings (the visual viewport and `innerHeight` lose the
 * keyboard), Chromium the Android ones (only the visual viewport shrinks). Whether a real keyboard goes down or comes
 * back is read from focus alone. The drag is a mouse's pointer events, not a finger's. The 44 px press areas are read
 * with `elementFromPoint` 21 px above, below, left and right of each control's centre. Voice is never on in the
 * server: the page is told it is.
 *
 * Build the binary first (see inbox.spec.ts). PLANNOTATOR_E2E_SHOTS_DIR names a folder for the pictures (default
 * .local/proof/phone-composer), the keyboard's stand-in drawn in grey.
 */

import { chromium, devices, expect, test, webkit, type Browser, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands, type InboxReplyCommand } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/phone-composer'));

const SIZE = { width: 390, height: 660, keyboard: 403 } as const;
const ONE = 'ses-composer-one';
const TWO_A = 'ses-composer-two-claude';
const TWO_B = 'ses-composer-two-pi';
/** Longer than the Inbox keeps (60 characters), so every place that shows it has to cut it. */
const LABEL = 'Rework the billing export so very large CSV files stream to disk without a pause';
const LABEL_TWO = 'Keep the checkout total from jumping when the promo field opens on the smallest phones';
const LINES = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: the promo field moves under the order summary.`).join('\n');

/** One live session: the bridge's long-poll, keeping what the person sent it. */
class Poll {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = false;
  private readonly loop: Promise<void>;
  constructor(port: number, token: string, session: string, host: string, project: string, label?: string) {
    const startedAt = Date.now() - 45 * 60_000;
    this.loop = (async () => {
      while (!this.stopped) {
        const response = await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ session, host, waitMs: 1_000, tags: true, project_path: project, started_at: startedAt, busy: false, idle_since: startedAt, ...(label ? { label } : {}) }),
        }).catch(() => null);
        const text = (await response?.text().catch(() => '')) ?? '';
        for (const command of text ? parseInboxBridgeCommands(text) : []) if (!this.commands.some((known) => known.id === command.id)) this.commands.push(command);
      }
    })();
  }
  /** Whether this session was handed words holding `words` in `thread` (null: any thread). */
  got(words: string, thread: string | null): boolean {
    return this.commands.some((c) => (thread === null || c.thread_id === thread) && JSON.stringify(c).includes(words));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

let world: { url: string; agents: SimAgent[]; polls: Record<string, Poll>; oneThread: string; twoThread: string; sameThread: string; serverSession: string };

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-phone-composer-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  markTourDecided(dataDir);
  const off = { PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0' };
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', ...off, PLANNOTATOR_TEST_SANDBOX: root };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'fernway-checkout');
  const { port, token } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  const polls = {
    [ONE]: new Poll(port, token, ONE, 'claude-code', project, LABEL),
    [TWO_A]: new Poll(port, token, TWO_A, 'claude-code', project, LABEL_TWO),
    [TWO_B]: new Poll(port, token, TWO_B, 'pi', project),
  };
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  // `agent_session` is the session the shim would fill in: the one whose poll above is live.
  const one = await claude.send({ project_path: project, subject: 'Checkout: the sticky footer', body: 'The footer holds on a phone.', agent_session: ONE } as never, { wakes: true });
  await claude.send({ project_path: project, subject: 'Checkout: the promo field', thread: 'composer-two', body: 'First, from Claude Code.', agent_session: TWO_A } as never, { wakes: true });
  const two = await pi.send({ project_path: project, subject: 'Checkout: the promo field', thread: 'composer-two', body: 'Second, from Pi.', agent_session: TWO_B } as never, { wakes: true });
  // Two sessions of one agent in one thread: the mark alone cannot say which gets the reply.
  await claude.send({ project_path: project, subject: 'Checkout: the totals', thread: 'composer-same', body: 'First, from one Claude Code.', agent_session: ONE } as never, { wakes: true });
  const same = await claude.send({ project_path: project, subject: 'Checkout: the totals', thread: 'composer-same', body: 'Second, from another.', agent_session: TWO_A } as never, { wakes: true });
  const settings = (await (await fetch(new URL('/api/inbox/settings', url))).json()) as { serverSession: string };
  world = { url, agents: [claude, pi], polls, oneThread: one.thread_id as string, twoThread: two.thread_id as string, sameThread: same.thread_id as string, serverSession: settings.serverSession };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(Object.values(world.polls).map((poll) => poll.stop()));
    for (const agent of world.agents) await agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

/** Every test starts with no reply draft: a thread opened with one opens its box by itself, holding the words. */
test.beforeEach(async () => {
  for (const thread of [world.oneThread, world.twoThread, world.sameThread]) {
    const gone = await fetch(new URL(`/api/inbox/threads/${thread}/draft/delete`, world.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverSession: world.serverSession }) });
    expect(gone.status, 'the reply draft of the test before could not be deleted').toBe(200);
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

async function keyboardUp(page: Page, up: Keyboard): Promise<void> {
  await up(page, SIZE.keyboard);
  await expect(page.locator('html'), 'the page did not notice the keyboard stand-in').toHaveAttribute('data-ib-keyboard', '');
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
  await expect(page.locator('html')).not.toHaveAttribute('data-ib-keyboard', /.*/);
}

/** A picture of the window, with a grey box for the stand-in: in the open dialog (a modal dialog is the top layer), else on <html>. */
async function shot(page: Page, name: string, keyboard = false): Promise<void> {
  if (keyboard) {
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'e2e-keyboard';
      box.textContent = 'keyboard stand-in';
      box.style.cssText = `position:fixed;left:0;right:0;top:${window.visualViewport!.height}px;bottom:0;z-index:2147483647;pointer-events:none;background:rgb(120,120,128);color:#fff;font:600 15px system-ui;display:grid;place-items:center`;
      (document.querySelector('dialog[open]') ?? document.documentElement).appendChild(box);
    });
  }
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  if (keyboard) await page.evaluate(() => document.getElementById('e2e-keyboard')?.remove());
}

const pane = (page: Page) => page.locator('section.ib-pane');
const replyField = (page: Page) => pane(page).locator('.ib-rbox textarea').first();
const recipient = (page: Page) => pane(page).locator('.ib-rbox [data-reply-row][data-phone] [data-recipient]');
const replySheet = (page: Page) => page.locator('[data-sheet][data-recipient-list]');

/** The thread with its reply box open and empty, the field holding focus. */
async function openBox(page: Page, thread: string): Promise<void> {
  await page.goto(`${world.url}#thread=${thread}`);
  const reply = pane(page).locator('.ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ }).first();
  await expect(reply.or(replyField(page)).first()).toBeVisible();
  if (!(await replyField(page).isVisible())) await reply.click();
  await replyField(page).fill('');
  await replyField(page).focus();
}

/** The sheet is open and has stopped moving: shown, no transform left, and its top the same on two reads. */
async function sheetOpen(sheet: Locator): Promise<void> {
  await expect(sheet, 'the sheet did not open').toHaveAttribute('data-shown', '');
  let last = Number.NaN;
  const rest = async () => {
    const now = await sheet.evaluate((el) => ({ top: el.getBoundingClientRect().top, still: ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(el).transform) }));
    const same = now.still && now.top === last;
    last = now.top;
    return same;
  };
  await expect.poll(rest, { message: 'the sheet never came to rest' }).toBe(true);
}

/** A box (the card, a sheet) against the part of the window that shows (`seen` is the keyboard's top, or the window's bottom). */
const cardFacts = (card: Locator) =>
  card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport!;
    return { left: r.left, fromRight: document.documentElement.clientWidth - r.right, fromSeen: vv.offsetTop + vv.height - r.bottom, seen: vv.offsetTop + vv.height };
  });

/** The card is 8 px from the left and right edges, and ends 8 px over `what`. */
async function floats(card: Locator, what: string): Promise<void> {
  const c = await cardFacts(card);
  expect(Math.abs(c.left - 8), 'the card is 8 px from the left edge').toBeLessThanOrEqual(1);
  expect(Math.abs(c.fromRight - 8), 'the card is 8 px from the right edge').toBeLessThanOrEqual(1);
  expect(Math.abs(c.fromSeen - 8), `the card ends 8 px over ${what}`).toBeLessThanOrEqual(1.5);
}

/** A control's box, and whether it is what a press at its own centre lands on. */
const spot = (control: Locator) =>
  control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, onTop: el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
  });

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

    async function phone(): Promise<Page> {
      const { userAgent, deviceScaleFactor, isMobile, hasTouch } = engine.device;
      const context = await browser.newContext({ userAgent, deviceScaleFactor, isMobile, hasTouch, viewport: { width: SIZE.width, height: SIZE.height }, colorScheme: 'dark', ...(engine.name === 'chromium' ? { permissions: ['microphone'] } : {}) });
      const page = await context.newPage();
      await voiceOn(page);
      return page;
    }

    // A drag down on the sheet's head, by the mouse: both engines turn it into the pointer events the head listens for.
    // Should an engine send none (the head never hears the press), the same events are dispatched on the head instead.
    async function dragDown(page: Page, sheet: Locator): Promise<void> {
      const head = sheet.locator('[data-sheet-head]');
      await head.evaluate((el) => el.addEventListener('pointerdown', () => el.setAttribute('data-e2e-pressed', ''), { once: true }));
      const box = (await head.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      if ((await head.getAttribute('data-e2e-pressed')) !== null) {
        await page.mouse.move(x, y + 200, { steps: 8 });
        await page.mouse.up();
        return;
      }
      await page.mouse.up();
      await head.evaluate((el, [x, y]) => {
        const fire = (type: string, dy: number) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y! + dy }));
        fire('pointerdown', 0);
        for (const dy of [50, 100, 150, 200]) fire('pointermove', dy);
        fire('pointerup', 200);
      }, [x, y]);
    }

    test('reply, one agent: no recipient control; paperclip, Skills, the mic and a round Send, 44 px to press; the card floats 8 px from the edges and the keyboard', async () => {
      const page = await phone();
      await openBox(page, world.oneThread);
      const box = pane(page).locator('.ib-rbox');
      await expect(box.locator('[data-reply-row] [data-voice-mic]'), 'the mic is not on the row').toBeVisible();
      await expect(pane(page).locator('[data-recipient], .ib-sheet'), 'a one-agent thread has a recipient control or a sheet').toHaveCount(0);
      const row = await box.evaluate((el) => {
        const parts = { paperclip: '.ib-rclip', Skills: '[data-reply-skills]', mic: '[data-voice-mic]', Send: '[data-reply-send]' };
        const missed: string[] = [];
        const centres: number[] = [];
        for (const [name, selector] of Object.entries(parts)) {
          const control = el.querySelector<HTMLElement>(`[data-reply-row][data-phone] ${selector}`);
          const r = control?.getBoundingClientRect();
          if (!control || !r) missed.push(`${name} is not in the row`);
          else {
            const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
            centres.push(x);
            for (const [side, dx, dy] of [['above', 0, -21], ['below', 0, 21], ['left', -21, 0], ['right', 21, 0]] as const) if (!control.contains(document.elementFromPoint(x + dx, y + dy))) missed.push(`${name}, ${side}`);
          }
        }
        const send = el.querySelector<HTMLElement>('[data-reply-send]')!;
        const s = send.getBoundingClientRect();
        return { missed, centres, send: { width: s.width, height: s.height, radius: parseFloat(getComputedStyle(send).borderTopLeftRadius), right: s.right }, boxRight: el.getBoundingClientRect().right, sideways: document.documentElement.scrollWidth - window.innerWidth };
      });
      expect(row.missed, 'a press 21 px from a control\'s centre misses it').toEqual([]);
      expect(row.centres, 'the row reads paperclip, Skills, mic, Send from the left').toEqual([...row.centres].sort((a, b) => a - b));
      expect(Math.abs(row.send.width - 36), 'Send is 36 px wide').toBeLessThanOrEqual(1);
      expect(Math.abs(row.send.height - 36), 'Send is 36 px tall').toBeLessThanOrEqual(1);
      expect(row.send.radius, 'Send is round').toBeGreaterThanOrEqual(row.send.width / 2);
      expect(row.boxRight - row.send.right, 'Send is at the card\'s right end').toBeLessThanOrEqual(12);
      await expect(box.getByRole('button', { name: 'Send', exact: true }), 'Send lost its name').toHaveAttribute('data-reply-send', '');
      await floats(box, 'the window\'s bottom');
      expect(row.sideways, 'the page scrolls sideways').toBeLessThanOrEqual(0);
      await shot(page, `${engine.name}-reply-one`);
      // The keyboard up: the card ends 8 px over it, and a long reply scrolls inside 40% of what is left.
      const send = box.locator('[data-reply-send]');
      await keyboardUp(page, engine.up);
      await expect.poll(async () => Math.abs((await cardFacts(box)).fromSeen - 8), { message: 'the card does not end 8 px over the keyboard' }).toBeLessThanOrEqual(1.5);
      const seen = (await cardFacts(box)).seen;
      const resting = await spot(send);
      expect(resting.bottom, 'Send is under the keyboard').toBeLessThanOrEqual(seen);
      expect(resting.onTop, 'something covers Send').toBe(true);
      expect((await spot(replyField(page))).height, 'the empty typing area is under 88 px tall').toBeGreaterThanOrEqual(88);
      expect(parseFloat(await replyField(page).evaluate((el) => getComputedStyle(el).fontSize)), 'the field\'s text is under 16 px (iOS would zoom)').toBeGreaterThanOrEqual(16);
      await replyField(page).fill(LINES);
      const scroll = box.locator('.ib-rscroll');
      await expect.poll(() => scroll.evaluate((el) => el.scrollHeight > el.clientHeight), { message: 'a 14-line reply does not scroll inside the box' }).toBe(true);
      expect((await spot(scroll)).height, 'the words take more than 40% of what the keyboard leaves').toBeLessThanOrEqual(seen * 0.4 + 1);
      const long = await spot(send);
      expect(long.top, 'a long reply pushed Send off the top').toBeGreaterThanOrEqual(0);
      expect(long.bottom, 'a long reply pushed Send under the keyboard').toBeLessThanOrEqual(seen);
      expect(long.onTop, 'something covers Send over a long reply').toBe(true);
      await shot(page, `${engine.name}-reply-keyboard`, true);
      await replyField(page).fill('');
      await keyboardDown(page);
      await page.context().close();
    });

    test('the sheet: takes focus from the field, cuts a long label on one line, closes by Escape, the scrim and a drag down; no slide with reduced motion', async () => {
      const page = await phone();
      await openBox(page, world.twoThread);
      await expect(replyField(page), 'the reply does not hold focus before the sheet opens').toBeFocused();
      const sheet = replySheet(page);
      await recipient(page).tap();
      await sheetOpen(sheet);
      await expect(sheet).toHaveAttribute('role', 'dialog');
      const placed = await cardFacts(sheet);
      expect(Math.abs(placed.left - 8), 'the sheet is 8 px from the left edge').toBeLessThanOrEqual(1);
      expect(Math.abs(placed.fromRight - 8), 'the sheet is 8 px from the right edge').toBeLessThanOrEqual(1);
      expect(placed.fromSeen, 'the sheet runs past the window\'s bottom').toBeGreaterThanOrEqual(0);
      await expect(replyField(page), 'the field kept focus, so a real keyboard would stay up').not.toBeFocused();
      expect(await sheet.evaluate((el) => el.contains(document.activeElement)), 'focus is not in the sheet').toBe(true);
      const title = sheet.locator(`[data-recipient-row="${TWO_A}"] .ib-sheet-t`);
      await expect(title, 'the row does not show the session\'s label').toContainText(LABEL_TWO.slice(0, 40), { timeout: 30_000 });
      const cut = await title.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const s = el.closest('[data-sheet]')!.getBoundingClientRect();
        return { cut: el.scrollWidth > el.clientWidth, inside: r.left >= s.left && r.right <= s.right, height: r.height };
      });
      expect(cut.cut, 'the long label is not cut').toBe(true);
      expect(cut.inside, 'the long label runs out of the sheet').toBe(true);
      expect(cut.height, 'the long label wraps').toBeLessThanOrEqual(24);
      await shot(page, `${engine.name}-sheet-label`);
      await page.keyboard.press('Escape');
      await expect(sheet, 'Escape did not close the sheet').toHaveCount(0);
      await expect(pane(page).locator('.ib-rbox'), 'Escape closed the reply box too').toBeVisible();
      await expect(replyField(page), 'after Escape focus is not back in the reply (a real keyboard would stay down)').toBeFocused();
      await recipient(page).tap();
      await sheetOpen(sheet);
      await page.locator('[data-sheet-scrim]').tap({ position: { x: SIZE.width / 2, y: 96 } });
      await expect(sheet, 'a tap on the scrim did not close the sheet').toHaveCount(0);
      await expect(pane(page).locator('.ib-rbox'), 'the tap on the scrim pressed something under it').toBeVisible();
      await recipient(page).tap();
      await sheetOpen(sheet);
      await dragDown(page, sheet);
      await expect(sheet, 'a drag down on the head did not close the sheet').toHaveCount(0);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await recipient(page).tap();
      await expect(sheet).toHaveAttribute('data-shown', '');
      expect(await sheet.evaluate((el) => getComputedStyle(el).transform), 'with reduced motion the sheet still slides').toBe('none');
      await expect(sheet, 'with reduced motion the sheet never fades in').toHaveCSS('opacity', '1');
      await page.keyboard.press('Escape');
      await expect(sheet, 'with reduced motion the sheet does not close').toHaveCount(0);
      await page.context().close();
    });

    test('reply, two agents: the pill is a mark named for a screen reader, a row picks one, a circle adds one, Send reaches both; two sessions of one agent: the pill says which', async () => {
      const page = await phone();
      await openBox(page, world.twoThread);
      const box = pane(page).locator('.ib-rbox');
      const sheet = replySheet(page);
      await expect(recipient(page), 'a two-agent thread shows the recipient as a pill').toHaveAttribute('data-agent-pill', '');
      await expect(recipient(page).locator('.ib-apill-n'), 'agents of two kinds: the pill shows words beside the mark').toHaveCount(0);
      // What a screen reader hears: the agent, and its session's title where it has one.
      const named = async (session: string) => {
        const heard = (await recipient(page).getAttribute('aria-label')) ?? '';
        for (const part of session === TWO_A ? ['Claude Code', LABEL_TWO.slice(0, 40)] : ['Pi']) expect(heard, `the pill's name leaves out "${part}"`).toContain(part);
        expect(heard, 'the pill\'s name does not say what it is for').toMatch(/^Reply goes to .*\. Change$/);
      };
      await named((await recipient(page).getAttribute('data-recipient-chosen'))!);
      const pill = await spot(recipient(page));
      expect(pill.height, 'the pill is taller than one line').toBeLessThanOrEqual(37);
      expect(pill.width, 'a mark and a chevron take 70 px or more').toBeLessThan(70);
      expect(pill.left, 'the pill runs under Skills').toBeGreaterThanOrEqual((await spot(box.locator('[data-reply-skills]'))).right);
      expect(pill.right, 'the pill runs under the mic').toBeLessThanOrEqual((await spot(box.locator('[data-voice-mic]'))).left);
      await shot(page, `${engine.name}-reply-two`);
      await recipient(page).tap();
      await sheetOpen(sheet);
      await expect(sheet.locator('[data-recipient-row]'), 'the sheet does not list both agents').toHaveCount(2);
      await expect(sheet.locator('[data-recipient-row][aria-selected="true"]'), 'not exactly one agent is checked').toHaveCount(1);
      await shot(page, `${engine.name}-sheet-two`);
      const other = (await sheet.locator('[data-recipient-row][aria-selected="false"]').getAttribute('data-recipient-row'))!;
      await sheet.locator(`[data-recipient-row="${other}"] .ib-sheet-t`).tap();
      await expect(sheet, 'a tap on a row did not close the sheet').toHaveCount(0);
      await expect(recipient(page), 'the pill is not the agent tapped').toHaveAttribute('data-recipient-chosen', other);
      await named(other);
      await expect(replyField(page), 'after a pick focus is not in the reply (a real keyboard would stay down)').toBeFocused();
      await recipient(page).tap();
      await sheetOpen(sheet);
      await sheet.locator('[data-recipient-tick][aria-checked="false"]').tap();
      await expect(sheet.locator('[data-recipient-tick][aria-checked="true"]'), 'the circle did not add the second agent').toHaveCount(2);
      await expect(sheet, 'the circle closed the sheet').toHaveAttribute('data-shown', '');
      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
      await expect(recipient(page), 'two recipients are not shown as a mark').toHaveAttribute('data-agent-mark', '');
      await expect(recipient(page).locator('[data-agent-count]'), 'the mark does not count two recipients').toHaveText('2');
      const words = `Both of you: keep the promo field closed by default (${engine.name}).`;
      await replyField(page).fill(words);
      await box.getByRole('button', { name: 'Send', exact: true }).tap();
      await expect(pane(page).locator('article.ib-message[data-author="person"]', { hasText: words }), 'the thread does not show the reply').toBeVisible();
      for (const session of [TWO_A, TWO_B]) await expect.poll(() => world.polls[session]!.got(words, world.twoThread), { message: `${session} was not handed the reply`, timeout: 30_000 }).toBe(true);
      // Two Claude Code sessions: the pill says which, on one line, in 14ch at most, still between Skills and the mic.
      await openBox(page, world.sameThread);
      const name = recipient(page).locator('.ib-apill-n');
      await expect(name, 'two sessions of one agent: the pill does not say which').toHaveText(/\S/);
      const said = await name.evaluate((el) => {
        const zero = document.createElement('span');
        zero.textContent = '0';
        zero.style.cssText = 'position:absolute;visibility:hidden';
        el.parentElement!.appendChild(zero);
        const ch = zero.getBoundingClientRect().width;
        zero.remove();
        return { width: el.getBoundingClientRect().width, most: 14 * ch + 1, height: el.getBoundingClientRect().height, ellipsis: getComputedStyle(el).textOverflow };
      });
      expect(said.width, 'the name in the pill is wider than 14ch').toBeLessThanOrEqual(said.most);
      expect(said.height, 'the name in the pill wraps').toBeLessThanOrEqual(24);
      expect(said.ellipsis, 'a long name in the pill is not cut with an ellipsis').toBe('ellipsis');
      const both = await spot(recipient(page));
      expect(both.left, 'the named pill runs under Skills').toBeGreaterThanOrEqual((await spot(box.locator('[data-reply-skills]'))).right);
      expect(both.right, 'the named pill runs under the mic').toBeLessThanOrEqual((await spot(box.locator('[data-voice-mic]'))).left);
      await shot(page, `${engine.name}-reply-same-agent`);
      await page.context().close();
    });

    test('new message: To in the foot\'s row, its sheet with the filter unfocused, the card 8 px over the keyboard with the title kept, and it sends', async () => {
      const page = await phone();
      await page.goto(world.url);
      await page.locator('.ib-lhead [data-open-compose]').click();
      const dialog = page.locator('dialog[data-compose]');
      const to = dialog.locator('.ib-cp-foot [data-compose-to]');
      const card = dialog.locator('[data-compose-pcard]');
      const send = dialog.locator('.ib-cp-foot [data-compose-send]');
      const field = dialog.locator('[data-compose-text] textarea');
      const title = dialog.getByRole('heading', { name: 'New message' });
      await expect(to).not.toHaveAttribute('data-loading', /.*/);
      await expect(to, 'To does not ask for an agent').toHaveText('Choose an agent');
      await expect(dialog.locator('.ib-cp-to'), 'the To line is still drawn under the title').toHaveCount(0);
      await expect(title).toBeVisible();
      await floats(card, 'the window\'s bottom');
      await to.tap();
      const sheet = dialog.locator('[data-compose-to-sheet]');
      await sheetOpen(sheet);
      await expect(sheet.locator('input[role="combobox"]'), 'the filter took focus, so a real keyboard would cover the list').not.toBeFocused();
      await expect(sheet.locator('[data-compose-session]'), 'the sheet does not list the three live sessions').toHaveCount(3);
      await shot(page, `${engine.name}-compose-sheet`);
      await sheet.locator(`[data-compose-session="${ONE}"]`).tap();
      await expect(sheet, 'a pick did not close the sheet').toHaveCount(0);
      await expect(to).toHaveAttribute('data-compose-to', ONE);
      const name = await to.locator('.ib-apill-n').evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth, ellipsis: getComputedStyle(el).textOverflow }));
      expect(name, 'the long label in To is not cut with an ellipsis').toEqual({ cut: true, ellipsis: 'ellipsis' });
      const foot = await spot(dialog.locator('.ib-cp-foot'));
      const pill = await spot(to);
      expect(pill.height, 'To is taller than one line').toBeLessThanOrEqual(37);
      expect(pill.left >= foot.left && pill.right <= foot.right && pill.top >= foot.top && pill.bottom <= foot.bottom, 'To runs out of the foot').toBe(true);
      expect(pill.right, 'To runs under Send').toBeLessThanOrEqual((await spot(send)).left);
      expect((await spot(send)).right, 'Send is off the screen').toBeLessThanOrEqual(SIZE.width);
      await expect(field, 'after a pick focus is not in the message').toBeFocused();
      await keyboardUp(page, engine.up);
      await expect.poll(async () => Math.abs((await cardFacts(card)).fromSeen - 8), { message: 'the card does not end 8 px over the keyboard' }).toBeLessThanOrEqual(1.5);
      await expect(title, 'the title went with the keyboard up').toBeVisible();
      const up = await spot(send);
      expect(up.onTop, 'something covers Send with the keyboard up').toBe(true);
      expect(up.bottom, 'Send is under the keyboard').toBeLessThanOrEqual((await cardFacts(card)).seen);
      const ground = await dialog.evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, layout: document.documentElement.clientHeight, own: getComputedStyle(el).backgroundColor, backdrop: getComputedStyle(el, '::backdrop').backgroundColor }));
      expect(ground.bottom, 'the dialog stops at the keyboard, so its backdrop can show under the card').toBeGreaterThanOrEqual(ground.layout - 1);
      expect(['transparent', 'rgba(0, 0, 0, 0)'], 'the dialog has no ground of its own').not.toContain(ground.own);
      // An engine that cannot read `::backdrop` through getComputedStyle gives nothing here: that half is skipped there.
      if (ground.backdrop) expect(ground.backdrop, 'the backdrop is not the dialog\'s own ground').toBe(ground.own);
      await shot(page, `${engine.name}-compose-keyboard`, true);
      const words = `Rename the Quiet section to Done? (${engine.name})`;
      await field.fill(words);
      await send.tap();
      await expect(dialog, 'Send did not close New message').toHaveCount(0);
      await expect.poll(() => world.polls[ONE]!.got(words, null), { message: 'the session in To was not handed the message', timeout: 30_000 }).toBe(true);
      await page.context().close();
    });
  });
}

test.describe('Chromium at 1440 x 900 (the desktop)', () => {
  test('none of it applies: the recipient pill, Send with its word, the To line', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const box = pane(page).locator('.ib-rbox');
    for (const thread of [world.oneThread, world.twoThread]) {
      await page.goto(`${world.url}#thread=${thread}`);
      await pane(page).locator('.ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ }).first().click();
      await expect(box.locator('[data-reply-send]')).toBeVisible();
      if (thread === world.oneThread) await expect(box.locator('[data-recipient]'), 'a one-agent thread has a recipient pill on the desktop').toHaveCount(0);
    }
    await expect(box.locator('[data-recipient]'), 'the desktop lost its recipient pill').toHaveClass(/(^|\s)ib-rto(\s|$)/);
    await expect(pane(page).locator('.ib-rbox [data-agent-mark], .ib-rbox [data-agent-pill], .ib-sheet'), 'a phone part is drawn on the desktop').toHaveCount(0);
    expect((await box.locator('[data-reply-send] .ib-rsend-w').boundingBox())!.width, 'Send lost its word on the desktop').toBeGreaterThanOrEqual(20);
    await page.locator('[data-open-compose]').first().click();
    const dialog = page.locator('dialog[data-compose]');
    await expect(dialog.locator('.ib-cp-to'), 'the desktop lost its To line').toBeVisible();
    await expect(dialog.locator('[data-compose-pcard]'), 'the phone card is drawn on the desktop').toHaveCount(0);
    await expect(dialog.locator('[data-agent-pill], .ib-sheet'), 'a phone part is drawn in the desktop\'s New message').toHaveCount(0);
  });
});
