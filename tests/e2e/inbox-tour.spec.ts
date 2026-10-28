/**
 * The onboarding tour, version 2 (approval "inbox-onboarding-tour"), proved in
 * a real browser against the compiled binary: `plannotator inbox --background`
 * under a temp PLANNOTATOR_DATA_DIR, a scratch HOME and a PATH of the system's
 * own tools only (no agent CLI is ever run), notifications recorded by an init
 * script.
 *
 *  - The walk on a desktop through the Inbox's real viewers: a pick, a comment
 *    on the question's words, a comment on a line of EVALUATION.md, one Send,
 *    the replay, a circle on a screenshot, Artifacts, the film commented at a
 *    moment, compose to a session, and the person's own Inbox at step 10. Every
 *    comment box opens with the developer's real comment; nothing is written
 *    but the tour setting; the person's list is exactly as it was. Shots light
 *    and dark, one headless video.
 *  - Keyboard only; an iPhone in WebKit (taps, 44 px targets, the film
 *    comment); reduced motion and a stacked window.
 *  - Exit at steps 1 to 8 gives the Inbox back as it was; a real message
 *    mid-tour is a chip; Back never reopens the tour; step 9 counts as
 *    finished.
 *  - The fixture routes: read only, the film by Range, the notes as text.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * Shots and the video go to PLANNOTATOR_TOUR_SHOTS (default .local/proof/tour).
 */
import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_TOUR_SHOTS ?? join(repo, '.local/proof/tour'));
const DESKTOP = { width: 1440, height: 900 };

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
}

function startWorld(name: string): World {
  const root = inboxScratch(`plannotator-tour-${name}-`);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  for (const dir of [home, dataDir]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {
    // The system's own tools only: never the agents installed on the machine running the spec.
    PATH: '/usr/bin:/bin',
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  return { root, dataDir, env, url: started.stdout.trim() };
}

/** An agent writes to the person's Inbox through the real stdio entry. */
async function agentWrites(w: World, body: string, subject: string): Promise<string> {
  const agent = await SimAgent.connect({ binary, env: w.env, name: 'Claude Code', host: 'claude-code' });
  try {
    const project = scratchProject(join(w.root, 'src'), 'billing-svc');
    const sent = await agent.send({ project_path: project, body, subject });
    return sent.thread_id as string;
  } finally {
    await agent.close();
  }
}

function config(w: World): Record<string, any> {
  const file = join(w.dataDir, 'config.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

/** The person's list as the server holds it, without what moves on its own. */
async function ownList(w: World): Promise<string> {
  const res = await fetch(new URL('api/inbox/threads', w.url));
  const model = (await res.json()) as Record<string, any>;
  const { cursor: _cursor, serverSession: _session, update: _update, notice: _notice, version: _version, ...rest } = model;
  return JSON.stringify(rest);
}

function recordNotifications(): void {
  const calls: string[] = [];
  (window as unknown as { __calls: string[] }).__calls = calls;
  const Real = window.Notification;
  // iOS Safari has no Notification at all.
  if (!Real) return;
  class Recorded extends Real {
    constructor(title: string, options?: NotificationOptions) {
      super(title, options);
      calls.push(title);
    }
  }
  window.Notification = Recorded as typeof Notification;
}

async function open(
  browser: Browser,
  w: World,
  errors: string[],
  options: Parameters<Browser['newContext']>[0] = {},
  init?: () => void,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: DESKTOP, colorScheme: 'light', ...options });
  await context.addInitScript(recordNotifications);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  // PLANNOTATOR_E2E_CPU_THROTTLE=6: a slow CI runner on a fast laptop (Chromium only).
  const throttle = Number(process.env.PLANNOTATOR_E2E_CPU_THROTTLE ?? '');
  if (throttle > 1 && browser.browserType().name() === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // The Artifacts grid draws an HTML file small in a script-free sandbox (by design): Chromium logs its blocked scripts.
    // WebKit's own video controls (headless) log their icons failing to load: the browser's chrome, not the page.
    if (message.type() === 'error' && !message.text().startsWith("Blocked script execution in 'about:srcdoc'") && !message.text().startsWith('Button failed to load, iconName =')) errors.push(message.text());
  });
  await page.goto(w.url);
  return { context, page };
}

const coach = (page: Page) => page.locator('[data-tour-coach]');
/** A tour started from a screen opens on its first card ("a fresh reminder", 0.28.31): Show me goes to step 1. */
async function pastIntro(page: Page, how: 'click' | 'tap' | 'keys' = 'click') {
  const go = page.locator('[data-tour-intro-go]');
  await expect(page.locator('[data-tour-intro] h2')).toHaveText('The Inbox works beside your agents');
  await expect(page.locator('[data-tour-intro] h2')).toBeFocused();
  await expect(page.locator('[data-tour-exit]')).toBeVisible();
  if (how === 'keys') {
    await page.keyboard.press('Tab');
    await expect(go).toBeFocused();
    await page.keyboard.press('Enter');
  } else if (how === 'tap') await go.tap();
  else await go.click();
  await expect(go).toHaveCount(0);
}
const step = (page: Page) => page.locator('[data-tour-bar] .ib-tour-steps');
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Reads the coach card as a newcomer would: 220 words a minute, then 1.5 s to find the control. */
async function read(page: Page, paced: boolean): Promise<void> {
  if (!paced) return;
  const text = await coach(page).innerText();
  await page.waitForTimeout(Math.round((words(text) / 220) * 60_000) + 1500);
}

/** Time spent taking screenshots, left out of the walk's timings (a newcomer takes none). */
let shooting = 0;

async function shoot(page: Page, name: string, themes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  const began = Date.now();
  try {
    await shootThemes(page, name, themes);
  } finally {
    shooting += Date.now() - began;
  }
}

async function shootThemes(page: Page, name: string, themes: readonly ('light' | 'dark')[]): Promise<void> {
  mkdirSync(shots, { recursive: true });
  // Never a coach card caught in its fade-in, or before it is placed.
  await page.waitForFunction(() => {
    const coach = document.querySelector<HTMLElement>('[data-tour-coach]');
    return !coach || (coach.style.visibility !== 'hidden' && coach.getAnimations().every((a) => a.playState !== 'running'));
  });
  await page.waitForTimeout(250);
  for (const scheme of themes) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForFunction((dark) => document.documentElement.classList.contains('light') !== dark, scheme === 'dark', { timeout: 3000 });
    // Past the theme's 150 ms crossfade and any entrance (WebKit headless can leave a colour transition mid-way).
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        try {
          a.finish();
        } catch {
          // An endless animation (the Tater sprite, a spinner) has no end to finish at.
        }
      }
      // WebKit can keep an inherited colour from before an emulated scheme change: restyle the page once.
      const root = document.getElementById('root') ?? document.body;
      const scrolled = [...document.querySelectorAll<HTMLElement>('*')].filter((el) => el.scrollTop > 0).map((el) => [el, el.scrollTop] as const);
      root.style.display = 'none';
      void root.offsetHeight;
      root.style.display = '';
      for (const [el, top] of scrolled) el.scrollTop = top;
      // The restyle restarts CSS animations (the coach card's entrance): finish them again.
      for (const a of document.getAnimations()) {
        try {
          a.finish();
        } catch {
          // Endless.
        }
      }
    });
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Focus is never left on the page after a step changes. */
async function focusKept(page: Page): Promise<string> {
  const where = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return !el || el === document.body ? 'body' : `${el.tagName.toLowerCase()} ${el.textContent?.trim().slice(0, 40) ?? ''}`;
    });
  // Within a few frames of the change (the screen that took the control's place renders first), and still held a
  // moment later: focus on a control that is about to go would pass the first look and then drop to the page.
  await expect.poll(where, { timeout: 3000 }).not.toBe('body');
  await page.waitForTimeout(600);
  await expect.poll(where, { timeout: 3000 }).not.toBe('body');
  return where();
}

