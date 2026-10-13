/**
 * The Inbox with the worst realistic data (the stress test of 2026-10-12 and
 * its fix plan, PR 1): scripts/inbox-worst-case.ts fills a throwaway Inbox
 * with non-Latin project folders, two folders named "api", a 54-character
 * project name, right-to-left text, long and near-identical file names, a
 * changed file with comments, a message table and a tall screenshot, a
 * thread over four days and one from last year, a 2,000-character decision,
 * 46 projects and 50 live agent sessions. Every screen is loaded at the
 * widths people use (1440, 1280, 1024, an iPad upright, a phone, a phone on
 * its side, and 200% zoom as 720 by 450) and checked for shapes, not pixels:
 *
 * - the page never scrolls sideways;
 * - a primary button is inside the window;
 * - a decision's text column keeps a readable width;
 * - tiles in one grid keep one height, and a changed file keeps its count;
 * - the list's header stays 60 px with a long project name and folder, and
 *   the sidebar's Inbox and Decisions stay 32 px with 46 projects;
 * - a shortened name has its full text as its hover text;
 * - project names are the folders' own, times say their day and year.
 *
 * Each later fix adds its own check here (a break not fixed yet is a
 * `test.fixme` with the fix plan's row). Build the binary first (see
 * inbox.spec.ts), then `bun run test:e2e:inbox`. PNGs land in
 * .local/proof/worst-case/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { LiveSessions, LONG_DECISION, seedWorstCase, type WorstCaseWorld } from '../../scripts/inbox-worst-case';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'worst-case');

interface World {
  url: string;
  startedAt: number;
  seed: WorstCaseWorld;
  ids: Record<string, string>;
  live: LiveSessions;
}

let world: World;

interface Width {
  name: string;
  width: number;
  height: number;
  touch?: boolean;
}

const WIDTHS: Width[] = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1024', width: 1024, height: 768 },
  { name: 'ipad', width: 820, height: 1180, touch: true },
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'phone-side', width: 844, height: 390, touch: true },
  { name: 'zoom200', width: 720, height: 450 },
];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-worst-case-e2e-');
  const dataDir = join(root, 'data');
  const seed = await seedWorstCase({ dataDir, src: join(root, 'src') });
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: 'none', PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/+$/, '');
  const projects = (await (await fetch(`${url}/api/inbox/projects`)).json()) as { projects: { id: string; root: string }[] };
  const ids = Object.fromEntries(Object.entries(seed.projects).map(([role, path]) => [role, projects.projects.find((p) => p.root === path)?.id ?? '']));
  world = { url, startedAt: Date.now(), seed, ids, live: new LiveSessions(dataDir, seed.projects.billing, 50) };
});

test.afterAll(async () => {
  try {
    await world?.live.stop();
  } finally {
    await removeInboxScratch();
  }
});

async function open(browser: Browser, w: Width, hash = '', colorScheme: 'light' | 'dark' = 'light'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: w.width, height: w.height }, isMobile: !!w.touch, hasTouch: !!w.touch, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme });
  const page = await context.newPage();
  await page.goto(`${world.url}/${hash ? `#${hash}` : ''}`);
  await page.waitForSelector('.pn-inbox');
  await page.waitForTimeout(500);
  return { context, page };
}

/** The shapes every screen keeps: nothing scrolls the page sideways, and a visible primary button is inside the window. */
async function shapes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const W = window.innerWidth;
    const H = window.innerHeight;
    const scroller = document.scrollingElement!;
    if (scroller.scrollWidth > W + 1) out.push(`the page is ${scroller.scrollWidth}px wide in a ${W}px window`);
    for (const el of document.querySelectorAll<HTMLElement>('.pn-inbox *')) {
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || style.visibility === 'hidden') continue;
      if (el.closest('pre, code, table, [data-code-view], .ib-cmd, .ib-docarea, .ib-imgstage, .ib-gbody')) continue;
      // Drawn past the window, and not clipped by a box of its own (a name cut with "…" is clipped by its cell).
      let clipped = false;
      for (let up = el.parentElement; up && !up.classList.contains('ib-shell'); up = up.parentElement) {
        if (getComputedStyle(up).overflowX !== 'visible' && up.getBoundingClientRect().right <= W + 1) {
          clipped = true;
          break;
        }
      }
      if (r.right > W + 1 && !clipped && el.closest('.ib-shell')) {
        out.push(`${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')} reaches ${Math.round(r.right)} in a ${W}px window`);
        break;
      }
    }
    for (const button of document.querySelectorAll<HTMLElement>('.ib-btn.ib-pri')) {
      const r = button.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(button).visibility === 'hidden' || button.closest('[inert], [hidden]')) continue;
      if (r.bottom > H + 1 || r.right > W + 1 || r.top < -1) out.push(`"${button.textContent?.trim()}" is outside the window (${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)})`);
    }
    return out;
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

