/**
 * Phone panels close by a swipe that starts inside them and moves outward (a flick, or a slow drag past the line),
 * reopen where they were left, never open from the page edge, and leave vertical scrolling to the list. Plan
 * (annotate) and code review, in Chromium (real touches through the DevTools protocol) and WebKit (touch events as
 * iOS sends them). A desktop pass checks nothing of it reaches a wide window. Pictures land in
 * $PLANNOTATOR_E2E_PROOF_DIR/compact-panel-swipe (default .local/proof).
 */
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch, scratchEnv } from './inbox-scratch';

type Engine = 'chromium' | 'webkit';
const repoRoot = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repoRoot, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repoRoot, '.local/proof')), 'compact-panel-swipe');
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const FIRST_RUN: Record<string, string> = {
  'plannotator-announce-agent-tool-seen': '1',
  'plannotator-announce-ask-session-seen': '1',
  'plannotator-announce-inbox-seen': '1',
  'plannotator-announce-tui-herdr-seen': '1',
  'plannotator-auto-viewed-notice-seen': '1',
  'plannotator-edit-mode-announcement-seen': '3',
  'plannotator-guide-hint-acked': 'true',
  'plannotator-guide-intro-seen': '2',
  'plannotator-look-feel-announcement-seen': '2',
  'plannotator-plan-look-choice-resolved': 'true',
  'plannotator-review-dest-spotlight-seen': '1',
  'plannotator-token-hover-announcement-seen': '1',
};

/** Counts touchmoves the page cancelled, and the touch listeners left on the document. */
const WATCH = () => {
  const w = window as unknown as { __prevented: number; __touchListeners: Set<unknown> };
  w.__prevented = 0;
  w.__touchListeners = new Set();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const key = (type: string, fn: unknown, opts: unknown) =>
    `${type}|${typeof opts === 'boolean' ? opts : !!(opts as { capture?: boolean } | undefined)?.capture}`;
  const ids = new WeakMap<object, number>();
  let next = 0;
  const id = (fn: unknown) => {
    if (!fn || typeof fn !== 'object' && typeof fn !== 'function') return 0;
    if (!ids.has(fn as object)) ids.set(fn as object, ++next);
    return ids.get(fn as object)!;
  };
  EventTarget.prototype.addEventListener = function (type: string, fn: never, opts?: never) {
    if (this === document && type.startsWith('touch')) w.__touchListeners.add(`${key(type, fn, opts)}|${id(fn)}`);
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type: string, fn: never, opts?: never) {
    if (this === document && type.startsWith('touch')) w.__touchListeners.delete(`${key(type, fn, opts)}|${id(fn)}`);
    return remove.call(this, type, fn, opts);
  };
  window.addEventListener('touchmove', (event) => { if (event.defaultPrevented) w.__prevented++; }, { passive: true });
};

interface Finger {
  down(x: number, y: number): Promise<void>;
  move(dx: number, dy: number, moves: number, waitMs: number): Promise<void>;
  up(): Promise<void>;
  flick?(x: number, y: number, dx: number, dy: number): Promise<void>;
}

