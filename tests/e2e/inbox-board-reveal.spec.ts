/**
 * The Board reveal for returning users (approval "inbox-feature-reveal", 2026-11-03), proved in a real Chromium against
 * a compiled binary with a release version (0.30.0): the shared e2e binary is 0.0.0-dev, which never decides a reveal,
 * so the spec compiles its own (as inbox-snooze-intro.spec.ts does). Each case is its own Inbox in a temp data dir,
 * seeded at day 4 with six threads (inbox-board-reveal-seed.ts), Snooze's announcement shown on day 1.5 and the Board
 * never decided (config.json `inboxBoard` unset).
 *
 * Reveals are opt-in (the owner, 2026-11-04): showing the dialog turns nothing on.
 *
 *  - Desktop: never on load, and no Board row; a thread read and closed on a page younger than a minute shows nothing
 *    and stamps nothing. Past a minute on the page the person reads a thread and closes it: the Board's own
 *    first-visit dialog (BoardIntro) opens as an offer (Not now, Turn it on), config.json has the reveal stamped (never
 *    the Board's welcome) and the Board still unset, and there is no Board row. A second tab reaching its moment shows
 *    nothing. Not now closes it and the Board stays off (unset, no row). A reload reaching the moment again shows
 *    nothing.
 *  - A 390 px phone: the dialog as a sheet, Turn it on on top; Turn it on writes the Board on and its row is in the
 *    sidebar sheet, and at once in a desktop tab open beside it (settings sync everywhere: `event: capabilities`); the
 *    Board's first visit shows its welcome with Copy prompt once (the owner, 2026-11-04), never again.
 *
 * Each scene is shot in light and dark (the Inbox follows the system's mode). The read and settling times are real
 * (5 s, 2.5 s). The page's minute is on the page's own clock: the gate reads `Date.now()` in the page, so each context
 * installs Playwright's clock before its pages load (it then runs in real time) and a case fast-forwards it a minute
 * instead of waiting one out. Every time the spec reads from the Inbox (config.json stamps, the seeded days) is the
 * Inbox's own, never the page's. Build the apps first (bun run --cwd apps/review build && bun run build:hook), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-board-reveal.spec.ts`. PNGs land in
 * PLANNOTATOR_E2E_PROOF_DIR/board-reveal, or .local/proof/board-reveal/.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'board-reveal');
const VERSION = '0.30.0';
const DIALOG = '[data-dialog="board-intro"]';
const DAY = 24 * 3600_000;
/** The page's minute, on the page's clock (fast-forwarded, never waited out). */
const PAGE_AGE_MS = 60_000;
/** Past the 5 s read. */
const READ_MS = 5_600;

let binary = '';
let scratch = '';
const contexts: BrowserContext[] = [];

interface World {
  url: string;
  dataDir: string;
  ids: Record<string, string>;
}

function compileReleaseBinary(): string {
  const out = join(scratch, 'bin', 'plannotator');
  const built = spawnSync(
    'bun',
    ['build', 'apps/hook/server/index.ts', '--compile', '--no-compile-autoload-bunfig', '--define', `__CLI_VERSION__="${VERSION}"`, '--outfile', out],
    { cwd: repo, encoding: 'utf8', timeout: 180_000 },
  );
  expect(built.status, built.stderr).toBe(0);
  return out;
}

/**
 * An Inbox four days into use: the seeded log, Snooze's announcement shown two and a half days ago (so the spacing
 * holds), every other one-time dialog and the tour behind the person, the Board never decided, and every agent's home
 * a temp folder. HOME is the world's temp folder.
 */
async function world(): Promise<World> {
  const root = realpathSync(mkdtempSync(join(scratch, 'world-')));
  const dataDir = join(root, 'data');
  const src = join(root, 'src');
  for (const dir of [dataDir, src, join(root, 'claude'), join(root, 'codex'), join(root, 'xdg-config'), join(root, 'xdg-data')]) mkdirSync(dir, { recursive: true });
  const seeded = spawnSync('bun', [join(repo, 'tests/e2e/inbox-board-reveal-seed.ts'), dataDir, src, '4'], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir } });
  expect(seeded.status, seeded.stderr).toBe(0);
  const ids = JSON.parse(seeded.stdout.trim()) as Record<string, string>;
  const past = '2026-10-01T10:00:00.000Z';
  const snoozeShown = new Date(Date.now() - 2.5 * DAY).toISOString();
  writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ inboxVersion: VERSION }));
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      inboxTour: { version: 2, seen_at: past, skipped_at: past },
      inboxNotifications: { dismissed: true },
      inboxAgentNotes: { offered: true, asked: ['claude-code', 'codex', 'opencode', 'pi', 'gemini', 'qwen', 'cursor'] },
      inboxSound: { dialogShownFor: VERSION },
      inboxListIntro: { shownAt: past, version: 2 },
      inboxVoiceIntro: { shownAt: past },
      // The tab icon dialog (an update-day dialog): settled by a favicon already chosen.
      favicon: 'glass',
      inboxSnoozeIntro: { shownAt: snoozeShown },
      inboxReveals: { lastShownAt: snoozeShown },
    }),
  );
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    // A release version: never the live daily ping (packages/shared/daily-ping.ts).
    NO_ANON_PING: '1',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    // HOME is this world's temp folder: the sandbox keeps this Inbox out of any real skill folder.
    PLANNOTATOR_TEST_SANDBOX: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  expect(url).not.toContain(':59812');
  rememberInboxOf(dataDir);
  return { url, dataDir, ids };
}