test.beforeAll(() => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
});
test.afterAll(async () => {
  await removeInboxScratch();
});

/** A press: a tap on a phone, a click otherwise. */
type Press = (selector: string) => Promise<void>;

function presser(page: Page, phone: boolean): Press {
  return async (selector) => {
    const el = page.locator(selector).filter({ visible: true }).first();
    if (phone) await el.tap();
    else await el.click();
  };
}

/** Select words the way a drag does, so the viewer's selection toolbar opens over them. */
async function selectWords(page: Page, rootSel: string, phrase: string): Promise<void> {
  await page.evaluate(
    ({ rootSel, phrase }) => {
      const root = document.querySelector(rootSel)!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let all = '';
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        nodes.push(t as Text);
        all += (t as Text).data;
      }
      const at = all.indexOf(phrase);
      if (at < 0) throw new Error(`"${phrase}" is not on screen`);
      let off = 0;
      const range = document.createRange();
      for (const node of nodes) {
        const end = off + node.data.length;
        if (at >= off && at < end) range.setStart(node, at - off);
        if (at + phrase.length > off && at + phrase.length <= end) {
          range.setEnd(node, at + phrase.length - off);
          break;
        }
        off = end;
      }
      (range.startContainer.parentElement as HTMLElement).scrollIntoView({ block: 'center' });
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      const r = range.getBoundingClientRect();
      range.startContainer.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.right, clientY: r.bottom }));
      document.dispatchEvent(new Event('selectionchange'));
    },
    { rootSel, phrase },
  );
}

const PHRASE = 'a 2-day check that hover feels instant';
const EV_LINE = 'It is also the cheapest direction, because the reader and its hooks already exist.';
const toolbarComment = '[data-pn-annotation-toolbar-row] button[aria-label="Comment"]';

interface WalkOptions {
  phone?: boolean;
  /** Called at each place worth a picture, with its name. */
  shot?: (name: string) => Promise<void>;
  /** What each comment box opened with, in order. */
  suggestions?: string[];
}

/**
 * From the tour's first card to step `to` (1 to 9), doing each step's real action and keeping every
 * suggestion the boxes open with. Step 9 is the person's own Inbox.
 */
