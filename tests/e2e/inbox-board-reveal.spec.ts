/**
 * The Board reveal for returning users (approval "inbox-feature-reveal", 2026-11-03), proved in a real Chromium against
 * a compiled binary with a release version (0.30.0): the shared e2e binary is 0.0.0-dev, which never decides a reveal,
 * so the spec compiles its own (as inbox-snooze-intro.spec.ts does). Each case is its own Inbox in a temp data dir,
 * seeded at day 4 with six threads (inbox-board-reveal-seed.ts), Snooze's announcement shown on day 1.5 and the Board
 * never decided (config.json `inboxBoard` unset).
 *
 *  - Desktop: never on load, and no Board row. Past a minute on the page the person reads a thread and closes it: the
 *    Board's own first-visit dialog (BoardIntro) opens, the Board row is in the sidebar with it, and config.json has
 *    the Board on and the first-visit dialog stamped. A second tab reaching its moment shows nothing. Not now closes
 *    it and the Board stays on; the Board's first visit shows no dialog; its "?" opens it again. A reload reaching the
 *    moment again shows nothing.
 *  - A 390 px phone: the same, with the sidebar sheet before and after.
 *
 * Each scene is shot in light and dark (the Inbox follows the system's mode). The page's thresholds are real (60 s,
 * 5 s, 2.5 s). Build the apps first (bun run --cwd apps/review build && bun run build:hook), then `bunx playwright test
 * -c tests/e2e/playwright.config.ts inbox-board-reveal.spec.ts`. PNGs land in PLANNOTATOR_E2E_PROOF_DIR/board-reveal,
 * or .local/proof/board-reveal/.
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
/** Past the page's minute, with room for the list's first read. */
const PAGE_AGE_MS = 57_000;
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
 * An Inbox four days into use: the seeded log, Snooze's announcement shown two and a half days ago (so the 48 h spacing
 * holds), every other one-time dialog and the tour behind the person, the Board never decided, and every agent's home
 * a temp folder. HOME is left as it is (never set).
 */
