/**
 * The one-time list options dialog (approval "inbox-list-options-intro", 2026-10-31), proved in a real Chromium
 * against a compiled binary under temp HOMEs and data dirs. The spec compiles its own binary with a release version
 * (0.30.0): the shared e2e binary is 0.0.0-dev, which never decides the dialog (so it never shows in other specs).
 * Each case is its own Inbox (the dialog is once per machine); agents write through `plannotator inbox mcp`.
 *
 *  - A new user (a fresh install) never gets it, even with a long list.
 *  - Someone who used an Inbox before: it shows once, in one of two tabs, plays its preview (each option on in turn,
 *    then all off), and Done puts the switches on the real list at once, which a reload keeps; it never shows again.
 *  - Escape and Keep as it is change nothing and retire it (with reduced motion: no preview at all).
 *  - A key or a click during the preview ends it at once, back to the defaults.
 *  - Never on the same load as the sound dialog or the tour; the next load shows it.
 *  - With a thread open too (the owner, 2026-10-31): a first load on a thread link (desktop or phone) shows it over the
 *    thread after the same short wait as a first load on the list, with the picture's rows drawn (a phone hides the
 *    real list under a thread); never while a reply is being typed there or left with words in its box, then once
 *    it is not; never while a file is open beside the thread, then after the short wait once it is closed; never
 *    under an image opened full size or a modal layer; another thread opened just before the wait ends starts it again.
 *  - The dialog follows the window's mode, its text and switches at WCAG AA in dark and light (desktop and a dark
 *    phone); only its picture is light, in both (and under Synthwave '84), and nothing else on the page is a light
 *    scope or a second window root.
 *  - The picture's thread names stay on one line, a long one cut with "…" (the owner: no long names in the examples).
 *  - Smaller thread names is the fourth switch, in the preview and saved by Done.
 *  - Dark, and a 390 px phone: a bottom sheet with the phone's rows.
 *
 * Build the apps first (bun run --cwd apps/review build && bun run build:hook), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-list-intro.spec.ts`. PNGs and a video of the preview
 * land in PLANNOTATOR_E2E_PROOF_DIR/list-intro, or .local/proof/list-intro/.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'list-intro');
const VERSION = '0.30.0';
const DIALOG = '[data-dialog="list-look-intro"]';
const KEYS = ['highlight', 'compact', 'hideAgents', 'smallNames'] as const;
const LONG_NAME = 'Ledger reconciliation dry run for the quarter-end close across every subsidiary and region';

let binary = '';
let scratch = '';
const agents: SimAgent[] = [];
const contexts: BrowserContext[] = [];

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
 * with the sound dialog and the agent notes already behind them unless `soundDue`.
 */
async function world(options: { earlier: boolean; soundDue?: boolean; attachment?: boolean }): Promise<World> {
  const root = realpathSync(mkdtempSync(join(scratch, 'world-')));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home);
  if (options.earlier) {
    writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ inboxVersion: '0.29.0' }));
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({
        inboxTour: { version: 2, seen_at: '2026-10-01T10:00:00.000Z', skipped_at: '2026-10-01T10:00:00.000Z' },
        inboxNotifications: { dismissed: true },
        inboxAgentNotes: { offered: true },
        ...(options.soundDue ? {} : { inboxSound: { dialogShownFor: '0.29.0' } }),
      }),
    );
  }
  const env = { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_PHONES: '0' };
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