async function walk(page: Page, to: number, options: WalkOptions = {}): Promise<void> {
  const phone = options.phone ?? false;
  const press = presser(page, phone);
  const shot = options.shot ?? (async () => {});
  const at = (key: string) => expect(coach(page)).toHaveAttribute('data-tour-coach', key, { timeout: 15_000 });
  const keep = async (selector: string) => options.suggestions?.push(await page.locator(selector).first().inputValue());
  await at('1-orient');
  await shot('01-orient');
  await press('[data-tour-next]');
  await at('1');
  await shot('01-row');
  if (to === 1) return;
  await press('[data-thread-id="tour-vscode"]:is(button,a,[role=button])');
  // Crawl: a plain question first, and the "Your turn" cue on the card.
  await at('2');
  await expect(coach(page).locator('[data-tour-your-turn]')).toBeVisible();
  await shot('02-plain');
  if (to === 2) return;
  await page.locator('[data-tour-message="warm"] input[type=radio]').first().click({ force: true });
  await at('2-send');
  await shot('02-send');
  await press('[data-tour-warm-send]');
  // Walk: the answer arrives with picture choices and the files (the rich message).
  await at('3');
  await expect(page.locator('[data-tour-message="ask"] [data-question-tiles]')).toBeVisible();
  await expect(page.locator('[data-tour-message="ask"] .ib-att-t[data-attachment-name="d1-clean.png"]')).toBeVisible();
  await shot('03-pictures');
  if (to === 3) return;
  await page.locator('[data-tour-message="ask"] input[type=radio]').first().click({ force: true });
  await at('4');
  await shot('04-words');
  if (to === 4) return;
  await selectWords(page, '[data-tour-message="ask"] .ib-body', PHRASE);
  await page.locator(toolbarComment).first().click();
  await at('4-box');
  await keep('[data-comment-popover] textarea');
  await shot('04-comment');
  await page.locator('[data-comment-popover] button', { hasText: 'Save' }).click();
  await at('5');
  await shot('05-file-tile');
  if (to === 5) return;
  await press('[data-tour-thread] .ib-attachments:not(.ib-hatts-tiles) [data-attachment-name="EVALUATION.md"]');
  await at('5-file');
  await shot('05-file');
  await selectWords(page, '[data-attachment-pane] .ib-docscroll', EV_LINE);
  await page.locator(toolbarComment).first().click();
  await at('5-box');
  await keep('[data-comment-popover] textarea');
  await shot('05-comment');
  await page.locator('[data-comment-popover] button', { hasText: 'Save' }).click();
  await at('6');
  await shot('06-reply');
  if (to === 6) return;
  await press('[data-tour-reply]');
  await at('6-box');
  await shot('06-recap');
  await press('[data-tour-send]');
  await at('7');
  await shot('07-replay');
  if (to === 7) return;
  await press('[data-tour-thread] img[data-inline-image="tour-img-built-a1"]');
  await at('7-file');
  await keep('[data-image-composer] textarea');
  await shot('07-screenshot');
  // Mark up: a circle on the screenshot.
  await press('[data-attachment-pane] [data-markup-open]');
  await page.waitForTimeout(600);
  const circle = page.locator('button[title*="ircle" i], button[aria-label*="ircle" i]').first();
  if (await circle.count()) await circle.click();
  const canvas = (await page.locator('canvas').last().boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width * 0.3, canvas.y + canvas.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * 0.55, canvas.y + canvas.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await shot('07-markup');
  // Enter adds the drawing (with the suggestion's words in the box) to the reply at once.
  await page.keyboard.press('Enter');
  await at('7-drawn');
  await shot('07-circled');
  await press('[data-tour-next]');
  await at('7-art');
  await press('[data-tour-thread] [data-artifacts-button]');
  await at('7-art-grid');
  await shot('07-artifacts');
  await page.locator('[data-artifacts-view] [data-artifact-kind="markdown"]').first().click();
  await at('7-art-open');
  await press('[data-tour-next]');
  await at('8-open');
  await shot('08-film-row');
  if (to === 8) return;
  await press('[data-thread-id="tour-film"]:is(button,a,[role=button])');
  await at('8');
  await press('[data-tour-thread] .ib-attachments:not(.ib-hatts-tiles) [data-attachment-name="guides-vscode.mp4"]');
  await at('8-file');
  await page.waitForTimeout(600);
  // The film really plays (from the asset route, by Range): its clock moves.
  await page.evaluate(async () => {
    const v = document.querySelector<HTMLVideoElement>('[data-video-player]')!;
    v.muted = true;
    await v.play();
  });
  await expect.poll(() => page.locator('[data-video-player]').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.5);
  // Then a pause near the chapter text: the comment box fills and the moment pins.
  await page.evaluate(async () => {
    const v = document.querySelector<HTMLVideoElement>('[data-video-player]')!;
    v.currentTime = 7.2;
    await new Promise((r) => setTimeout(r, 400));
    v.pause();
  });
  if (phone) await press('[data-video-compose]');
  await at('8-pinned');
  await keep('[data-video-composer] textarea');
  await shot('08-film');
  await page.locator('[data-video-comment-save]').click();
  await at('8-send');
  await press('[data-tour-film-send]');
  await at('8-done');
  await shot('08-answer');
  await press('[data-tour-next]');
  await at('9');
  await shot('09-compose-button');
  if (to === 9) return;
  await press('[data-open-compose]');
  await at('9-open');
  // Compose is modal, but the tour bar stays in view above it and its Exit is pressable.
  await expect(page.locator('[data-tour-bar-over] [data-tour-exit]')).toBeVisible();
  const barBox = (await page.locator('[data-tour-bar-over]').boundingBox())!;
  expect(barBox.y).toBe(0);
  if (phone) expect((await page.locator('dialog[data-compose]').boundingBox())!.y).toBeGreaterThanOrEqual(barBox.height - 1);
  expect(
    await page.evaluate(() => {
      const exit = document.querySelector<HTMLElement>('[data-tour-bar-over] [data-tour-exit]')!;
      const r = exit.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === exit;
    }),
  ).toBe(true);
  await keep('[data-compose] textarea');
  await shot('09-compose');
  await press('[data-compose] [data-compose-to]');
  await page.locator('[role="option"]').first().click();
  await at('9-to');
  await press('[data-compose] [data-compose-send]');
  await at('9-loop');
  await shot('09-answer');
  await press('[data-tour-next]');
  await at('9-also');
  await shot('09-also');
  await press('[data-tour-next]');
  await expect(page.locator('[data-tour-exit="finish"]')).toBeVisible();
  await shot('10-yours');
}

/** Routes the tour may ask for: its own read-only routes, the window's reads, the `tour` setting and the window's presence report. */
function writesOf(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' || r.method() === 'HEAD') return;
    const path = new URL(r.url()).pathname;
    if (path === '/api/inbox/window') return;
    writes.push(`${r.method()} ${path} ${r.postData()?.slice(0, 120) ?? ''}`);
  });
  return writes;
}

