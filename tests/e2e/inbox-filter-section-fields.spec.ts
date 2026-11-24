/**
 * The filter menu's long sections (components/ListFilterSections.tsx, listFilterSearch.ts) in a real Chromium against
 * the compiled binary, agents writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - six projects: the menu as it always was, no field and no inner scroll anywhere, nothing at its top;
 *  - eleven projects: Project gets its own field under its heading ("Find a project") and a list of about seven rows
 *    that scrolls inside the menu; nothing at the menu's top;
 *  - the wheel over that list scrolls it, and at its ends goes on to scroll the menu (no trap), both ways;
 *  - ticked projects come first inside the capped scroll; typing narrows Project only, the match bold, the field never moving;
 *    ↓ from the field goes to its first row, ↑ back; Escape empties the field, then closes the menu;
 *  - nothing matching: "No projects match “zzz”" in that section, the ticked rows kept;
 *  - seven ticked: the list's foot still cuts a row in half under the separator; the first match, below the ticked
 *    rows, comes into view as the words change and is the row Enter ticks; a ticked row's match is drawn bold;
 *  - a phone, 390 wide: the same field in the sheet, 16 px text, the list shorter, the sheet not moving as rows go.
 *
 * What this catches: a field on a short list or at the menu's top; a long section with no field or no cap; an inner
 * list that traps the wheel at its ends; typing that narrows other sections, moves the field, or loses the ticked rows;
 * arrows that skip the field; Escape that closes before it empties; a cap that ends between rows (no sign there is
 * more); Enter acting on a row out of sight; a phone field that iOS would zoom into, or a sheet
 * that jumps while typing.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/filter-sections (CI keeps .local/proof/ as the shard's "inbox-window-proof"
 * artifact): 01-open, 02-typed-project, 03-nothing-matches, 04-short-lists-unchanged, 05-phone-typed. Build the binary
 * first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'filter-sections');

/** Six projects first (a short list), then five more (a long one). */
const FIRST = ['acme-web', 'billing-svc', 'cart-service', 'docs-site', 'mobile-app', 'web-app'];
const MORE = ['admin-console', 'billing-api', 'billing-worker', 'mobile-billing', 'search-index'];
const ALL = [...FIRST, ...MORE].sort((a, b) => a.localeCompare(b));
/** The projects holding "bil" that are not ticked (billing-svc is, and sits above them). */
const BIL = ['billing-api', 'billing-worker', 'mobile-app', 'mobile-billing'];
/** Ticked as well, to make seven: none holds "bil" or "worker". */
const EXTRA = ['acme-web', 'admin-console', 'cart-service', 'docs-site', 'search-index'];

interface World {
  url: string;
  root: string;
  env: Record<string, string>;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
}

let world: World;

test.describe.configure({ mode: 'serial' });

const funnel = (page: Page) => page.locator('.ib-lhead [data-list-filter]');
const menu = (page: Page) => page.locator('[data-list-filter-menu]');
const projects = (page: Page) => page.locator('[data-list-filter-long="projects"]');
const field = (page: Page) => page.locator('[data-list-filter-find="projects"]');
const inner = (page: Page) => projects(page).locator('[data-list-filter-scroll]');
const words = (page: Page, where: string) => page.locator(where).evaluateAll((rows) => rows.map((row) => row.querySelector('.ib-pmi-l')?.textContent ?? ''));
const top = async (page: Page) => (await field(page).boundingBox())!.y;
const scrollOf = (page: Page, which: 'menu' | 'inner') => (which === 'menu' ? menu(page) : inner(page)).evaluate((el) => el.scrollTop);
/**
 * The menu's entrance (it scales from 0.97) has finished. The measures below also take the list's foot in the same
 * transformed pixels as its rows' rects: an unscaled `clientHeight` added to a scaled rect, read on the entrance's
 * first frame, put the cut at 0.75 of a row.
 */