const config = (w: World) => JSON.parse(readFileSync(join(w.dataDir, 'config.json'), 'utf8')) as Record<string, any>;

/**
 * This spec proves the leave moment ("back on the list"), so the page is never idle (idleClock.ts: 20 s without input
 * is also the moment, and Playwright tells every page it is focused): a pointer move every 3 s, from the first paint.
 */
const neverIdle = () => {
  setInterval(() => window.dispatchEvent(new Event('pointermove')), 3_000);
};

async function context(browser: Browser, phone = false): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  // Before any page loads: the reveal's page age is the page's `Date.now()`, so the minute can be fast-forwarded.
  await ctx.clock.install();
  await ctx.addInitScript(neverIdle);
  contexts.push(ctx);
  return ctx;
}

/** The scene in light, then in dark (the Inbox follows the system's mode), then back to light. */
async function shots(page: Page, name: string) {
  // "Inbox updated to 0.30.0": this spec's release binary carries apps built as dev, so the page says it is older.
  // Not this feature's; hidden (never clicked: with a dialog open a click there is a click outside).
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-stale-page]')) el.style.display = 'none';
  });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(proofDir, `${name.replace('{s}', scheme)}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const rowOf = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`).first();

/** Open a thread from the list, read it past the read time, and go back to the list. */
async function readAndLeave(page: Page, id: string, phone = false) {
  await rowOf(page, id).click();
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await page.waitForTimeout(READ_MS);
  await page.locator(phone ? '[data-phone-back]' : 'button[aria-label="Close the thread"]').first().click();
  await expect(page.locator('section.ib-pane')).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run --cwd apps/review build && bun run build:hook)').toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  scratch = inboxScratch('plannotator-inbox-board-reveal-');
  binary = compileReleaseBinary();
});