const SUGGESTIONS = [
  'Good. If hover isn’t instant, tell me before you build B.',
  'Nice, reusing the reader’s hooks keeps this small.',
  'Looks great. This screenshot should go on the site.',
  'Make chapter one taller here. It’s the narrative guide, and it’s easy to miss.',
  'We need a page and a short film for Guided Reviews in VS Code, like plannotator.ai/inbox.',
];

test('the walk on a desktop: the real viewers, compose and Artifacts; writes nothing; the person’s Inbox exactly as it was; light and dark shots', async ({ browser }) => {
  const w = startWorld('walk');
  const errors: string[] = [];
  const { context, page } = await open(browser, w, errors, { recordVideo: { dir: join(shots, 'video'), size: DESKTOP } });
  const writes = writesOf(page);
  const before = await ownList(w);
  await expect(page.getByRole('heading', { name: 'Two ways to start' })).toBeVisible();
  await shoot(page, 'desktop-00-entry');
  await page.locator('[data-tour-start]').click();
  await shoot(page, 'desktop-00-intro');
  await pastIntro(page);
  const suggestions: string[] = [];
  const began = Date.now();
  shooting = 0;
  await walk(page, 10, { suggestions, shot: (name) => shoot(page, `desktop-${name}`) });
  const seconds = (Date.now() - began - shooting) / 1000;
  expect(suggestions).toEqual(SUGGESTIONS);
  // Nothing of the tour reached the server but the tour setting.
  expect(writes.filter((r) => !r.startsWith('POST /api/inbox/settings'))).toEqual([]);
  for (const r of writes) expect(r).toContain('"tour"');
  expect(existsSync(join(w.dataDir, 'inbox', 'markups'))).toBe(false);
  expect(existsSync(join(w.dataDir, 'inbox', 'uploads'))).toBe(false);
  expect(existsSync(join(w.dataDir, 'inbox', 'drafts'))).toBe(false);
  expect(await ownList(w)).toBe(before);
  await page.locator('[data-tour-exit="finish"]').click();
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await expect.poll(() => config(w).inboxTour?.finished_at ?? null).not.toBeNull();
  expect(errors).toEqual([]);
  await context.close();
  const video = readdirSync(join(shots, 'video')).find((f) => f.endsWith('.webm'));
  if (video) copyFileSync(join(shots, 'video', video), join(shots, 'desktop-walk.webm'));
  console.log(`desktop walk, without shots: ${seconds.toFixed(1)} s`);
});

