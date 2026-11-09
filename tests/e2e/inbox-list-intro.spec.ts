/**
 * The one-time "Choose how your list looks" dialog (approval "inbox-rows-dialog", round 7b), proved in a real
 * Chromium against a compiled binary under temp HOMEs and data dirs. The spec compiles its own binary with a release
 * version (0.30.0): the shared e2e binary is 0.0.0-dev, which never decides the dialog (so it never shows in other
 * specs). Each case is its own Inbox (the dialog is once per machine); agents write through `plannotator inbox mcp`.
 * Every Inbox here has six threads: the dialog waits for five (q-2c590791).
 *
 *  - A fresh install gets it too (no day-four rule), once, like someone who used an Inbox before.
 *  - Someone who saw the earlier dialog (0.28.42, the switches) gets this one once: the saved mark moved to version 2.
 *  - Once, in one of two tabs: the demo plays and holds on the stacked picture, nothing is picked, Done waits for a
 *    pick; a pick raises the card with the person's own rows, and Done puts the look on the real list at once, which a
 *    reload keeps; it never shows again.
 *  - Escape and Keep as it is change nothing and retire it, even after a pick (with reduced motion: no demo at all).
 *  - "Customize rows" opens Settings → Rows, saves nothing and retires it.
 *  - A key or a click during the demo jumps to the held picture.
 *  - Never on the same load as the tour (the next load shows it); after the sound dialog, never that load nor the next
 *    (the line of one-time dialogs, approval "inbox-one-time-dialogs": one a day, two days apart).
 *  - Its moment is back on the list (approval "inbox-one-time-dialogs"): a first load on a thread link (desktop or
 *    phone) never shows it over the thread; back on the list it shows after the same short wait as a first load on the
 *    list; never while a file is open beside the thread, nor with the thread alone; never under an image opened full
 *    size or a modal layer; a thread opened just before the wait ends starts it again.
 *  - The dialog and its picture follow the window's mode, its words at WCAG AA in dark and light (desktop and phone).
 *  - A 390 px phone: a bottom sheet, the three looks and 44 px buttons.
 *
 * Build the apps first (bun run --cwd apps/review build && bun run build:hook), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-list-intro.spec.ts`. PNGs and a video of the demo
 * land in PLANNOTATOR_E2E_PROOF_DIR/list-intro, or .local/proof/list-intro/.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { savedConfig } from '../helpers/saved-config';

const repo = resolve(__dirname, '../..');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'list-intro');
const VERSION = '0.30.0';
const DIALOG = '[data-dialog="list-look-intro"]';
const LOOKS = ['minimal', 'balanced', 'detailed'] as const;
const LONG_NAME = 'Ledger reconciliation dry run for the quarter-end close across every subsidiary and region';

let binary = '';
let scratch = '';
// What the running test started, stopped in afterEach: each world is a whole Inbox, three `inbox mcp` agents and a
// browser context at 2x. Kept to the end, a spec's twenty-odd worlds ran the 8 GB e2e machine out of memory (exit 137)
// in its last test, the video one.
const agents: SimAgent[] = [];
const contexts: BrowserContext[] = [];
const worldRoots: string[] = [];

interface World {
  url: string;
  dataDir: string;
  opened: string;
  /** With `attachment`: the file on the opened thread's reply. */
  file?: string;
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
 * An Inbox with six threads. `earlier`: someone who used an Inbox before (update-state.json names an older version),
 * with the sound dialog and the agent notes already behind them unless `soundDue`; `seenOld`: they also saw the
 * earlier list dialog (its mark has no version).
 */