async function finger(page: Page, engine: Engine): Promise<Finger> {
  if (engine === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    let at = { x: 0, y: 0 };
    // Each event carries its own time (a second behind the clock, 16 ms or the wait apart): the page reads a flick's
    // speed from event.timeStamp, and the protocol delivers a move about every 50 ms, slower than any real flick.
    let clock = 0;
    const tick = (ms: number, sync = false) => (clock = sync ? Math.max(clock + ms / 1000, Date.now() / 1000 - 1) : clock + ms / 1000);
    return {
      async down(x, y) {
        at = { x, y };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at], timestamp: tick(50, true) });
      },
      async move(dx, dy, moves, waitMs) {
        const from = at;
        for (let i = 1; i <= moves; i++) {
          at = { x: from.x + (dx * i) / moves, y: from.y + (dy * i) / moves };
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at], timestamp: tick(waitMs || 16) });
          if (waitMs) await page.waitForTimeout(waitMs);
        }
      },
      async up() {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: tick(16) });
      },
    };
  }
  return {
    async down(x, y) {
      await page.evaluate(({ x, y }) => {
        let target = document.elementFromPoint(x, y)!;
        while (target.shadowRoot) {
          const inner = target.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === target) break;
          target = inner;
        }
        const w = window as unknown as { __finger: { target: Element; x: number; y: number; fire: (type: string) => void } };
        const state = { target, x, y, fire: (type: string) => {
          const point = { identifier: 1, clientX: state.x, clientY: state.y, pageX: state.x, pageY: state.y, screenX: state.x, screenY: state.y, target };
          const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
          Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
          Object.defineProperty(event, 'targetTouches', { value: type === 'touchend' ? [] : [point] });
          Object.defineProperty(event, 'changedTouches', { value: [point] });
          target.dispatchEvent(event);
        } };
        w.__finger = state;
        state.fire('touchstart');
      }, { x, y });
    },
    async move(dx, dy, moves, waitMs) {
      await page.evaluate(async ({ dx, dy, moves, waitMs }) => {
        const f = (window as unknown as { __finger: { x: number; y: number; fire: (type: string) => void } }).__finger;
        const from = { x: f.x, y: f.y };
        for (let i = 1; i <= moves; i++) {
          f.x = from.x + (dx * i) / moves;
          f.y = from.y + (dy * i) / moves;
          f.fire('touchmove');
          if (waitMs) await new Promise((done) => setTimeout(done, waitMs));
        }
      }, { dx, dy, moves, waitMs });
    },
    async up() {
      await page.evaluate(() => (window as unknown as { __finger: { fire: (type: string) => void } }).__finger.fire('touchend'));
    },
    // One script for the whole flick: separate round trips can leave more than the 100 ms a flick's speed is read over.
    async flick(x, y, dx, dy) {
      await page.evaluate(async ({ x, y, dx, dy }) => {
        let target = document.elementFromPoint(x, y)!;
        while (target.shadowRoot) {
          const inner = target.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === target) break;
          target = inner;
        }
        const fire = (type: string, px: number, py: number) => {
          const point = { identifier: 1, clientX: px, clientY: py, pageX: px, pageY: py, screenX: px, screenY: py, target };
          const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
          Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
          Object.defineProperty(event, 'targetTouches', { value: type === 'touchend' ? [] : [point] });
          Object.defineProperty(event, 'changedTouches', { value: [point] });
          target.dispatchEvent(event);
        };
        fire('touchstart', x, y);
        for (let i = 1; i <= 3; i++) {
          await new Promise((done) => setTimeout(done, 8));
          fire('touchmove', x + (dx * i) / 3, y + (dy * i) / 3);
        }
        fire('touchend', x + dx, y + dy);
      }, { x, y, dx, dy });
    },
  };
}

/** A slow drag (about 0.1 px/ms) or a flick (no waits: well over 0.5 px/ms). */
async function swipe(f: Finger, x: number, y: number, dx: number, dy: number, kind: 'slow' | 'flick') {
  if (kind === 'flick' && f.flick) return f.flick(x, y, dx, dy);
  await f.down(x, y);
  if (kind === 'slow') await f.move(dx, dy, Math.max(8, Math.round(Math.hypot(dx, dy) / 3)), 30);
  else await f.move(dx, dy, 3, 0);
  await f.up();
}

/** Scroll a list: a real vertical finger drag in Chromium; in WebKit, whose touches here are synthetic, the list's own scrollTop. */
async function scrollList(page: Page, engine: Engine, list: Locator, f: Finger, by: number) {
  const box = (await list.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height - 20, 520);
  if (engine === 'chromium') {
    await f.down(x, y);
    await f.move(0, -Math.min(by, y - box.y - 20), 20, 16);
    await f.up();
  } else {
    await list.evaluate((el, by) => { el.scrollTop += by; }, by);
  }
  await page.waitForTimeout(300);
}