async function world(): Promise<World> {
  const root = realpathSync(mkdtempSync(join(scratch, 'world-')));
  const dataDir = join(root, 'data');
  const src = join(root, 'src');
  for (const dir of [dataDir, src, join(root, 'claude'), join(root, 'codex'), join(root, 'xdg-config'), join(root, 'xdg-data')]) mkdirSync(dir, { recursive: true });
  const seeded = spawnSync('bun', [join(repo, 'tests/e2e/inbox-board-reveal-seed.ts'), dataDir, src, '4'], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', PLANNOTATOR_DATA_DIR: dataDir } });
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
      inboxListIntro: { shownAt: past },
      inboxVoiceIntro: { shownAt: past },
      inboxSnoozeIntro: { shownAt: snoozeShown },
      inboxReveals: { lastShownAt: snoozeShown },
    }),
  );
  const env = {
    PATH: process.env.PATH ?? '',
    PLANNOTATOR_DATA_DIR: dataDir,
    // A release version: never the live daily ping (packages/shared/daily-ping.ts).
    NO_ANON_PING: '1',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
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

async function context(browser: Browser, phone = false): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
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

test('desktop: never on load; at the calm moment the Board turns on with its first-visit dialog; once, and the Board stays on', async ({ browser }) => {
  test.setTimeout(360_000);
  const w = await world();
  const ctx = await context(browser);
  const [a, b] = await Promise.all([ctx.newPage(), ctx.newPage()]);
  await Promise.all([a.goto(w.url), b.goto(w.url)]);
  await expect(rowOf(a, w.ids['invoice-pdf']!)).toBeVisible();
  await expect(a.locator('[data-board-nav]')).toHaveCount(0);
  await shots(a, 'desktop-{s}-before');
  // A minute on the page: nothing, in either tab, and the Board still undecided.
  await a.waitForTimeout(PAGE_AGE_MS);
  await expect(a.locator(DIALOG)).toHaveCount(0);
  await expect(b.locator(DIALOG)).toHaveCount(0);
  expect(config(w).inboxBoard).toBeUndefined();
  // The moment: a thread read and closed, back to the list.
  await readAndLeave(a, w.ids['invoice-pdf']!);
  await expect(a.locator(DIALOG)).toBeVisible({ timeout: 8_000 });
  // The claim turned the Board on and stamped its first-visit dialog, before the person did anything with it.
  const saved = config(w);
  expect(saved.inboxBoard).toBe(true);
  expect(saved.inboxBoardIntro.shownAt).toBe(saved.inboxReveals.board.shownAt);
  // The Board row arrives with the dialog.
  await expect(a.locator('[data-board-nav]')).toBeVisible();
  await shots(a, 'desktop-{s}-reveal');
  // The second tab reaches its own moment: the Inbox says no.
  await readAndLeave(b, w.ids['refund-window']!);
  await b.waitForTimeout(5_000);
  await expect(b.locator(DIALOG)).toHaveCount(0);
  // Not now: closed, the Board stays on.
  await a.locator('[data-board-intro-close]').click();
  await expect(a.locator(DIALOG)).toHaveCount(0);
  await a.mouse.move(4, 4);
  await shots(a, 'desktop-{s}-after');
  expect(config(w).inboxBoard).toBe(true);
  // The Board: its first visit shows no dialog (the reveal was it); "?" opens it again.
  await a.locator('[data-board-nav]').click();
  await expect(a.locator('[data-board-about]')).toBeVisible();
  await a.waitForTimeout(1_500);
  await expect(a.locator(DIALOG)).toHaveCount(0);
  await a.mouse.move(4, 4);
  await shots(a, 'desktop-{s}-board');
  await a.locator('[data-board-about]').click();
  await expect(a.locator(DIALOG)).toBeVisible();
  await a.keyboard.press('Escape');
  await expect(a.locator(DIALOG)).toHaveCount(0);
  // A reload and the same moment a minute on: never again.
  await a.goto(`${w.url.replace(/#.*$/, '')}`);
  await expect(rowOf(a, w.ids['release-notes']!)).toBeVisible();
  await a.waitForTimeout(PAGE_AGE_MS);
  await readAndLeave(a, w.ids['release-notes']!);
  await a.waitForTimeout(5_000);
  await expect(a.locator(DIALOG)).toHaveCount(0);
  expect(config(w).inboxBoard).toBe(true);
});

test('a 390 px phone: the sidebar sheet before and after, the dialog as a sheet, the Board from the row', async ({ browser }) => {
  test.setTimeout(240_000);
  const w = await world();
  const page = await (await context(browser, true)).newPage();
  await page.goto(w.url);
  await expect(rowOf(page, w.ids['invoice-pdf']!)).toBeVisible();
  await shots(page, 'phone-{s}-before-list');
  await page.locator('[data-sidebar="trigger"]').first().click();
  await expect(page.locator('[data-mobile="true"]')).toBeVisible();
  await expect(page.locator('[data-board-nav]')).toHaveCount(0);
  await shots(page, 'phone-{s}-before');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-mobile="true"]')).toHaveCount(0);
  await page.waitForTimeout(PAGE_AGE_MS);
  await readAndLeave(page, w.ids['invoice-pdf']!, true);
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 8_000 });
  expect(config(w).inboxBoard).toBe(true);
  await shots(page, 'phone-{s}-reveal');
  await page.locator('[data-board-intro-close]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await page.locator('[data-sidebar="trigger"]').first().click();
  await expect(page.locator('[data-board-nav]')).toBeVisible();
  await shots(page, 'phone-{s}-after');
  await page.locator('[data-board-nav]').click();
  await expect(page.locator('[data-board-view="phone"]')).toBeVisible();
  await page.waitForTimeout(1_500);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await shots(page, 'phone-{s}-board');
});
