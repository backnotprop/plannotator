/**
 * Filter by typing (components/TitleFilter.tsx, listTitleFilter.ts) in a real Chromium against the compiled binary,
 * agents writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - the funnel's menu has one new row first, alone above Not seen (the search mark, no count);
 *  - its click closes the menu and a field eases in under the header, focused, "Filter by title", the header itself
 *    unchanged (the funnel alone, no badge);
 *  - typing narrows the list by title on every key, no Enter: three of six threads hold "page", band counts follow; a
 *    row that stops matching shrinks and fades where it was (a hidden copy, never a row), with reduced motion at once;
 *  - with a project picked in the menu, the words narrow what the pick left;
 *  - nothing matching reads "No threads match" where the list would be;
 *  - opening a thread and closing it, and a reload, keep the field and its words;
 *  - Escape empties it, folds it away while the whole list comes back in the same motion, gives back every row and
 *    focus to the funnel;
 *  - a phone, 390 wide: the same row in the sheet flies up to become the field under the header, typing narrows.
 *
 * What this catches: the row missing or not first; a field that does not open, take focus, or ease in; typing that
 * needs Enter or does not narrow; a leaving row that is not animated, is taken for a row, or animates with reduced
 * motion; the words replacing the menu's picks; no words when nothing matches; the field lost when a thread opens or
 * the page reloads; Escape that leaves the field, the words, a narrowed list or focus nowhere, or a list that comes
 * back with no motion; a phone that draws any of it differently or skips the row's flight.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/filter-typing (CI keeps .local/proof/ as the shard's "inbox-window-proof"
 * artifact): 01-menu-row, 02-field-open, 03a-row-leaving (held 40 ms into the exit), 03-typing, 04-no-match,
 * 05a-closing (held 90 ms into the close), 05-closed, 06-phone-menu, 06a-phone-travel (held 100 ms into the flight),
 * 07-phone-field-open, 08-phone-typing. Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch } from './inbox-scratch';
import { TITLE_FILTER_LABEL, TITLE_FILTER_NONE, TITLE_FILTER_PLACEHOLDER } from '../../packages/inbox/listTitleFilter';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'filter-typing');

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  ids: Record<'trash' | 'retry' | 'invoice' | 'search' | 'history' | 'webhook', string>;
}

let world: World;

test.describe.configure({ mode: 'serial' });

const funnel = (page: Page) => page.locator('.ib-lhead [data-list-filter]');
const titleRow = (page: Page) => page.locator('[data-list-filter-menu] [data-list-filter-title]');
const field = (page: Page) => page.locator('[data-title-filter-input]');
/** The list's thread ids, top to bottom (Quiet's folded rows are not drawn). */
const listOrder = (page: Page) => page.locator('.ib-lbody [data-thread-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-thread-id')));
const sorted = (ids: (string | null)[]) => [...ids].sort();
/** Each band drawn and its count, "New since you looked 3". */
const bands = (page: Page) =>
  page.locator('.ib-lbody .ib-group[data-section-id]').evaluateAll((groups) => groups.map((g) => (g.querySelector('.ib-band')?.textContent ?? '').replace(/\s+/g, ' ').trim()));

async function shot(page: Page, name: string) {
  // The menu's entrance, or the field's ease (200 ms), has played.
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(proofDir, name) });
}