const scrollTop = (el: Locator) => el.evaluate((node) => node.scrollTop);
const prevented = (page: Page) => page.evaluate(() => (window as unknown as { __prevented: number }).__prevented);
const touchListeners = (page: Page) => page.evaluate(() => (window as unknown as { __touchListeners: Set<string> }).__touchListeners.size);
const resetPrevented = (page: Page) => page.evaluate(() => { (window as unknown as { __prevented: number }).__prevented = 0; });
const left = async (el: Locator) => Math.round((await el.boundingBox())?.x ?? NaN);

/** Swipes from the page's left and right edges with nothing open: nothing opens and no move is cancelled (Back and Forward stay the browser's). */
async function edgeSwipesOpenNothing(page: Page, f: Finger, panels: Locator[]) {
  await resetPrevented(page);
  await swipe(f, 4, 420, 170, 0, 'slow');
  await swipe(f, 386, 420, -170, 0, 'slow');
  await swipe(f, 2, 300, 120, 0, 'flick');
  await swipe(f, 388, 300, -120, 0, 'flick');
  await page.waitForTimeout(250);
  for (const panel of panels) await expect(panel).toHaveCount(0);
  expect(await prevented(page)).toBe(0);
}

function shot(page: Page, engine: Engine, name: string) {
  mkdirSync(proofDir, { recursive: true });
  return page.screenshot({ path: join(proofDir, `${engine}-${name}.png`) });
}

async function startServer(args: string[], cwd: string, env: NodeJS.ProcessEnv, readyFile: string) {
  const child = spawn(binary, args, { cwd, stdio: 'ignore', env });
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
  return { child, url };
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  // inbox-guard: own annotate/review child, never an Inbox.
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
}

async function phonePage(browser: Browser, url: string, options: Parameters<Browser['newContext']>[0] = {}) {
  const context = await browser.newContext({ ...PHONE, ...options });
  await context.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url })));
  await context.addInitScript(WATCH);
  return context.newPage();
}

