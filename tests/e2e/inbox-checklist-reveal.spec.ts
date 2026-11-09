/**
 * The Checklist reveal for returning users (approval "inbox-checklist-reveal", 2026-11-04), proved in a real Chromium
 * against a compiled binary with a release version (0.30.0): the shared e2e binary is 0.0.0-dev, which never decides a
 * reveal, so the spec compiles its own (as inbox-board-reveal.spec.ts does). Each case is its own Inbox in a temp data
 * dir, seeded at day 8 with six threads (inbox-board-reveal-seed.ts), Snooze and the Board already revealed (the Board
 * on, its reveal 3 days ago, so the spacing holds), the Checklist as each case says.
 *
 * Reveals are opt-in (the owner, 2026-11-04): showing the dialog turns nothing on.
 *
 *  - Desktop: never on load, and not at a calm moment while the page is younger than a minute (a thread read and
 *    closed shows nothing and stamps nothing). Past a minute on the page the person reads a thread and closes it:
 *    ChecklistIntro opens as an offer, and the claim stamped it (its stamp the spacing clock's) with `inboxSteps`
 *    still unset. "Turn it on" writes it true, and Settings → Capabilities shows the Checklist switch on. A reload
 *    reaching the moment again shows nothing, and the Checklist stays on.
 *  - A 390 px phone: the dialog as a sheet, Turn it on on top; "Not now" closes it and the Checklist stays unset.
 *  - A person who set the Checklist, on or off: the moment shows nothing, their setting stays, and no reveal is stamped.
 *  - In every case the "Tell your agents" dialog never appears.
 *
 * The read and settling times are real (5 s, 2.5 s). The page's minute is on the page's own clock: the gate reads
 * `Date.now()` in the page, so each context installs Playwright's clock before its pages load (it then runs in real
 * time) and a case fast-forwards it a minute instead of waiting one out. Every time the spec reads from the Inbox
 * (config.json stamps, the seeded days) is the Inbox's own, never the page's. Build the apps first (bun run --cwd
 * apps/review build && bun run build:hook), then `bunx playwright test -c tests/e2e/playwright.config.ts
 * inbox-checklist-reveal.spec.ts`. PNGs land in PLANNOTATOR_E2E_PROOF_DIR/checklist-reveal, or
 * .local/proof/checklist-reveal/.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { savedConfig } from '../helpers/saved-config';

const repo = resolve(__dirname, '../..');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'checklist-reveal');
const VERSION = '0.30.0';
const DIALOG = '[data-dialog="checklist-intro"]';
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
 * An Inbox eight days into use: the seeded log, Snooze shown 5.5 days ago and the Board revealed (and on) 3 days ago,
 * every other one-time dialog and the tour behind the person, and every agent's home a temp folder. `steps`: the
 * person's own Checklist setting (absent: never set). HOME is the world's temp folder.
 */
async function world(steps?: boolean): Promise<World> {
  const root = realpathSync(mkdtempSync(join(scratch, 'world-')));
  const dataDir = join(root, 'data');
  const src = join(root, 'src');
  for (const dir of [dataDir, src, join(root, 'claude'), join(root, 'codex'), join(root, 'xdg-config'), join(root, 'xdg-data')]) mkdirSync(dir, { recursive: true });
  const seeded = spawnSync('bun', [join(repo, 'tests/e2e/inbox-board-reveal-seed.ts'), dataDir, src, '8'], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir } });
  expect(seeded.status, seeded.stderr).toBe(0);
  const ids = JSON.parse(seeded.stdout.trim()) as Record<string, string>;
  const past = '2026-10-01T10:00:00.000Z';
  const snoozeShown = new Date(Date.now() - 5.5 * DAY).toISOString();
  const boardShown = new Date(Date.now() - 3 * DAY).toISOString();
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
      inboxSnoozeIntro: { shownAt: snoozeShown },
      inboxBoard: true,
      inboxBoardIntro: { shownAt: boardShown },
      inboxReveals: { lastShownAt: boardShown, board: { shownAt: boardShown } },
      ...(steps === undefined ? {} : { inboxSteps: steps }),
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
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
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

/** Records it if the "Tell your agents" dialog ever appears on this page, from its first paint on. */
async function guardAgentNote(page: Page) {
  await page.addInitScript(() => {
    const seen = () => {
      if (document.querySelector('[data-dialog="agent-note"]') || document.body?.innerText.includes('Tell your agents')) (window as any).__agentNote = true;
    };
    new MutationObserver(seen).observe(document, { subtree: true, childList: true, characterData: true });
  });
}
async function noAgentNote(page: Page) {
  expect(await page.evaluate(() => Boolean((window as any).__agentNote)), 'the "Tell your agents" dialog appeared').toBe(false);
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

/**
 * The calm moment on a page younger than its minute: the thread read and closed, the moment settles, and the page may
 * not claim it yet. Nothing shows and nothing is stamped (the claim is not spent: the next leave is the next chance).
 */
async function tooYoung(page: Page, w: World) {
  await expect(rowOf(page, w.ids['invoice-pdf']!)).toBeVisible();
  // The page's first read of the line keeps when the Checklist first became next (not a claim): wait for it, so the
  // stamps compared below are the ones the moment could spend.
  await expect.poll(() => config(w).inboxReveals?.waitingSince?.steps ?? null).not.toBeNull();
  const before = JSON.stringify(config(w).inboxReveals);
  await readAndLeave(page, w.ids['invoice-pdf']!);
  await page.waitForTimeout(5_000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(JSON.stringify(config(w).inboxReveals)).toBe(before);
}

/** A minute on the page with nothing shown and the Checklist still unset, then the moment: the dialog, the claim already spent. */
async function reveal(page: Page, w: World, phone = false) {
  await expect(rowOf(page, w.ids['invoice-pdf']!)).toBeVisible();
  await page.clock.fastForward(PAGE_AGE_MS);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(config(w).inboxSteps).toBeUndefined();
  await readAndLeave(page, w.ids['invoice-pdf']!, phone);
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 8_000 });
  // The claim stamped the reveal and the spacing clock, in one save, and turned nothing on.
  const saved = config(w);
  expect(saved.inboxSteps).toBeUndefined();
  expect(saved.inboxReveals.steps.shownAt).toBe(saved.inboxReveals.lastShownAt);
  await expect(page.locator(`${DIALOG} [data-checklist-intro-close]`)).toHaveText('Not now');
  await expect(page.locator(`${DIALOG} [data-checklist-intro-on]`)).toHaveText('Turn it on');
  // The Board's own stamps are left as they were.
  expect(saved.inboxBoard).toBe(true);
}