const entered = async (page: Page) => {
  await menu(page).evaluate((m) => Promise.all(m.getAnimations({ subtree: true }).map((a) => a.finished)));
};
/** How much of the row the inner list's foot cuts through shows, scrolled to its top (0.5: half a row says "more"). */
const cutShows = async (page: Page) => {
  await entered(page);
  return inner(page).evaluate((el) => {
    el.scrollTop = 0;
    const box = el.getBoundingClientRect();
    const foot = box.top + el.clientHeight * (box.height / el.offsetHeight);
    const cut = [...el.querySelectorAll('.ib-pmi')].map((r) => r.getBoundingClientRect()).find((r) => r.top < foot && r.bottom > foot);
    return cut ? (foot - cut.top) / cut.height : null;
  });
};
/** The row Enter in the field acts on is in full view inside the inner list. */
const firstInView = async (page: Page) => {
  await entered(page);
  return inner(page).evaluate((el) => {
    const row = el.querySelector('[data-list-filter-first]');
    if (!row) return null;
    const box = el.getBoundingClientRect();
    const foot = box.top + el.clientHeight * (box.height / el.offsetHeight);
    const at = row.getBoundingClientRect();
    return { label: row.querySelector('.ib-pmi-l')?.textContent ?? '', seen: at.top >= box.top - 0.5 && at.bottom <= foot + 0.5 };
  });
};

async function shot(page: Page, name: string) {
  // The menu's entrance has played.
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(proofDir, name) });
}