async function world(options: { earlier: boolean; soundDue?: boolean; attachment?: boolean; seenOld?: boolean }): Promise<World> {
  const root = inboxScratch('plannotator-inbox-list-intro-world-');
  worldRoots.push(root);
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home);
  // A fresh install: no update state and nothing that says an Inbox ran here (inboxUsedBefore), only the tour and the
  // agent notes behind it, so the one-time dialog is the first thing on the list.
  // Launch off here too (on by default since 0.28.52): New message must run no `claude --version` on the runner's PATH.
  if (!options.earlier) writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, inboxTour: { version: 2, seen_at: '2026-10-01T10:00:00.000Z', skipped_at: '2026-10-01T10:00:00.000Z' }, inboxAgentNotes: { offered: true } }));
  if (options.earlier) {
    writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ inboxVersion: '0.29.0' }));
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({
        // Written whole: launch stays off (inboxScratch's launchOff), so New message runs no `claude --version` on the runner's PATH.
        ...E2E_LAUNCH_OFF,
        inboxTour: { version: 2, seen_at: '2026-10-01T10:00:00.000Z', skipped_at: '2026-10-01T10:00:00.000Z' },
        inboxNotifications: { dismissed: true },
        inboxAgentNotes: { offered: true },
        // Due on a used Inbox, and its check would run the `codex` on this PATH.
        inboxVoiceIntro: { shownAt: '2026-10-01T10:00:00.000Z' },
        ...(options.soundDue ? {} : { inboxSound: { dialogShownFor: '0.29.0' } }),
        ...(options.seenOld ? { inboxListIntro: { dueAt: '2026-10-20T10:00:00.000Z', shownAt: '2026-10-21T10:00:00.000Z' } } : {}),
      }),
    );
  }
  const env = { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir, NO_ANON_PING: '1', PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_PHONES: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  expect(url).not.toContain(':59812');
  rememberInboxOf(dataDir);
  const [claude, codex, pi] = await Promise.all(
    ([['Claude Code', 'claude-code'], ['Codex', 'codex'], ['Pi', 'pi']] as const).map(([name, host]) => SimAgent.connect({ binary, env, name, host })),
  );
  agents.push(claude!, codex!, pi!);
  const src = join(root, 'src');
  const ask = (q: string) => [':::question', q, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
  const say = async (agent: SimAgent, project: string, thread: string, subject: string, body: string) =>
    (await agent.send({ project_path: scratchProject(src, project), thread, subject, body })).thread_id;
  await say(pi!, 'plannotator', 'Release 0.28.41', 'Release notes for 0.28.41: check the contributor credits', 'Release notes are drafted.');
  await say(claude!, 'billing-svc', 'Refund events', 'Trust the webhook or poll Stripe every 10 minutes?', ask('Webhook?'));
  const opened = await say(claude!, 'plannotator', 'Thread items again', 'The list shows the subject in bold and the thread name as a pill', ask('Which row should I build?'));
  let file: string | undefined;
  if (options.attachment) {
    // The opened thread's reply carries a file, to open beside the thread.
    writeFileSync(join(scratchProject(src, 'plannotator'), 'row-notes.md'), '# Row notes\n\nThe pill version reads best.\n');
    const sent = await codex!.send({ project_path: scratchProject(src, 'plannotator'), reply_to: opened, body: 'I drew the phone rows.', attachments: ['row-notes.md'] });
    file = (sent.attachments as { id: string }[])[0]!.id;
  } else await codex!.send({ project_path: scratchProject(src, 'plannotator'), reply_to: opened, body: 'I drew the phone rows.' });
  await say(codex!, 'design-system-tokens', 'Spacing scale', 'Drop the 6 px step from the spacing scale?', ask('Drop the 6 px step?'));
  await say(pi!, 'api', 'Raise the batch import rate limit before the Friday migration window opens', 'The import hits 429s at 400 requests a minute', ask('Raise it to 800?'));
  const ledger = await say(claude!, 'northwind-industries-reconciliation-platform', LONG_NAME,'Dry run the ledger reconciliation against last quarter', ask('Run it tonight?'));
  await codex!.send({ project_path: scratchProject(src, 'northwind-industries-reconciliation-platform'), reply_to: ledger, body: 'Codex checked its part.' });
  return { url, dataDir, opened, file };
}

interface SavedIntro {
  dueAt?: string;
  shownAt?: string;
  version?: number;
  before?: { dueAt?: string; shownAt?: string };
}

const saved = (w: World) => savedConfig(w.dataDir).inboxListIntro as SavedIntro | undefined;
const savedRows = (w: World) => savedConfig(w.dataDir).inboxRows as string[] | undefined;

async function context(browser: Browser, options: { phone?: boolean; dark?: boolean; reduce?: boolean; video?: boolean } = {}): Promise<BrowserContext> {
  const viewport = options.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: options.video ? 1 : 2,
    colorScheme: options.dark ? 'dark' : 'light',
    reducedMotion: options.reduce ? 'reduce' : 'no-preference',
    ...(options.phone ? { isMobile: true, hasTouch: true } : {}),
    ...(options.video ? { recordVideo: { dir: join(proofDir, 'video'), size: viewport } } : {}),
  });
  contexts.push(ctx);
  return ctx;
}