test('keyboard only: Tab and Enter through the coach cards, focus never on the page', async ({ browser }) => {
  const w = startWorld('keys');
  const errors: string[] = [];
  const { context, page } = await open(browser, w, errors);
  await page.locator('[data-tour-start]').focus();
  await page.keyboard.press('Enter');
  await pastIntro(page, 'keys');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '1-orient');
  await focusKept(page);
  // Next by keyboard: Tab from the card's heading reaches it.
  for (let i = 0; i < 6 && !(await page.locator('[data-tour-next]').evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(page.locator('[data-tour-next]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '1');
  await focusKept(page);
  // The thread's row by keyboard.
  await page.locator('[data-thread-id="tour-vscode"]').first().focus();
  await page.keyboard.press('Enter');
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '2');
  await focusKept(page);
  expect(errors).toEqual([]);
  await context.close();
});

test('Fast-forward on every step lands on its end state, writing nothing; a click the tour cannot use is answered, never ignored', async ({ browser }) => {
  const w = startWorld('forward');
  const errors: string[] = [];
  const { context, page } = await open(browser, w, errors);
  const writes = writesOf(page);
  const before = await ownList(w);
  await page.locator('[data-tour-start]').click();
  await pastIntro(page);
  // The opener has Next, no Fast-forward; a click on its picture goes on (it is never dead).
  await expect(page.locator('[data-tour-forward]')).toHaveCount(0);
  await page.locator('[data-tour-orient]').click();
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '1');
  await expect(coach(page).locator('[data-tour-your-turn]')).toHaveText('Your turn');
  // A click on the card's own words points at its target again.
  await coach(page).locator('h2').click();
  await expect(page.locator('.ib-tour-again')).toHaveCount(1);
  // The step's end, then the next step's card, for every step to 9; then step 9's end is the loop.
  const ends: Record<number, string> = { 1: '2', 2: '3', 3: '4', 4: '5', 5: '6', 6: '7', 7: '8-open', 8: '9' };
  for (let n = 1; n <= 8; n++) {
    await expect(step(page)).toHaveAttribute('aria-label', `Step ${n} of 10`);
    await page.locator('[data-tour-forward]').click();
    await expect(coach(page), `after step ${n}`).toHaveAttribute('data-tour-coach', ends[n]!);
    await focusKept(page);
    if (n === 2) {
      // The rich message is there: the picture question above its files.
      await expect(page.locator('[data-tour-message="ask"] [data-question-tiles]')).toBeVisible();
      await expect(page.locator('[data-tour-message="ask"] .ib-att-t[data-attachment-name="d1-clean.png"]')).toBeVisible();
    }
    if (n === 3) {
      // The step's end state: the real answer picked; Mark read is not part of the tour, and says so.
      await page.locator('[data-tour-thread] .ib-phead button[aria-disabled="true"]').first().click({ force: true });
      await expect(page.locator('[data-tour-nudge]')).toContainText('after the tour');
      // A sent card answers a click too, once the walk is past it.
      await page.locator('[data-tour-message="warm"] .question-block label').first().dispatchEvent('click');
      await expect(page.locator('[data-tour-nudge]')).toContainText('sent already');
    }
  }
  // New message before step 9 says when; on 9 it opens compose, whose own coach can fast-forward too.
  await page.locator('[data-open-compose]').first().click();
  await expect(page.locator('dialog[data-compose]')).toBeVisible();
  await page.locator('[data-compose] [data-tour-forward]').click();
  await expect(page.locator('dialog[data-compose]')).toHaveCount(0);
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '9-loop');
  await expect(page.locator('[data-tour-forward]')).toHaveCount(0);
  await page.locator('[data-tour-next]').click();
  await page.locator('[data-tour-next]').click();
  await expect(step(page)).toHaveAttribute('aria-label', 'Step 10 of 10');
  expect(writes.filter((r) => !r.startsWith('POST /api/inbox/settings'))).toEqual([]);
  expect(await ownList(w)).toBe(before);
  expect(errors).toEqual([]);
  await context.close();
});

test('New message before step 9 is answered, not ignored', async ({ browser }) => {
  const w = startWorld('early-compose');
  const errors: string[] = [];
  const { context, page } = await open(browser, w, errors);
  await page.locator('[data-tour-start]').click();
  await pastIntro(page);
  await page.locator('[data-tour-next]').click();
  await page.locator('[data-open-compose]').first().click();
  await expect(page.locator('dialog[data-compose]')).toHaveCount(0);
  await expect(page.locator('[data-tour-nudge]')).toContainText('step 9');
  expect(errors).toEqual([]);
  await context.close();
});