function saved(w: World): { dueAt?: string; shownAt?: string } | undefined {
  const path = join(w.dataDir, 'config.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).inboxListIntro : undefined;
}

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

const lookClasses = (page: Page) => page.locator('.pn-inbox .ib-listcol:not(.ib-lo-list)').first().evaluate((el) => [...el.classList].filter((c) => c.startsWith('ib-lk-')).sort());
const option = (page: Page, key: string) => page.locator(`${DIALOG} [data-list-intro-option="${key}"]`);

async function allOff(page: Page) {
  for (const key of KEYS) await expect(option(page, key)).toHaveAttribute('aria-checked', 'false');
}

/** The dialog is up and its preview has played out (or never played): every switch off and usable. */
async function settledDialog(page: Page) {
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-list-intro-playing]')).toHaveCount(0, { timeout: 5_000 });
  await allOff(page);
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

/** Every thread name in the picture is one line; the long one is cut with "…". */
async function namesOneLine(page: Page) {
  const names = await page.locator(`${DIALOG} .ib-lo-frame :is(.ib-title, .ib-m2)`).evaluateAll((els) =>
    els.map((el) => {
      const style = getComputedStyle(el);
      return { text: el.textContent ?? '', lines: Math.round(el.getBoundingClientRect().height / parseFloat(style.lineHeight)), cut: el.scrollWidth > el.clientWidth + 0.5, overflow: style.textOverflow };
    }),
  );
  expect(names.length).toBeGreaterThanOrEqual(3);
  for (const name of names) expect(name.lines, `"${name.text}" on one line`).toBe(1);
  const long = names.find((name) => name.text === LONG_NAME);
  expect(long, 'the long name is in the picture').toBeTruthy();
  expect(long).toMatchObject({ cut: true, overflow: 'ellipsis' });
}

/**
 * WCAG contrast of the dialog's words and switches against what they sit on, in sRGB as Chromium paints the
 * colours (a 1 px canvas resolves oklch and color-mix). Text 4.5:1; an off switch's outline and its thumb 3:1.
 */
async function dialogContrast(page: Page): Promise<Record<string, number>> {
  return page.locator(DIALOG).evaluate((dialog) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const rgb = (color: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!];
    };
    const lum = (color: string) => {
      const [r, g, b] = rgb(color).map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
      return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100;
    };
    const bg = getComputedStyle(dialog).backgroundColor;
    const color = (sel: string) => getComputedStyle(dialog.querySelector(sel)!).color;
    const done = dialog.querySelector('[data-list-intro-done]')!;
    const off = dialog.querySelector<HTMLElement>('.ib-sw[aria-checked="false"]')!;
    const offStyle = getComputedStyle(off);
    const picture = dialog.querySelector('[data-list-intro-picture]')!;
    const pictureBg = getComputedStyle(picture).backgroundColor;
    const band = getComputedStyle(picture.querySelector('.ib-band')!);
    return {
      background: lum(bg),
      picture: lum(pictureBg),
      pictureName: ratio(getComputedStyle(picture.querySelector('.ib-title, .ib-m2')!).color, pictureBg),
      // Text that takes its colour from the picture itself, not a row: the first band's label on the band, and the
      // desktop picture's list header (none on a phone, so it passes as 21).
      pictureBand: ratio(band.color, band.backgroundColor === 'rgba(0, 0, 0, 0)' ? pictureBg : band.backgroundColor),
      pictureHeader: picture.querySelector('.ib-lhead h1') ? ratio(getComputedStyle(picture.querySelector('.ib-lhead h1')!).color, pictureBg) : 21,
      title: ratio(color('#ib-lo-title'), bg),
      line: ratio(color('#ib-lo-desc'), bg),
      label: ratio(color('.ib-lo-opt > span'), bg),
      keep: ratio(color('[data-list-intro-keep]'), bg),
      done: ratio(getComputedStyle(done).color, getComputedStyle(done).backgroundColor),
      offOutline: ratio(offStyle.borderTopColor, bg),
      offThumb: ratio(getComputedStyle(off, '::after').backgroundColor, offStyle.backgroundColor),
    };
  });
}

function contrastPasses(c: Record<string, number>) {
  for (const key of ['title', 'line', 'label', 'keep', 'done', 'pictureName', 'pictureBand', 'pictureHeader']) expect(c[key], `${key}: text 4.5:1`).toBeGreaterThanOrEqual(4.5);
  for (const key of ['offOutline', 'offThumb']) expect(c[key], `${key}: 3:1`).toBeGreaterThanOrEqual(3);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run build:review && bun run build:hook)').toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  scratch = inboxScratch('plannotator-inbox-list-intro-');
  binary = compileReleaseBinary();
});

