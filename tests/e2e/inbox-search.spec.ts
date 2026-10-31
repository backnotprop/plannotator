/**
 * Inbox search in a real browser against the compiled binary (the approved
 * "inbox-search" design), with agents writing through `plannotator inbox mcp`
 * (tests/e2e/inbox-search-world.ts seeds the mock's store):
 *
 *  - the sidebar's Search entry opens the palette (a modal dialog, the input
 *    a combobox over a listbox); ⌘K on macOS / Ctrl+K elsewhere opens it
 *    (the one shortcut, an owner exception; from the reply box without eating
 *    typing; again while open goes back to its input), and no other key does;
 *  - an empty query lists the threads looked at last;
 *  - typing groups the results (Threads, Messages, Files), the
 *    matched words semibold, the live region says how many;
 *  - ↓ moves the highlight (`aria-activedescendant`), Enter on a message
 *    lands on it: the thread opens, the message focused and ringed, the
 *    query's words highlighted (CSS Custom Highlight API), `msg=` dropped from
 *    the hash; the first click in the thread clears the highlight;
 *  - recent searches come back next time, and Clear forgets them;
 *  - filters: a chip's menu by keyboard, Escape closes the menu before the
 *    palette, archived results labelled, "No matches" names the scope and
 *    "Search everywhere" clears it; focus returns to the Search entry;
 *  - long, right-to-left and CJK text never overflows the palette;
 *  - ⌘/Ctrl+Enter opens a new tab and keeps the palette open;
 *  - every result starts with its mark (the agent's for a message, an outline
 *    otherwise), the selected row is lighter than the panel in dark and
 *    darker in light, the text keeps AA, and the key footer's keys work
 *    (approval "inbox-search-contrast", option B);
 *  - searched from a project, a result keeps the list on it; the same thread
 *    again replaces its entry; a stray msg= leaves the address;
 *  - a phone: the list header's search icon opens a full-screen sheet with
 *    Cancel; a result opens the thread, and Back returns to the list.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in .local/proof/search/ (PLANNOTATOR_E2E_PROOF_DIR).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { seedSearchWorld, type SearchWorld } from './inbox-search-world';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'search');

let url = '';
let world: SearchWorld;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];

async function shot(p: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await p.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await p.waitForTimeout(150);
    await p.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await p.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const palette = (p: Page) => p.locator('dialog[data-search-palette]');
const input = (p: Page) => palette(p).getByRole('combobox');

async function openFromSidebar(p: Page): Promise<void> {
  await p.locator('.ib-side .ib-sp-entry').first().click();
  await expect(palette(p)).toBeVisible();
  await expect(input(p)).toBeFocused();
}

async function settled(p: Page): Promise<void> {
  await expect(palette(p).locator('.ib-sp-list')).not.toHaveAttribute('data-dim', '');
  await expect(palette(p).locator('[data-search-indexing]')).toHaveCount(0);
}

/** The answer to the words just typed is the one drawn: the recent view (or the last query's answer) can still show,
 *  undimmed, before the new one lands, so wait for a message row with this query's matched word, then settle. */
async function answered(p: Page, word: string): Promise<void> {
  await expect(palette(p).locator('[data-search-group="recent"]')).toHaveCount(0);
  await expect(palette(p).locator('[data-search-group="messages"] [data-result="message"] .ib-sp-m').filter({ hasText: new RegExp(`^${word}$`, 'i') }).first()).toBeVisible();
  await settled(p);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-search-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  world = await seedSearchWorld({ binary, env, root, url });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
});