test('an iPhone in WebKit: taps, 44 px targets, the film comment at a moment; light and dark shots', async () => {
  const w = startWorld('phone');
  const errors: string[] = [];
  const browser = await webkit.launch({ args: [] });
  try {
    const { context, page } = await open(browser, w, errors, { ...devices['iPhone 15'], colorScheme: 'light' });
    const writes = writesOf(page);
    const before = await ownList(w);
    await expect(page.getByRole('heading', { name: 'Two ways to start' })).toBeVisible();
    await shoot(page, 'phone-00-entry');
    // The hit area: the box, and the ::before / ::after a small control reaches out with.
    const big = async (selector: string) => {
      // Measured once the coach card has finished its entrance (it rises from 0.97 scale).
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || (a.effect as KeyframeEffect | null)?.getComputedTiming().iterations === Infinity));
      const hit = await page.locator(selector).filter({ visible: true }).first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        let w = r.width;
        let h = r.height;
        for (const pseudo of ['::before', '::after']) {
          const s = getComputedStyle(el, pseudo);
          if (s.content === 'none' || s.position !== 'absolute') continue;
          w = Math.max(w, r.width - parseFloat(s.left) - parseFloat(s.right));
          h = Math.max(h, r.height - parseFloat(s.top) - parseFloat(s.bottom));
        }
        return { w, h };
      });
      expect(hit.h, selector).toBeGreaterThanOrEqual(44);
      expect(hit.w, selector).toBeGreaterThanOrEqual(44);
    };
    await page.locator('[data-tour-start]').tap();
    await shoot(page, 'phone-00-intro');
    await pastIntro(page, 'tap');
    await big('[data-tour-exit]');
    await big('[data-tour-next]');
    const suggestions: string[] = [];
    await walk(page, 10, {
      phone: true,
      suggestions,
      shot: async (name) => {
        if (name === '02-plain') await big('[data-tour-forward]');
        // The sheet never covers what it points at: the question's prompt, and the first row of pictures with its labels and
        // magnifiers, stay clear of it (on a phone four pictures are two rows, taller than the screen; the second is a scroll away).
        if (name === '02-plain' || name === '03-pictures') {
          await page.waitForTimeout(800);
          const sheet = (await coach(page).boundingBox())!;
          const card = name === '02-plain' ? '[data-tour-message="warm"]' : '[data-tour-message="ask"]';
          const parts = [`${card} [data-question-part="prompt"]`, name === '02-plain' ? `${card} input[type="radio"]` : `${card} [data-question-zoom]`];
          for (const sel of parts) {
            const all = await page.locator(sel).evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => ({ top: r.top, bottom: r.bottom })));
            const firstRow = Math.min(...all.map((r) => r.top));
            const boxes = all.filter((r) => Math.abs(r.top - firstRow) < 4);
            expect(boxes.length, `${name}: ${sel}`).toBeGreaterThan(0);
            for (const b of boxes) expect(b.bottom <= sheet.y || b.top >= sheet.y + sheet.height, `${name}: ${sel} under the sheet ${JSON.stringify({ b, sheet })}`).toBe(true);
          }
        }
        if (name === '02-send') await big('[data-tour-warm-send]');
        if (name === '06-reply') await big('[data-tour-reply]');
        if (name === '08-answer') await big('[data-tour-next]');
        await shoot(page, `phone-${name}`);
      },
    });
    expect(suggestions).toEqual(SUGGESTIONS);
    expect(writes.filter((r) => !r.startsWith('POST /api/inbox/settings'))).toEqual([]);
    expect(await ownList(w)).toBe(before);
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('reduced motion: no pulse, a shorter replay; a stacked window: the thread covers the list, the file covers the thread', async ({ browser }) => {
  const w = startWorld('reduced');
  const errors: string[] = [];
  const { context, page } = await open(browser, w, errors, { reducedMotion: 'reduce', viewport: { width: 900, height: 800 } });
  await page.getByRole('button', { name: 'Start the tour' }).click();
  await pastIntro(page);
  await page.locator('[data-tour-next]').click();
  await expect(page.locator('.ib-tour-target')).toHaveCount(1);
  expect(await page.locator('.ib-tour-target').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.locator('[data-thread-id="tour-vscode"]').first().click();
  // Stacked: the thread covers the list, its way back leads.
  await expect(page.locator('.ib-listcol')).toHaveCount(0);
  await expect(page.locator('[data-tour-thread-back]')).toBeVisible();
  await page.locator('[data-tour-message="warm"] input[type=radio]').first().click({ force: true });
  const warmSent = Date.now();
  await page.locator('[data-tour-warm-send]').filter({ visible: true }).first().click();
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '3');
  expect(Date.now() - warmSent).toBeLessThan(2600);
  await page.locator('[data-tour-message="ask"] input[type=radio]').first().click({ force: true });
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '4');
  await selectWords(page, '[data-tour-message="ask"] .ib-body', PHRASE);
  await page.locator(toolbarComment).first().click();
  await page.locator('[data-comment-popover] button', { hasText: 'Save' }).click();
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '5');
  await page.locator('[data-tour-thread] .ib-attachments:not(.ib-hatts-tiles) [data-attachment-name="EVALUATION.md"]').click();
  // Stacked: the file covers the thread.
  await expect(page.locator('[data-attachment-pane]')).toBeVisible();
  await shoot(page, 'stacked-05-file', ['light']);
  await selectWords(page, '[data-attachment-pane] .ib-docscroll', EV_LINE);
  await page.locator(toolbarComment).first().click();
  await page.locator('[data-comment-popover] button', { hasText: 'Save' }).click();
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '6');
  await page.locator('[data-tour-reply]').filter({ visible: true }).first().click();
  const sent = Date.now();
  await page.locator('[data-tour-send]').filter({ visible: true }).first().click();
  await expect(page.locator('[data-tour-arrival="2"]')).toBeVisible();
  expect(Date.now() - sent).toBeLessThan(5600);
  expect(errors).toEqual([]);
  await context.close();
});

