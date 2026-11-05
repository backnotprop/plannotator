/**
 * The List view and two steadiness fixes (approval "inbox-list-view", 2026-11-05, issue #2714), in Chromium against
 * the compiled binary, with agents writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - R1: "N new · Show" sits in the list's header beside the title. News arriving while the pointer rests on a row
 *    moves no row (every row's top measured before and after), in the grouped view and in List, on a desktop and on
 *    a 390 px phone; Show still brings the news in.
 *  - List: the ⋮ menu's View choice (Grouped, List; `menuitemradio` with its state). List shows every thread the
 *    grouped view shows (Quiet and Sent included; the snoozed stay in their folded band), newest first, no bands; the
 *    choice survives a reload; ↓ steps through its rows.
 *  - R7: a hover Mark read with news waiting behind "N new" brings none of it in: the row stays where it is, not
 *    bold; Undo makes it bold again in place; Show still works after.
 *
 * HOME and the data dir are temp folders. PNGs land in PLANNOTATOR_LIST_VIEW_SHOTS (default .local/proof/list-view),
 * and with PLANNOTATOR_LIST_VIEW_VIDEO set, a recording of news arriving under a resting pointer is saved there as
 * news-arrives.webm. Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_LIST_VIEW_SHOTS ?? join(repo, '.local/proof/list-view'));

interface World {
  url: string;
  serverSession: string;
  root: string;
  claude: SimAgent;
  codex: SimAgent;
  billing: string;
  docs: string;
  mobile: string;
  /** Every thread the agents wrote, by name. */
  threads: Record<string, string>;
  context: BrowserContext;
  page: Page;
}

let world: World;
let news = 0;

/**
 * An agent starts a thread of its own (a session's sends without a thread key go into one thread). The key is the
 * subject, so the row reads the subject alone, as a thread the agent did not name.
 */
function start(agent: SimAgent, project: string, subject: string, body: string): Promise<Record<string, unknown>> {
  return agent.send({ project_path: project, thread: subject, subject, body });
}

test.describe.configure({ mode: 'serial' });

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${world.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: world.serverSession, ...body }) });
}

/** Every row's top on screen, by thread, and the list's scroll. */
async function rowTops(page: Page): Promise<{ scroll: number; tops: Record<string, number> }> {
  return page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.ib-listcol .ib-lbody')!;
    const tops: Record<string, number> = {};
    for (const el of body.querySelectorAll<HTMLElement>('[data-thread-id]')) tops[el.getAttribute('data-thread-id')!] = Math.round(el.getBoundingClientRect().top * 10) / 10;
    return { scroll: body.scrollTop, tops };
  });
}

const shownIds = (page: Page) => page.locator('.ib-listcol .ib-lbody [data-thread-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-thread-id')!));
const notice = (page: Page) => page.locator('.ib-listcol .ib-lhead [data-inbox-notice]');

/** An agent starts a thread the held list keeps behind "N new". */
async function agentNews(project = world.docs): Promise<string> {
  const sent = await start(world.codex, project, `Nightly check ${++news}`, `Check ${news} finished: the links are fine.`);
  return String(sent.thread_id);
}

/** Headless Chromium's "blocks notifications" line comes a beat after the rows: hidden first, so nothing else moves them. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator('.ib-listcol .ib-lbody [data-thread-id]').first()).toBeVisible();
  const hide = page.locator('.ib-listcol').getByRole('button', { name: 'Hide', exact: true });
  await hide.waitFor({ timeout: 5000 }).catch(() => {});
  if (await hide.count()) await hide.click();
  await page.waitForTimeout(600);
}

async function shot(page: Page, name: string, both = true): Promise<void> {
  for (const colorScheme of both ? (['light', 'dark'] as const) : (['light'] as const)) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, `${name}${both ? `-${colorScheme}` : ''}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function openMenu(page: Page): Promise<void> {
  await page.locator('.ib-listcol [data-tidy-menu]').click();
  await expect(page.locator('[data-tidy-menu-popup]')).toBeVisible();
}

/** Escape closes the menu; focus back on ⋮ would draw its ring in every picture after, so it goes, as a next click takes it. */
async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tidy-menu-popup]')).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function chooseView(page: Page, view: 'grouped' | 'list'): Promise<void> {
  await openMenu(page);
  await page.locator(`[data-tidy-menu-popup] [data-list-view="${view}"]`).click();
  await closeMenu(page);
}

/** The pointer at rest on a row's title, the way a person reads. */
async function restOn(page: Page, id: string): Promise<void> {
  const box = (await page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2);
}

