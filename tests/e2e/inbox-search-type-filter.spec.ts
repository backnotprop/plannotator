/**
 * The search palette's Type chip (approval "inbox-search-type-filter",
 * option B) in a real browser against the compiled binary, with four agents
 * writing a relay world through `plannotator inbox mcp`
 * (tests/e2e/inbox-search-type-world.ts):
 *
 *  - All types: the request, the groups, their order, their rows and caps
 *    are the server's plain first answer, as before the chip;
 *  - the Type menu lists each type with the total the answer carries;
 *  - Files picked: the Files group alone with every file (more than the
 *    cap), its heading kept, no Actions, the first row highlighted, the live
 *    region saying "10 files"; kept while the words change; with no words a
 *    quiet line;
 *  - All types again at every open, and on Clear filters;
 *  - by keyboard only: Tab to the chip, Enter, the arrows, Enter; Escape
 *    closes the menu and focus goes back to the chip;
 *  - a phone: the chip leads the sideways chip row and picks in the bottom
 *    menu sheet.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs (desktop 1440×900 @2x, phone 390×844 @3x) land in
 * .local/proof/search-type-filter/ (PLANNOTATOR_E2E_PROOF_DIR).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { seedTypeWorld, type TypeWorld } from './inbox-search-type-world';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'search-type-filter');

const GROUPS = ['threads', 'messages', 'files', 'projects'] as const;
type GroupId = (typeof GROUPS)[number];
interface ServerAnswer {
  totals: Record<GroupId, number>;
  groups: Partial<Record<GroupId, { id: string }[]>>;
}

let url = '';
let world: TypeWorld;
let context: BrowserContext;
let page: Page;
/** Every search request the page made, in order. */
const requests: URL[] = [];

async function shot(p: Page, name: string, scheme: 'light' | 'dark' = 'light'): Promise<void> {
  await p.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await p.waitForTimeout(150);
  await p.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  await p.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const palette = (p: Page) => p.locator('dialog[data-search-palette]');
const input = (p: Page) => palette(p).getByRole('combobox');
const typeChip = (p: Page) => palette(p).locator('[data-chip="type"]');
const menu = (p: Page) => palette(p).getByRole('menu');
const live = (p: Page) => palette(p).locator('[data-search-live]');

async function settled(p: Page): Promise<void> {
  await expect(palette(p).locator('.ib-sp-list')).not.toHaveAttribute('data-dim', '');
  await expect(palette(p).locator('[data-search-indexing]')).toHaveCount(0);
}

/** The words typed have their answer drawn: no recent view, a result row, nothing dimmed. */
async function answered(p: Page): Promise<void> {
  await expect(palette(p).locator('[data-search-group="recent"]')).toHaveCount(0);
  await expect(palette(p).locator('[data-result]').first()).toBeVisible();
  await settled(p);
}

async function openFromSidebar(p: Page): Promise<void> {
  await p.locator('.ib-side .ib-sp-entry').first().click();
  await expect(palette(p)).toBeVisible();
  await expect(input(p)).toBeFocused();
}

/** The result groups drawn (Actions left out), each with its result ids and its "Show all" row's words. */
async function drawnGroups(p: Page): Promise<{ id: string; rows: string[]; more: string | null }[]> {
  return palette(p)
    .locator('[data-search-group]')
    .evaluateAll((groups) =>
      groups
        .filter((g) => g.getAttribute('data-search-group') !== 'actions')
        .map((g) => ({
          id: g.getAttribute('data-search-group')!,
          rows: [...g.querySelectorAll('[data-result]')].map((r) => r.getAttribute('data-result-id')!),
          more: g.querySelector('[data-show-more]')?.textContent ?? null,
        })),
    );
}

const groupIds = (p: Page) => palette(p).locator('[data-search-group]').evaluateAll((g) => g.map((x) => x.getAttribute('data-search-group')));

/** The server's own answer to a request, the window's route. */
async function serverSearch(params: Record<string, string>): Promise<ServerAnswer> {
  const response = await fetch(new URL(`/api/inbox/search?${new URLSearchParams(params)}`, url), { headers: { Accept: 'application/json' } });
  expect(response.ok).toBe(true);
  return (await response.json()) as ServerAnswer;
}

const lastSearch = (q: string) => [...requests].reverse().find((r) => r.searchParams.get('q') === q)!;

async function pickFromMenu(p: Page, label: string): Promise<void> {
  await typeChip(p).click();
  await expect(menu(p)).toBeVisible();
  await menu(p).locator('[role="menuitemradio"]').filter({ has: p.locator('.ib-sp-ml', { hasText: new RegExp(`^${label}$`) }) }).click();
  await expect(menu(p)).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-search-type-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  world = await seedTypeWorld({ binary, env, root, url });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  page = await context.newPage();
  page.on('request', (request) => {
    const at = new URL(request.url());
    if (at.pathname === '/api/inbox/search') requests.push(at);
  });
  await page.goto(url);
});