test.afterAll(async () => {
  try {
    for (const ctx of contexts) await ctx.close().catch(() => {});
    await Promise.all(agents.map((a) => a.close().catch(() => {})));
  } finally {
    await removeInboxScratch();
  }
});

test('a new user never gets it, even with a long list', async ({ browser }) => {
  const w = await world({ earlier: false });
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
  const page = await (await context(browser)).newPage();
  await page.goto(w.url);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  await page.waitForTimeout(3500);
  await expect(page.locator(DIALOG)).toHaveCount(0);
});

test('once, in one of two tabs: the preview plays, Done puts the switches on the real list at once, a reload keeps them', async ({ browser }) => {
  const w = await world({ earlier: true });
  expect(saved(w)?.dueAt).toMatch(/^\d{4}-/);
  const ctx = await context(browser);
  const [a, b] = await Promise.all([ctx.newPage(), ctx.newPage()]);
  await Promise.all([a.goto(w.url), b.goto(w.url)]);
  await expect.poll(async () => (await a.locator(DIALOG).count()) + (await b.locator(DIALOG).count()), { timeout: 15_000 }).toBe(1);
  const page = (await a.locator(DIALOG).count()) === 1 ? a : b;
  const other = page === a ? b : a;
  // The preview: Highlight first, the switches out of reach meanwhile, and the real rows in the picture change.
  await expect(option(page, 'highlight')).toHaveAttribute('aria-checked', 'true', { timeout: 3_000 });
  await expect(page.locator(`${DIALOG} .ib-lo-list.ib-lk-pill`)).toHaveCount(1);
  await settledDialog(page);
  await shot(page, 'desktop-light-open');
  await option(page, 'highlight').click();
  await option(page, 'compact').click();
  await expect(page.locator(`${DIALOG} .ib-lo-list.ib-lk-pill.ib-lk-compact`)).toHaveCount(1);
  await namesOneLine(page);
  await shot(page, 'desktop-light-options-on');
  // The real list is today's until Done.
  expect(await lookClasses(page)).toEqual([]);
  await page.locator('[data-list-intro-done]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(await lookClasses(page)).toEqual(['ib-lk-compact', 'ib-lk-pill']);
  await shot(page, 'after-done');
  await page.reload();
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  expect(await lookClasses(page)).toEqual(['ib-lk-compact', 'ib-lk-pill']);
  await other.reload();
  await page.waitForTimeout(3000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(other.locator(DIALOG)).toHaveCount(0);
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
});

for (const how of ['Escape', 'Keep as it is'] as const) {
  test(`${how} changes nothing and retires it; with reduced motion there is no preview`, async ({ browser }) => {
    const w = await world({ earlier: true });
    const page = await (await context(browser, { reduce: true })).newPage();
    await page.goto(w.url);
    await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
    // Reduced motion: never a preview; the switches are usable from the start.
    await expect(page.locator('[data-list-intro-playing]')).toHaveCount(0);
    await page.waitForTimeout(700);
    await allOff(page);
    // Tab stays inside the dialog and never lands on the picture's (inert) rows.
    await expect(page.locator('[data-list-intro-done]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(option(page, 'highlight')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('[data-list-intro-done]')).toBeFocused();
    await option(page, 'compact').click();
    await option(page, 'hideAgents').click();
    if (how === 'Escape') await page.keyboard.press('Escape');
    else await page.locator('[data-list-intro-keep]').click();
    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(await lookClasses(page)).toEqual([]);
    // The list is still there: Escape closed only the dialog.
    await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
    await page.reload();
    await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(await lookClasses(page)).toEqual([]);
  });
}

for (const how of ['a key', 'a click'] as const) {
  test(`${how} during the preview ends it at once, back to the defaults`, async ({ browser }) => {
    const w = await world({ earlier: true });
    const page = await (await context(browser)).newPage();
    await page.goto(w.url);
    await expect(option(page, 'compact')).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
    await expect(page.locator('[data-list-intro-playing]')).toHaveCount(1);
    // The key is Tab: it ends the preview and moves focus from Done (the first focus) to the first switch.
    if (how === 'a key') await page.keyboard.press('Tab');
    else await page.locator(`${DIALOG} #ib-lo-title`).click();
    await expect(page.locator('[data-list-intro-playing]')).toHaveCount(0);
    if (how === 'a key') await expect(option(page, 'highlight')).toBeFocused();
    await allOff(page);
    await expect(page.locator(`${DIALOG} .ib-lo-list`)).not.toHaveClass(/ib-lk-/);
    // Nothing plays on after it, and the switches answer.
    await page.waitForTimeout(1800);
    await allOff(page);
    await option(page, 'hideAgents').click();
    await expect(option(page, 'hideAgents')).toHaveAttribute('aria-checked', 'true');
  });
}

test('never on the same load as the sound dialog: the next load shows it', async ({ browser }) => {
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
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  await expect(sound).toHaveCount(0);
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
  test(`a first load on a thread link${phone ? ' on a phone' : ''}: it shows over the thread after the short wait`, async ({ browser }) => {
    const w = await world({ earlier: true });
    const page = await (await context(browser, { phone, reduce: true })).newPage();
    const t0 = Date.now();
    await page.goto(`${w.url}#thread=${w.opened}`);
    const subject = page.locator('.ib-pane h2.ib-subject').first();
    await expect(subject).toBeVisible({ timeout: 15_000 });
    // Not the moment the thread is up: after the same short wait as a first load on the list.
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);
    expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
    await settledDialog(page);
    // The thread stays open behind it, and the picture's rows are drawn (a phone hides its real list under a thread).
    await expect(subject).toBeAttached();
    expect(await page.evaluate(() => location.hash)).toContain(`thread=${w.opened}`);
    await expect(page.locator(`${DIALOG} .ib-lo-frame ${phone ? '.ib-mrow' : '.ib-nrow'}`).first()).toBeVisible();
    await namesOneLine(page);
    await shot(page, `thread-link${phone ? '-phone' : ''}-dialog`);
    // Once: Keep as it is retires it, and closing and opening the thread never brings it again.
    await page.locator('[data-list-intro-keep]').click();
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await expect(subject).toBeVisible();
    await page.locator(phone ? '[data-phone-back]' : 'button[aria-label="Close the thread"]').first().click();
    await expect(subject).toHaveCount(0);
    await page.locator('.ib-lbody [data-thread-id]').first().click();
    await expect(subject).toBeVisible();
    await page.waitForTimeout(3500);
    await expect(page.locator(DIALOG)).toHaveCount(0);
  });
}

test('over a thread, never while a reply is being typed: it waits, unspent, and shows once the reply is gone', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser, { reduce: true })).newPage();
  await page.goto(`${w.url}#thread=${w.opened}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('h2.ib-subject')).toBeVisible({ timeout: 15_000 });
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  const box = pane.locator('textarea');
  await box.fill('Build the pill version.');
  // Well past the wait: nothing over the reply, and the claim is not spent.
  await page.waitForTimeout(6000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(saved(w)?.shownAt).toBeUndefined();
  // Focus leaves the box, its words still in it: still nothing, still unspent.
  await pane.locator('h2.ib-subject').click();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
  await expect(box).toHaveValue('Build the pill version.');
  await page.waitForTimeout(6000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(saved(w)?.shownAt).toBeUndefined();
  // The reply gone and the box left: it shows over the thread.
  await box.fill('');
  await pane.locator('h2.ib-subject').click();
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
});

test('never under an image opened full size or another modal layer: it waits, unspent, and shows once it is gone', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser, { reduce: true })).newPage();
  await page.goto(`${w.url}#thread=${w.opened}`);
  await expect(page.locator('.ib-pane h2.ib-subject').first()).toBeVisible({ timeout: 15_000 });
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

test('another thread opened just before the wait ends: the wait starts again from there', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser, { reduce: true })).newPage();
  await page.goto(w.url);
  const rows = page.locator('.ib-lbody [data-thread-id]');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  // Just short of the wait from the list's first draw.
  await page.waitForTimeout(2000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await rows.first().click();
  const opened = Date.now();
  await expect(page.locator('.ib-pane h2.ib-subject').first()).toBeVisible();
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - opened).toBeGreaterThanOrEqual(2000);
});

test('never over a file open beside a thread: it waits, unspent; closed, it shows after the short wait', async ({ browser }) => {
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
  // The file closed, the thread alone: after the same short wait, never at once.
  await close.click();
  const closed = Date.now();
  await expect(close).toHaveCount(0);
  await page.waitForTimeout(1000);
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - closed).toBeGreaterThanOrEqual(2000);
  expect(saved(w)?.shownAt).toMatch(/^\d{4}-/);
  expect(await page.evaluate(() => location.hash)).not.toContain('file=');
});