/** News arrives with the pointer at rest: "N new · Show" comes in the header, and no row moves. */
async function newsMovesNothing(page: Page, restId: string, name: string): Promise<string> {
  await restOn(page, restId);
  await page.waitForTimeout(300);
  const before = await rowTops(page);
  if (name) await page.screenshot({ path: join(shots, `${name}-before.png`) });
  const id = await agentNews();
  await expect(notice(page)).toBeVisible();
  await page.waitForTimeout(400);
  const after = await rowTops(page);
  if (name) await page.screenshot({ path: join(shots, `${name}-after.png`) });
  expect(after).toEqual(before);
  expect(await page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`).count()).toBe(0);
  return id;
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-list-view-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/$/, '');
  expect(new URL(url).port).not.toBe('59812');
  const src = join(root, 'src');
  const billing = scratchProject(src, 'billing-svc');
  const docs = scratchProject(src, 'docs-site');
  const mobile = scratchProject(src, 'mobile-app');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const list = (await (await fetch(`${url}/api/inbox/threads?archived=exclude`)).json()) as { serverSession: string };
  world = { url, serverSession: list.serverSession, root, claude, codex, billing, docs, mobile, threads: {}, context: null as unknown as BrowserContext, page: null as unknown as Page };
  const t = world.threads;
  const id = (sent: Record<string, unknown>) => String(sent.thread_id);
  // Quiet first (oldest): read updates.
  t.quiet1 = id(await start(pi, mobile, 'Crash on cold start fixed', 'The cold start crash is fixed and released.'));
  t.quiet2 = id(await start(claude, billing, 'Invoice PDF fonts fixed', 'The invoice fonts render on every platform now.'));
  for (const quiet of [t.quiet1, t.quiet2]) expect((await post(`/api/inbox/threads/${quiet}/seen`, {})).status).toBe(200);
  // Sent: the person answered.
  const asked = await start(codex, billing, 'Pagination API shape', 'Cursor or page numbers for the new list endpoint?');
  t.sent = id(asked);
  expect((await post(`/api/inbox/messages/${asked.message_id}/reply`, { idempotency_key: 'reply-sent', words: 'Cursor, please.' })).status).toBe(200);
  // A snoozed thread (until tomorrow): its band, folded, in both views.
  t.snoozed = id(await start(pi, mobile, 'Push token refresh on iOS', 'The push token refresh needs a look next week.'));
  expect((await post(`/api/inbox/threads/${t.snoozed}/snooze`, { until: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(200);
  // Waiting on the person: stopped, holding up work, a plain question; then news.
  t.stopped = id(await start(claude, billing, 'Retry worker for 409s', DEMO_MESSAGES.stopped));
  t.holding = id(await start(codex, docs, 'Install page: detect agents?', DEMO_MESSAGES.holding));
  t.waiting = id(await start(claude, billing, 'Refund events: webhook or polling?', DEMO_MESSAGES.named));
  t.new1 = id(await start(pi, mobile, 'Offline queue migration finished', 'The offline queue migration finished on every device.'));
  t.new2 = id(await start(codex, docs, 'Broken links sweep done', DEMO_MESSAGES.news));
  t.new3 = id(await start(claude, billing, 'Webhook retries tuned', 'Webhook retries back off up to an hour now.'));
  await pi.close();
  world.context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  world.page = await world.context.newPage();
  await world.page.goto(`${url}/`);
  await settled(world.page);
});

test.afterAll(async () => {
  try {
    await world?.context?.close().catch(() => {});
    await world?.claude.close().catch(() => {});
    await world?.codex.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('grouped: news arriving under a resting pointer moves no row; "N new · Show" is in the header; Show brings it in', async () => {
  const { page } = world;
  await expect(page.locator('.ib-listcol [data-section-id="quiet"] .ib-band')).toBeVisible();
  const id = await newsMovesNothing(page, world.threads.new1, 'grouped-news');
  await expect(notice(page)).toHaveText(/^1 new in docs-site\s*Show$/);
  await expect(page.locator('.ib-listcol .ib-lbody [data-inbox-notice]')).toHaveCount(0);
  await page.locator('.ib-listcol .ib-lhead').screenshot({ path: join(shots, 'notice-header-desktop.png') });
  await notice(page).click();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`)).toBeVisible();
});

