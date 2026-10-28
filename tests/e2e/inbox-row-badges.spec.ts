/**
 * The list rows' badges and their hover card (approval "inbox-row-badges",
 * card A), proved in a real browser against the compiled binary. Nothing is
 * mocked: the binary runs `plannotator inbox --background` under a temp
 * PLANNOTATOR_DATA_DIR and HOME, and agents write through `plannotator inbox
 * mcp` (scripts/inbox-sim.ts).
 *
 *  - Stopped is a red triangle alone, Holds up an amber triangle and its count;
 *    their accessible text stays "Stopped" and "Holds up 3".
 *  - The agent's mark has its own column just before the time: every mark's
 *    right edge lines up, and every subject cell starts on one left edge.
 *  - Card A opens on the badge after the tooltip delay, and while the row has
 *    keyboard focus; a click's focus opens nothing.
 *  - Beside an open thread the two-line rows keep the card. Line 1 keeps its
 *    own words (nothing reserved for a mark); the mark ends line 2, every
 *    mark on one right edge (the owner's pick (h), 2026-10-27).
 *  - An iPhone (WebKit): icons only, no card. Line 1 is the project and the
 *    time; the mark ends line 3, or the subject's last line when the row has
 *    no line 3; a long thread name gives way before the count moves to a line
 *    of its own. On a 320 or 360 px phone the guided review mark drops to its
 *    icon before the thread name shrinks, and the name keeps a readable width.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs (desktop light and dark, beside a thread, both cards open, keyboard,
 * an iPhone) land in PLANNOTATOR_ROW_BADGES_SHOTS, or .local/proof/row-badges/.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FIXTURE_V1_LOCAL } from '../../packages/core/guide-format-fixtures';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_ROW_BADGES_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'row-badges'));

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  stopped: string;
  holding: string;
  /** A long project name, a long thread name and two questions. */
  long: string;
  /** No badge, no thread name, no count: nothing for a phone's third line. */
  news: string;
  /** Two agents in one thread. */
  pair: string;
  /** Holds up 3, a thread name, 2 questions and a guided review: a full phone line 3. */
  guided: string;
}

let world: World;

const card = (page: Page) => page.locator('[data-pn-tooltip]:not([data-closed]) [data-wait-card]');