test('the dialog follows the window\'s mode and passes WCAG AA in both; only its picture is light', async ({ browser }) => {
  const cases = [
    { dark: true, phone: false, name: 'dark-window-dark-dialog-light-preview' },
    { dark: false, phone: false, name: 'light-window-light-dialog' },
    { dark: true, phone: true, name: 'phone-dark' },
  ];
  for (const { dark, phone, name } of cases) {
    const w = await world({ earlier: true });
    const page = await (await context(browser, { dark, phone, reduce: true })).newPage();
    await page.goto(`${w.url}#thread=${w.opened}`);
    await settledDialog(page);
    expect(await page.evaluate(() => document.documentElement.classList.contains('light'))).toBe(!dark);
    // The light scope is the picture alone: no other element of the page is light or a scope, and the picture is
    // not a second window root (`.pn-inbox`), so the window's own layout rules never reach it.
    const scopes = await page.evaluate(() => ({
      light: [...document.querySelectorAll('body .light, .ib-lightscope')].map((el) => ({ picture: el.hasAttribute('data-list-intro-picture'), dialogText: el.querySelectorAll('#ib-lo-title, [role="switch"], [data-list-intro-done]').length })),
      roots: document.querySelectorAll('.pn-inbox').length,
      pictureRoot: document.querySelector('[data-list-intro-picture]')!.classList.contains('pn-inbox'),
    }));
    expect(scopes).toEqual({ light: [{ picture: true, dialogText: 0 }], roots: 1, pictureRoot: false });
    // The thread behind keeps the window's mode.
    const paneLight = await page.locator('section.ib-pane').first().evaluate((el) => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return (r! + g! + b!) / 3 > 128;
    });
    expect(paneLight, 'the thread behind').toBe(!dark);
    const c = await dialogContrast(page);
    // The dialog in the window's mode; the picture light in both.
    if (dark) expect(c.background, `a dark dialog: ${JSON.stringify(c)}`).toBeLessThan(0.1);
    else expect(c.background, `a light dialog: ${JSON.stringify(c)}`).toBeGreaterThan(0.8);
    expect(c.picture, `a light picture: ${JSON.stringify(c)}`).toBeGreaterThan(0.8);
    contrastPasses(c);
    // The picture's bottom: in a dark dialog the rows fade into the card's own light ground (no mask, a clean rounded
    // edge, its bottom row of pixels the card's colour); in a light one, the approved fade to transparent.
    const edge = await page.locator('[data-list-intro-picture]').evaluate((el) => {
      const style = getComputedStyle(el);
      const after = getComputedStyle(el, '::after');
      return { mask: style.maskImage, radius: style.borderBottomLeftRadius, fade: after.backgroundImage, fadeBottom: after.bottom, card: style.backgroundColor };
    });
    if (dark) {
      expect(edge.mask).toBe('none');
      expect(edge.radius).toBe('10px');
      expect(edge.fade).toContain('linear-gradient');
      expect(edge.fadeBottom).toBe('0px');
    } else {
      expect(edge.mask).toContain('linear-gradient');
      expect(edge.radius).toBe('0px');
      expect(edge.fade).toBe('none');
    }
    await namesOneLine(page);
    await shot(page, name);
    if (dark && !phone) {
      // A dark palette with its own ground rule for the window (Synthwave '84, Terminal): the picture keeps its own.
      const ground = () => page.locator('[data-list-intro-picture]').evaluate((el) => getComputedStyle(el).getPropertyValue('--ib-ground-panes').trim());
      const before = await ground();
      await page.evaluate(() => {
        const root = document.documentElement;
        for (const cls of [...root.classList]) if (cls.startsWith('theme-')) root.classList.remove(cls);
        root.classList.add('theme-synthwave-84');
      });
      expect(await ground()).toBe(before);
      const synth = await dialogContrast(page);
      expect(synth.picture, `a light picture under Synthwave: ${JSON.stringify(synth)}`).toBeGreaterThan(0.8);
    }
  }
});