const lookClasses = (page: Page) => page.locator('.pn-inbox .ib-listcol:not(.ib-lo-list):not(.ib-rl-list)').first().evaluate((el) => [...el.classList].filter((c) => c.startsWith('ib-lk-')).sort());
const look = (page: Page, id: string) => page.locator(`${DIALOG} [data-list-intro-look="${id}"]`);
const radio = (page: Page, id: string) => look(page, id).locator('input[type="radio"]');
const picture = (page: Page) => page.locator(`${DIALOG} [data-list-intro-picture]`);
const done = (page: Page) => page.locator('[data-list-intro-done]');

/** The person's look as it opens (Balanced with none saved): checked, its card up once held, and Done ready. */
async function balancedPicked(page: Page) {
  for (const id of LOOKS) await (id === 'balanced' ? expect(radio(page, id)).toBeChecked() : expect(radio(page, id)).not.toBeChecked());
  await expect(page.locator(`${DIALOG} [data-list-intro-card="balanced"]`)).toHaveCount(1);
  await expect(done(page)).toBeEnabled();
}

/** The dialog is up and its demo held on the stacked picture (or never played), with Balanced picked. */
async function heldDialog(page: Page) {
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  await expect(picture(page)).toHaveAttribute('data-scene', 'held', { timeout: 5_000 });
  await balancedPicked(page);
}

/** Picks a look: it is checked, the card rises with that look's layer on, and Done is ready. */
async function pick(page: Page, id: string) {
  await look(page, id).click();
  await expect(radio(page, id)).toBeChecked();
  await expect(page.locator(`${DIALOG} [data-list-intro-card="${id}"]`)).toHaveCount(1);
  await expect(page.locator(`${DIALOG} .ib-rl-cl[data-look="${id}"]`)).toHaveAttribute('data-on', '');
  await expect(done(page)).toBeEnabled();
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

/**
 * WCAG contrast of the dialog's words against what they sit on, in sRGB as Chromium paints the colours: a 1 px
 * canvas resolves oklch and color-mix, and each element's ground is its own and its ancestors' backgrounds painted in
 * order from the dialog's, so a tint with alpha counts as it shows. Run with a look picked, so Done is enabled.
 */
async function dialogContrast(page: Page): Promise<Record<string, number>> {
  return page.locator(DIALOG).evaluate((dialog) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const paint = (layers: string[]) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 1, 1);
      for (const color of layers) {
        ctx.fillStyle = '#000';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
      }
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!];
    };
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const grounds = (el: Element) => {
      const layers: string[] = [];
      for (let at: Element | null = el; at; at = at === dialog ? null : at.parentElement) layers.unshift(getComputedStyle(at).backgroundColor);
      return layers;
    };
    const ratio = (sel: string) => {
      const el = dialog.querySelector(sel)!;
      const layers = grounds(el);
      const [x, y] = [lum(paint([...layers, getComputedStyle(el).color])), lum(paint(layers))].sort((m, n) => n - m);
      return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100;
    };
    return {
      background: lum(paint([getComputedStyle(dialog).backgroundColor])),
      picture: lum(paint(grounds(dialog.querySelector('.ib-rl-comp')!))),
      title: ratio('#ib-lo-title'),
      line: ratio('#ib-lo-desc'),
      customize: ratio('[data-list-intro-customize]'),
      lookName: ratio('[data-list-intro-look]:not([data-on]) .ib-rl-ln'),
      pickedName: ratio('[data-list-intro-look][data-on] .ib-rl-ln'),
      current: ratio('.ib-rl-cur'),
      keep: ratio('[data-list-intro-keep]'),
      done: ratio('[data-list-intro-done]'),
    };
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run build:review && bun run build:hook)').toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  scratch = inboxScratch('plannotator-inbox-list-intro-');
  binary = compileReleaseBinary();
});

/** Close the test's contexts and agents, and stop its Inboxes (their folders go with them). */
async function closeWorlds() {
  try {
    for (const ctx of contexts.splice(0)) await ctx.close().catch(() => {});
    await Promise.all(agents.splice(0).map((a) => a.close().catch(() => {})));
  } finally {
    for (const root of worldRoots.splice(0)) await removeInboxScratch(root);
  }
}

