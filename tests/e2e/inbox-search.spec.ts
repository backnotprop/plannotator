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
  // Tab reaches the chips; the Status menu opens; arrows and Enter pick Archived.
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
  // Every part of the second line stays inside its row: the time is drawn whole, at desktop and phone widths.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const q of ['deploy', 'CDN cache key', 'spike']) {
      await input(page).fill(q);
      await settled(page);
      const bad = await palette(page).evaluate((dialog) =>
        [...dialog.querySelectorAll<HTMLElement>('.ib-sp-tl')].filter((line) => {
          const at = line.querySelector('.ib-sp-at') ?? line.lastElementChild!;
          return line.scrollWidth > line.clientWidth + 1 || at.getBoundingClientRect().right > line.getBoundingClientRect().right + 1;
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