// Every width in light, and the widest and a phone in dark too.
for (const [w, scheme] of [...WIDTHS.map((w) => [w, 'light'] as const), [WIDTHS[0]!, 'dark'] as const, [WIDTHS[4]!, 'dark'] as const]) {
  test(`${w.name}${scheme === 'dark' ? ' dark' : ''}: the list, a thread with files, a message table, Decisions and Settings hold their shapes`, async ({ browser }) => {
    const { context, page } = await open(browser, w, '', scheme);
    try {
      // The list, and the real project names (rows 1 to 5).
      expect(await shapes(page)).toEqual([]);
      await shot(page, `${w.name}-${scheme}-list`);
      // The thread with files: tiles keep one height and the changed file keeps its count (rows 16 to 19).
      await page.goto(`${world.url}/#thread=${world.seed.threads.files}`);
      await page.waitForSelector('section.ib-pane .ib-atts.ib-tiles');
      await page.waitForTimeout(400);
      expect(await shapes(page)).toEqual([]);
      const tiles = page.locator('section.ib-pane .ib-atts.ib-tiles').last().locator('.ib-att-t');
      const heights = new Set((await tiles.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))).filter((h) => h > 0));
      expect([...heights], 'tiles in one grid have one height').toHaveLength(1);
      await expect(page.locator(`section.ib-pane .ib-atts.ib-tiles [data-attachment-name="${world.seed.files.changed}"]`).last()).toContainText('2 annotations');
      await shot(page, `${w.name}-${scheme}-files`);
      // A message with a table and a tall screenshot (rows 8, 33).
      await page.goto(`${world.url}/#thread=${world.seed.threads.kitchen}`);
      await page.waitForSelector('section.ib-pane .ib-body table');
      await page.waitForTimeout(600);
      expect(await shapes(page)).toEqual([]);
      const cell = await page.locator('section.ib-pane .ib-body td').first().evaluate((el) => el.getBoundingClientRect().width);
      expect(cell, 'a table cell keeps a word whole').toBeGreaterThan(40);
      const img = page.locator('section.ib-pane .ib-body img[data-ib-tall]');
      await expect(img).toHaveCount(1);
      expect((await img.boundingBox())!.height).toBeLessThanOrEqual(481);
      await shot(page, `${w.name}-${scheme}-kitchen`);
      // Decisions: the text column keeps a readable width (row 62) and a long decision three lines (row 63).
      await page.goto(`${world.url}/#decisions=${world.ids.billing}`);
      await page.waitForSelector('[data-decision-id]');
      await page.waitForTimeout(300);
      expect(await shapes(page)).toEqual([]);
      const text = page.locator('[data-decision-id] .ib-st', { hasText: 'Refunds for partial captures' }).first();
      expect((await text.boundingBox())!.width, 'a decision has room to read').toBeGreaterThan(Math.min(260, w.width - 140));
      expect(LONG_DECISION.length).toBe(2000);
      expect((await text.boundingBox())!.height, 'a long decision shows three lines').toBeLessThan(80);
      await shot(page, `${w.name}-${scheme}-decisions`);
      // Settings: Storage keeps its sizes and Delete in view (rows 64, 65); Archived keeps Unarchive on its row (row 67).
      await page.goto(`${world.url}/#settings/storage`);
      await page.waitForSelector('[data-store-project]');
      await page.locator('[data-store-project] .ib-fold', { hasText: 'billing-svc' }).first().click();
      await page.waitForTimeout(300);
      expect(await shapes(page)).toEqual([]);
      const table = await page.locator('.ib-stbl').evaluate((el) => ({ table: el.getBoundingClientRect().right, card: (el.closest('.ib-card') ?? el.parentElement)!.getBoundingClientRect().right }));
      expect(table.table).toBeLessThanOrEqual(table.card + 1);
      await shot(page, `${w.name}-${scheme}-storage`);
      await page.goto(`${world.url}/#settings/archived`);
      await page.waitForSelector('[data-archived-thread]');
      await page.waitForTimeout(300);
      expect(await shapes(page)).toEqual([]);
      const row = await page.locator('[data-archived-thread]').first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        const b = el.querySelector('[data-archived-unarchive]')!.getBoundingClientRect();
        return { rowTop: r.top, rowBottom: r.bottom, button: b.top };
      });
      expect(row.button, 'Unarchive sits beside the subject, not under it').toBeLessThan(row.rowTop + 40);
      await shot(page, `${w.name}-${scheme}-archived`);
    } finally {
      await context.close();
    }
  });
}

