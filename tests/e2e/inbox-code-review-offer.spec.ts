/**
 * Code review's one-time offer for people who already use the Inbox (approval "inbox-code-review-offer", 2026-11-23),
 * proved in a real Chromium against a compiled binary with a release version (0.30.0): the shared e2e binary is
 * 0.0.0-dev, which never decides a one-time dialog, so the spec compiles its own (as inbox-board-reveal.spec.ts does).
 * Each case is its own Inbox in a temp data dir, seeded at day 4 with six threads (inbox-code-review-offer-seed.ts),
 * the tour and every other one-time dialog behind the person, and Code review as each case sets it.
 *
 *  - Desktop, Code review never decided: the offer opens over the Inbox on the first load, named by its title; showing
 *    it turns nothing on. "Turn on code review" closes it, turns Code review on as Settings does (config.json
 *    `inboxCodeReview: true`) and Reviews joins the sidebar at once. A reload never shows it again, nor another
 *    one-time dialog inside the gap.
 *  - A 390 px phone: the offer as a sheet; Escape is Not now: closed, Code review still never decided, the line's Not
 *    now stamped, and a reload shows no dialog at all.
 *  - Code review already on: no offer.
 *
 * Pictures (made-up content): the offer over the Inbox in light and dark, the phone in light, and the window right
 * after Turn on. Build the apps first (bun run --cwd apps/review build && bun run build:hook), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-code-review-offer.spec.ts`. PNGs land in
 * PLANNOTATOR_E2E_PROOF_DIR/code-review-offer, or .local/proof/code-review-offer/.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { E2E_GROUP_TIP_SEEN, E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { savedConfig } from '../helpers/saved-config';

const repo = resolve(__dirname, '../..');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'code-review-offer');
const VERSION = '0.30.0';
const DAY = 24 * 3600_000;
const OFFER = 'dialog[data-dialog="code-review-offer"]';
/** Long enough for the page's settling wait and a claim, were anything to open. */
const QUIET_MS = 8_000;

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
 * An Inbox four days into use: the seeded log, the tour, the agent notes and every other one-time dialog behind the
 * person (the last one 2.5 days ago, so the gap holds no dialog back), and every agent's home a temp folder. HOME is
 * the world's temp folder. `codeReview`: config.json `inboxCodeReview` (absent: never decided).
 */
async function world(codeReview?: boolean): Promise<World> {
  const root = realpathSync(mkdtempSync(join(scratch, 'world-')));
  const dataDir = join(root, 'data');
  const src = join(root, 'src');
  for (const dir of [dataDir, src, join(root, 'claude'), join(root, 'codex'), join(root, 'xdg-config'), join(root, 'xdg-data')]) mkdirSync(dir, { recursive: true });
  const seeded = spawnSync('bun', [join(repo, 'tests/e2e/inbox-code-review-offer-seed.ts'), dataDir, src, '4'], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir } });
  expect(seeded.status, seeded.stderr).toBe(0);
  const ids = JSON.parse(seeded.stdout.trim()) as Record<string, string>;
  const past = '2026-10-01T10:00:00.000Z';
  const lastShown = new Date(Date.now() - 2.5 * DAY).toISOString();
  writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ inboxVersion: VERSION }));
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      ...E2E_LAUNCH_OFF,
      inboxTour: { version: 2, seen_at: past, skipped_at: past },
      inboxNotifications: { dismissed: true },
      inboxAgentNotes: { offered: true, asked: ['claude-code', 'codex', 'opencode', 'pi', 'gemini', 'qwen', 'cursor'] },
      inboxSound: { dialogShownFor: VERSION },
      inboxListIntro: { shownAt: past, version: 2 },
      inboxVoiceIntro: { shownAt: past },
      favicon: 'glass',
      inboxSnoozeIntro: { shownAt: lastShown },
      inboxBoard: false,
      inboxSteps: false,
      inboxBro: false,
      inboxTool: { openclaw: true },
      inboxPriorityIntro: { usedAt: lastShown },
      // Every world's stamps but Code review's offer, which is what this spec is about.
      inboxReveals: { band_tip: E2E_GROUP_TIP_SEEN.band_tip, lastShownAt: lastShown, view_choice: { shownAt: past }, star: { shownAt: past }, sidebar_tip: { shownAt: past } },
      ...(codeReview === undefined ? {} : { inboxCodeReview: codeReview }),
    }),
  );
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    // A release version: never the live daily ping (packages/shared/daily-ping.ts).
    NO_ANON_PING: '1',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
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