test.afterAll(async () => {
  try {
    for (const ctx of contexts) await ctx.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('desktop: never on load; at the calm moment the first-visit dialog offers the Board and turns nothing on; Not now leaves it off; once', async ({ browser }) => {
  test.setTimeout(360_000);
  const w = await world();
  const ctx = await context(browser);
  const [a, b] = await Promise.all([ctx.newPage(), ctx.newPage()]);
  await Promise.all([a.goto(w.url), b.goto(w.url)]);
  await expect(rowOf(a, w.ids['invoice-pdf']!)).toBeVisible();
  await expect(a.locator('[data-board-nav]')).toHaveCount(0);
  await shots(a, 'desktop-{s}-before');
  // The moment on a page younger than a minute: a thread read and closed, and the page may not claim it yet.
  await readAndLeave(a, w.ids['invoice-pdf']!);
  await a.waitForTimeout(5_000);
  await expect(a.locator(DIALOG)).toHaveCount(0);
  expect(config(w).inboxReveals.board).toBeUndefined();
  // A minute on the page: nothing, in either tab (one context, one clock), and the Board still undecided.
  await ctx.clock.fastForward(PAGE_AGE_MS);
  await expect(a.locator(DIALOG)).toHaveCount(0);
  await expect(b.locator(DIALOG)).toHaveCount(0);
  expect(config(w).inboxBoard).toBeUndefined();
  // The moment: a thread read and closed, back to the list.
  await readAndLeave(a, w.ids['invoice-pdf']!);
  await expect(a.locator(DIALOG)).toBeVisible({ timeout: 8_000 });
  // The claim stamped the reveal, never the Board's welcome, and turned nothing on.
  const saved = config(w);
  expect(saved.inboxBoard).toBeUndefined();
  expect(saved.inboxReveals.board.shownAt).toMatch(/^\d{4}-/);
  expect(saved.inboxBoardIntro).toBeUndefined();
  await expect(a.locator('[data-board-nav]')).toHaveCount(0);
  await expect(a.locator(`${DIALOG} [data-board-intro-close]`)).toHaveText('Not now');
  await expect(a.locator(`${DIALOG} [data-board-intro-on]`)).toHaveText('Turn it on');
  await expect(a.locator(`${DIALOG} [data-board-intro-copy]`)).toHaveCount(0);
  // No line about the prompt in the offer (there is no Copy prompt to point at).
  await expect(a.locator(`${DIALOG} .ib-bi-q`)).toHaveCount(0);
  await shots(a, 'desktop-{s}-reveal');
  // The second tab reaches its own moment: the Inbox says no.
  await readAndLeave(b, w.ids['refund-window']!);
  await b.waitForTimeout(5_000);
  await expect(b.locator(DIALOG)).toHaveCount(0);
  // Not now: closed, the Board stays off (unset), no row.
  await a.locator('[data-board-intro-close]').click();
  await expect(a.locator(DIALOG)).toHaveCount(0);
  await a.mouse.move(4, 4);
  await shots(a, 'desktop-{s}-after');
  expect(config(w).inboxBoard).toBeUndefined();
  await expect(a.locator('[data-board-nav]')).toHaveCount(0);
  // A reload and the same moment a minute on: never again.
  await a.goto(`${w.url.replace(/#.*$/, '')}`);
  await expect(rowOf(a, w.ids['release-notes']!)).toBeVisible();
  await a.clock.fastForward(PAGE_AGE_MS);
  await readAndLeave(a, w.ids['release-notes']!);
  await a.waitForTimeout(5_000);
  await expect(a.locator(DIALOG)).toHaveCount(0);
  expect(config(w).inboxBoard).toBeUndefined();
});

test('a 390 px phone: the dialog as a sheet; Turn it on writes the Board on, its row in the sidebar sheet and a desktop tab, the welcome on the first visit', async ({ browser }) => {
  test.setTimeout(240_000);
  const w = await world();
  const page = await (await context(browser, true)).newPage();
  // A desktop tab open beside the phone: it hears the switch live, with no reload.
  const desk = await (await context(browser, false)).newPage();
  await desk.goto(w.url);
  await expect(rowOf(desk, w.ids['invoice-pdf']!)).toBeVisible();
  await expect(desk.locator('[data-board-nav]')).toHaveCount(0);
  await page.goto(w.url);
  await expect(rowOf(page, w.ids['invoice-pdf']!)).toBeVisible();
  await shots(page, 'phone-{s}-before-list');
  await page.locator('[data-sidebar="trigger"]').first().click();
  await expect(page.locator('[data-mobile="true"]')).toBeVisible();
  await expect(page.locator('[data-board-nav]')).toHaveCount(0);
  await shots(page, 'phone-{s}-before');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-mobile="true"]')).toHaveCount(0);
  await page.clock.fastForward(PAGE_AGE_MS);
  await readAndLeave(page, w.ids['invoice-pdf']!, true);
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 8_000 });
  expect(config(w).inboxBoard).toBeUndefined();
  // Stacked, the primary on top.
  const on = await page.locator('[data-board-intro-on]').boundingBox();
  const not = await page.locator('[data-board-intro-close]').boundingBox();
  expect(on!.y).toBeLessThan(not!.y);
  await shots(page, 'phone-{s}-reveal');
  await page.locator('[data-board-intro-on]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect.poll(() => config(w).inboxBoard).toBe(true);
  await expect(desk.locator('[data-board-nav]')).toBeVisible({ timeout: 5_000 });
  await page.locator('[data-sidebar="trigger"]').first().click();
  await expect(page.locator('[data-board-nav]')).toBeVisible();
  await shots(page, 'phone-{s}-after');
  await page.locator('[data-board-nav]').click();
  await expect(page.locator('[data-board-view="phone"]')).toBeVisible();
  // The first visit: the welcome, with Copy prompt (the offer had none).
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(`${DIALOG} [data-board-intro-copy]`)).toBeVisible();
  await expect(page.locator(`${DIALOG} [data-board-intro-on]`)).toHaveCount(0);
  await shots(page, 'phone-{s}-welcome');
  await page.locator('[data-board-intro-close]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(config(w).inboxBoardIntro.shownAt).toMatch(/^\d{4}-/);
  await shots(page, 'phone-{s}-board');
  // The desktop tab's first visit: the welcome was this machine's, once.
  await desk.locator('[data-board-nav]').click();
  await desk.waitForTimeout(1_500);
  await expect(desk.locator(DIALOG)).toHaveCount(0);
});