test('plan: navigator, Options and Annotations close by an outward swipe, reopen in place, and the page edge opens nothing', async ({ browser, browserName }) => {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  const engine = browserName as Engine;
  const root = inboxScratch('plannotator-panel-swipe-');
  const doc = join(root, 'long.md');
  writeFileSync(doc, '# Field notes\n\n' + Array.from({ length: 70 }, (_, i) =>
    `## Section ${i + 1}\n\n${'Placeholder text for a long made-up document. '.repeat(30)}\n\n`).join(''));
  const ready = join(root, 'ready.jsonl');
  let child: ChildProcess | undefined;
  try {
    const started = await startServer(['annotate', doc], root, {
      ...process.env, ...scratchEnv(root), PLANNOTATOR_TEST_SANDBOX: '1', PLANNOTATOR_READY_FILE: ready,
      PLANNOTATOR_REMOTE: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_CONNECT: '0',
    }, ready);
    child = started.child;
    const page = await phonePage(browser, started.url);
    await page.goto(started.url);
    await expect(page.locator('article')).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const f = await finger(page, engine);
    const navigator = page.locator('#pn-compact-plan-navigator');
    const options = page.getByRole('dialog', { name: 'Options', exact: true });
    const annotations = page.locator('#pn-compact-plan-annotations');
    const openNavigator = () => page.locator('#pn-compact-plan-navigator-trigger').evaluate((el) => (el as HTMLButtonElement).click());
    const baseline = await touchListeners(page);

    await edgeSwipesOpenNothing(page, f, [navigator, options, annotations]);

    await openNavigator();
    await expect(navigator).toBeVisible();
    await page.waitForTimeout(250);
    const list = navigator.locator('nav[aria-label="Table of contents"]').locator('..');
    await scrollList(page, engine, list, f, 900);
    const saved = await scrollTop(list);
    expect(saved).toBeGreaterThan(200);
    // A vertical drag, even a little sideways, is the list's: the navigator stays.
    await swipe(f, 200, 600, -30, -220, 'slow');
    await expect(navigator).toHaveAttribute('data-pn-panel-state', 'open');
    const kept = await scrollTop(list);

    // Short of a third of the width, a slow drag springs back.
    await swipe(f, 300, 400, -100, 0, 'slow');
    await page.waitForTimeout(300);
    await expect(navigator).toHaveAttribute('data-pn-panel-state', 'open');
    await expect.poll(() => left(navigator)).toBe(0);

    // The navigator follows the finger, and closes past the line.
    await f.down(320, 400);
    await f.move(-120, 0, 12, 20);
    await expect.poll(() => left(navigator)).toBeLessThanOrEqual(-110);
    await shot(page, engine, 'plan-navigator-mid-swipe');
    await f.move(-80, 0, 8, 20);
    await f.up();
    await expect(navigator).toHaveCount(0);

    await openNavigator();
    await expect(navigator).toBeVisible();
    await expect.poll(() => scrollTop(list)).toBeGreaterThan(kept - 4);
    expect(Math.abs((await scrollTop(list)) - kept)).toBeLessThanOrEqual(4);
    await page.waitForTimeout(250);
    await shot(page, engine, 'plan-navigator-reopened-at-position');

    // A short fast flick closes it too.
    await swipe(f, 300, 400, -60, 0, 'flick');
    await expect(navigator).toHaveCount(0);

    // Options: a slow drag of 30 px stays; 70 px closes; a 45 px flick closes.
    const burger = page.getByRole('button', { name: 'Options', exact: true });
    await burger.click();
    await expect(options).toBeVisible();
    let box = (await options.boundingBox())!;
    await swipe(f, box.x + 40, box.y + 40, 30, 0, 'slow');
    await page.waitForTimeout(200);
    await expect(options).toBeVisible();
    await swipe(f, box.x + 40, box.y + 40, 70, 0, 'slow');
    await expect(options).toHaveCount(0);
    await burger.click();
    await expect(options).toBeVisible();
    box = (await options.boundingBox())!;
    await swipe(f, box.x + 40, box.y + 40, 45, 0, 'flick');
    await expect(options).toHaveCount(0);

    // Annotations: vertical stays, outward closes.
    await burger.click();
    await options.getByText('Annotations', { exact: true }).click();
    await expect(annotations).toBeVisible();
    await page.waitForTimeout(250);
    await swipe(f, 200, 500, 20, -250, 'slow');
    await expect(annotations).toHaveAttribute('data-pn-panel-state', 'open');
    await swipe(f, 120, 500, 90, 0, 'slow');
    await expect(annotations).toHaveCount(0);

    // An inward swipe on an open right panel does nothing.
    await burger.click();
    await options.getByText('Annotations', { exact: true }).click();
    await expect(annotations).toBeVisible();
    await swipe(f, 300, 500, -150, 0, 'slow');
    await expect(annotations).toHaveAttribute('data-pn-panel-state', 'open');
    await page.getByRole('button', { name: 'Close Annotations', exact: true }).click();
    await expect(annotations).toHaveCount(0);

    // Everything closed: the lock is gone and no touch listener was left behind.
    await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-pn-panel-scroll-lock'))).toBe(false);
    expect(await touchListeners(page)).toBe(baseline);
    await edgeSwipesOpenNothing(page, f, [navigator, options, annotations]);
    await page.context().close();

    // Reduced motion: no sliding, no following, and the drag still closes.
    const still = await phonePage(browser, started.url, { reducedMotion: 'reduce' });
    await still.goto(started.url);
    await expect(still.locator('article')).toBeVisible();
    const g = await finger(still, engine);
    const nav = still.locator('#pn-compact-plan-navigator');
    await still.locator('#pn-compact-plan-navigator-trigger').evaluate((el) => (el as HTMLButtonElement).click());
    await expect(nav).toBeVisible();
    expect(await nav.evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s/);
    await g.down(320, 400);
    await g.move(-120, 0, 12, 20);
    expect(await left(nav)).toBe(0);
    await g.up();
    await expect(nav).toHaveCount(0, { timeout: 150 });
    await still.context().close();

    // Desktop: none of it.
    const wide = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await wide.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url: started.url })));
    const desk = await wide.newPage();
    await desk.goto(started.url);
    await expect(desk.locator('article')).toBeVisible();
    await desk.getByRole('button', { name: 'Options', exact: true }).click();
    await expect(desk.locator('[data-pn-dismissable-popover="true"]')).toBeVisible();
    await expect(desk.getByRole('dialog', { name: 'Options', exact: true })).toHaveCount(0);
    expect(await desk.locator('[data-pn-panel-side]').count()).toBe(0);
    expect(await desk.evaluate(() => document.documentElement.hasAttribute('data-pn-panel-scroll-lock'))).toBe(false);
    await wide.close();
  } finally {
    await stop(child);
    await removeInboxScratch(root);
  }
});