test('the ⋮ menu: View, Grouped or List, each heard with its state; List shows every thread the groups show, no bands', async () => {
  const { page } = world;
  // Every thread the grouped view shows, folded Quiet opened.
  const quiet = page.locator('.ib-listcol [data-section-id="quiet"] .ib-band');
  if ((await quiet.getAttribute('aria-expanded')) === 'false') await quiet.click();
  const grouped = new Set(await shownIds(page));
  expect(grouped.has(world.threads.quiet1)).toBe(true);
  expect(grouped.has(world.threads.sent)).toBe(true);
  await quiet.click();
  await openMenu(page);
  const radios = page.locator('[data-tidy-menu-popup] [role="menuitemradio"]');
  await expect(radios).toHaveText(['Grouped', 'List']);
  await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true');
  await page.mouse.move(1300, 400);
  await page.waitForTimeout(200);
  await shot(page, 'menu-open');
  await page.locator('[data-tidy-menu-popup] [data-list-view="list"]').click();
  await expect(radios.nth(1)).toHaveAttribute('aria-checked', 'true');
  await shot(page, 'menu-open-list-chosen', false);
  await closeMenu(page);
  const listed = await shownIds(page);
  expect(new Set(listed)).toEqual(grouped);
  expect(listed.length).toBe(grouped.size);
  // No bands but the folded Snoozed one; the snoozed thread stays in it.
  await expect(page.locator('.ib-listcol .ib-lbody .ib-band')).toHaveCount(1);
  await expect(page.locator('.ib-listcol .ib-lbody [data-section-id="snoozed"] .ib-band')).toHaveAttribute('aria-expanded', 'false');
  expect(listed).not.toContain(world.threads.snoozed);
  // Newest first: the times on the rows' threads go down the list.
  const times = await Promise.all(listed.map(async (id) => ((await (await fetch(`${world.url}/api/inbox/threads/${id}`)).json()) as { row: { last_at: string } }).row.last_at));
  expect([...times].sort().reverse()).toEqual(times);
  // The badges stay.
  await expect(page.locator(`.ib-listcol .ib-lbody [data-thread-id="${world.threads.stopped}"]`)).toContainText('Stopped');
  await expect(page.locator(`.ib-listcol .ib-lbody [data-thread-id="${world.threads.holding}"]`)).toContainText('Holds up');
  await page.mouse.move(1300, 880);
  await shot(page, 'list-1440');
  // Remembered: a reload draws List.
  await page.reload();
  await settled(page);
  await expect(page.locator('.ib-listcol .ib-lbody .ib-band')).toHaveCount(1);
  expect(await shownIds(page)).toEqual(listed);
});

test('List: ↓ steps through the rows in their order', async () => {
  const { page } = world;
  const listed = await shownIds(page);
  await page.locator(`.ib-listcol .ib-lbody [data-thread-id="${listed[0]}"]`).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`.ib-listcol .ib-lbody [data-thread-id="${listed[1]}"]`)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(`.ib-listcol .ib-lbody [data-thread-id="${listed[2]}"]`)).toBeFocused();
  await page.locator('body').click({ position: { x: 1300, y: 880 } }).catch(() => {});
});

test('List: news arriving moves no row; a hover Mark read with news waiting brings none in; Undo; Show', async () => {
  const { page } = world;
  const held = await newsMovesNothing(page, world.threads.new2, 'list-news');
  await shot(page, 'list-notice-1440');
  // Mark read on a bold row with the news still behind "N new".
  const target = world.threads.new2;
  const row = page.locator(`.ib-listcol .ib-lbody [data-thread-id="${target}"]`);
  await expect(row).toHaveClass(/\bib-u\b/);
  const before = await rowTops(page);
  await restOn(page, target);
  await page.locator(`.ib-listcol .ib-rw[data-row="${target}"] [data-row-mark-read]`).click();
  await expect(row).not.toHaveClass(/\bib-u\b/);
  await page.waitForTimeout(500);
  // Nothing came in, nothing moved, the news still waits.
  expect(await rowTops(page)).toEqual(before);
  await expect(notice(page)).toHaveText(/^1 new in docs-site\s*Show$/);
  expect(await page.locator(`.ib-listcol .ib-lbody [data-thread-id="${held}"]`).count()).toBe(0);
  // Mark unread is now under the pointer, on the same row.
  await expect(page.locator(`.ib-listcol .ib-rw[data-row="${target}"] [data-row-mark-unread]`)).toBeVisible();
  await page.screenshot({ path: join(shots, 'list-mark-read-in-place.png') });
  // Undo: bold again, in place.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row).toHaveClass(/\bib-u\b/);
  await page.waitForTimeout(300);
  expect(await rowTops(page)).toEqual(before);
  await expect(notice(page)).toBeVisible();
  // Show still works: the news comes in.
  await notice(page).click();
  await expect(page.locator(`.ib-listcol .ib-lbody [data-thread-id="${held}"]`)).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});