/** No pointer over a row (no tooltip, no hover). */
async function pointerAway(page: Page) {
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 1440) - 10, (size?.height ?? 900) - 40);
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-filter-typing-e2e-');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify(E2E_LAUNCH_OFF));
  const web = scratchProject(join(root, 'src'), 'web-app');
  const api = scratchProject(join(root, 'src'), 'billing-svc');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: data, PLANNOTATOR_TEST_SANDBOX: '1', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const send = async (agent: SimAgent, project: string, subject: string, thread: string, body: string) => (await agent.send({ project_path: project, subject, thread, body })).thread_id as string;
  const ids = {
    trash: await send(claude, web, 'Trash for deleted pages', 'trash', 'Deleted pages now go to a trash for 30 days. Ada Novak asked for it.'),
    retry: await send(codex, api, 'Retry worker on a 409', 'retry', 'The worker retries a 409 three times, then gives up.'),
    invoice: await send(claude, api, 'Invoice PDF export', 'invoice', 'Invoices export as PDF now. Bob Tully checked the totals.'),
    search: await send(codex, web, 'Search results page layout', 'search', 'The results page uses two columns on wide screens.'),
    history: await send(claude, web, 'Page history: restore a version', 'history', 'Any earlier version of a page can be restored.'),
    webhook: await send(codex, api, 'Webhook signature check', 'webhook', 'Every webhook is checked against its signature. Charlie Dunn reviewed it.'),
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = started.stdout.trim();
  await page.goto(url);
  world = { url, agents: [claude, codex], context, page, errors, ids };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    for (const agent of world.agents) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test("the funnel's menu: the new row first, alone above Not seen, the search mark and no count", async () => {
  const { page, ids } = world;
  await expect(page.locator(`.ib-lbody [data-thread-id="${ids.webhook}"]`)).toBeVisible();
  expect(sorted(await listOrder(page))).toEqual(sorted(Object.values(ids)));
  await funnel(page).click();
  await expect(titleRow(page)).toBeVisible();
  const first = page.locator('[data-list-filter-menu] .ib-pmi').first();
  await expect(first).toHaveAttribute('data-list-filter-title', '');
  await expect(first.locator('.ib-pmi-l')).toHaveText(TITLE_FILTER_LABEL);
  await expect(first.locator('.ib-pmi-n')).toHaveCount(0);
  await expect(first.locator('svg')).toHaveCount(1);
  // Its own section: the menu's separator, then Not seen.
  expect(await first.evaluate((el) => el.nextElementSibling?.classList.contains('ib-pm-sep') ?? false)).toBe(true);
  await expect(page.locator('[data-list-filter-menu] .ib-pmi').nth(1)).toHaveAttribute('data-list-filter-not-seen', '');
  await shot(page, '01-menu-row.png');
  expect(world.errors).toEqual([]);
});

test('the row closes the menu; the field eases in under the header, focused; the header is unchanged', async () => {
  const { page, ids } = world;
  await titleRow(page).click();
  await expect(page.locator('[data-list-filter-menu]')).toHaveCount(0);
  await expect(field(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveAttribute('placeholder', TITLE_FILTER_PLACEHOLDER);
  await expect(field(page)).toHaveAttribute('aria-label', TITLE_FILTER_PLACEHOLDER);
  // Under the header, not in it; the funnel alone in the header, no badge.
  expect(await page.locator('[data-title-filter]').evaluate((el) => el.previousElementSibling?.classList.contains('ib-lhead') ?? false)).toBe(true);
  await expect(page.locator('.ib-lhead [data-title-filter]')).toHaveCount(0);
  await expect(page.locator('[data-list-filter-count]')).toHaveCount(0);
  // The field sits above the first band, which moved down by the field's height only.
  const fieldBox = (await page.locator('[data-title-filter]').boundingBox())!;
  const bandBox = (await page.locator('.ib-lbody .ib-group[data-section-id]').first().boundingBox())!;
  expect(bandBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height - 1);
  expect(fieldBox.height).toBeLessThan(48);
  expect(sorted(await listOrder(page))).toEqual(sorted(Object.values(ids)));
  await pointerAway(page);
  await shot(page, '02-field-open.png');
  expect(world.errors).toEqual([]);
});

/**
 * Types `text` into the field as one key does (the input event), and reports in that same task, before any paint, the
 * copies of rows leaving (titleFilterRows.ts) and what else animates in the list; `pauseAt` holds every animation at
 * that time (ms) for a still, `release` lets them finish.
 */
async function typeAndCatch(page: Page, text: string, pauseAt: number | null = null) {
  return field(page).evaluate(
    (input: HTMLInputElement, { text, pauseAt }) => {
      // Only what this key starts counts: an earlier test's last key may still be playing its exit in the list.
      const ghostsBefore = new Set(document.querySelectorAll('.ib-lbody [data-tflt-ghost]'));
      const movingBefore = new Set(document.querySelector('.ib-lbody')!.getAnimations({ subtree: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const body = document.querySelector('.ib-lbody')!;
      const ghosts = [...body.querySelectorAll<HTMLElement>('[data-tflt-ghost]')].filter((g) => !ghostsBefore.has(g));
      const moving = body.getAnimations({ subtree: true }).filter((a) => !movingBefore.has(a));
      if (pauseAt !== null) for (const a of document.getAnimations()) (a.pause(), (a.currentTime = pauseAt));
      return {
        ghosts: ghosts.length,
        hidden: ghosts.every((g) => g.getAttribute('aria-hidden') === 'true' && g.inert && !g.querySelector('[data-thread-id]')),
        moving: moving.length,
      };
    },
    { text, pauseAt },
  );
}
/**
 * Finishes every animation that has an end; one that loops for ever (the sidebar's mascot, a spinner) cannot be
 * finished, so it only plays on again from where `pauseAt` held it.
 */
const release = (page: Page) =>
  page.evaluate(() => {
    for (const a of document.getAnimations()) {
      if (a.effect && Number.isFinite(a.effect.getComputedTiming().endTime as number)) a.finish();
      else a.play();
    }
  });

test('typing narrows the list on every key, no Enter; band counts follow', async () => {
  const { page, ids } = world;
  // "p": the two rows that stop matching shrink and fade where they were (a copy each, never taken for a row).
  const caught = await typeAndCatch(page, 'p', 40);
  expect(caught.ghosts).toBeGreaterThanOrEqual(2);
  expect(caught.hidden).toBe(true);
  await shot(page, '03a-row-leaving.png');
  await release(page);
  await expect(page.locator('.ib-lbody [data-tflt-ghost]')).toHaveCount(0);
  await expect.poll(async () => sorted(await listOrder(page))).toEqual(sorted([ids.trash, ids.invoice, ids.search, ids.history]));
  await page.keyboard.type('age');
  await expect.poll(async () => sorted(await listOrder(page))).toEqual(sorted([ids.trash, ids.search, ids.history]));
  // Every band drawn counts only its matches: three rows in all.
  const counts = (await bands(page)).map((words) => Number(/(\d+)$/.exec(words)?.[1] ?? 0));
  expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
  await pointerAway(page);
  await shot(page, '03-typing.png');
  expect(world.errors).toEqual([]);
});

test("with a project picked, the words narrow what the pick left; the pick stays", async () => {
  const { page, ids } = world;
  await funnel(page).click();
  const billing = page.locator('[data-list-filter-menu] [data-list-filter-project]').filter({ hasText: 'billing-svc' });
  await billing.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-list-filter-menu]')).toHaveCount(0);
  await field(page).fill('e');
  await expect.poll(async () => sorted(await listOrder(page))).toEqual(sorted([ids.retry, ids.invoice, ids.webhook]));
  await field(page).fill('export');
  await expect.poll(() => listOrder(page)).toEqual([ids.invoice]);
  await expect(page.locator('[data-list-filter-count]')).toHaveText('1');
  // The pick off again, the words still on.
  await funnel(page).click();
  await billing.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-list-filter-count]')).toHaveCount(0);
  await field(page).fill('page');
  await expect.poll(async () => sorted(await listOrder(page))).toEqual(sorted([ids.trash, ids.search, ids.history]));
  expect(world.errors).toEqual([]);
});

test('nothing matching: "No threads match" where the list would be', async () => {
  const { page } = world;
  // Reduced motion: the rows go at once, nothing plays.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await typeAndCatch(page, 'quarterly roadmap');
  expect(still).toEqual({ ghosts: 0, hidden: true, moving: 0 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.ib-lbody [data-title-filter-none]')).toHaveText(TITLE_FILTER_NONE);
  await expect(page.locator('.ib-lbody [data-thread-id]')).toHaveCount(0);
  await expect(page.locator('.ib-lbody [data-title-filter-none] button')).toHaveCount(0);
  await pointerAway(page);
  await shot(page, '04-no-match.png');
  expect(world.errors).toEqual([]);
});

test('a thread opened and closed, and a reload, keep the field and its words', async () => {
  const { page, ids } = world;
  await field(page).fill('page');
  await expect.poll(async () => sorted(await listOrder(page))).toEqual(sorted([ids.trash, ids.search, ids.history]));
  await page.locator(`.ib-lbody [data-thread-id="${ids.search}"]`).click();
  await expect(page.locator('section.ib-pane [aria-label="Close the thread"]')).toBeVisible();
  await expect(field(page)).toHaveValue('page');
  await page.locator('section.ib-pane [aria-label="Close the thread"]').click();
  await expect(field(page)).toHaveValue('page');
  await expect.poll(async () => sorted(await listOrder(page))).toEqual(sorted([ids.trash, ids.search, ids.history]));
  await page.reload();
  await expect(field(page)).toHaveValue('page');
  // The thread opened is read now, so the reload sorts it into Quiet, folded: two rows drawn, Quiet counts the third.
  await expect.poll(async () => sorted(await listOrder(page))).toEqual(sorted([ids.trash, ids.history]));
  const quiet = page.locator('.ib-lbody [data-section-id="quiet"] .ib-band');
  await expect(quiet).toHaveAttribute('aria-expanded', 'false');
  await expect(quiet.locator('.ib-n')).toHaveText(/^1(\D|$)/);
  // Unfolded, the third match is there (and stays unfolded for the tests after this one).
  await quiet.click();
  await expect(quiet).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => sorted(await listOrder(page))).toEqual(sorted([ids.trash, ids.search, ids.history]));
  await expect(page.locator(`.ib-lbody [data-section-id="quiet"] [data-thread-id="${ids.search}"]`)).toBeVisible();
  expect(world.errors).toEqual([]);
});

test('Escape empties the field, takes it away, gives back every row and focus to the funnel', async () => {
  const { page, ids } = world;
  await field(page).focus();
  // In the key's own task: the field's copy folds away with its words while the whole list comes back (the rows still
  // drawn glide to their places, the others fade in), held halfway for a still.
  const closing = await field(page).evaluate((input) => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const caught = { copies: document.querySelectorAll('.ib-tflt[aria-hidden="true"]').length, moving: document.querySelector('.ib-lbody')!.getAnimations({ subtree: true }).length };
    for (const a of document.getAnimations()) (a.pause(), (a.currentTime = 90));
    return caught;
  });
  expect(closing.copies).toBe(1);
  expect(closing.moving).toBeGreaterThan(0);
  await pointerAway(page);
  await shot(page, '05a-closing.png');
  await release(page);
  await expect(field(page)).toHaveCount(0);
  await expect(page.locator('[data-title-filter]')).toHaveCount(0);
  await expect.poll(async () => sorted(await listOrder(page))).toEqual(sorted(Object.values(ids)));
  await expect(funnel(page)).toBeFocused();
  // Opened again, it is empty.
  await funnel(page).click();
  await titleRow(page).click();
  await expect(field(page)).toHaveValue('');
  await page.locator('[data-title-filter-close]').click();
  await expect(field(page)).toHaveCount(0);
  await expect(funnel(page)).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pointerAway(page);
  await shot(page, '05-closed.png');
  expect(world.errors).toEqual([]);
});

test('a phone, 390 wide: the row in the sheet, the field under the header, typing narrows', async () => {
  const { page, ids } = world;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(funnel(page)).toBeVisible();
  await funnel(page).click();
  await expect(titleRow(page)).toBeVisible();
  await shot(page, '06-phone-menu.png');
  // The row flies up from the sheet and becomes the field, as on a wide window; held halfway for a still.
  const flying = await titleRow(page).evaluate((row: HTMLElement) => {
    row.click();
    const ghosts = document.querySelectorAll('.ib-tflt-ghost').length;
    for (const a of document.getAnimations()) (a.pause(), (a.currentTime = 100));
    return ghosts;
  });
  expect(flying).toBe(1);
  await shot(page, '06a-phone-travel.png');
  await release(page);
  await expect(page.locator('.ib-tflt-ghost')).toHaveCount(0);
  await expect(page.locator('[data-list-filter-menu]')).toHaveCount(0);
  await expect(field(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
  // A thumb's height, 16px text (iOS does not zoom), nothing wider than the screen.
  const look = await field(page).evaluate((el) => ({ size: getComputedStyle(el).fontSize, height: el.getBoundingClientRect().height }));
  expect(look.size).toBe('16px');
  expect(look.height).toBeGreaterThanOrEqual(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await shot(page, '07-phone-field-open.png');
  await page.keyboard.type('page');
  await expect.poll(async () => sorted(await listOrder(page))).toEqual(sorted([ids.trash, ids.search, ids.history]));
  await shot(page, '08-phone-typing.png');
  await page.keyboard.press('Escape');
  await expect(field(page)).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(world.errors).toEqual([]);
});