test('the names: real folder names, a parent folder for two "api", days and years, hover text on what is cut', async ({ browser }) => {
  const { context, page } = await open(browser, WIDTHS[0]!);
  try {
    const sidebar = await page.locator('.ib-side .ib-proj .ib-name').allTextContents();
    for (const name of ['請求サービス', 'خدمة-الفواتير', 'dịch-vụ-thanh-toán', 'платёжный-сервис', 'api · work', 'api · personal', 'northwind-industries-holdings-platform-billing-service']) expect(sidebar).toContain(name);
    // With 46 projects the nav items keep their 32 px (row 28).
    for (const height of await page.locator('.ib-side > .ib-nav').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(height).toBe(32);
    // Last year's thread says its year (row 12).
    await page.goto(`${world.url}/#project=${world.ids.billing}`);
    await page.waitForSelector(`[data-thread-id="${world.seed.threads.lastYear}"]`);
    await expect(page.locator(`[data-thread-id="${world.seed.threads.lastYear}"] .ib-t`)).toHaveText(new RegExp(`, ${new Date().getFullYear() - 1}$`));
    // No subject is cut inside a character (row 26).
    for (const subject of await page.locator('.ib-lbody .ib-st').allTextContents()) expect(subject).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    // Hovered, what the list cuts with "…" has its full text as its title, and what it does not cut has none (row 23).
    const titles = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.ib-lbody .ib-st, .ib-lbody .ib-keyt, .ib-lbody .ib-p')].map((el) => {
        el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        return { cut: el.scrollWidth > el.clientWidth + 1, text: el.textContent, title: el.getAttribute('title') };
      }),
    );
    expect(titles.filter((t) => t.cut).length, 'the seed cuts something in this list').toBeGreaterThan(0);
    expect(titles.filter((t) => t.cut && t.title !== t.text)).toEqual([]);
    expect(titles.filter((t) => !t.cut && t.title !== null)).toEqual([]);
    // A long project name and its folder stay in the 60 px header (row 25).
    await page.goto(`${world.url}/#project=${world.ids.long}&thread=${world.seed.threads.multiDay}`);
    await page.waitForSelector('section.ib-pane');
    expect((await page.locator('.ib-lhead').boundingBox())!.height).toBe(60);
    // Yesterday's message says its day (row 10).
    await expect(page.locator('section.ib-pane :is(.ib-tm, .ib-fl-tm)').first()).toContainText(/[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/);
  } finally {
    await context.close();
  }
});

