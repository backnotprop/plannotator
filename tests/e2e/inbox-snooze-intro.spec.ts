/**
 * The one-time Snooze announcement (approval "inbox-snooze-announce", 2026-11-02), proved in a real Chromium against a
 * compiled binary with a release version (0.30.0): the shared e2e binary is 0.0.0-dev, which never decides a one-time
 * dialog, so the spec compiles its own (as inbox-list-intro.spec.ts does). Each case is its own Inbox in a temp data
 * dir (the dialog is once per machine), its event log written three days back before the Inbox starts
 * (inbox-snooze-intro-seed.ts), so the release start's backfill makes it due.
 *
 *  - Never on load: a page open a minute shows nothing. Once the page is past a minute, the person opens a thread that
 *    waits on them, reads it, and closes it: the dialog shows (B "The real menu": their rows, the real Snooze until
 *    menu, the real toast), and the Inbox stamped it before it drew. A second tab reaching the same moment shows
 *    nothing; Got it closes it; a reload reaching the moment again shows nothing.
 *  - Dark: the picture follows the window's mode. Try it opens the real right-click menu of the row just left, on its
 *    times, and snoozes nothing (no snoozes.json, no "snoozed" mark).
 *  - A 390 px phone layout on this computer: the ⋯ sheet's times; Try it opens the thread just left again and its ⋯
 *    sheet on the times, snoozing nothing.
 *
 * The page's thresholds are real (60 s, 5 s, 2.5 s), so each case waits a minute. Build the apps first (bun run --cwd
 * apps/review build && bun run build:hook), then `bunx playwright test -c tests/e2e/playwright.config.ts
 * inbox-snooze-intro.spec.ts`. PNGs land in PLANNOTATOR_E2E_PROOF_DIR/snooze-intro, or .local/proof/snooze-intro/.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'snooze-intro');
const VERSION = '0.30.0';
const DIALOG = '[data-dialog="snooze-intro"]';
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
 * An Inbox three days into use: the seeded log, every other one-time dialog and the tour already behind the person (so
 * nothing else shows on these loads), and every agent's home a temp folder. HOME is the world's temp folder.
 */
async function world(): Promise<World> {
  const root = realpathSync(mkdtempSync(join(scratch, 'world-')));
  const dataDir = join(root, 'data');
  const src = join(root, 'src');
  for (const dir of [dataDir, src, join(root, 'claude'), join(root, 'codex'), join(root, 'xdg-config'), join(root, 'xdg-data')]) mkdirSync(dir, { recursive: true });
  const seeded = spawnSync('bun', [join(repo, 'tests/e2e/inbox-snooze-intro-seed.ts'), dataDir, src, '3'], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir } });
  expect(seeded.status, seeded.stderr).toBe(0);
  const ids = JSON.parse(seeded.stdout.trim()) as Record<string, string>;
  const past = '2026-10-01T10:00:00.000Z';
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

function saved(w: World): { firstUseAt?: string; snoozedAt?: string; shownAt?: string } | undefined {
  return JSON.parse(readFileSync(join(w.dataDir, 'config.json'), 'utf8')).inboxSnoozeIntro;
}