test.afterAll(async () => {
  try {
    if (world) await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the Search entry sits under the Tater mark; no key but the chord and / opens the palette', async () => {
  await page.goto(url);
  const entry = page.locator('.ib-side .ib-sp-entry');
  // The keycap is drawn from its attribute (shortcuts/hint.tsx), so the entry's words are "Search".
  await expect(entry).toHaveText('Search');
  await expect(entry.locator('[data-shortcut-hint="inbox-search.openSearch"]')).toHaveAttribute('data-keycap', /^(⌘K|Ctrl K)$/);
  await expect(entry).toHaveAttribute('aria-haspopup', 'dialog');
  // Under the brand, above Inbox.
  const brand = await page.locator('.ib-side .ib-brand').boundingBox();
  const box = await entry.boundingBox();
  const inbox = await page.locator('.ib-side .ib-nav').first().boundingBox();
  expect(box!.y).toBeGreaterThan(brand!.y);
  expect(box!.y).toBeLessThan(inbox!.y);
  // The phone header's icon is not drawn on a desktop.
  await expect(page.locator('.ib-lhead .ib-lhead-search')).toBeHidden();
  // ⌘K / Ctrl+K (its own tests below) and / (approval "inbox-keyboard-shortcuts") open it; nothing else does.
  for (const key of ['k', 'Alt+k', 'Shift+K', 'Control+Shift+K', 'Alt+/']) {
    await page.keyboard.press(key);
    await expect(palette(page)).toHaveCount(0);
  }
  await page.keyboard.press('/');
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await shot(page, '01-closed');
});

test('an empty query lists the threads looked at last; typing groups the results with the matched words in semibold', async () => {
  await openFromSidebar(page);
  await settled(page);
  const recent = palette(page).locator('[data-search-group="recent"] [data-result="thread"]');
  await expect(recent.first()).toBeVisible();
  expect(await recent.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-result-id')))).toContain(world.threads.relay);
  // Combobox semantics.
  await expect(input(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(input(page)).toHaveAttribute('aria-autocomplete', 'list');
  const listId = await input(page).getAttribute('aria-controls');
  await expect(page.locator(`#${listId}`)).toHaveAttribute('role', 'listbox');
  await shot(page, '02-open-empty');

  await input(page).fill('rate lim');
  await settled(page);
  const groups = await palette(page).locator('[data-search-group]').evaluateAll((g) => g.map((x) => x.getAttribute('data-search-group')));
  expect(groups).toEqual(['threads', 'messages', 'files']);
  const thread = palette(page).locator(`[data-result="thread"][data-result-id="${world.threads.relay}"]`);
  await expect(thread).toBeVisible();
  await expect(thread.locator('.ib-sp-m')).toHaveText(['rate', 'lim']);
  await expect(thread.locator('.ib-sp-chip')).toHaveText('Stopped');
  await expect(palette(page).locator('[data-result="file"]').first()).toContainText('relay-rate-limits.md');
  await expect(palette(page).locator('[data-search-live]')).toHaveText(/^\d+ results? in 3 groups$/);
  // The first row is highlighted; the input keeps focus.
  const first = await palette(page).locator('[role="option"]').first().getAttribute('id');
  await expect(input(page)).toHaveAttribute('aria-activedescendant', first!);
  await expect(input(page)).toBeFocused();
  await shot(page, '03-typing-grouped');
});

test('↓ moves the highlight; Enter on a message lands on it with the words highlighted, and msg= leaves the hash', async () => {
  await input(page).fill('retry budget');
  await settled(page);
  const target = palette(page).locator(`[data-result="message"][data-result-id="${world.retryBudget}"]`);
  await expect(target).toBeVisible();
  const options = await palette(page).locator('[role="option"]').evaluateAll((o) => o.map((x) => x.getAttribute('data-result-id')));
  const at = options.indexOf(world.retryBudget);
  expect(at).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < at; i++) await page.keyboard.press('ArrowDown');
  await expect(input(page)).toHaveAttribute('aria-activedescendant', (await target.getAttribute('id'))!);
  await expect(target).toHaveAttribute('aria-selected', 'true');
  await shot(page, '04-message-hit', ['light']);
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  const article = page.locator(`section.ib-pane [data-message-article="${world.retryBudget}"]`);
  await expect(article).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.hash)).not.toContain('msg=');
  expect(await page.evaluate(() => window.location.hash)).toContain(`thread=${world.threads.retry}`);
  // Focused, and the query's words painted without changing the DOM.
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-message-article') ?? document.activeElement?.closest('[data-message-article]')?.getAttribute('data-message-article') ?? null)).toBe(world.retryBudget);
  const hits = await page.evaluate(() => {
    const h = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get('ib-search-hit');
    return h ? [...h].map((r) => r.toString()) : [];
  });
  expect(hits.map((h) => h.toLowerCase())).toEqual(expect.arrayContaining(['retry', 'budget']));
  await expect(article.locator('mark')).toHaveCount(0);
  await shot(page, '05-landed-on-message');
  // The first click in the thread clears the highlight.
  await page.locator('section.ib-pane h2.ib-subject').click();
  expect(await page.evaluate(() => (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.has('ib-search-hit') ?? false)).toBe(false);
  // Back returns to where the search started.
  await page.goBack();
  await expect.poll(() => page.evaluate(() => window.location.hash)).not.toContain(world.threads.retry);
});

/** The project a thread is in (its root message's). */
async function projectOf(p: Page, threadId: string): Promise<string> {
  return p.evaluate(async (id) => {
    const body = (await (await fetch(`/api/inbox/threads/${id}`)).json()) as { thread: { messages: { project_id: string }[] } };
    return body.thread.messages[0]!.project_id;
  }, threadId);
}

test('searched from a project, a result keeps the list on that project; a result in the open thread replaces its entry; a stray msg= leaves the address', async () => {
  const projectId = await projectOf(page, world.threads.retry);
  await page.goto(`${url}#project=${projectId}`);
  await openFromSidebar(page);
  await input(page).fill('retry budget');
  await settled(page);
  // A mouse press on a result keeps focus in the input until the click opens it.
  await palette(page).locator(`[data-result="message"][data-result-id="${world.retryBudget}"]`).hover();
  await page.mouse.down();
  await expect(input(page)).toBeFocused();
  await page.mouse.up();
  await expect(palette(page)).toBeHidden();
  // As a row click does: the list stays that project's, beside the thread.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#project=${projectId}&thread=${world.threads.retry}`);
  const length = await page.evaluate(() => history.length);
  // The same thread again, from a result: no second entry, so the first Back leaves the thread.
  await openFromSidebar(page);
  await input(page).fill('retry budget');
  await settled(page);
  await palette(page).locator(`[data-result="message"][data-result-id="${world.retryBudget}"]`).click();
  await expect(palette(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#project=${projectId}&thread=${world.threads.retry}`);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#project=${projectId}`);
  // A msg= with no thread is dropped from the address.
  await page.goto(`${url}#project=${projectId}&msg=${world.retryBudget}`);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#project=${projectId}`);
  // The next tests search from the whole Inbox.
  await page.goto(url);
});

/**
 * ⌘K / Ctrl+K, the Inbox's one shortcut (owner exception, approval amendment
 * 2026-10-14), on each platform: `navigator.platform` is set before the page
 * loads, as the window reads it once.
 */
for (const platform of [
  { name: 'macOS', value: 'MacIntel', chord: 'Meta+K', other: 'Control+K', hint: '⌘K', shot: 'mac' },
  { name: 'Windows and Linux', value: 'Win32', chord: 'Control+K', other: 'Meta+K', hint: 'Ctrl K', shot: 'other' },
]) {
  test(`${platform.name}: ${platform.chord} opens search from the reply box without eating typing; again goes back to the input; the entry shows ${platform.hint}`, async ({ browser }: { browser: Browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    try {
      await ctx.addInitScript((value) => Object.defineProperty(Navigator.prototype, 'platform', { get: () => value, configurable: true }), platform.value);
      const p = await ctx.newPage();
      await p.goto(`${url}#thread=${world.threads.retry}`);
      const hint = p.locator('.ib-side .ib-sp-entry [data-shortcut-hint="inbox-search.openSearch"]');
      await expect(hint).toHaveAttribute('data-keycap', platform.hint);
      await expect(p.locator('.ib-side .ib-sp-entry')).toHaveAttribute('aria-keyshortcuts', platform.value === 'MacIntel' ? 'Meta+K /' : 'Control+K /');
      await p.locator('.ib-side').screenshot({ path: join(proofDir, `30-sidebar-hint-${platform.shot}-light.png`) });
      await p.emulateMedia({ colorScheme: 'dark' });
      await p.waitForTimeout(250);
      await p.locator('.ib-side').screenshot({ path: join(proofDir, `30-sidebar-hint-${platform.shot}-dark.png`) });
      await p.emulateMedia({ colorScheme: 'light' });
      // From the reply box: the words stay, search opens.
      await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
      const box = p.getByRole('textbox', { name: /^Reply to/ });
      await box.fill('Half a sentence');
      await p.keyboard.press(platform.other);
      await expect(palette(p)).toBeHidden();
      await p.keyboard.press(platform.chord);
      await expect(palette(p)).toBeVisible();
      await expect(input(p)).toBeFocused();
      await expect(box).toHaveValue('Half a sentence');
      // Again while open: back to the input, the words selected to type over.
      await input(p).fill('retry budget');
      await palette(p).locator('.ib-sp-filters button').first().focus();
      await p.keyboard.press(platform.chord);
      await expect(input(p)).toBeFocused();
      expect(await input(p).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 'retry budget'.length]);
      await expect(palette(p)).toHaveCount(1);
      // Escape closes it, and focus goes back to the reply box.
      await p.keyboard.press('Escape');
      await expect(palette(p)).toBeHidden();
      await expect(box).toBeFocused();
    } finally {
      await ctx.close();
    }
  });
}

test('recent searches come back on the next open, and Clear forgets them', async () => {
  await openFromSidebar(page);
  await settled(page);
  const recent = palette(page).locator('[data-recent-search]');
  await expect(recent.first()).toHaveText('retry budget');
  await recent.first().click();
  await settled(page);
  await expect(input(page)).toHaveValue('retry budget');
  await input(page).fill('');
  await settled(page);
  await palette(page).locator('[data-clear-recent]').click();
  await expect(palette(page).locator('[data-recent-search]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(page.locator('.ib-side .ib-sp-entry')).toBeFocused();
});

test('filters: a chip menu by keyboard, Escape closes the menu before the palette, archived results labelled', async () => {
  await openFromSidebar(page);
  await input(page).fill('pagination');
  await settled(page);
  const archived = palette(page).locator(`[data-result="thread"][data-result-id="${world.threads.pagination}"]`);
  await expect(archived.locator('.ib-sp-chip')).toHaveText('Archived');
  // The open thread of the same quality ranks above the archived one.
  const order = await palette(page).locator('[data-search-group="threads"] [data-result]').evaluateAll((r) => r.map((x) => x.getAttribute('data-result-id')));
  expect(order.indexOf(world.threads.cliPagination)).toBeLessThan(order.indexOf(world.threads.pagination));
  // Tab reaches the chips (Type, Project, then Status); the Status menu opens; arrows and Enter pick Archived.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(palette(page).locator('[data-chip="status"]')).toBeFocused();
  await page.keyboard.press('Enter');
  const menu = palette(page).getByRole('menu');
  await expect(menu).toBeVisible();
  await shot(page, '06-filter-menu', ['light']);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await settled(page);
  await expect(palette(page).locator('[data-chip="status"]')).toHaveText('Archived');
  await expect(palette(page).locator('[data-search-group="threads"] [data-result]')).toHaveCount(1);
  await shot(page, '07-filters-applied');
  // Escape with a menu open closes the menu only.
  await palette(page).locator('[data-chip="from"]').click();
  await expect(palette(page).getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page).getByRole('menu')).toHaveCount(0);
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).locator('[data-chip="from"]')).toBeFocused();
  // No matches names the scope; Search everywhere clears it.
  await input(page).fill('jitter');
  await settled(page);
  await expect(palette(page).locator('[data-search-none]')).toContainText('No matches for “jitter”');
  await expect(palette(page).locator('[data-search-none]')).toContainText('Searched only Archived.');
  await shot(page, '08-no-results-filtered', ['light']);
  await palette(page).locator('[data-search-none] [data-clear-filters]').click();
  await settled(page);
  await expect(palette(page).locator('[data-result="message"]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(page.locator('.ib-side .ib-sp-entry')).toBeFocused();
});

test('a message and a file draw their thread’s chip; every second line keeps its time', async () => {
  await openFromSidebar(page);
  await input(page).fill('retry budget');
  await settled(page);
  const budget = palette(page).locator(`[data-result="message"][data-result-id="${world.retryBudget}"]`);
  // The list's chip: the thread's name.
  const budgetChip = budget.locator('.ib-key[data-result-thread="name"]');
  await expect(budgetChip.locator('.ib-keyt')).toHaveText('retry');
  // The whole thread is the chip's component tooltip (portaled into the palette's dialog), never a native title.
  await expect(budgetChip).not.toHaveAttribute('title', /./);
  await budgetChip.hover();
  await expect(palette(page).getByText('Thread: retry: Retry storm on the relay after a deploy', { exact: true })).toBeVisible();
  await page.mouse.move(1, 1);
  await input(page).fill('retry-policy');
  await settled(page);
  await expect(palette(page).locator('[data-result="file"]').first().locator('.ib-key .ib-keyt')).toHaveText('retry');
  await input(page).fill('CDN cache key');
  await settled(page);
  for (const kind of ['message']) {
    const chip = palette(page).locator(`[data-result="${kind}"]`).first().locator('.ib-key[data-result-thread]');
    await expect(chip.locator('.ib-keyt')).toHaveText('nightly-deploy-investigation-for-the-customer-portal');
    await expect(chip).not.toHaveAttribute('title', /./);
    await chip.hover();
    await expect(palette(page).getByText(/^Thread: nightly-deploy-investigation-for-the-customer-portal: Investigate why the nightly deploy/)).toBeVisible();
    await page.mouse.move(1, 1);
  }
  await shot(page, '09a-thread-on-row');
  // Every part of the second line stays inside its row, and the time is drawn whole inside the row (its own
  // column on a desktop, the end of the second line on a phone), at desktop and narrow widths.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const q of ['deploy', 'CDN cache key', 'spike']) {
      await input(page).fill(q);
      await settled(page);
      const bad = await palette(page).evaluate((dialog) =>
        [...dialog.querySelectorAll<HTMLElement>('.ib-sp-tl')].filter((line) => {
          const row = line.closest<HTMLElement>('[role="option"]')!;
          const at = row.querySelector('[data-result-time]') ?? line.querySelector('.ib-sp-at') ?? line.lastElementChild!;
          return line.scrollWidth > line.clientWidth + 1 || at.getBoundingClientRect().right > row.getBoundingClientRect().right + 1;
        }).length,
      );
      expect(bad, `${q} at ${width}px`).toBe(0);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
});

test('long, right-to-left and CJK text stays inside the palette', async () => {
  await openFromSidebar(page);
  await input(page).fill('deploy');
  await settled(page);
  await expect(palette(page).locator(`[data-result="thread"][data-result-id="${world.threads.arabic}"]`)).toBeVisible();
  await expect(palette(page).locator(`[data-result="thread"][data-result-id="${world.threads.japanese}"]`)).toBeVisible();
  const overflow = await palette(page).evaluate((dialog) => {
    const list = dialog.querySelector('.ib-sp-list') as HTMLElement;
    const rows = [...dialog.querySelectorAll<HTMLElement>('[role="option"]')];
    return { list: list.scrollWidth - list.clientWidth, rows: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length };
  });
  expect(overflow).toEqual({ list: 0, rows: 0 });
  // The truncating line carries dir="auto"; its full text is a component tooltip while cut, never a native title.
  const arabic = palette(page).locator(`[data-result="thread"][data-result-id="${world.threads.arabic}"] .ib-sp-p`);
  await expect(arabic).toHaveAttribute('dir', 'auto');
  await expect(arabic).not.toHaveAttribute('title', /./);
  // Cut it (a narrow box, as on a phone): hovered, the component tooltip holds the whole right-to-left text.
  await arabic.evaluate((el) => ((el as HTMLElement).style.maxWidth = '140px'));
  expect(await arabic.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await arabic.hover();
  await expect(palette(page).locator('[data-side].bg-popover')).toHaveText('تقرير أخطاء الدفع بعد آخر deploy على الخادم الثاني');
  await page.mouse.move(1, 1);
  await arabic.evaluate((el) => ((el as HTMLElement).style.maxWidth = ''));
  await shot(page, '09-stress-long-rtl');
});

test('⌘/Ctrl+Enter opens the result in a new tab and keeps the palette open', async () => {
  const opened = context.waitForEvent('page');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  const tab = await opened;
  await tab.waitForLoadState();
  expect(tab.url()).toContain('#thread=');
  await expect(palette(page)).toBeVisible();
  await tab.close();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  expect(errors).toEqual([]);
});

/** The box of the palette's first named thread chip, and of a plain `.ib-key` mounted in the Inbox outside the palette, as the rest of the Inbox draws it (border, corners, fill, padding, face). */
async function chipBoxes(p: Page): Promise<{ search: string | null; list: string | null; boxed: boolean }> {
  return p.evaluate(() => {
    const box = (el: Element | null | undefined) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return [s.borderTopWidth, s.borderTopStyle, s.borderTopColor, s.borderTopLeftRadius, s.backgroundColor, s.paddingLeft, s.fontFamily].join(' | ');
    };
    const ref = document.createElement('span');
    ref.className = 'ib-key';
    ref.textContent = 'ref';
    document.querySelector('.pn-inbox')!.append(ref);
    const list = box(ref);
    ref.remove();
    const chip = document.querySelector('dialog.ib-sp .ib-sp-tl .ib-key[data-result-thread="name"]');
    // Drawn as a box: padded, and filled or outlined (the default style fills it; others outline it).
    const clear = (c: string) => c === 'transparent' || /\/ 0\)$|, 0\)$/.test(c);
    const s = chip ? getComputedStyle(chip) : null;
    const boxed = Boolean(s && parseFloat(s.paddingLeft) > 0 && (!clear(s.backgroundColor) || (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' && !clear(s.borderTopColor))));
    return { search: box(chip), list, boxed };
  });
}

/** WCAG contrast of two CSS colours, the first composited over the second (canvas-resolved, so oklch and color-mix work). */
async function contrastOf(p: Page, fg: string, bg: string, under?: string): Promise<{ ratio: number; fgLum: number; bgLum: number }> {
  return p.evaluate(
    ([fg, bg, under]) => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const x = c.getContext('2d', { willReadFrequently: true })!;
      const rgba = (css: string): number[] => {
        x.clearRect(0, 0, 1, 1);
        x.fillStyle = '#000';
        x.fillStyle = css;
        x.fillRect(0, 0, 1, 1);
        const d = x.getImageData(0, 0, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
      };
      const over = (top: number[], base: number[]) => top.slice(0, 3).map((v, i) => v * top[3]! + base[i]! * (1 - top[3]!));
      const lum = (rgb: number[]) => {
        const l = rgb.map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * l[0]! + 0.7152 * l[1]! + 0.0722 * l[2]!;
      };
      const base = under ? over(rgba(bg), rgba(under)) : rgba(bg).slice(0, 3);
      const top = over(rgba(fg), base);
      const [a, b] = [lum(top), lum(base)];
      return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), fgLum: a, bgLum: b };
    },
    [fg, bg, under ?? ''] as const,
  );
}

test('every result starts with its mark; the selected row stands apart from the panel; text keeps AA; the key footer’s keys work', async () => {
  await openFromSidebar(page);
  await input(page).fill('retry');
  await answered(page, 'retry');
  const rows = palette(page).locator('[role="option"][data-result]');
  await expect(rows.first()).toBeVisible();
  // Each result's first child is its mark, drawn (a visible icon), and hidden from a screen reader.
  const marks = await rows.evaluateAll((all) =>
    all.map((row) => {
      const mark = row.firstElementChild as HTMLElement;
      const box = mark.querySelector('svg, img')?.getBoundingClientRect();
      return { type: row.getAttribute('data-result'), id: row.getAttribute('data-result-id'), isMark: mark.classList.contains('ib-sp-mark'), mark: mark.getAttribute('data-row-mark'), hidden: mark.getAttribute('aria-hidden'), drawn: Boolean(box && box.width >= 14 && box.height >= 14) };
    }),
  );
  expect(marks.length).toBeGreaterThan(3);
  for (const m of marks) expect(m, JSON.stringify(m)).toMatchObject({ isMark: true, hidden: 'true', drawn: true });
  const want: Record<string, string> = { thread: 'comment', file: 'doc', guide: 'book', project: 'folder' };
  for (const m of marks.filter((r) => r.type !== 'message')) expect(m.mark).toBe(want[m.type!]);
  expect(new Set(marks.map((m) => m.type))).toEqual(new Set(['thread', 'message', 'file']));
  // A message shows its writer's mark: Claude Code's for Claude Code, the person's outline for a reply.
  const byWriter = await palette(page)
    .locator('[data-result="message"]')
    .evaluateAll((all) => all.map((r) => [r.querySelector('.ib-sp-tl .ib-sp-lead')!.textContent, r.querySelector('.ib-sp-mark')!.getAttribute('data-row-mark')]));
  const hostOf: Record<string, string> = { 'Claude Code': 'agent:claude-code', Pi: 'agent:pi', OpenCode: 'agent:opencode', You: 'user' };
  expect(byWriter.map(([who]) => who)).toEqual(expect.arrayContaining(['Claude Code', 'You']));
  for (const [who, mark] of byWriter) expect(mark, who!).toBe(hostOf[who!]);

  // The selected row against the panel, and the text against both, in each theme.
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('light'))).toBe(scheme === 'light');
    // Every element eases its colours over 150 ms on a theme switch (packages/ui/theme.css, `*`): measure once no
    // colour transition runs, or a slow machine reads the panel and the row half-way between the themes.
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === 'running').length)).toBe(0);
    const look = await palette(page).evaluate((dialog) => {
      const panel = getComputedStyle(dialog).backgroundColor;
      const selected = dialog.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')!;
      const other = dialog.querySelector<HTMLElement>('[role="option"][data-result="message"]:not([aria-selected="true"])')!;
      return {
        panel,
        selectedBg: getComputedStyle(selected).backgroundColor,
        otherBg: getComputedStyle(other).backgroundColor,
        title: getComputedStyle(other.querySelector('.ib-sp-p')!).color,
        meta: getComputedStyle(other.querySelector('.ib-sp-tl')!).color,
        time: getComputedStyle(other.querySelector('[data-result-time]')!).color,
        selectedTitle: getComputedStyle(selected.querySelector('.ib-sp-p')!).color,
        selectedMeta: getComputedStyle(selected.querySelector('.ib-sp-s')!).color,
        heading: getComputedStyle(dialog.querySelector('.ib-sp-gh')!).color,
      };
    });
    // An unselected row has no fill; the selected one does, lighter than the panel in dark and darker in light (it was darker in dark: 1.05:1).
    const fill = await contrastOf(page, look.selectedBg, look.panel);
    expect((await contrastOf(page, look.otherBg, look.panel)).ratio).toBeCloseTo(1, 2);
    expect(fill.ratio, `${scheme} selected fill`).toBeGreaterThanOrEqual(1.2);
    expect(fill.fgLum > fill.bgLum, `${scheme}: selected lighter than the panel`).toBe(scheme === 'dark');
    for (const [name, fg, bg] of [
      ['title', look.title, look.panel],
      ['meta', look.meta, look.panel],
      ['time', look.time, look.panel],
      ['heading', look.heading, look.panel],
    ] as const) {
      expect((await contrastOf(page, fg, bg)).ratio, `${scheme} ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const [name, fg] of [
      ['selected title', look.selectedTitle],
      ['selected meta', look.selectedMeta],
    ] as const) {
      expect((await contrastOf(page, fg, look.selectedBg, look.panel)).ratio, `${scheme} ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    // The thread's name keeps the chip form, the box the rest of the Inbox draws (owner request 2026-10-16), in each theme.
    const chip = await chipBoxes(page);
    expect(chip.boxed, `${scheme}: the thread chip is drawn as a box`).toBe(true);
    expect(chip.search, `${scheme}: the thread chip is the Inbox's chip`).toBe(chip.list);
    await page.screenshot({ path: join(proofDir, `10-marks-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

  // The footer names only keys the palette handles, and each does what it says.
  const foot = palette(page).locator('[data-search-keys]');
  await expect(foot).toBeVisible();
  // Each keycap names its binding and is spelled by the registry (as Send's ⌘↵ / Ctrl ↵ is); each binding is pressed below.
  const keys = await foot.locator('kbd').evaluateAll((all) => all.map((k) => [k.getAttribute('data-keycap-binding'), k.textContent]));
  expect(keys.map(([binding]) => binding)).toEqual(['ArrowUp', 'ArrowDown', 'Enter', 'Mod+Enter', 'Escape']);
  const caps = keys.map(([, text]) => text!);
  expect(caps.slice(0, 3)).toEqual(['↑', '↓', '↵']);
  expect(caps[3]).toMatch(/^(⌘↵|Ctrl ↵)$/);
  expect(caps[4]).toBe('Esc');
  await expect(foot).toContainText('Move');
  await expect(foot).toContainText('Open in new tab');
  await expect(foot).toContainText('Close');
  const active = () => input(page).getAttribute('aria-activedescendant');
  const optionIds = await palette(page).locator('[role="option"]').evaluateAll((all) => all.map((o) => o.id));
  expect(await active()).toBe(optionIds[0]);
  await page.keyboard.press('ArrowDown');
  expect(await active()).toBe(optionIds[1]);
  await page.keyboard.press('ArrowUp');
  expect(await active()).toBe(optionIds[0]);
  // The new-tab chord as the footer names it.
  const opened = context.waitForEvent('page');
  await page.keyboard.press(caps[3]!.startsWith('⌘') ? 'Meta+Enter' : 'Control+Enter');
  const tab = await opened;
  await tab.waitForLoadState();
  expect(tab.url()).toContain('#thread=');
  await tab.close();
  await expect(palette(page)).toBeVisible();
  // Enter opens the highlighted result and closes the palette.
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('thread=');
  // Esc closes it.
  await openFromSidebar(page);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  // A phone has no footer (checked with the sheet below).
  expect(errors).toEqual([]);
});

test('a phone: the list header opens a full-screen sheet; a result opens the thread and Back returns to the list', async ({ browser }: { browser: Browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const p = await phone.newPage();
    await p.goto(url);
    const icon = p.locator('.ib-lhead .ib-lhead-search');
    await expect(icon).toBeVisible();
    await shot(p, '20-phone-closed', ['light']);
    await icon.tap();
    await expect(palette(p)).toBeVisible();
    const box = await palette(p).boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: 390 });
    await expect(palette(p).locator('[data-search-cancel]')).toBeVisible();
    expect(await input(p).evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    await settled(p);
    await shot(p, '21-phone-open-empty', ['dark']);
    await input(p).fill('rate lim');
    await settled(p);
    const rowHeight = await palette(p).locator('[role="option"]').first().evaluate((el) => el.getBoundingClientRect().height);
    expect(rowHeight).toBeGreaterThanOrEqual(56);
    // A phone: each result keeps its mark, the time stays on the second line (no column), and there is no key footer.
    const relayRow = palette(p).locator(`[data-result="thread"][data-result-id="${world.threads.relay}"]`);
    await expect(relayRow.locator(':scope > .ib-sp-mark')).toHaveAttribute('data-row-mark', 'comment');
    await expect(relayRow.locator('[data-result-time]')).toHaveCount(0);
    await expect(relayRow.locator('.ib-sp-tl .ib-sp-at')).toBeVisible();
    await expect(palette(p).locator('[data-search-keys]')).toHaveCount(0);
    // A phone draws the thread chip with the Inbox's box too.
    await input(p).fill('retry');
    await answered(p, 'retry');
    const chip = await chipBoxes(p);
    expect(chip.boxed, 'phone: the thread chip is drawn as a box').toBe(true);
    expect(chip.search, "phone: the thread chip is the Inbox's chip").toBe(chip.list);
    await input(p).fill('rate lim');
    await settled(p);
    await shot(p, '22-phone-typing');
    await palette(p).locator(`[data-result="thread"][data-result-id="${world.threads.relay}"]`).tap();
    await expect(palette(p)).toBeHidden();
    await expect(p.locator('.pn-inbox')).toHaveAttribute('data-view', 'thread');
    await shot(p, '23-phone-landed', ['dark']);
    await p.goBack();
    await expect(p.locator('.pn-inbox')).toHaveAttribute('data-view', 'list');
    // Cancel closes the sheet.
    await icon.tap();
    await palette(p).locator('[data-search-cancel]').tap();
    await expect(palette(p)).toBeHidden();
    // The sidebar sheet's Search entry: the sheet closes and the search sheet opens.
    await p.locator('.ib-lhead .ib-sb-trigger').tap();
    const sheetEntry = p.locator('.ib-sp-entry').filter({ visible: true });
    await expect(sheetEntry).toBeVisible();
    await shot(p, '24-phone-sidebar-entry', ['light']);
    await sheetEntry.tap();
    await expect(palette(p)).toBeVisible();
    await expect(sheetEntry).toBeHidden();
    await palette(p).locator('[data-search-cancel]').tap();
    await expect(palette(p)).toBeHidden();
  } finally {
    await phone.close();
  }
});

test('a phone, from a project list: a result keeps the project, and ‹ is the browser’s Back to that list (D7)', async ({ browser }: { browser: Browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const p = await phone.newPage();
    await p.goto(url);
    const projectId = await projectOf(p, world.threads.relay);
    await p.goto(`${url}#project=${projectId}`);
    await expect(p.locator('.pn-inbox')).toHaveAttribute('data-view', 'list');
    const before = await p.evaluate(() => history.length);
    await p.locator('.ib-lhead .ib-lhead-search').tap();
    await input(p).fill('rate lim');
    await settled(p);
    await palette(p).locator(`[data-result="thread"][data-result-id="${world.threads.relay}"]`).tap();
    await expect(p.locator('.pn-inbox')).toHaveAttribute('data-view', 'thread');
    await expect.poll(() => p.evaluate(() => window.location.hash)).toBe(`#project=${projectId}&thread=${world.threads.relay}`);
    expect(await p.evaluate(() => history.length)).toBe(before + 1);
    await shot(p, '25-phone-project-result', ['light']);
    await p.locator('[data-phone-back]').tap();
    await expect(p.locator('.pn-inbox')).toHaveAttribute('data-view', 'list');
    await expect.poll(() => p.evaluate(() => window.location.hash)).toBe(`#project=${projectId}`);
    // The browser's Back, not a new entry: the thread is still ahead.
    expect(await p.evaluate(() => history.length)).toBe(before + 1);
    await p.goForward();
    await expect(p.locator('.pn-inbox')).toHaveAttribute('data-view', 'thread');
    // A message landed on: its ring clears the text (the message has no padding of its own on a phone) and nothing moves.
    await p.locator('[data-phone-back]').tap();
    await expect(p.locator('.pn-inbox')).toHaveAttribute('data-view', 'list');
    await p.locator('.ib-lhead .ib-lhead-search').tap();
    await input(p).fill('retry budget');
    await settled(p);
    await palette(p).locator(`[data-result="message"][data-result-id="${world.retryBudget}"]`).tap();
    const article = p.locator(`section.ib-pane [data-message-article="${world.retryBudget}"]`);
    await expect(article).toHaveClass(/ib-q-target/);
    const ring = await article.evaluate((el) => {
      const style = getComputedStyle(el);
      return { padding: style.paddingLeft, margin: style.marginLeft };
    });
    expect(ring).toEqual({ padding: '8px', margin: '-8px' });
    await shot(p, '26-phone-landed-message', ['light']);
  } finally {
    await phone.close();
  }
});