test('Exit at every step gives the person’s Inbox back exactly as it was; a real message mid-tour is a chip, never a notification', async ({ browser }) => {
  const w = startWorld('exit');
  // A returning person: one real thread, waiting on them.
  const threadId = await agentWrites(w, 'Which retry policy for the export job?\n\n:::question\nWhich retry policy?\n- [ ] Exponential\n- [ ] Fixed\n:::', 'Export job retries');
  const errors: string[] = [];
  const { context, page } = await open(browser, w, errors);
  const writes = writesOf(page);
  await expect(page.locator(`[data-thread-id="${threadId}"]`).first()).toBeVisible();
  const before = await ownList(w);
  // Returning people take the tour from Settings → General.
  const enter = async () => {
    await page.goto(`${w.url}#settings/general`);
    await page.locator('[data-settings-take-tour]').click();
    await expect(page).toHaveURL(/#tour=1$/);
    await pastIntro(page);
  };
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    await enter();
    await walk(page, n);
    await expect(step(page)).toHaveAttribute('aria-label', `Step ${n} of 10`);
    await page.locator('[data-tour-exit="exit"]').click();
    await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
    // Started in Settings: Exit returns to Settings, as the browser's Back (no new entry).
    await expect(page).toHaveURL(/#settings\/general$/);
    await expect(page.locator('[data-settings-take-tour]')).toBeVisible();
    await focusKept(page);
    expect(await ownList(w), `after Exit at step ${n}`).toBe(before);
  }
  // Exit with compose open (a modal dialog): the bar's copy over it ends the tour and closes compose.
  await enter();
  await walk(page, 9);
  await page.locator('[data-open-compose]').first().click();
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '9-open');
  await page.locator('[data-tour-bar-over] [data-tour-exit="exit"]').click();
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await expect(page.locator('dialog[data-compose]')).toHaveCount(0);
  await expect(page).toHaveURL(/#settings\/general$/);
  await focusKept(page);
  expect(await ownList(w), 'after Exit from compose').toBe(before);
  expect(writes.filter((r) => !r.startsWith('POST /api/inbox/settings'))).toEqual([]);
  expect(config(w).inboxTour.skipped_at).toBeTruthy();

  // A real message lands mid-tour: a chip in the bar, the tour goes on, no notification and no sound.
  await enter();
  await page.locator('[data-tour-next]').click();
  await page.locator('[data-thread-id="tour-vscode"]').first().click();
  const arrived = await agentWrites(w, 'Build finished: the export job retries now.', 'Export job: build finished');
  await expect(page.locator('[data-tour-arrivals]')).toHaveText('1 new message in your Inbox', { timeout: 10_000 });
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '2');
  expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toEqual([]);
  await shoot(page, 'chip-mid-tour', ['light']);
  await page.locator('[data-tour-arrivals]').click();
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`thread=${arrived}`));
  expect(errors).toEqual([]);
  await context.close();
});