test('things that grow: the reply chooser with 50 sessions, the New message list, a long draft', async ({ browser }) => {
  // The session that asked counts as live for a minute after the Inbox starts.
  await new Promise((r) => setTimeout(r, Math.max(0, world.startedAt + 70_000 - Date.now())));
  for (const [w, thread] of [
    [WIDTHS[2]!, world.seed.threads.ended],
    [WIDTHS[6]!, world.seed.threads.ended2],
  ] as const) {
    const { context, page } = await open(browser, w, `thread=${thread}`);
    try {
      await page.waitForSelector('section.ib-pane');
      await page.locator('.ib-pfoot .ib-btn', { hasText: 'Reply' }).first().click();
      await page.locator('.ib-rtext').fill('Wait for Monday.');
      await page.locator('.ib-pfoot .ib-btn.ib-pri', { hasText: 'Send' }).click();
      await page.waitForSelector('[data-route-choice]');
      await page.locator('.ib-route .ib-more').click();
      await page.waitForTimeout(300);
      // Send stays in the window (row 6).
      const send = (await page.locator('[data-route-send]').boundingBox())!;
      expect(send.y + send.height).toBeLessThanOrEqual(w.height);
      expect(await shapes(page)).toEqual([]);
      await shot(page, `chooser-${w.name}`);
    } finally {
      await context.close();
    }
  }
  // New message with 50 live sessions: the list starts inside the window (row 35).
  const { context, page } = await open(browser, WIDTHS[2]!, `thread=${world.seed.threads.kitchen}`);
  try {
    await page.waitForSelector('[data-new-message]');
    await expect(page.locator('[data-new-message]')).not.toHaveClass(/ib-dis/, { timeout: 20_000 });
    await page.locator('[data-new-message]').click();
    const picker = page.locator('[data-session-picker]');
    await expect(picker).toBeVisible();
    expect((await picker.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    await shot(page, 'new-message-1024');
  } finally {
    await context.close();
  }
});

test('a long file name never widens the window: the stepping guard, the header (rows 49, 74)', async ({ browser }) => {
  const { context, page } = await open(browser, WIDTHS[0]!, `thread=${world.seed.threads.files}`);
  try {
    await page.locator(`section.ib-pane .ib-atts.ib-tiles [data-attachment-name="${world.seed.files.arabic}"]`).first().click();
    await page.waitForSelector('section.ib-view', { timeout: 20_000 });
    await page.getByRole('button', { name: /Global comment/ }).first().click();
    // The comment popover is portalled out of the pane.
    const box = page.getByPlaceholder(/comment/i).last();
    await box.waitFor({ timeout: 10_000 });
    await box.fill('Not saved yet.');
    await page.locator('[data-step-next]').click();
    await page.waitForSelector('[data-step-guard]', { timeout: 10_000 });
    expect(await shapes(page)).toEqual([]);
    await expect(page.locator('[data-guard-discard]')).toHaveText(`Discard and go to ${world.seed.files.long}`);
    // One space between the words and the name, not the words' space and the button's gap (about 4 px, not 11).
    const space = await page.locator('[data-guard-discard] .ib-gto').evaluate((el) => {
      const words = document.createRange();
      words.selectNodeContents(el.firstChild!);
      return el.querySelector('.ib-fname')!.getBoundingClientRect().left - words.getBoundingClientRect().right;
    });
    expect(space).toBeLessThan(7);
    await shot(page, 'guard-1440');
  } finally {
    await context.close();
  }
});

test('message HTML keeps its own alignment; an Arabic paragraph reads right to left and an English one left to right (row 14)', async ({ browser }) => {
  const { context, page } = await open(browser, WIDTHS[0]!, `thread=${world.seed.threads.centered}`);
  try {
    await page.waitForSelector('section.ib-pane .ib-body p');
    /** Where a paragraph's text sits in its box: the gap left and right of the text's own extent. */
    const placement = (match: string) =>
      page.locator('section.ib-pane .ib-body p', { hasText: match }).first().evaluate((p) => {
        const range = document.createRange();
        range.selectNodeContents(p);
        const text = range.getBoundingClientRect();
        const box = p.getBoundingClientRect();
        const style = getComputedStyle(p);
        return { left: text.left - box.left - parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight) - text.right, align: style.textAlign };
      });
    // `<p align="center">` and a `<p>` inside `<div align="center">`: centred, as the message's HTML says.
    for (const match of ['Centered by its own attribute.', 'Centered by its parent.']) {
      const at = await placement(match);
      expect(at.align, match).toMatch(/center/);
      expect(Math.abs(at.left - at.right), match).toBeLessThan(4);
      expect(at.left, match).toBeGreaterThan(100);
    }
    await shot(page, 'centered-1440');
    await page.goto(`${world.url}/#thread=${world.seed.threads.arabic}`);
    await page.waitForSelector('section.ib-pane .ib-body p');
    await page.waitForTimeout(300);
    const arabic = await placement('تمت مراجعة');
    expect(arabic.right, 'the Arabic paragraph starts at the right').toBeLessThan(2);
    expect(arabic.left).toBeGreaterThan(20);
    const english = await placement('The duplicates are in');
    expect(english.left, 'the English paragraph starts at the left').toBeLessThan(2);
    expect(english.right).toBeGreaterThan(20);
  } finally {
    await context.close();
  }
});

test('a file name cut in two copies whole, and reads whole to a screen reader (row 16)', async ({ browser }) => {
  const { context, page } = await open(browser, WIDTHS[2]!, `thread=${world.seed.threads.files}`);
  try {
    const name = world.seed.files.b;
    const tile = page.locator(`section.ib-pane .ib-atts.ib-tiles [data-attachment-name="${name}"]`).first();
    await expect(tile).toBeVisible();
    const copied = await tile.locator('.ib-fname').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const data = new DataTransfer();
      document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      return { selected: selection.toString(), copied: data.getData('text/plain') };
    });
    expect(copied.selected, 'the two parts are apart in the selection').toContain('\n');
    expect(copied.copied).toBe(name);
    expect(await tile.locator('.ib-fname').textContent()).toBe(name);
  } finally {
    await context.close();
  }
});

test.fixme('PR 8: a file beside the thread at 920 to 1220 px keeps a readable column (rows 45 to 48, 50)', async () => {});