test.afterEach(closeWorlds);

test.afterAll(async () => {
  try {
    await closeWorlds();
  } finally {
    await removeInboxScratch();
  }
});

test('a fresh install gets it too, once, with Balanced as the current look', async ({ browser }) => {
  const w = await world({ earlier: false });
  expect(saved(w)).toMatchObject({ version: 2, dueAt: expect.stringMatching(/^\d{4}-/) });
  expect(saved(w)?.shownAt).toBeUndefined();
  const page = await (await context(browser, { reduce: true })).newPage();
  await page.goto(w.url);
  await heldDialog(page);
  await expect(page.locator(`${DIALOG} .ib-rl-cur`)).toHaveCount(1);
  await expect(look(page, 'balanced').locator('.ib-rl-cur')).toHaveText('Current');
  await page.locator('[data-list-intro-keep]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
  await page.reload();
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  await page.waitForTimeout(3500);
  await expect(page.locator(DIALOG)).toHaveCount(0);
});

test('someone who saw the earlier dialog gets this one once; the earlier show is kept for the line', async ({ browser }) => {
  const w = await world({ earlier: true, seenOld: true });
  expect(saved(w)).toMatchObject({ version: 2, before: { shownAt: '2026-10-21T10:00:00.000Z' } });
  expect(saved(w)?.shownAt).toBeUndefined();
  const page = await (await context(browser, { reduce: true })).newPage();
  await page.goto(w.url);
  await heldDialog(page);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
  await page.reload();
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  await page.waitForTimeout(3500);
  await expect(page.locator(DIALOG)).toHaveCount(0);
});

test('once, in one of two tabs: the demo holds with Balanced picked, and Done puts the look on the real list at once', async ({ browser }) => {
  const w = await world({ earlier: true });
  expect(saved(w)?.dueAt).toMatch(/^\d{4}-/);
  const ctx = await context(browser);
  const [a, b] = await Promise.all([ctx.newPage(), ctx.newPage()]);
  await Promise.all([a.goto(w.url), b.goto(w.url)]);
  await expect.poll(async () => (await a.locator(DIALOG).count()) + (await b.locator(DIALOG).count()), { timeout: 15_000 }).toBe(1);
  const page = (await a.locator(DIALOG).count()) === 1 ? a : b;
  const other = page === a ? b : a;
  // The demo plays, then holds on the stacked picture (the last step at 2.6 s): Balanced is picked from the start,
  // its card rising only once the demo holds.
  await expect(picture(page)).not.toHaveAttribute('data-scene', 'held');
  await expect(radio(page, 'balanced')).toBeChecked();
  await expect(page.locator(`${DIALOG} [data-list-intro-card]`)).toHaveCount(0);
  await heldDialog(page);
  await expect(page.locator(`${DIALOG} #ib-lo-title`)).toHaveText('Choose how your list looks');
  await expect(page.locator(`${DIALOG} #ib-lo-desc`)).toHaveText('Pick a look. Fine-tune it any time in Customize rows, from ⋮ above the list.');
  await expect(page.locator(`${DIALOG} .ib-rl-look .ib-rl-ln`)).toHaveText(['Minimal', /^Balanced\s*Current$/, 'Detailed']);
  await shot(page, 'desktop-light-held');
  // Each pick raises the card with the person's own threads in that look.
  await pick(page, 'detailed');
  await expect(page.locator(`${DIALOG} .ib-rl-cl[data-look="detailed"]`)).toContainText('Spacing scale');
  await expect(page.locator(`${DIALOG} .ib-rl-cl[data-look="detailed"] .ib-lm`).first()).toBeVisible();
  await shot(page, 'desktop-light-detailed');
  await pick(page, 'minimal');
  await expect(page.locator(`${DIALOG} .ib-rl-cl[data-look="minimal"] .ib-listcol.ib-lk-tfirst`)).toHaveCount(1);
  await shot(page, 'desktop-light-minimal');
  // The real list keeps its look until Done.
  expect(await lookClasses(page)).toEqual(['ib-lk-small']);
  await done(page).click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(await lookClasses(page)).toEqual(['ib-lk-small', 'ib-lk-tfirst']);
  await expect.poll(() => [...(savedRows(w) ?? [])].sort()).toEqual(['hidePreview', 'smallNames', 'titleFirst']);
  await page.reload();
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  expect(await lookClasses(page)).toEqual(['ib-lk-small', 'ib-lk-tfirst']);
  await other.reload();
  await page.waitForTimeout(3000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(other.locator(DIALOG)).toHaveCount(0);
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
});

for (const how of ['Escape', 'Keep as it is'] as const) {
  test(`${how} changes nothing and retires it, even after a pick; with reduced motion there is no demo`, async ({ browser }) => {
    const w = await world({ earlier: true });
    const page = await (await context(browser, { reduce: true })).newPage();
    await page.goto(w.url);
    await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
    const rowsBefore = savedRows(w);
    // Reduced motion: held from the first frame.
    await expect(picture(page)).toHaveAttribute('data-scene', 'held');
    await balancedPicked(page);
    // The looks take the first focus, Balanced picked; Tab reaches it, then an arrow picks the next by keyboard.
    await expect(page.locator(`${DIALOG} .ib-rl-looks`)).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowDown');
    await expect(radio(page, 'detailed')).toBeChecked();
    await pick(page, 'detailed');
    if (how === 'Escape') await page.keyboard.press('Escape');
    else await page.locator('[data-list-intro-keep]').click();
    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(await lookClasses(page)).toEqual(['ib-lk-small']);
    expect(savedRows(w)).toEqual(rowsBefore);
    // The list is still there: Escape closed only the dialog.
    await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
    await page.reload();
    await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(await lookClasses(page)).toEqual(['ib-lk-small']);
  });
}

test('"Customize rows" opens Settings → Rows, saves nothing and retires it', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser, { reduce: true })).newPage();
  await page.goto(w.url);
  await heldDialog(page);
  const rowsBefore = savedRows(w);
  await pick(page, 'detailed');
  await page.locator('[data-list-intro-customize]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page).toHaveURL(/#settings\/rows$/);
  await expect(page.locator('[data-settings-section="rows"]')).toBeVisible();
  expect(savedRows(w)).toEqual(rowsBefore);
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
});