test('leaving by the chip or the tour sidebar’s Settings: Back never reopens the tour; a tour reached by a link forgets an earlier start point', async ({ browser }) => {
  const w = startWorld('leave');
  const first = await agentWrites(w, 'A first real message.', 'First one');
  const errors: string[] = [];
  const { context, page } = await open(browser, w, errors);
  const fromSettings = async () => {
    await page.goto(`${w.url}#settings/general`);
    await page.locator('[data-settings-take-tour]').click();
    await expect(page).toHaveURL(/#tour=1$/);
    await pastIntro(page);
  };
  const neverTheTour = async () => {
    await page.goBack();
    await page.waitForTimeout(400);
    await expect(page).not.toHaveURL(/#tour/);
    await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  };

  // The chip: the new thread takes the tour's entry; Back goes to Settings, where the tour started.
  await fromSettings();
  const arrived = await agentWrites(w, 'Build finished.', 'Build finished');
  await page.locator('[data-tour-arrivals]').click();
  await expect(page).toHaveURL(new RegExp(`thread=${arrived}`));
  await neverTheTour();

  // The tour sidebar's Settings: the same.
  await fromSettings();
  await page.locator('.ib-setrow .ib-nav').click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await neverTheTour();

  // A tour reached by a link after one started from Settings: Exit goes to the Inbox, not to that old start point.
  await fromSettings();
  await page.locator('[data-tour-exit="exit"]').click();
  await expect(page).toHaveURL(/#settings\/general$/);
  await page.goto(`${w.url}#tour=2`);
  await expect(page.locator('[data-tour-coach]')).toHaveAttribute('data-tour-coach', '2');
  await page.locator('[data-tour-exit="exit"]').click();
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await expect(page).not.toHaveURL(/#settings/);
  await expect(page.locator(`[data-thread-id="${first}"]`).first()).toBeVisible();
  await focusKept(page);
  expect(errors).toEqual([]);
  await context.close();
});

test('step 10 and after a reload: every way out leaves the tour behind; from step 10 it counts as finished, How to allow opens Settings → General', async ({ browser }) => {
  const w = startWorld('step9');
  const first = await agentWrites(w, 'A first real message.', 'First one');
  const errors: string[] = [];
  // The browser blocked notifications for this address: step 10 offers How to allow.
  const { context, page } = await open(browser, w, errors, {}, () => {
    if (window.Notification) Object.defineProperty(window.Notification, 'permission', { get: () => 'denied' });
  });
  const fromSettings = async () => {
    await page.goto(`${w.url}#settings/general`);
    await page.locator('[data-settings-take-tour]').click();
    await expect(page).toHaveURL(/#tour=1$/);
    await pastIntro(page);
  };
  // Reached by its address: step 10 is the person's own Inbox, whatever came before.
  const toStep9 = async () => {
    // In the tour's own history entry, as a step change is.
    await page.evaluate(() => {
      location.replace('#tour=10');
    });
    await expect(step(page)).toHaveAttribute('aria-label', 'Step 10 of 10');
  };
  const neverTheTour = async () => {
    await page.goBack();
    await page.waitForTimeout(400);
    await expect(page).not.toHaveURL(/#tour/);
    await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  };
  const inAppBack = async (selector: string) => {
    await page.locator(selector).click();
    await page.waitForTimeout(400);
    await expect(page).not.toHaveURL(/#tour/);
    await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  };
  const finishedAt = () => config(w).inboxTour?.finished_at ?? null;

  await fromSettings();
  await toStep9();
  const before = finishedAt();
  await page.getByRole('button', { name: 'How to allow' }).click();
  await expect(page).toHaveURL(/#settings\/general$/);
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await expect.poll(finishedAt).not.toBe(before);
  await focusKept(page);
  await inAppBack('[data-settings-back]');
  await neverTheTour();

  for (const row of ['[data-inbox-nav]', '.ib-setrow .ib-nav']) {
    await fromSettings();
    await toStep9();
    const was = finishedAt();
    await page.locator(row).first().click();
    await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
    await expect(page).not.toHaveURL(/#tour/);
    await expect.poll(finishedAt).not.toBe(was);
    if (row.includes('setrow')) {
      await expect(page).toHaveURL(/#settings/);
      await inAppBack('[data-settings-back]');
    }
    await neverTheTour();
  }

  // A reload forgets where the tour started: Exit goes to the Inbox, in the tour's own entry.
  await fromSettings();
  await page.locator('[data-tour-next]').click();
  await page.locator('[data-thread-id="tour-vscode"]').first().click();
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '2');
  await page.reload();
  await expect(coach(page)).toHaveAttribute('data-tour-coach', '2');
  await page.locator('[data-tour-exit="exit"]').click();
  await expect(page.locator('[data-tour-bar]')).toHaveCount(0);
  await expect(page.locator(`[data-thread-id="${first}"]`).first()).toBeVisible();
  await focusKept(page);
  await neverTheTour();
  expect(errors).toEqual([]);
  await context.close();
});

test('the fixture routes: read only, embedded in the binary, the film by range, the notes as plain text, nothing outside the manifest', async () => {
  const w = startWorld('routes');
  const fixture = await fetch(new URL('api/inbox/tour/fixture.json', w.url));
  expect(fixture.status).toBe(200);
  expect(((await fixture.json()) as { v: number }).v).toBe(2);
  const mock = await fetch(new URL('api/inbox/tour/assets/vscode-mockups.html', w.url));
  expect(mock.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
  expect(mock.headers.get('content-security-policy')).not.toContain('allow-same-origin');
  expect(mock.headers.get('x-content-type-options')).toBe('nosniff');
  const notes = await fetch(new URL('api/inbox/tour/assets/evaluation.md', w.url));
  expect(notes.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(notes.headers.get('content-security-policy')).toContain('sandbox');
  const film = new URL('api/inbox/tour/assets/film-clip.mp4', w.url);
  const range = await fetch(film, { headers: { range: 'bytes=0-1023' } });
  expect(range.status).toBe(206);
  expect(range.headers.get('content-type')).toBe('video/mp4');
  expect(range.headers.get('content-range')).toMatch(/^bytes 0-1023\/\d+$/);
  expect((await range.arrayBuffer()).byteLength).toBe(1024);
  expect((await fetch(film, { headers: { range: 'bytes=99999999-' } })).status).toBe(416);
  const picture = await fetch(new URL('api/inbox/tour/assets/vs-a.webp', w.url));
  expect(picture.headers.get('content-type')).toBe('image/webp');
  const etag = picture.headers.get('etag')!;
  expect((await fetch(new URL('api/inbox/tour/assets/vs-a.webp', w.url), { headers: { 'if-none-match': etag } })).status).toBe(304);
  for (const bad of ['api/inbox/tour/assets/..%2F..%2Fconfig.json', 'api/inbox/tour/assets/inbox.json', 'api/inbox/tour/assets/graphite-inbox.webp', 'api/inbox/tour/other']) {
    expect((await fetch(new URL(bad, w.url))).status, bad).toBe(404);
  }
  expect((await fetch(new URL('api/inbox/tour/fixture.json', w.url), { method: 'POST' })).status).toBe(405);
  expect((await fetch(new URL('api/inbox/tour/fixture.json', w.url), { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  const html = await (await fetch(w.url)).text();
  expect(html).not.toContain('Honestly I’m just struggling with this UX');
  const content = join(repo, 'packages/inbox/tour/content');
  for (const name of readdirSync(content).filter((n) => n !== 'README')) {
    const path = name === 'fixture.json' ? 'api/inbox/tour/fixture.json' : `api/inbox/tour/assets/${name}`;
    const served = Buffer.from(await (await fetch(new URL(path, w.url))).arrayBuffer());
    expect(served.equals(readFileSync(join(content, name))), name).toBe(true);
  }
});