async function shot(page: Page, name: string, before?: () => Promise<void>): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    if (before) await before();
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Rest the pointer on a row's badge and wait for its card. */
async function hoverBadge(page: Page, threadId: string): Promise<void> {
  await page.mouse.move(5, 5);
  await expect(card(page)).toHaveCount(0);
  await page.locator(`[data-thread-id="${threadId}"] [data-row-badge]`).hover();
  await expect(card(page)).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-row-badges-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const docs = scratchProject(join(root, 'src'), 'docs-site');
  const relay = scratchProject(join(root, 'src'), 'relay-worker');
  const northwind = scratchProject(join(root, 'src'), 'northwind-industries-reconciliation-platform');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const opencode = await SimAgent.connect({ binary, env, name: 'OpenCode', host: 'opencode' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const holding = await opencode.send({ project_path: docs, body: DEMO_MESSAGES.holding, thread: 'install-page' });
  await pi.send({ project_path: relay, subject: 'FCM token migration', body: DEMO_MESSAGES.news });
  // Its own thread (pi's next message joins the one above): no badge, no thread name, no question.
  const news = await opencode.send({ project_path: relay, subject: 'Release notes are up', body: DEMO_MESSAGES.news });
  const long = await opencode.send({
    project_path: northwind,
    subject: 'Approve the ledger plan',
    thread: 'ledger-migration-dry-run-before-the-q3-close-and-audit',
    body: ['Two calls.', '', ':::question', 'Run the dry run on Friday?', '', '- [ ] Yes', '- [ ] No', ':::', '', ':::question', 'Keep the old ledger?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n'),
  });
  const named = await claude.send({ project_path: billing, body: DEMO_MESSAGES.named, thread: 'refund-webhooks' });
  // A second agent in that thread: its row shows the pair of marks.
  await pi.send({ project_path: billing, reply_to: named.message_id ?? named.thread_id, body: 'Pi here: the webhook is signed, so trusting it is safe.' });
  await pi.send({
    project_path: relay,
    subject: 'Push payload over 4 KB',
    body: [':::question', 'Drop the question context from the push, or send ids only?', 'Stopped: the relay cannot deliver without this.', '', '- [ ] Drop the context', '- [ ] Ids only', ':::'].join('\n'),
  });
  const stopped = await claude.send({ project_path: billing, body: DEMO_MESSAGES.stopped, thread: 'retry-worker' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const guided = await codex.submitGuide({ project_path: billing, snapshot: FIXTURE_V1_LOCAL, thread: 'ledger-migration', subject: 'Approve the ledger plan', body: 'A guided review of the ledger change.' });
  await codex.send({
    project_path: billing,
    thread: 'ledger-migration',
    body: ['Two calls.', '', ':::question', 'Run the dry run on Friday?', 'Holds up: the dry run; the audit; the close.', '', '- [ ] Yes', '- [ ] No', ':::', '', ':::question', 'Keep the old ledger?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n'),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  world = { url, agents: [claude, opencode, pi, codex], context, page, errors, stopped: stopped.thread_id as string, holding: holding.thread_id as string, long: long.thread_id as string, news: news.thread_id as string, pair: named.thread_id as string, guided: guided.thread_id as string };
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

test('desktop: the triangles, their words for a screen reader, and the marks in their own column', async () => {
  const { page } = world;
  await page.goto(world.url);
  const stop = page.locator(`.ib-row[data-thread-id="${world.stopped}"] [data-row-badge]`);
  const hold = page.locator(`.ib-row[data-thread-id="${world.holding}"] [data-row-badge]`);
  await expect(stop).toHaveText('Stopped');
  await expect(hold).toHaveText('Holds up 3');
  await expect(stop.locator('svg.ib-tri')).toBeVisible();
  // Drawn: the triangle alone; the triangle and "3". The words are visually hidden.
  // The words' box is the visually hidden one (1 px, clipped); the drawn text is the count alone.
  for (const badge of [stop, hold]) expect((await badge.locator('.ib-sr').boundingBox())!.width).toBeLessThanOrEqual(1);
  await expect(hold.locator('.ib-bn')).toHaveText('3');
  expect((await stop.boundingBox())!.width).toBeLessThanOrEqual(30);
  // The badge column narrowed: the badge fits in 48 px.
  expect((await hold.boundingBox())!.width).toBeLessThanOrEqual(48);
  // One accessible name per row, its words short; the card's words as its description.
  const row = page.locator(`.ib-row[data-thread-id="${world.stopped}"]`);
  const described = await row.getAttribute('aria-describedby');
  expect(described).toBeTruthy();
  await expect(page.locator(`[id="${described}"]`)).toHaveText(/^Stopped: The retry worker cannot ship without this\. Also holds up: The retry worker; The admin retry view\.$/);

  // Every mark ends on one right edge, just before the time; every subject cell starts on one left edge.
  const geometry = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.ib-row')].map((r) => ({
      mark: r.querySelector('.ib-mcol')!.getBoundingClientRect().right,
      time: r.querySelector('.ib-t')!.getBoundingClientRect().left,
      subj: r.querySelector('.ib-subj')!.getBoundingClientRect().left,
      inSubject: r.querySelector('.ib-subj .ib-mk') !== null,
    })),
  );
  expect(geometry.length).toBeGreaterThanOrEqual(4);
  expect(new Set(geometry.map((g) => Math.round(g.mark))).size).toBe(1);
  expect(new Set(geometry.map((g) => Math.round(g.subj))).size).toBe(1);
  for (const g of geometry) {
    expect(g.inSubject).toBe(false);
    expect(g.mark).toBeLessThanOrEqual(g.time);
  }
  await shot(page, 'desktop');
  expect(world.errors).toEqual([]);
});

test('card A on hover: Stopped, then Holds up', async () => {
  const { page } = world;
  await page.goto(world.url);
  await hoverBadge(page, world.stopped);
  const stop = card(page);
  await expect(stop.locator('.ib-wc-h')).toHaveText('Stopped');
  await expect(stop.locator('.ib-wc-chip')).toHaveText('retry-worker');
  await expect(stop.locator('.ib-wc-row')).toHaveText(['Q1The retry worker cannot ship without this', 'Q2The retry worker', 'Q2The admin retry view']);
  await expect(stop.locator('.ib-wc-sub')).toHaveText('Also holds up 2');
  await expect(stop.locator('.ib-wc-foot')).toContainText('Claude Code');
  await shot(page, 'card-stopped', () => hoverBadge(page, world.stopped));

  await hoverBadge(page, world.holding);
  const hold = card(page);
  await expect(hold.locator('.ib-wc-h')).toHaveText('Holds up 3');
  await expect(hold.locator('.ib-wc-row')).toHaveText(['The install page', 'The agent table', 'The screenshots']);
  await expect(hold.locator('.ib-wc-q')).toHaveCount(0);
  await expect(hold.locator('.ib-wc-foot')).toContainText('OpenCode');
  await shot(page, 'card-holds', () => hoverBadge(page, world.holding));
  await page.mouse.move(5, 5);
  await expect(card(page)).toHaveCount(0);
});

test("keyboard focus on the row opens the card; a click's focus does not", async () => {
  const { page } = world;
  await page.goto(world.url);
  await page.mouse.move(5, 5);
  const row = page.locator(`.ib-row[data-thread-id="${world.holding}"]`);
  // A key first, so the focus that follows is a keyboard focus (`:focus-visible`).
  await page.keyboard.press('Shift');
  await row.focus();
  expect(await row.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.ib-wc-h')).toHaveText('Holds up 3');
  await shot(page, 'keyboard', async () => {
    await page.keyboard.press('Shift');
    await row.focus();
    await expect(card(page)).toBeVisible();
  });
  // Tab on: the card goes with the focus.
  await page.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(card(page)).toHaveCount(0);

  // A click on the row's project label: it focuses the row (and opens the thread), with no card.
  await page.locator(`.ib-row[data-thread-id="${world.stopped}"] .ib-p`).click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await expect(card(page)).toHaveCount(0);
});

test('beside an open thread: line 1 keeps its words, the mark ends line 2 on one right edge, the card on keyboard focus', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.stopped}`);
  const narrow = page.locator(`.ib-nrow[data-thread-id="${world.holding}"]`);
  await expect(narrow).toBeVisible();
  const order = await narrow.locator('.ib-l1 > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]));
  expect(order.filter((c) => c !== 'ib-c')).toEqual(['ib-p', 'ib-t']);
  await expect(narrow.locator('.ib-l1 .ib-mk')).toHaveCount(0);
  // The hover's Mark read sits on line 1 and stops above line 2 (and so above its mark).
  await narrow.locator('.ib-l1 .ib-p').hover();
  await expect(page.locator(`.ib-rw[data-row="${world.holding}"] [data-row-mark-read]`)).toBeVisible();
  const clearance = await page.evaluate((id) => {
    const rw = document.querySelector(`.ib-rw[data-row="${id}"]`)!;
    return rw.querySelector('.ib-l2')!.getBoundingClientRect().top - rw.querySelector('[data-row-mark-read]')!.getBoundingClientRect().bottom;
  }, world.holding);
  expect(clearance).toBeGreaterThanOrEqual(0);
  await page.mouse.move(5, 5);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.ib-nrow')].map((r) => {
      const l1 = r.querySelector('.ib-l1')!;
      const mark = r.querySelector('.ib-l2 > .ib-mcol:last-child')!.getBoundingClientRect();
      const p = l1.querySelector('.ib-p')!;
      const next = p.nextElementSibling!.getBoundingClientRect();
      return { id: r.dataset.threadId, markRight: mark.right, markTop: mark.top, l1Bottom: l1.getBoundingClientRect().bottom, l2Right: r.querySelector('.ib-l2')!.getBoundingClientRect().right, pRight: p.getBoundingClientRect().right, nextLeft: next.left, cut: p.scrollWidth > p.clientWidth };
    }),
  );
  expect(rows.length).toBeGreaterThanOrEqual(5);
  // Every mark on line 2, on one right edge (0 px spread): the end of its line.
  expect(Math.max(...rows.map((r) => r.markRight)) - Math.min(...rows.map((r) => r.markRight))).toBe(0);
  for (const r of rows) {
    expect(r.markTop).toBeGreaterThanOrEqual(r.l1Bottom);
    expect(Math.abs(r.markRight - r.l2Right)).toBeLessThanOrEqual(0.5);
  }
  // Two agents: both marks at the scale's 20 px, and neither tile covers the other's glyph.
  const pair = await page.locator(`.ib-nrow[data-thread-id="${world.pair}"] .ib-l2 > .ib-mcol .ib-mk`).evaluateAll((marks) =>
    marks.map((m) => ({ tile: m.getBoundingClientRect(), glyph: m.firstElementChild!.getBoundingClientRect() })),
  );
  expect(pair.length).toBe(2);
  for (const m of pair) expect(Math.round(m.tile.width)).toBe(20);
  expect(pair[0]!.glyph.right).toBeLessThanOrEqual(pair[1]!.tile.left);
  // Nothing reserved on line 1: a long project name runs right up to the count, 8 px (the line's gap) short of it.
  const long = rows.find((r) => r.id === world.long)!;
  expect(long.cut).toBe(true);
  expect(long.nextLeft - long.pRight).toBeLessThanOrEqual(8.5);
  await shot(page, 'beside-thread');
  await page.keyboard.press('Shift');
  await narrow.focus();
  await expect(card(page)).toBeVisible();
  await shot(page, 'beside-thread-card', async () => {
    await page.keyboard.press('Shift');
    await narrow.focus();
    await expect(card(page)).toBeVisible();
  });
  // Escape closes the card, keeps focus on the row and leaves the thread open; the next Escape closes the thread.
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(narrow).toBeFocused();
  await page.waitForTimeout(300);
  expect(page.url()).toContain(`#thread=${world.stopped}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(new RegExp(`thread=${world.stopped}`));
});

test('an iPhone (WebKit): icons only, no card, the mark ends the last line', async () => {
  let own: Browser | null = null;
  try {
    own = await webkit.launch({ args: [] });
    for (const scheme of ['light', 'dark'] as const) {
      const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(world.url);
      const row = page.locator(`.ib-mrow[data-thread-id="${world.holding}"]`);
      await expect(row.locator('[data-row-badge]')).toHaveText('Holds up 3');
      const m1 = await row.locator('.ib-m1 > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]));
      expect(m1).toEqual(['ib-p', 'ib-t']);
      // The mark ends line 3, on the row's right edge.
      const line3 = await row.locator('.ib-m3').evaluate((m3) => ({ last: m3.lastElementChild!.className, right: m3.getBoundingClientRect().right, markRight: m3.lastElementChild!.getBoundingClientRect().right }));
      expect(line3.last).toBe('ib-mcol');
      expect(Math.abs(line3.right - line3.markRight)).toBeLessThanOrEqual(0.5);
      // No line 3: the mark ends the subject's last line.
      const news = page.locator(`.ib-mrow[data-thread-id="${world.news}"]`);
      await expect(news.locator('.ib-m3')).toHaveCount(0);
      const end = await news.locator('.ib-m2end').evaluate((el) => {
        const subject = el.querySelector('.ib-m2')!.getBoundingClientRect();
        const mark = el.querySelector('.ib-mcol')!.getBoundingClientRect();
        return { subjectBottom: subject.bottom, markTop: mark.top, markBottom: mark.bottom, lineHeight: parseFloat(getComputedStyle(el.querySelector('.ib-m2')!).lineHeight) };
      });
      expect(Math.abs(end.markBottom - end.subjectBottom)).toBeLessThanOrEqual(1);
      expect(end.markTop).toBeGreaterThanOrEqual(end.subjectBottom - end.lineHeight - 1);
      // A long thread name gives way: the count stays on the pill's line, never on a line of its own.
      const longRow = page.locator(`.ib-mrow[data-thread-id="${world.long}"]`);
      const parts = await longRow.locator('.ib-m3').evaluate((m3) => {
        const mid = (sel: string) => {
          const b = m3.querySelector(sel)!.getBoundingClientRect();
          return b.top + b.height / 2;
        };
        return { line: mid('.ib-m3 > .ib-key'), count: mid('.ib-m3 > .ib-c'), mark: mid('.ib-m3 > .ib-mcol'), height: m3.getBoundingClientRect().height };
      });
      expect(Math.abs(parts.count - parts.line)).toBeLessThanOrEqual(1);
      expect(Math.abs(parts.mark - parts.line)).toBeLessThanOrEqual(1);
      await row.locator('[data-row-badge]').tap();
      await page.waitForTimeout(400);
      await expect(card(page)).toHaveCount(0);
      await page.goto(world.url);
      await expect(page.locator(`.ib-mrow[data-thread-id="${world.stopped}"] [data-row-badge]`)).toHaveText('Stopped');
      await expect(page.locator(`.ib-mrow[data-thread-id="${world.stopped}"]`)).toBeVisible();
      // The rows skip paint until laid out (content-visibility): give WebKit a frame or two.
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(proofDir, `iphone-${scheme}.png`) });
      await context.close();
    }
  } finally {
    await own?.close();
  }
});

test('a small phone (320, 360): the guided review mark drops to its icon first; the thread name keeps a readable width', async () => {
  const own = await webkit.launch({ args: [] });
  try {
    for (const width of [320, 360]) {
      const context = await own.newContext({ ...devices['iPhone 15'], viewport: { width, height: 1600 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(world.url);
      const line3 = page.locator(`.ib-mrow[data-thread-id="${world.guided}"] .ib-m3`);
      await line3.scrollIntoViewIfNeeded();
      await expect(line3.locator('[data-guide-mark]')).toBeVisible();
      await expect(line3.locator('[data-row-badge]')).toHaveText('Holds up 3');
      // The rows skip paint until laid out (content-visibility): give WebKit a frame or two.
      await page.waitForTimeout(600);
      const m = await line3.evaluate((m3) => {
        const box = (sel: string) => m3.querySelector(sel)!.getBoundingClientRect();
        const mid = (b: DOMRect) => b.top + b.height / 2;
        const label = m3.querySelector<HTMLElement>('.ib-att-l')!;
        return {
          pill: box('.ib-key').width,
          pillMid: mid(box('.ib-key')),
          countMid: mid(box('.ib-c')),
          labelShown: label.getClientRects().length > 0,
          labelCut: label.scrollWidth > label.clientWidth + 0.5,
        };
      });
      // At least 7em of the pill's 11.5 px text, never a sliver.
      expect(m.pill).toBeGreaterThanOrEqual(48);
      expect(Math.abs(m.countMid - m.pillMid)).toBeLessThanOrEqual(1);
      // The label is either whole or gone (the icon stays), never cut mid-word.
      expect(m.labelShown && m.labelCut).toBe(false);
      await page.screenshot({ path: join(proofDir, `phone-${width}.png`) });
      await context.close();
    }
  } finally {
    await own.close();
  }
});