const config = (w: World) => savedConfig(w.dataDir);

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

/** "Inbox updated to 0.30.0": this spec's release binary carries apps built as dev. Not this feature's; hidden, never clicked. */
async function hideStaleNotice(page: Page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-stale-page]')) el.style.display = 'none';
  });
}

/** The scene in each scheme given (the Inbox follows the system's mode), then back to light. */
async function shots(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']) {
  await hideStaleNotice(page);
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(proofDir, `${name.replace('{s}', scheme)}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const rowOf = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`).first();

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run --cwd apps/review build && bun run build:hook)').toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  scratch = inboxScratch('plannotator-inbox-code-review-offer-');
  binary = compileReleaseBinary();
});

test.afterAll(async () => {
  try {
    for (const ctx of contexts) await ctx.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('desktop, Code review never decided: the offer over the Inbox; Turn on code review turns it on as Settings does and Reviews joins the sidebar; never again', async ({ browser }) => {
  test.setTimeout(300_000);
  const w = await world();
  const page = await (await context(browser)).newPage();
  await page.goto(w.url);
  await expect(rowOf(page, w.ids['refund-window']!)).toBeVisible();
  await expect(page.locator('[data-sidebar-item="reviews"]')).toHaveCount(0);
  // On the first load, once the page settles: no thread read, no page age.
  const offer = page.getByRole('dialog', { name: 'A new way to review' });
  await expect(offer).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`${OFFER} #ib-cro-feats li`)).toHaveCount(4);
  // Showing it turned nothing on, and only it is open.
  expect(config(w).inboxCodeReview).toBeUndefined();
  expect(config(w).inboxReveals.code_review.shownAt).toMatch(/^\d{4}-/);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await shots(page, 'offer-desktop-{s}');
  // The keyboard: focus starts on the dialog; Tab goes to its first button and stays inside.
  await page.keyboard.press('Tab');
  await expect(offer.getByRole('button', { name: 'Not now' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(offer.getByRole('button', { name: 'Turn on code review' })).toBeFocused();
  await offer.getByRole('button', { name: 'Turn on code review' }).click();
  await expect(page.locator(OFFER)).toHaveCount(0);
  await expect(page.locator('[data-sidebar-item="reviews"]')).toBeVisible();
  await expect.poll(() => config(w).inboxCodeReview).toBe(true);
  await page.mouse.move(4, 4);
  await shots(page, 'turned-on-desktop-{s}', ['light']);
  // A reload: Reviews stays, and no one-time dialog opens.
  await page.reload();
  await expect(rowOf(page, w.ids['refund-window']!)).toBeVisible();
  await expect(page.locator('[data-sidebar-item="reviews"]')).toBeVisible();
  await page.waitForTimeout(QUIET_MS);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('a 390 px phone: the offer as a sheet; Escape is Not now, Code review stays undecided, and no dialog follows', async ({ browser }) => {
  test.setTimeout(240_000);
  const w = await world();
  const page = await (await context(browser, true)).newPage();
  await page.goto(w.url);
  const offer = page.getByRole('dialog', { name: 'A new way to review' });
  await expect(offer).toBeVisible({ timeout: 20_000 });
  await shots(page, 'offer-phone-{s}', ['light']);
  await page.keyboard.press('Escape');
  await expect(page.locator(OFFER)).toHaveCount(0);
  await expect.poll(() => config(w).inboxReveals?.notNowAt ?? null).not.toBeNull();
  expect(config(w).inboxCodeReview).toBeUndefined();
  await page.reload();
  await page.waitForTimeout(QUIET_MS);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  expect(config(w).inboxCodeReview).toBeUndefined();
});

test('Code review already on: the offer never opens', async ({ browser }) => {
  test.setTimeout(180_000);
  const w = await world(true);
  const page = await (await context(browser)).newPage();
  await page.goto(w.url);
  await expect(rowOf(page, w.ids['refund-window']!)).toBeVisible();
  await expect(page.locator('[data-sidebar-item="reviews"]')).toBeVisible();
  await page.waitForTimeout(QUIET_MS);
  await expect(page.locator(OFFER)).toHaveCount(0);
  expect(config(w).inboxReveals.code_review).toBeUndefined();
});