function ownPath(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const tool of ['git', 'rg']) {
    const found = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, tool)).find((file) => {
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
    if (found) symlinkSync(found, join(bin, tool));
  }
  return [bin, '/usr/bin', '/bin'].join(delimiter);
}

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A made-up repository: docs and vendor folders nobody changed, and a branch of 40 commits each touching its own module. */
function buildRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  write(repo, 'ORCHARD.md', '# Orchard\n');
  for (let i = 0; i < 30; i++) write(repo, `docs/guides/guide-${String(i).padStart(2, '0')}.md`, `# Guide ${i}\n`);
  for (let i = 0; i < 12; i++) write(repo, `lib/util-${i}/index.ts`, `export const util${i} = ${i};\n`);
  for (let i = 0; i < 40; i++) write(repo, `src/mod-${String(i).padStart(2, '0')}/index.ts`, `export const mod${i} = ${i};\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  git(repo, ['checkout', '-q', '-b', 'feature/orchard']);
  for (let i = 0; i < 40; i++) {
    write(repo, `src/mod-${String(i).padStart(2, '0')}/index.ts`, `export const mod${i} = ${i + 100};\n`);
    git(repo, ['commit', '-qam', `Change module ${i}`]);
  }
  return repo;
}

interface Review {
  page: Page;
  f: Finger;
  repo: string;
  sheet: Locator;
  sidebar: Locator;
  openSheet(): Promise<void>;
  closeSheet(): Promise<void>;
  showAllFiles(): Promise<Locator>;
}

/** One review session per test on its own made-up repository, opened at phone width (the sheet opens on load). */
async function withReview(browser: Browser, browserName: string, body: (review: Review, engine: Engine) => Promise<void>) {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  const engine = browserName as Engine;
  const root = inboxScratch('plannotator-review-swipe-');
  const repo = buildRepo(root);
  const ready = join(root, 'ready.jsonl');
  let child: ChildProcess | undefined;
  try {
    const started = await startServer(['review'], repo, {
      PATH: ownPath(root), HOME: root, PLANNOTATOR_TEST_SANDBOX: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
      PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_READY_FILE: ready, PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_SKIP_BROWSER_OPEN: '1', NO_BROWSER, PLANNOTATOR_REMOTE: '0', PLANNOTATOR_UPDATE_CHECK: '0',
    }, ready);
    child = started.child;
    const page = await phonePage(browser, started.url);
    await page.goto(started.url);
    const f = await finger(page, engine);
    const sheet = page.locator('[data-pn-review-transient-overlay][aria-label="Review navigation"]');
    const sidebar = page.locator('[data-pn-review-transient-overlay][aria-label="Review sidebar"]');
    await expect(sheet).toHaveAttribute('data-pn-panel-state', 'open');
    await page.waitForTimeout(300);
    const review: Review = {
      page, f, repo, sheet, sidebar,
      async openSheet() {
        await page.getByRole('button', { name: 'Open review navigation', exact: true }).click();
        await expect(sheet).toHaveAttribute('data-pn-panel-state', 'open');
        await page.waitForTimeout(300);
      },
      async closeSheet() {
        await page.getByRole('button', { name: 'Close review navigation', exact: true }).click();
        await expect(sheet).toHaveCount(0);
      },
      async showAllFiles() {
        await sheet.locator('[data-tree-scope="all"]').click();
        const tree = sheet.locator('[data-repo-file-tree]');
        await expect(tree).toBeVisible();
        return tree;
      },
    };
    await body(review, engine);
    await page.context().close();
  } finally {
    await stop(child);
    await removeInboxScratch(root);
  }
}

/** Sets a list's offset as a finger or wheel would leave it, and returns where it settled. */
async function scrollTo(page: Page, list: Locator, to: number) {
  await list.evaluate((el, to) => { el.scrollTop = to; }, to);
  await page.waitForTimeout(250);
  return scrollTop(list);
}

/** Waits for a list to stop moving (a touch scroll can fling on). */
async function settled(page: Page, list: Locator) {
  let last = await scrollTop(list);
  await expect.poll(async () => {
    await page.waitForTimeout(150);
    const now = await scrollTop(list);
    const still = now === last;
    last = now;
    return still;
  }).toBe(true);
  return last;
}

async function expectNear(list: Locator, at: number) {
  await expect.poll(() => scrollTop(list)).toBeGreaterThan(at - 4);
  expect(Math.abs((await scrollTop(list)) - at)).toBeLessThanOrEqual(4);
}

const repoFolder = (tree: Locator, path: string) => tree.locator(`[data-item-path="${path}/"]`);

test('code review: the sheet follows the finger, closes past the line, and Changes reopens where it was', async ({ browser, browserName }) => {
  await withReview(browser, browserName, async ({ page, f, sheet, openSheet, closeSheet }, engine) => {
    await f.down(330, 520);
    await f.move(-120, 0, 12, 20);
    await expect.poll(() => left(sheet)).toBeLessThanOrEqual(-110);
    await shot(page, engine, 'review-sheet-mid-swipe');
    await f.move(-110, 0, 8, 20);
    await f.up();
    await expect(sheet).toHaveCount(0);

    await openSheet();
    const changes = sheet.locator('[data-changes-tree] [data-file-tree-virtualized-scroll]');
    expect(await scrollTo(page, changes, 600)).toBeGreaterThan(150);
    // A vertical drag, a little sideways, is the list's.
    await swipe(f, 200, 600, 25, -200, 'slow');
    await expect(sheet).toHaveAttribute('data-pn-panel-state', 'open');
    const kept = await settled(page, changes);
    await closeSheet();
    await openSheet();
    await expectNear(changes, kept);

    // Short of the line, a slow drag springs back; past it, the sheet closes and still reopens in place.
    await swipe(f, 330, 520, -80, 0, 'slow');
    await page.waitForTimeout(300);
    await expect(sheet).toHaveAttribute('data-pn-panel-state', 'open');
    await expect.poll(() => left(sheet)).toBe(0);
    await swipe(f, 330, 520, -230, 0, 'slow');
    await expect(sheet).toHaveCount(0);
    await openSheet();
    await expectNear(changes, kept);
  });
});

test('code review: All files reopens with its folders and place, and a new snapshot forgets the folders', async ({ browser, browserName }) => {
  await withReview(browser, browserName, async ({ page, repo, sheet, openSheet, closeSheet, showAllFiles }, engine) => {
    const tree = await showAllFiles();
    await expect(repoFolder(tree, 'docs')).toHaveAttribute('aria-expanded', 'false');
    await repoFolder(tree, 'docs').click();
    await expect(repoFolder(tree, 'docs')).toHaveAttribute('aria-expanded', 'true');
    await repoFolder(tree, 'docs/guides').click();
    await expect(repoFolder(tree, 'docs/guides')).toHaveAttribute('aria-expanded', 'true');
    const scroller = tree.locator('[data-file-tree-virtualized-scroll]');
    const at = await scrollTo(page, scroller, 400);
    expect(at).toBeGreaterThan(100);
    await shot(page, engine, 'review-all-files-before-close');
    await closeSheet();

    await openSheet();
    await expect(tree).toBeVisible();
    await expectNear(scroller, at);
    await shot(page, engine, 'review-all-files-reopened');
    await scrollTo(page, scroller, 0);
    await expect(repoFolder(tree, 'docs')).toHaveAttribute('aria-expanded', 'true');
    await expect(repoFolder(tree, 'docs/guides')).toHaveAttribute('aria-expanded', 'true');
    await closeSheet();

    write(repo, 'src/mod-00/extra.ts', 'export const extra = true;\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'Add extra']);
    const refresh = page.locator('[data-review-status="stale-diff"] button', { hasText: 'Refresh' });
    await expect(refresh).toBeVisible({ timeout: 30_000 });
    const switched = page.waitForResponse((response) => response.url().includes('/api/diff/switch'));
    await refresh.click();
    await switched;
    await expect(refresh).toHaveCount(0, { timeout: 30_000 });
    await page.waitForTimeout(300);
    await openSheet();
    await expect(sheet.locator('[data-tree-scope="changes"]')).toContainText('41');
    await expect(tree).toBeVisible();
    await scrollTo(page, scroller, 0);
    await expect(repoFolder(tree, 'docs')).toHaveAttribute('aria-expanded', 'false');
  });
});

test('code review: a file picked while All files was away is shown when All files comes back, its folders kept', async ({ browser, browserName }) => {
  await withReview(browser, browserName, async ({ page, sheet, openSheet, closeSheet, showAllFiles }) => {
    const tree = await showAllFiles();
    await repoFolder(tree, 'docs').click();
    await repoFolder(tree, 'docs/guides').click();
    await expect(repoFolder(tree, 'docs/guides')).toHaveAttribute('aria-expanded', 'true');
    const scroller = tree.locator('[data-file-tree-virtualized-scroll]');
    expect(await scrollTo(page, scroller, 400)).toBeGreaterThan(100);
    await sheet.locator('[data-tree-scope="changes"]').click();
    await closeSheet();

    await openSheet();
    await expect(tree).toHaveCount(0);
    const picked = 'src/mod-05/index.ts';
    await sheet.locator(`[data-changes-tree] [data-item-path$="mod-05/index.ts"]`).first().click();
    await page.waitForTimeout(400);
    const stillOpen = page.getByRole('button', { name: 'Close review navigation', exact: true });
    if (await stillOpen.count()) await stillOpen.click();
    await expect(sheet).toHaveCount(0);
    await openSheet();
    await showAllFiles();
    await expect(tree.locator(`[data-item-path="${picked}"]`)).toBeInViewport();
    await scrollTo(page, scroller, 0);
    await expect(repoFolder(tree, 'docs/guides')).toHaveAttribute('aria-expanded', 'true');
  });
});

test('code review: Commits reopens where it was', async ({ browser, browserName }) => {
  await withReview(browser, browserName, async ({ page, sheet, openSheet, closeSheet }) => {
    await sheet.locator('[data-panel-view="commits"]').click();
    await expect(sheet.getByText('Change module 3', { exact: true })).toBeVisible();
    const list = sheet.locator('[data-review-sidebar] > .flex-1.min-h-0');
    const at = await scrollTo(page, list, 700);
    expect(at).toBeGreaterThan(150);
    await closeSheet();
    await openSheet();
    await expectNear(list, at);
  });
});

async function inPageFlick(page: Page, x: number, y: number, dx: number) {
  const webkitStyle = await finger(page, 'webkit');
  await webkitStyle.flick!(x, y, dx, 0);
}

test('code review: a flick inside Changes or All files closes the sheet', async ({ browser, browserName }) => {
  await withReview(browser, browserName, async ({ page, sheet, openSheet, showAllFiles }) => {
    await inPageFlick(page, 330, 520, -110);
    await expect(sheet).toHaveCount(0);
    await openSheet();
    const tree = await showAllFiles();
    await repoFolder(tree, 'docs').click();
    await repoFolder(tree, 'docs/guides').click();
    await scrollTo(page, tree.locator('[data-file-tree-virtualized-scroll]'), 300);
    await inPageFlick(page, 330, 520, -110);
    await expect(sheet).toHaveCount(0);
  });
});

test('code review: the sidebar closes by an outward swipe, and the page edge opens nothing', async ({ browser, browserName }) => {
  await withReview(browser, browserName, async ({ page, f, sheet, sidebar, closeSheet }) => {
    await closeSheet();
    await page.waitForTimeout(300);
    const baseline = await touchListeners(page);
    await edgeSwipesOpenNothing(page, f, [sheet, sidebar]);

    await page.getByRole('button', { name: /^Open comments, AI and agents/ }).click();
    await expect(sidebar).toHaveAttribute('data-pn-panel-state', 'open');
    await page.waitForTimeout(300);
    await swipe(f, 200, 500, 20, -220, 'slow');
    await expect(sidebar).toHaveAttribute('data-pn-panel-state', 'open');
    await swipe(f, 120, 500, 30, 0, 'slow');
    await page.waitForTimeout(200);
    await expect(sidebar).toHaveAttribute('data-pn-panel-state', 'open');
    await swipe(f, 120, 500, 100, 0, 'slow');
    await expect(sidebar).toHaveCount(0);
    await page.getByRole('button', { name: /^Open comments, AI and agents/ }).click();
    await expect(sidebar).toHaveAttribute('data-pn-panel-state', 'open');
    await page.waitForTimeout(300);
    await swipe(f, 120, 500, 60, 0, 'flick');
    await expect(sidebar).toHaveCount(0);

    await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-pn-panel-scroll-lock'))).toBe(false);
    expect(await touchListeners(page)).toBe(baseline);
    await edgeSwipesOpenNothing(page, f, [sheet, sidebar]);
  });
});

test('code review on a desktop: the file tree and sidebar as before, no panel motion, no lock', async ({ browser }) => {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  const root = inboxScratch('plannotator-review-swipe-desk-');
  const repo = buildRepo(root);
  const ready = join(root, 'ready.jsonl');
  let child: ChildProcess | undefined;
  try {
    const started = await startServer(['review'], repo, {
      PATH: ownPath(root), HOME: root, PLANNOTATOR_TEST_SANDBOX: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
      PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_READY_FILE: ready, PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_SKIP_BROWSER_OPEN: '1', NO_BROWSER, PLANNOTATOR_REMOTE: '0', PLANNOTATOR_UPDATE_CHECK: '0',
    }, ready);
    child = started.child;
    const wide = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await wide.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url: started.url })));
    const desk = await wide.newPage();
    await desk.goto(started.url);
    await expect(desk.locator('[data-tree-scope-row]')).toBeVisible();
    await expect(desk.locator('[data-pn-review-transient-overlay]')).toHaveCount(0);
    await desk.getByRole('button', { name: /^Open comments, AI and agents/ }).click();
    await expect(desk.getByRole('button', { name: /^Close comments, AI and agents/ })).toBeVisible();
    expect(await desk.locator('[data-pn-panel-side]').count()).toBe(0);
    expect(await desk.evaluate(() => document.documentElement.hasAttribute('data-pn-panel-scroll-lock'))).toBe(false);
    await desk.getByRole('button', { name: /^Close comments, AI and agents/ }).click();
    await expect(desk.getByRole('button', { name: /^Open comments, AI and agents/ })).toBeVisible({ timeout: 100 });
    await wide.close();
  } finally {
    await stop(child);
    await removeInboxScratch(root);
  }
});