async function context(browser: Browser, options: { phone?: boolean; dark?: boolean } = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: options.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: options.phone ? 3 : 2,
    colorScheme: options.dark ? 'dark' : 'light',
    ...(options.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  contexts.push(ctx);
  return ctx;
}

async function shot(page: Page, name: string) {
  // "Inbox updated to 0.30.0": this spec's release binary carries apps built as dev, so the page says it is older.
  // Not this dialog's; hidden (never clicked: with the dialog open a click there is a click outside, which dismisses it)
  // so the pictures compare with the approved ones.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-stale-page]')) el.style.display = 'none';
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

const rowOf = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`).first();

/** Open a thread from the list, read it past the read time, and leave it for the list. */
async function readAndLeave(page: Page, id: string, phone = false) {
  await rowOf(page, id).click();
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await page.waitForTimeout(READ_MS);
  await page.locator(phone ? '[data-phone-back]' : 'button[aria-label="Close the thread"]').first().click();
  await expect(page.locator('section.ib-pane')).toHaveCount(0);
}

/** The person snoozed nothing: no snoozes.json, no "snoozed" mark. */
function snoozedNothing(w: World) {
  expect(existsSync(join(w.dataDir, 'inbox', 'snoozes.json'))).toBe(false);
  expect(saved(w)?.snoozedAt).toBeUndefined();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run --cwd apps/review build && bun run build:hook)').toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  scratch = inboxScratch('plannotator-inbox-snooze-intro-');
  binary = compileReleaseBinary();
});

test.afterAll(async () => {
  try {
    for (const ctx of contexts) await ctx.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('desktop, light: never on load; once at the calm moment; a second tab and a reload never show it again', async ({ browser }) => {
  test.setTimeout(330_000);
  const w = await world();
  // The release start's backfill: first use from the event log, three days back.
  expect(Date.now() - Date.parse(saved(w)!.firstUseAt!)).toBeGreaterThan(2.9 * 24 * 3600_000);
  const ctx = await context(browser);
  const [a, b] = await Promise.all([ctx.newPage(), ctx.newPage()]);
  await Promise.all([a.goto(w.url), b.goto(w.url)]);
  await expect(rowOf(a, w.ids['cache-rate']!)).toBeVisible();
  // A minute on the page: nothing, in either tab.
  await a.waitForTimeout(PAGE_AGE_MS);
  await expect(a.locator(DIALOG)).toHaveCount(0);
  await expect(b.locator(DIALOG)).toHaveCount(0);
  expect(saved(w)?.shownAt).toBeUndefined();
  // The moment: cache-rate read and left.
  await readAndLeave(a, w.ids['cache-rate']!);
  await expect(a.locator(DIALOG)).toBeVisible({ timeout: 8_000 });
  // Stamped by the claim, before the person did anything with it.
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
  // B "The real menu": the row just left is the menu's target, under the menu; Tomorrow under the pointer; the toast.
  await expect(a.locator(`${DIALOG} .ib-zx-list .ib-rw`)).toHaveCount(2);
  await expect(a.locator(`${DIALOG} .ib-zx-list .ib-rw`).last()).toHaveAttribute('data-menu', /.*/);
  await expect(a.locator(`${DIALOG} .ib-zx-list .ib-rw[data-menu]`)).toContainText('cache-rate');
  await expect(a.locator(`${DIALOG} [data-snooze-intro-choice="tomorrow"]`)).toHaveAttribute('data-highlighted', '');
  await expect(a.locator(`${DIALOG} .ib-zx-toast`)).toContainText('Snoozed');
  await expect(a.locator('[data-snooze-intro-try]')).toBeFocused();
  await shot(a, 'desktop-light');
  // The second tab reaches its own moment: the Inbox says no.
  await readAndLeave(b, w.ids['refund-window']!);
  await b.waitForTimeout(5_000);
  await expect(b.locator(DIALOG)).toHaveCount(0);
  // Got it, then a reload and the same moment a minute on: never again.
  await a.locator('[data-snooze-intro-close]').click();
  await expect(a.locator(DIALOG)).toHaveCount(0);
  await a.reload();
  await expect(rowOf(a, w.ids['release-notes']!)).toBeVisible();
  await a.waitForTimeout(PAGE_AGE_MS);
  await readAndLeave(a, w.ids['release-notes']!);
  await a.waitForTimeout(5_000);
  await expect(a.locator(DIALOG)).toHaveCount(0);
  snoozedNothing(w);
});

test('desktop, dark: Try it opens the real Snooze menu of the row just left, and snoozes nothing', async ({ browser }) => {
  test.setTimeout(240_000);
  const w = await world();
  const page = await (await context(browser, { dark: true })).newPage();
  await page.goto(w.url);
  await expect(rowOf(page, w.ids['cache-rate']!)).toBeVisible();
  await page.waitForTimeout(PAGE_AGE_MS);
  await readAndLeave(page, w.ids['cache-rate']!);
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 8_000 });
  // The person's own mode: no light scope anywhere in it.
  await expect(page.locator(`${DIALOG} .ib-lightscope`)).toHaveCount(0);
  await shot(page, 'desktop-dark');
  await page.locator('[data-snooze-intro-try]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  const menu = page.locator(`[data-row-menu="${w.ids['cache-rate']}"]`);
  await expect(menu.locator('[data-snooze-choice="tomorrow"]')).toBeVisible();
  await page.mouse.move(4, 4);
  await shot(page, 'try-it-desktop-dark');
  await page.waitForTimeout(1_000);
  snoozedNothing(w);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  snoozedNothing(w);
});

test('a 390 px phone layout, light: the ⋯ sheet picture; Try it opens the thread just left on its ⋯ sheet times, and snoozes nothing', async ({ browser }) => {
  test.setTimeout(240_000);
  const w = await world();
  const page = await (await context(browser, { phone: true })).newPage();
  await page.goto(w.url);
  await expect(rowOf(page, w.ids['cache-rate']!)).toBeVisible();
  await page.waitForTimeout(PAGE_AGE_MS);
  await readAndLeave(page, w.ids['cache-rate']!, true);
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 8_000 });
  await expect(page.locator(`${DIALOG} .ib-zx-pos [data-snooze-intro-choice]`).first()).toBeVisible();
  // 44 px targets.
  for (const sel of ['[data-snooze-intro-try]', '[data-snooze-intro-close]']) expect((await page.locator(sel).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await shot(page, 'phone-light');
  // The same dialog in dark (the Inbox follows the system's mode), for its picture.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).not.toHaveClass(/(^|\s)light(\s|$)/);
  await shot(page, 'phone-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  // The narrowest phone (an iPhone SE's 320 px): the same sheet, every button still a 44 px target.
  await page.setViewportSize({ width: 320, height: 568 });
  for (const sel of ['[data-snooze-intro-try]', '[data-snooze-intro-close]']) expect((await page.locator(sel).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await shot(page, 'phone-light-320');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-snooze-intro-try]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await expect(page.locator('[data-thread-menu] [data-snooze-choice="tomorrow"]')).toBeVisible();
  await shot(page, 'try-it-phone-light');
  await page.waitForTimeout(1_000);
  snoozedNothing(w);
});