test('Smaller thread names: the fourth switch, in the preview, saved by Done', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser)).newPage();
  await page.goto(w.url);
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`${DIALOG} [role="switch"]`)).toHaveCount(4);
  await expect(page.locator(`${DIALOG} .ib-lo-opt > span`)).toHaveText(['Highlight thread subject', 'Compact rows', 'Hide agent icons', 'Smaller thread names']);
  // The preview reaches it last, all four on together, then all off.
  await expect(option(page, 'smallNames')).toHaveAttribute('aria-checked', 'true', { timeout: 4_000 });
  await expect(page.locator(`${DIALOG} .ib-lo-list.ib-lk-small`)).toHaveCount(1);
  for (const key of KEYS) await expect(option(page, key)).toHaveAttribute('aria-checked', 'true');
  await settledDialog(page);
  await option(page, 'smallNames').click();
  await page.locator('[data-list-intro-done]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(await lookClasses(page)).toEqual(['ib-lk-small']);
  await page.reload();
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  expect(await lookClasses(page)).toEqual(['ib-lk-small']);
});

test('dark, with options on', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser, { dark: true, reduce: true })).newPage();
  await page.goto(w.url);
  await settledDialog(page);
  await option(page, 'highlight').click();
  await option(page, 'compact').click();
  await shot(page, 'desktop-dark-options-on');
});