for (const how of ['a key', 'a click'] as const) {
  test(`${how} during the demo jumps to the held picture`, async ({ browser }) => {
    const w = await world({ earlier: true });
    const page = await (await context(browser)).newPage();
    await page.goto(w.url);
    await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
    await expect(picture(page)).not.toHaveAttribute('data-scene', 'held');
    const at = Date.now();
    if (how === 'a key') await page.keyboard.press('Shift');
    else await page.locator(`${DIALOG} #ib-lo-title`).click();
    await expect(picture(page)).toHaveAttribute('data-scene', 'held', { timeout: 1_000 });
    expect(Date.now() - at).toBeLessThan(1500);
    await expect(page.locator(`${DIALOG} .ib-rl-art[data-moving]`)).toHaveCount(0);
    await balancedPicked(page);
    await pick(page, 'detailed');
  });
}

test('after the sound dialog: never on that load, nor on the next (one a day, two days apart)', async ({ browser }) => {
  const w = await world({ earlier: true, soundDue: true });
  const page = await (await context(browser, { reduce: true })).newPage();
  await page.goto(w.url);
  const sound = page.locator('[data-dialog="sound-intro"]');
  await expect(sound).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(sound).toHaveCount(0);
  await page.waitForTimeout(3500);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(saved(w)?.shownAt).toBeUndefined();
  await page.reload();
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(6000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(sound).toHaveCount(0);
  expect(saved(w)?.shownAt).toBeUndefined();
});

test('never on the same load as the tour: the next load shows it', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser, { reduce: true })).newPage();
  await page.goto(`${w.url}#tour=1`);
  await expect(page.locator('[data-tour-intro], [data-tour-coach]').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  // Back to the list on the same load: still not.
  await page.locator('[data-tour-exit]').click();
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(3500);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(saved(w)?.shownAt).toBeUndefined();
  await page.reload();
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
});

test('a first load on the list: it shows after the short wait, not the moment the list is up', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser, { reduce: true })).newPage();
  const t0 = Date.now();
  await page.goto(w.url);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
  await shot(page, 'first-load-on-list');
});