test('grouped: the same hover Mark read keeps the row in its group, not bold, and brings no news in', async () => {
  const { page } = world;
  await chooseView(page, 'grouped');
  const held = await agentNews();
  await expect(notice(page)).toBeVisible();
  const target = world.threads.new3;
  const row = page.locator(`.ib-listcol .ib-lbody [data-section-id="new"] [data-thread-id="${target}"]`);
  await expect(row).toHaveClass(/\bib-u\b/);
  const before = await rowTops(page);
  await restOn(page, target);
  await page.locator(`.ib-listcol .ib-rw[data-row="${target}"] [data-row-mark-read]`).click();
  await expect(row).not.toHaveClass(/\bib-u\b/);
  await page.waitForTimeout(500);
  expect(await rowTops(page)).toEqual(before);
  expect(await page.locator(`.ib-listcol .ib-lbody [data-thread-id="${held}"]`).count()).toBe(0);
  await notice(page).click();
  await expect(page.locator(`.ib-listcol .ib-lbody [data-thread-id="${held}"]`)).toBeVisible();
  await chooseView(page, 'list');
});

test('a 390 px phone: List from the ⋮ sheet; news moves no row; "1 new" and Show fit the header; Show works', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await settled(page);
    // A new browser: Grouped until it chooses.
    await expect(page.locator('.ib-listcol [data-section-id="quiet"] .ib-band')).toBeVisible();
    await page.locator('.ib-listcol [data-tidy-menu]').tap();
    await expect(page.locator('[data-tidy-menu-popup]')).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, 'phone-menu.png') });
    await page.locator('[data-tidy-menu-popup] [data-list-view="list"]').tap();
    await closeMenu(page);
    await expect(page.locator('.ib-listcol .ib-lbody .ib-band')).toHaveCount(1);
    await shot(page, 'phone-list');
    const before = await rowTops(page);
    const id = await agentNews(world.mobile);
    await expect(notice(page)).toBeVisible();
    await page.waitForTimeout(400);
    expect(await rowTops(page)).toEqual(before);
    // The header keeps its buttons; the line reads "1 new" and Show, the project for a screen reader.
    await expect(notice(page)).toHaveAccessibleName(/^1 new in mobile-app\s*Show$/);
    const head = page.locator('.ib-listcol .ib-lhead');
    for (const button of ['[data-open-search]', '[data-open-compose]', '[data-tidy-menu]']) await expect(head.locator(button)).toBeInViewport({ ratio: 1 });
    // Neither the title nor "1 new" is cut at 390 px.
    const cut = (selector: string) => head.locator(selector).evaluate((el) => el.scrollWidth > el.clientWidth + 0.5);
    expect(await cut('.ib-lhead-tt')).toBe(false);
    expect(await cut('.ib-notice-text')).toBe(false);
    const pill = (await notice(page).locator('.ib-hnotice-pill').boundingBox())!;
    expect(pill.height).toBeLessThan(40);
    expect((await notice(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shot(page, 'phone-notice');
    await head.screenshot({ path: join(shots, 'notice-header-phone.png') });
    await notice(page).tap();
    await expect(page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`)).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a recording: news arrives three times under a resting pointer, in List, and nothing moves', async ({ browser }) => {
  test.skip(!process.env.PLANNOTATOR_LIST_VIEW_VIDEO, 'set PLANNOTATOR_LIST_VIEW_VIDEO to record');
  const dir = join(shots, 'video');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', recordVideo: { dir, size: { width: 1280, height: 800 } } });
  const page = await context.newPage();
  try {
    await page.goto(`${world.url}/`);
    await context.addCookies([{ name: 'plannotator-inbox-list-view', value: 'list', url: world.url }]);
    await page.reload();
    await settled(page);
    await restOn(page, world.threads.waiting);
    await page.waitForTimeout(1500);
    const before = await rowTops(page);
    for (let i = 0; i < 3; i++) {
      await agentNews(i === 1 ? world.billing : world.docs);
      await page.waitForTimeout(2200);
    }
    expect(await rowTops(page)).toEqual(before);
    await page.waitForTimeout(800);
    await notice(page).click();
    await page.waitForTimeout(3000);
  } finally {
    const video = page.video();
    await context.close();
    if (video) renameSync(await video.path(), join(shots, 'news-arrives.webm'));
  }
});