async function send(agent: SimAgent, root: string, project: string, subject: string) {
  const path = scratchProject(join(root, 'src'), project);
  await agent.send({ project_path: path, subject, thread: subject, body: `${subject}. Ada Novak asked for it.` });
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-filter-sections-e2e-');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify(E2E_LAUNCH_OFF));
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: data, PLANNOTATOR_TEST_SANDBOX: '1', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  for (const [i, project] of FIRST.entries()) await send(i % 2 ? codex : claude, root, project, `Release notes for ${project}`);
  // Tall enough for the whole short menu, short enough that the long one scrolls.
  const context = await browser.newContext({ viewport: { width: 1440, height: 700 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = started.stdout.trim();
  await page.goto(url);
  world = { url, root, env, agents: [claude, codex], context, page, errors };
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

test('six projects: the menu as it always was, no field and no inner scroll', async () => {
  const { page } = world;
  await expect(page.locator('.ib-lbody [data-thread-id]')).toHaveCount(FIRST.length);
  await funnel(page).click();
  await expect(menu(page)).toBeVisible();
  await expect(page.locator('[data-list-filter-find]')).toHaveCount(0);
  await expect(page.locator('[data-list-filter-scroll]')).toHaveCount(0);
  await expect(menu(page).locator('input')).toHaveCount(0);
  expect(await words(page, '[data-list-filter-menu] [data-list-filter-project]')).toEqual([...FIRST].sort((a, b) => a.localeCompare(b)));
  await shot(page, '04-short-lists-unchanged.png');
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test('eleven projects: Project gets its own field under its heading and a capped list; nothing at the top', async () => {
  const { page, root } = world;
  const [claude, codex] = world.agents;
  for (const [i, project] of MORE.entries()) await send(i % 2 ? codex! : claude!, root, project, `Release notes for ${project}`);
  await page.reload();
  await expect(page.locator('.ib-lbody [data-thread-id]')).toHaveCount(ALL.length);
  await funnel(page).click();
  await expect(field(page)).toBeVisible();
  // A click open puts focus on the menu, never in a field (its line drawn focused, the pointer's hover off).
  await page.waitForTimeout(200);
  await expect(field(page)).not.toBeFocused();
  await expect(menu(page)).toBeFocused();
  await expect(field(page)).toHaveAttribute('placeholder', 'Find a project');
  await expect(field(page)).toHaveAttribute('aria-label', 'Find a project');
  await expect(page.locator('[data-list-filter-find]')).toHaveCount(1);
  // Nothing above the menu's first row; the field sits under Project's heading.
  expect(await menu(page).evaluate((m) => !!(m.querySelector('.ib-pmi')!.compareDocumentPosition(m.querySelector('input')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(menu(page).locator('.ib-pmi').first()).toHaveAttribute('data-list-filter-title', '');
  await expect(projects(page).locator('.ib-pm-glabel')).toHaveText('Project');
  // Seven rows and half of the eighth, the rest a scroll away inside it.
  const box = await inner(page).evaluate((el) => ({ height: el.clientHeight, full: el.scrollHeight, rows: el.querySelectorAll('.ib-pmi').length }));
  expect(box.rows).toBe(ALL.length);
  expect(box.full).toBeGreaterThan(box.height);
  const cut = await cutShows(page);
  expect(cut).toBeGreaterThan(0.4);
  expect(cut).toBeLessThan(0.6);
  await field(page).scrollIntoViewIfNeeded();
  await page.mouse.move(10, 690);
  await shot(page, '01-open.png');
  expect(world.errors).toEqual([]);
});

test('the wheel over the inner list scrolls it, and at its ends goes on to the menu, both ways', async () => {
  const { page } = world;
  // The menu at its foot, the list at its top: a wheel up over the list goes on to the menu above it.
  await menu(page).evaluate((m) => (m.scrollTop = m.scrollHeight));
  await inner(page).evaluate((el) => (el.scrollTop = 0));
  const listBox = (await inner(page).boundingBox())!;
  await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + Math.min(40, listBox.height / 2));
  const menuWas = await scrollOf(page, 'menu');
  expect(menuWas).toBeGreaterThan(0);
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => scrollOf(page, 'menu')).toBeLessThan(menuWas);
  expect(await scrollOf(page, 'inner')).toBe(0);
  // Back down, the pointer over the list: a wheel down scrolls the list itself first.
  await menu(page).evaluate((m) => (m.scrollTop = m.scrollHeight));
  const again = (await inner(page).boundingBox())!;
  await page.mouse.move(again.x + again.width / 2, again.y + Math.min(40, again.height / 2));
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, 60);
  await expect.poll(() => scrollOf(page, 'inner')).toBeGreaterThan(0);
  // At its foot, a wheel down goes on to the menu below it.
  await inner(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
  await menu(page).evaluate((m) => (m.scrollTop = Math.max(0, m.scrollTop - 80)));
  const menuBefore = await scrollOf(page, 'menu');
  const atEnd = (await inner(page).boundingBox())!;
  await page.mouse.move(atEnd.x + atEnd.width / 2, atEnd.y + Math.min(40, atEnd.height / 2));
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => scrollOf(page, 'menu')).toBeGreaterThan(menuBefore);
  expect(world.errors).toEqual([]);
});

test('ticked projects come first in the capped scroll; typing narrows Project only, bold, and the field never moves', async () => {
  const { page } = world;
  for (const name of ['billing-svc', 'web-app']) await projects(page).locator('.ib-pmi').filter({ hasText: new RegExp(`^${name}`) }).first().click();
  await expect(page.locator('[data-list-filter-count]')).toHaveText('2');
  const agentsBefore = await words(page, '[data-list-filter-group="agents"] .ib-pmi');
  await menu(page).evaluate((m) => (m.scrollTop = m.scrollHeight));
  await field(page).click();
  const before = await top(page);
  await page.keyboard.type('bil');
  await expect.poll(() => words(page, '[data-list-filter-long="projects"] [data-list-filter-rows] .ib-pmi')).toEqual(BIL);
  expect(await words(page, '[data-list-filter-long="projects"] [data-list-filter-pins] .ib-pmi')).toEqual(['billing-svc', 'web-app']);
  await expect(projects(page).locator('[data-list-filter-scroll] .ib-lflt-hit').first()).toHaveText('bil');
  expect(await words(page, '[data-list-filter-group="agents"] .ib-pmi')).toEqual(agentsBefore);
  expect(Math.abs((await top(page)) - before)).toBeLessThanOrEqual(1);
  // ↓ from the field: its first row (a ticked one); ↑ back to the field.
  await page.keyboard.press('ArrowDown');
  await expect(projects(page).locator('[data-list-filter-pins] .ib-pmi').first()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(field(page)).toBeFocused();
  await page.mouse.move(10, 690);
  await shot(page, '02-typed-project.png');
  expect(world.errors).toEqual([]);
});

test('nothing matching: the line in Project only, its ticked rows kept; Escape empties, then closes', async () => {
  const { page } = world;
  const before = await top(page);
  await field(page).fill('zzz');
  await expect(projects(page).locator('[data-list-filter-none]')).toHaveText('No projects match “zzz”');
  await expect(page.locator('[data-list-filter-none]')).toHaveCount(1);
  expect(await words(page, '[data-list-filter-long="projects"] [data-list-filter-pins] .ib-pmi')).toEqual(['billing-svc', 'web-app']);
  expect(Math.abs((await top(page)) - before)).toBeLessThanOrEqual(1);
  await page.mouse.move(10, 690);
  await shot(page, '03-nothing-matches.png');
  await field(page).focus();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toBeVisible();
  await expect(field(page)).toHaveValue('');
  await expect(inner(page).locator('[data-list-filter-rows] .ib-pmi')).toHaveCount(ALL.length - 2);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(funnel(page)).toBeFocused();
  // Opened from the keyboard (↓, then Enter), focus is on the first row, not on the menu or a field.
  for (const name of ['ArrowDown', 'Enter']) {
    await page.keyboard.press(name);
    await expect(menu(page)).toBeVisible();
    await page.waitForTimeout(200);
    await expect(menu(page).locator('.ib-pmi').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await expect(funnel(page)).toBeFocused();
  }
  expect(world.errors).toEqual([]);
});

test('seven ticked: the cut still halves a row under the separator; the first match is brought into view; a ticked match is bold', async () => {
  const { page } = world;
  await funnel(page).click();
  for (const name of EXTRA) await projects(page).locator('.ib-pmi').filter({ hasText: new RegExp(`^${name}`) }).first().click();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await funnel(page).click();
  await expect(projects(page).locator('[data-list-filter-pins] .ib-pmi')).toHaveCount(7);
  // Seven ticked rows and the separator under them: the cut is through the middle of the first row below it.
  const cut = await cutShows(page);
  expect(cut).toBeGreaterThan(0.4);
  expect(cut).toBeLessThan(0.6);
  // "worker": its one match sits below the ticked rows, past the cut; it comes into full view as the words change.
  await field(page).click();
  await page.keyboard.type('worker');
  await expect.poll(() => firstInView(page)).toEqual({ label: 'billing-worker', seen: true });
  expect(await scrollOf(page, 'inner')).toBeGreaterThan(0);
  // Enter ticks that row, the one in view; again unticks it.
  await page.keyboard.press('Enter');
  await expect(projects(page).locator('.ib-pmi[data-list-filter-first]')).toHaveAttribute('data-checked', '');
  expect(await firstInView(page)).toEqual({ label: 'billing-worker', seen: true });
  await page.keyboard.press('Enter');
  await expect(projects(page).locator('.ib-pmi[data-list-filter-first]')).not.toHaveAttribute('data-checked', '');
  // A ticked row holding the match: the match drawn bold against a plain-weight label, as in the other rows.
  await field(page).fill('bil');
  const weights = await projects(page)
    .locator('[data-list-filter-pins] .ib-pmi-l', { hasText: 'billing-svc' })
    .evaluate((label) => ({ label: Number(getComputedStyle(label).fontWeight), hit: Number(getComputedStyle(label.querySelector('.ib-lflt-hit')!).fontWeight) }));
  expect(weights.hit - weights.label).toBeGreaterThanOrEqual(200);
  await field(page).fill('');
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  // Nine ticked, more than the list's seven whole rows: the separator is below the cut, which still halves a row.
  const NINE = ['billing-api', 'billing-worker'];
  await funnel(page).click();
  for (const name of NINE) await projects(page).locator('.ib-pmi').filter({ hasText: new RegExp(`^${name}`) }).first().click();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await funnel(page).click();
  await expect(projects(page).locator('[data-list-filter-pins] .ib-pmi')).toHaveCount(9);
  const cutNine = await cutShows(page);
  expect(cutNine).toBeGreaterThan(0.4);
  expect(cutNine).toBeLessThan(0.6);
  // Back to seven for the phone's check.
  for (const name of NINE) await projects(page).locator('.ib-pmi').filter({ hasText: new RegExp(`^${name}`) }).first().click();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test('a phone, 390 wide: the field in the sheet at 16 px, a shorter list, the sheet still while typing', async () => {
  const { page } = world;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(funnel(page)).toBeVisible();
  await funnel(page).click();
  await expect(field(page)).toBeVisible();
  // Opening the sheet never focuses a field (a phone's keyboard would rise).
  await page.waitForTimeout(200);
  await expect(field(page)).not.toBeFocused();
  const look = await field(page).evaluate((el) => ({ size: getComputedStyle(el).fontSize, height: el.getBoundingClientRect().height }));
  expect(look.size).toBe('16px');
  expect(look.height).toBeGreaterThanOrEqual(44);
  // Five rows and half of the sixth (seven ticked ones fill it).
  const cut = await cutShows(page);
  expect(cut).toBeGreaterThan(0.4);
  expect(cut).toBeLessThan(0.6);
  await field(page).click();
  const sheet = async () => (await menu(page).boundingBox())!;
  const was = await sheet();
  const fieldWas = await top(page);
  await page.keyboard.type('bil');
  await expect.poll(() => words(page, '[data-list-filter-long="projects"] [data-list-filter-rows] .ib-pmi')).toEqual(BIL);
  const now = await sheet();
  expect(Math.abs(now.y - was.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(now.height - was.height)).toBeLessThanOrEqual(1);
  expect(Math.abs((await top(page)) - fieldWas)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await shot(page, '05-phone-typed.png');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 700 });
  expect(world.errors).toEqual([]);
});