for (const phone of [false, true]) {
  test(`a first load on a thread link${phone ? ' on a phone' : ''}: never over the thread; back on the list, after the short wait`, async ({ browser }) => {
    const w = await world({ earlier: true });
    const page = await (await context(browser, { phone, reduce: true })).newPage();
    await page.goto(`${w.url}#thread=${w.opened}`);
    const subject = page.locator('.ib-pane h2.ib-subject').first();
    await expect(subject).toBeVisible({ timeout: 15_000 });
    // Well past the wait: nothing over the thread, and the claim is not spent.
    await page.waitForTimeout(6000);
    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(saved(w)?.shownAt).toBeUndefined();
    // Back on the list: after the same short wait as a first load on the list.
    await page.locator(phone ? '[data-phone-back]' : 'button[aria-label="Close the thread"]').first().click();
    await expect(subject).toHaveCount(0);
    const back = Date.now();
    await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - back).toBeGreaterThanOrEqual(2000);
    expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
    await heldDialog(page);
    await shot(page, `thread-link${phone ? '-phone' : ''}-dialog`);
    // Once: Keep as it is retires it, and opening a thread and closing it never brings it again.
    await page.locator('[data-list-intro-keep]').click();
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await page.locator('.ib-lbody [data-thread-id]').first().click();
    await expect(subject).toBeVisible();
    await page.locator(phone ? '[data-phone-back]' : 'button[aria-label="Close the thread"]').first().click();
    await expect(subject).toHaveCount(0);
    await page.waitForTimeout(3500);
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });
}

test('never under an image opened full size or another modal layer: it waits, unspent, and shows once it is gone', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser, { reduce: true })).newPage();
  await page.goto(w.url);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible({ timeout: 15_000 });
  // The layers ui draws over the page by itself, outside the route and the window's dialogs: the image lightbox's
  // own marker (`data-image-lightbox`), then a modal panel (`aria-modal`), each as ui renders it on <body>.
  for (const layer of ['[data-image-lightbox]', '[role="dialog"][aria-modal="true"]']) {
    // One layer swapped for the next in the same task, so the page is never free in between.
    await page.evaluate((which) => {
      document.getElementById('stand-in-layer')?.remove();
      const el = document.createElement('div');
      el.id = 'stand-in-layer';
      if (which === '[data-image-lightbox]') el.setAttribute('data-image-lightbox', '');
      else {
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
      }
      document.body.appendChild(el);
    }, layer);
    await page.waitForTimeout(4500);
    await expect(page.locator(DIALOG), layer).toHaveCount(0);
    expect(saved(w)?.shownAt, layer).toBeUndefined();
  }
  await page.evaluate(() => document.getElementById('stand-in-layer')?.remove());
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
});

test('a thread opened just before the wait ends: never over it; back on the list, the wait starts again from there', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser, { reduce: true })).newPage();
  await page.goto(w.url);
  const rows = page.locator('.ib-lbody [data-thread-id]');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  // Just short of the wait from the list's first draw.
  await page.waitForTimeout(2000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await rows.first().click();
  const subject = page.locator('.ib-pane h2.ib-subject').first();
  await expect(subject).toBeVisible();
  await page.waitForTimeout(4000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await page.locator('button[aria-label="Close the thread"]').first().click();
  await expect(subject).toHaveCount(0);
  const back = Date.now();
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - back).toBeGreaterThanOrEqual(2000);
});