/** A reload and the same moment a minute on: nothing, and the Checklist as the person left it. */
async function neverAgain(page: Page, w: World, steps: boolean | undefined, phone = false) {
  await page.goto(w.url.replace(/#.*$/, ''));
  await expect(rowOf(page, w.ids['release-notes']!)).toBeVisible();
  await page.clock.fastForward(PAGE_AGE_MS);
  await readAndLeave(page, w.ids['release-notes']!, phone);
  await page.waitForTimeout(5_000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(config(w).inboxSteps).toBe(steps);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run --cwd apps/review build && bun run build:hook)').toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  scratch = inboxScratch('plannotator-inbox-checklist-reveal-');
  binary = compileReleaseBinary();
});

test.afterAll(async () => {
  try {
    for (const ctx of contexts) await ctx.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('desktop: never on load; at the calm moment the dialog offers the Checklist and turns nothing on; Turn it on turns it on; once', async ({ browser }) => {
  test.setTimeout(360_000);
  const w = await world();
  const page = await (await context(browser)).newPage();
  await guardAgentNote(page);
  await page.goto(w.url);
  await tooYoung(page, w);
  await reveal(page, w);
  await shots(page, 'desktop-{s}-reveal');
  await noAgentNote(page);
  // Turn it on: the dialog closes and the switch is saved; Settings → Capabilities reads it on.
  await page.locator('[data-checklist-intro-on]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect.poll(() => config(w).inboxSteps).toBe(true);
  await page.goto(`${w.url.replace(/#.*$/, '')}#settings/capabilities`);
  await expect(page.locator('[data-settings-steps]')).toBeVisible();
  await expect(page.locator('[data-settings-steps] [role="switch"]')).toHaveAttribute('aria-checked', 'true');
  await page.mouse.move(4, 4);
  await shots(page, 'desktop-{s}-settings');
  expect(config(w).inboxSteps).toBe(true);
  await noAgentNote(page);
  await neverAgain(page, w, true);
  await noAgentNote(page);
});

test('a 390 px phone: the dialog as a sheet, Turn it on on top; Not now closes it and the Checklist stays unset; once', async ({ browser }) => {
  test.setTimeout(300_000);
  const w = await world();
  const page = await (await context(browser, true)).newPage();
  await guardAgentNote(page);
  await page.goto(w.url);
  await reveal(page, w, true);
  const on = await page.locator('[data-checklist-intro-on]').boundingBox();
  const not = await page.locator('[data-checklist-intro-close]').boundingBox();
  expect(on!.y).toBeLessThan(not!.y);
  await shots(page, 'phone-{s}-reveal');
  await page.locator('[data-checklist-intro-close]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  // Not now writes nothing: the Checklist stays unset (off), and only Settings turns it on from here.
  await page.waitForTimeout(1_000);
  expect(config(w).inboxSteps).toBeUndefined();
  await noAgentNote(page);
  await neverAgain(page, w, undefined, true);
  await noAgentNote(page);
});

test('a person who set the Checklist, on or off, never gets it: the moment shows nothing, the setting and the reveal stamps are untouched', async ({ browser }) => {
  test.setTimeout(300_000);
  const sets = [true, false];
  const worlds = await Promise.all(sets.map((set) => world(set)));
  // What the reveal would write (the Inbox itself may still fill Snooze's first use from the log).
  const before = worlds.map((w) => JSON.stringify(config(w).inboxReveals));
  const ctx = await context(browser);
  const pages = await Promise.all(worlds.map(() => ctx.newPage()));
  for (const page of pages) await guardAgentNote(page);
  await Promise.all(pages.map((page, i) => page.goto(worlds[i]!.url)));
  for (const [i, page] of pages.entries()) await expect(rowOf(page, worlds[i]!.ids['invoice-pdf']!)).toBeVisible();
  // One context, one clock: the minute passes on both pages.
  await ctx.clock.fastForward(PAGE_AGE_MS);
  await Promise.all(pages.map((page, i) => readAndLeave(page, worlds[i]!.ids['invoice-pdf']!)));
  await pages[0]!.waitForTimeout(5_000);
  for (const [i, page] of pages.entries()) {
    await expect(page.locator(DIALOG)).toHaveCount(0);
    const saved = config(worlds[i]!);
    expect(saved.inboxSteps).toBe(sets[i]);
    expect(JSON.stringify(saved.inboxReveals)).toBe(before[i]);
    await noAgentNote(page);
  }
});