test.afterAll(async () => {
  try {
    if (world) await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('All types: the request, the groups, their order, rows and caps are the plain first answer', async () => {
  await openFromSidebar(page);
  await expect(palette(page).locator('[data-chip]')).toHaveCount(4);
  expect(await palette(page).locator('[data-chip]').evaluateAll((c) => c.map((x) => x.getAttribute('data-chip')))).toEqual(['type', 'project', 'status', 'from']);
  await expect(typeChip(page)).toHaveText('All types');
  await expect(typeChip(page)).toHaveAttribute('aria-haspopup', 'menu');
  await input(page).fill('relay');
  await answered(page);

  // The request is the one the palette sent before the chip: no group, no limit, no offset.
  const sent = lastSearch('relay');
  expect([sent.searchParams.get('group'), sent.searchParams.get('limit'), sent.searchParams.get('offset')]).toEqual([null, null, null]);
  // The server's plain answer to it, drawn as it comes: the fixed order, each group's rows, "Show all" past a cap.
  const plain = await serverSearch({ q: 'relay' });
  const expected = GROUPS.filter((id) => (plain.groups[id] ?? []).length > 0).map((id) => {
    const rows = plain.groups[id]!.map((r) => r.id);
    return { id, rows, more: plain.totals[id] > rows.length ? `Show all ${plain.totals[id]} ${id}` : null };
  });
  expect(await drawnGroups(page)).toEqual(expected);
  // The caps hold: six threads show five, ten files show five.
  expect(plain.totals.threads).toBe(6);
  expect(plain.totals.files).toBe(world.relayFiles);
  expect(expected.find((g) => g.id === 'threads')!.rows).toHaveLength(5);
  expect(expected.find((g) => g.id === 'files')!.rows).toHaveLength(5);
  await expect(live(page)).toHaveText(/^\d+ results in 4 groups$/);
  await shot(page, '01-unpicked');
});

test('the Type menu lists each type with the total the answer carries, and none before there are words', async () => {
  const plain = await serverSearch({ q: 'relay' });
  await typeChip(page).click();
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toHaveAttribute('aria-label', 'Type');
  await expect(typeChip(page)).toHaveAttribute('aria-expanded', 'true');
  const items = menu(page).locator('[role="menuitemradio"]');
  await expect(items).toHaveText(['All types', `Threads${plain.totals.threads}`, `Messages${plain.totals.messages}`, `Files${plain.totals.files}`, `Projects${plain.totals.projects}`]);
  await expect(items.first()).toHaveAttribute('aria-checked', 'true');
  await shot(page, '02-menu-open');
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(palette(page)).toBeVisible();

  // No words: the types, without counts.
  await input(page).fill('');
  await settled(page);
  await typeChip(page).click();
  await expect(menu(page).locator('[role="menuitemradio"]')).toHaveText(['All types', 'Threads', 'Messages', 'Files', 'Projects']);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
});

test('Files picked: the Files group alone with every file, heading kept, no Actions, the first row highlighted, "10 files" spoken', async () => {
  await input(page).fill('relay');
  await answered(page);
  await pickFromMenu(page, 'Files');
  await expect(typeChip(page)).toHaveText('Files');
  await expect(palette(page).locator('[data-unset="type"]')).toHaveAttribute('aria-label', 'Clear the type filter');
  await expect.poll(() => groupIds(page)).toEqual(['files']);
  await settled(page);

  // The request: the group's own page ("Show all"'s), on this query.
  const sent = lastSearch('relay');
  expect([sent.searchParams.get('group'), sent.searchParams.get('limit')]).toEqual(['files', '50']);
  const all = await serverSearch({ q: 'relay', group: 'files', limit: '50' });
  const ids = all.groups.files!.map((r) => r.id);
  expect(ids.length).toBe(world.relayFiles);
  expect(ids.length).toBeGreaterThan(5);
  expect(await drawnGroups(page)).toEqual([{ id: 'files', rows: ids, more: null }]);
  // The heading stays and labels the group.
  const group = palette(page).locator('[data-search-group="files"]');
  await expect(group).toHaveAttribute('role', 'group');
  await expect(palette(page).locator(`#${await group.getAttribute('aria-labelledby')}`)).toHaveText('Files');
  await expect(palette(page).locator('[data-compose-action]')).toHaveCount(0);
  const first = palette(page).locator('[role="option"]').first();
  await expect(input(page)).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(live(page)).toHaveText(`${world.relayFiles} files`);
  await shot(page, '03-files-picked', 'light');
  await shot(page, '03-files-picked', 'dark');

  // Kept while the words change; with no words, a quiet line and no rows.
  await input(page).fill('relay latency');
  await settled(page);
  await expect.poll(() => lastSearch('relay latency')?.searchParams.get('group')).toBe('files');
  await expect.poll(() => groupIds(page)).toEqual(['files']);
  await expect(typeChip(page)).toHaveText('Files');
  await input(page).fill('');
  await settled(page);
  await expect(palette(page).locator('[data-search-type-empty]')).toHaveText('Type to search files.');
  await expect(palette(page).locator('[role="option"]')).toHaveCount(0);
});

test('the type goes back to All types at every open', async () => {
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await openFromSidebar(page);
  await expect(typeChip(page)).toHaveText('All types');
  await expect(palette(page).locator('[data-unset="type"]')).toHaveCount(0);
  await input(page).fill('relay');
  await answered(page);
  expect(lastSearch('relay').searchParams.get('group')).toBeNull();
  expect(await groupIds(page)).toEqual(expect.arrayContaining(['threads', 'messages', 'files', 'projects']));
});

test('Clear filters puts the type back to All types with the other chips', async () => {
  await pickFromMenu(page, 'Files');
  await expect.poll(() => groupIds(page)).toEqual(['files']);
  await palette(page).locator('[data-chip="from"]').click();
  await menu(page).locator('[role="menuitemradio"]').filter({ hasText: 'Agents' }).click();
  await expect(palette(page).locator('[data-chip="from"]')).toHaveText('From agents');
  await settled(page);
  await expect(typeChip(page)).toHaveText('Files');
  await palette(page).locator('.ib-sp-filters [data-clear-filters]').click();
  await expect(typeChip(page)).toHaveText('All types');
  await expect(palette(page).locator('[data-chip="from"]')).toHaveText('From anyone');
  await answered(page);
  expect(await groupIds(page)).toEqual(expect.arrayContaining(['threads', 'messages', 'files', 'projects']));
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
});

test('by keyboard only: Tab to the chip, Enter, the arrows, Enter; Escape closes the menu and focus goes back to the chip', async () => {
  await page.keyboard.press('/');
  await expect(input(page)).toBeFocused();
  await page.keyboard.type('relay');
  await answered(page);
  await page.keyboard.press('Tab');
  await expect(typeChip(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu(page)).toBeVisible();
  const items = menu(page).locator('[role="menuitemradio"]');
  await expect(items.first()).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await expect(items.nth(3)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu(page)).toHaveCount(0);
  await expect(typeChip(page)).toHaveText('Files');
  await expect(typeChip(page)).toBeFocused();
  await expect.poll(() => groupIds(page)).toEqual(['files']);
  // Open again, then Escape: the menu closes, the palette stays, focus is on the chip.
  await page.keyboard.press('Enter');
  await expect(menu(page)).toBeVisible();
  await expect(items.nth(3)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(palette(page)).toBeVisible();
  await expect(typeChip(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
});

test('a phone: the Type chip leads the sideways chip row and picks in the bottom menu sheet', async ({ browser }: { browser: Browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const p = await phone.newPage();
    await p.goto(url);
    await p.locator('.ib-lhead .ib-lhead-search').tap();
    await expect(palette(p)).toBeVisible();
    await input(p).fill('relay');
    await answered(p);
    const row = palette(p).locator('.ib-sp-filters');
    expect(await row.locator('[data-chip]').first().getAttribute('data-chip')).toBe('type');
    // The one row of chips scrolls sideways; no new row.
    expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === 'auto')).toBe(true);
    const chipBox = (await typeChip(p).boundingBox())!;
    const projectBox = (await palette(p).locator('[data-chip="project"]').boundingBox())!;
    expect(Math.abs(chipBox.y - projectBox.y)).toBeLessThan(2);
    await shot(p, '04-phone-unpicked');

    await typeChip(p).tap();
    await expect(menu(p)).toBeVisible();
    // The bottom sheet: across the width, at the bottom of the window.
    const sheet = (await menu(p).boundingBox())!;
    expect(sheet.width).toBeGreaterThan(360);
    expect(sheet.y + sheet.height).toBeGreaterThan(844 - 40);
    await menu(p).locator('[role="menuitemradio"]').filter({ has: p.locator('.ib-sp-ml', { hasText: /^Files$/ }) }).tap();
    await expect(menu(p)).toHaveCount(0);
    await expect(typeChip(p)).toHaveText('Files');
    await expect.poll(() => groupIds(p)).toEqual(['files']);
    await settled(p);
    await expect(palette(p).locator('[data-search-group="files"] [data-result]')).toHaveCount(world.relayFiles);
    await shot(p, '05-phone-files-picked');
  } finally {
    await phone.close();
  }
});

// Last: it adds a project, which would change the counts above.
test('every filter set with a long project name: the one desktop row keeps every chip and Clear filters inside the panel', async () => {
  const longName = await world.longProject();
  await page.reload();
  await openFromSidebar(page);
  await input(page).fill('relay');
  await answered(page);
  await palette(page).locator('[data-chip="project"]').click();
  await menu(page).locator('[role="menuitemradio"]').filter({ hasText: longName }).click();
  await palette(page).locator('[data-chip="status"]').click();
  await menu(page).locator('[role="menuitemradio"]').filter({ hasText: 'New since you looked' }).click();
  await palette(page).locator('[data-chip="from"]').click();
  await menu(page).locator('[role="menuitemradio"]').filter({ hasText: 'Agents' }).click();
  await pickFromMenu(page, 'Files');
  await settled(page);
  await expect(palette(page).locator('[data-unset]')).toHaveCount(4);
  const row = palette(page).locator('.ib-sp-filters');
  const clear = row.locator('[data-clear-filters]');
  await expect(clear).toBeVisible();
  // One row (every part on the same middle line), no sideways scrolling, nothing past the panel's edge.
  const fit = await row.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const right = box.right - parseFloat(getComputedStyle(el).paddingRight);
    const parts = [...el.querySelectorAll<HTMLElement>('.ib-sp-fcell, [data-clear-filters]')].map((p) => p.getBoundingClientRect());
    return { scrolls: el.scrollWidth > el.clientWidth, past: parts.filter((r) => r.right > right + 0.5).length, rows: new Set(parts.map((r) => Math.round(r.top + r.height / 2))).size };
  });
  expect(fit).toEqual({ scrolls: false, past: 0, rows: 1 });
  // The project chip gave way: its name is cut, whole in its tooltip.
  expect(await palette(page).locator('[data-chip="project"] .ib-sp-fl').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await shot(page, '06-every-filter-set');
});