test('never over a file open beside a thread, nor the thread alone: it waits, unspent; back on the list, after the short wait', async ({ browser }) => {
  const w = await world({ earlier: true, attachment: true });
  const page = await (await context(browser, { reduce: true })).newPage();
  await page.goto(`${w.url}#thread=${w.opened}&file=${w.file}&view=side`);
  await expect(page.locator('.ib-pane h2.ib-subject').first()).toBeVisible({ timeout: 15_000 });
  const close = page.getByRole('button', { name: 'Close row-notes.md' });
  await expect(close).toBeVisible({ timeout: 15_000 });
  // Well past the wait: nothing over the file, and the claim is not spent.
  await page.waitForTimeout(6000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(saved(w)?.shownAt).toBeUndefined();
  await shot(page, 'file-open-no-dialog');
  // The file closed, the thread alone: still nothing.
  await close.click();
  await expect(close).toHaveCount(0);
  await page.waitForTimeout(4000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(saved(w)?.shownAt).toBeUndefined();
  // Back on the list: after the same short wait, never at once.
  await page.locator('button[aria-label="Close the thread"]').first().click();
  const closed = Date.now();
  await page.waitForTimeout(1000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - closed).toBeGreaterThanOrEqual(2000);
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
  expect(await page.evaluate(() => location.hash)).not.toContain('file=');
});

test('the dialog and its picture follow the window\'s mode, its words at WCAG AA in both; each look picked', async ({ browser }) => {
  const cases = [
    { dark: false, phone: false, name: 'desktop-light' },
    { dark: true, phone: false, name: 'desktop-dark' },
    { dark: false, phone: true, name: 'phone-light' },
    { dark: true, phone: true, name: 'phone-dark' },
  ];
  for (const { dark, phone, name } of cases) {
    const w = await world({ earlier: true });
    const page = await (await context(browser, { dark, phone, reduce: true })).newPage();
    await page.goto(w.url);
    await heldDialog(page);
    expect(await page.evaluate(() => document.documentElement.classList.contains('light'))).toBe(!dark);
    // No light scope anywhere: the picture follows the mode (the owner, q-fd707b9e), and it is not a second window root.
    const scopes = await page.evaluate(() => ({
      light: document.querySelectorAll('body .light, .ib-lightscope').length,
      roots: document.querySelectorAll('.pn-inbox').length,
    }));
    expect(scopes).toEqual({ light: 0, roots: 1 });
    await shot(page, `${name}-held`);
    for (const id of LOOKS) {
      await pick(page, id);
      await shot(page, `${name}-${id}`);
    }
    const c = await dialogContrast(page);
    if (dark) {
      expect(c.background, `a dark dialog: ${JSON.stringify(c)}`).toBeLessThan(0.1);
      expect(c.picture, `a dark picture: ${JSON.stringify(c)}`).toBeLessThan(0.1);
    } else {
      expect(c.background, `a light dialog: ${JSON.stringify(c)}`).toBeGreaterThan(0.8);
      expect(c.picture, `a light picture: ${JSON.stringify(c)}`).toBeGreaterThan(0.8);
    }
    for (const key of ['title', 'line', 'customize', 'lookName', 'pickedName', 'current', 'keep', 'done']) expect(c[key], `${name} ${key}: text 4.5:1 (${JSON.stringify(c)})`).toBeGreaterThanOrEqual(4.5);
    await closeWorlds();
  }
});

test('a 390 px phone: a bottom sheet with the three looks and 44 px buttons', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser, { phone: true, reduce: true })).newPage();
  await page.goto(w.url);
  await heldDialog(page);
  const box = (await page.locator(DIALOG).boundingBox())!;
  const why = await page.locator(DIALOG).evaluate((el) => JSON.stringify({ vw: innerWidth, cw: document.documentElement.clientWidth, width: getComputedStyle(el).width, margin: getComputedStyle(el).margin }));
  // A sheet: 8 px from each side and the bottom.
  expect(Math.round(box.x), why).toBe(8);
  expect(Math.round(390 - box.x - box.width), why).toBe(8);
  expect(Math.round(844 - box.y - box.height)).toBeLessThanOrEqual(9);
  // The three looks side by side, inside the sheet.
  const looks = await page.locator(`${DIALOG} [data-list-intro-look]`).evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, right: r.right })));
  expect(looks).toHaveLength(3);
  expect(new Set(looks.map((l) => Math.round(l.y))).size).toBe(1);
  for (const l of looks) expect(l.x >= box.x && l.right <= box.x + box.width).toBe(true);
  for (const button of await page.locator(`${DIALOG} .ib-lo-acts .ib-btn`).all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await pick(page, 'minimal');
  await expect(page.locator(`${DIALOG} .ib-rl-cl[data-look="minimal"] .ib-mrow`).first()).toBeVisible();
});

test('the demo, recorded', async ({ browser }) => {
  const w = await world({ earlier: true });
  const ctx = await context(browser, { video: true });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(w.url);
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  const openedAt = (Date.now() - t0) / 1000;
  const box = (await page.locator(DIALOG).boundingBox())!;
  await heldDialog(page);
  await page.waitForTimeout(900);
  await pick(page, 'detailed');
  await page.waitForTimeout(900);
  const video = page.video()!;
  await ctx.close();
  writeFileSync(join(proofDir, 'video', 'preview.json'), JSON.stringify({ path: await video.path(), openedAt, box }));
});