test('a 390 px phone: a bottom sheet with the phone rows', async ({ browser }) => {
  const w = await world({ earlier: true });
  const page = await (await context(browser, { phone: true, reduce: true })).newPage();
  await page.goto(w.url);
  await settledDialog(page);
  await namesOneLine(page);
  await shot(page, 'phone-390');
  const box = (await page.locator(DIALOG).boundingBox())!;
  const why = await page.locator(DIALOG).evaluate((el) => JSON.stringify({ vw: innerWidth, cw: document.documentElement.clientWidth, width: getComputedStyle(el).width, margin: getComputedStyle(el).margin }));
  // A sheet: 8 px from each side and the bottom.
  expect(Math.round(box.x), why).toBe(8);
  expect(Math.round(390 - box.x - box.width), why).toBe(8);
  expect(Math.round(844 - box.y - box.height)).toBeLessThanOrEqual(9);
  await expect(page.locator(`${DIALOG} .ib-mrow`).first()).toBeVisible();
  for (const button of await page.locator(`${DIALOG} .ib-lo-acts .ib-btn`).all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await option(page, 'highlight').click();
  await option(page, 'compact').click();
  await shot(page, 'phone-390-options-on');
});

test('the preview, recorded', async ({ browser }) => {
  const w = await world({ earlier: true });
  const ctx = await context(browser, { video: true });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(w.url);
  await expect(page.locator(DIALOG)).toBeVisible({ timeout: 15_000 });
  const openedAt = (Date.now() - t0) / 1000;
  const box = (await page.locator(DIALOG).boundingBox())!;
  await settledDialog(page);
  await page.waitForTimeout(900);
  const video = page.video()!;
  await ctx.close();
  writeFileSync(join(proofDir, 'video', 'preview.json'), JSON.stringify({ path: await video.path(), openedAt, box }));
});
