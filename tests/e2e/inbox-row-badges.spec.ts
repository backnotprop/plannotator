/**
 * The list rows' badges and their hover card (approval "inbox-row-badges",
 * card A), proved in a real browser against the compiled binary. Nothing is
 * mocked: the binary runs `plannotator inbox --background` under a temp
 * PLANNOTATOR_DATA_DIR and HOME, and agents write through `plannotator inbox
 * mcp` (scripts/inbox-sim.ts).
 *
 *  - Stopped is a red triangle alone, Holds up an amber triangle and its count;
 *    their accessible text stays "Stopped" and "Holds up 3".
 *  - The one-line row (approval "inbox-row-byline"): the project, the subject
 *    cell, then the agents' marks, the badge, the count and the time, each in
 *    its own column: every column's right edge lines up down the list, and
 *    every subject cell starts on one left edge.
 *  - Card A opens on the badge after the tooltip delay, and while the row has
 *    keyboard focus; a click's focus opens nothing.
 *  - Beside an open thread the two-line rows keep the card (approval
 *    "inbox-row-byline", 2026-10-29). Line 1 is the project, the thread pill
 *    and the time; line 2 is the subject, then at its right end the marks,
 *    the badge and the open count `?N` last. The subject is cut first: the
 *    marks, the badge and the count are never cut and end on the line's edge.
 *  - An iPhone (WebKit): icons only, no card, the same two lines. On a 320 or
 *    360 px phone the subject is still cut first, and the thread pill keeps a
 *    readable width.
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
  /** Where the scratch projects live. */
  src: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  stopped: string;
  holding: string;
  /** A long project name, a long thread name, a long subject and two questions. */
  long: string;
  /** No badge, no thread name, no count: the marks end line 2. */
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
    subject: "Approve the ledger reconciliation plan before Friday's cutover and the audit",
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
  world = { url, src: join(root, 'src'), agents: [claude, opencode, pi, codex], context, page, errors, stopped: stopped.thread_id as string, holding: holding.thread_id as string, long: long.thread_id as string, news: news.thread_id as string, pair: named.thread_id as string, guided: guided.thread_id as string };
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

test('desktop: the triangles with their words, and the marks, badge and count in their own columns', async () => {
  const { page } = world;
  await page.goto(world.url);
  const stop = page.locator(`.ib-row[data-thread-id="${world.stopped}"] [data-row-badge]`);
  const hold = page.locator(`.ib-row[data-thread-id="${world.holding}"] [data-row-badge]`);
  await expect(stop).toHaveText('Stopped');
  await expect(hold).toHaveText('Holds up 3');
  await expect(stop.locator('svg.ib-tri')).toBeVisible();
  // Full width (the owner, 2026-10-29): the triangle, then the badge's words drawn, as before approval
  // "inbox-row-badges" ("Stopped", "Holds up 3"); whole, inside the 110 px badge column.
  for (const [badge, words] of [[stop, 'Stopped'], [hold, 'Holds up 3']] as const) {
    await expect(badge.locator('.ib-bw')).toHaveText(words);
    await expect(badge.locator('.ib-bw')).toBeVisible();
    await expect(badge.locator('.ib-sr')).toHaveCount(0);
    const fit = await badge.evaluate((b) => ({ width: b.getBoundingClientRect().width, whole: b.scrollWidth <= b.clientWidth + 0.5 }));
    expect(fit.whole, words).toBe(true);
    expect(fit.width, words).toBeLessThanOrEqual(110);
  }
  // One accessible name per row, its words short; the card's words as its description.
  const row = page.locator(`.ib-row[data-thread-id="${world.stopped}"]`);
  const described = await row.getAttribute('aria-describedby');
  expect(described).toBeTruthy();
  await expect(page.locator(`[id="${described}"]`)).toHaveText(/^Stopped: The retry worker cannot ship without this\. Also holds up: The retry worker; The admin retry view\.$/);

  // Left to right after the subject: the marks, the badge, the count, the time, each column on one right edge
  // down the list (approval "inbox-row-byline", the one-line row); every subject cell starts on one left edge.
  const geometry = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.ib-row')].map((r) => {
      const box = (sel: string) => r.querySelector(sel)!.getBoundingClientRect();
      const badge = r.querySelector('.ib-bcol > [data-row-badge]');
      return {
        cells: [...r.children].map((c) => c.className.split(' ')[0]),
        rights: ['.ib-mcol', '.ib-bcol', '.ib-cq', '.ib-t'].map((sel) => Math.round(box(sel).right)),
        lefts: ['.ib-mcol', '.ib-bcol', '.ib-cq', '.ib-t'].map((sel) => box(sel).left),
        subjRight: box('.ib-subj').right,
        subj: box('.ib-subj').left,
        // A badge ends on its column's right edge.
        badgeEnd: badge ? Math.abs(badge.getBoundingClientRect().right - box('.ib-bcol').right) : 0,
        inSubject: r.querySelector('.ib-subj :is(.ib-mk, [data-row-badge])') !== null,
      };
    }),
  );
  expect(geometry.length).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < 4; i++) expect(new Set(geometry.map((g) => g.rights[i])).size, `column ${i}`).toBe(1);
  expect(new Set(geometry.map((g) => Math.round(g.subj))).size).toBe(1);
  for (const g of geometry) {
    expect(g.cells.slice(-6)).toEqual(['ib-subj', 'ib-cw', 'ib-mcol', 'ib-bcol', 'ib-cq', 'ib-t']);
    expect(g.inSubject).toBe(false);
    expect(g.lefts[0]).toBeGreaterThanOrEqual(g.subjRight);
    for (let i = 1; i < 4; i++) expect(g.lefts[i]).toBeGreaterThanOrEqual(g.rights[i - 1]! - 0.5);
    expect(g.badgeEnd).toBeLessThanOrEqual(0.5);
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

/** A row's line 2, read in the page: what is on it in order, and where its right-hand parts sit. */
function lineTwo(line: Element) {
  const kids = [...line.children];
  const named = (c: Element) => (c.matches('[data-row-badge]') ? 'badge' : c.classList.contains('ib-qn') ? 'count' : c.classList.contains('ib-c') ? 'words' : c.className.split(' ')[0]!);
  const box = (c: Element | null | undefined) => (c ? c.getBoundingClientRect() : null);
  const subject = line.querySelector(':scope > .ib-s .ib-st, :scope > .ib-m2') as HTMLElement;
  const mark = line.querySelector(':scope > .ib-mcol');
  const badge = line.querySelector(':scope > [data-row-badge]');
  const count = line.querySelector(':scope > .ib-c');
  // Each right-hand part shows whole: nothing in it is cut, and it sits inside the line.
  const whole = [mark, badge, count].filter((c): c is Element => c !== null).every((c) => {
    const r = c.getBoundingClientRect();
    const l = line.getBoundingClientRect();
    return c.scrollWidth <= c.clientWidth + 0.5 && r.left >= l.left - 0.5 && r.right <= l.right + 0.5;
  });
  return {
    order: kids.map(named),
    lineRight: line.getBoundingClientRect().right,
    lastRight: kids[kids.length - 1]!.getBoundingClientRect().right,
    subjectLeft: subject.getBoundingClientRect().left,
    lineLeft: line.getBoundingClientRect().left,
    subjectCut: subject.scrollWidth > subject.clientWidth + 0.5,
    mark: box(mark)?.toJSON() as DOMRect | undefined,
    badge: box(badge)?.toJSON() as DOMRect | undefined,
    count: box(count)?.toJSON() as DOMRect | undefined,
    whole,
  };
}

/** Line 2's order and geometry, the same on a two-line row and a phone row (approval "inbox-row-byline"). */
function expectLineTwo(l: ReturnType<typeof lineTwo>, id: string) {
  // The subject starts the line; the marks come before the badge, and the count, when there is one, is last.
  expect(l.order[0], `row ${id}`).toMatch(/^ib-(s|m2)$/);
  expect(Math.abs(l.subjectLeft - l.lineLeft), `row ${id}`).toBeLessThanOrEqual(0.5);
  const tail = l.order.slice(l.order.indexOf('ib-mcol'));
  expect(['ib-mcol', 'ib-mcol,badge', 'ib-mcol,count', 'ib-mcol,words', 'ib-mcol,badge,count', 'ib-mcol,badge,words'], `row ${id}: ${l.order}`).toContain(tail.join(','));
  // Left to right on screen in that order, and the last ends the line.
  if (l.badge) expect(l.badge.left, `row ${id}`).toBeGreaterThanOrEqual(l.mark!.right);
  if (l.count) expect(l.count.left, `row ${id}`).toBeGreaterThanOrEqual((l.badge ?? l.mark)!.right);
  expect(Math.abs(l.lastRight - l.lineRight), `row ${id}`).toBeLessThanOrEqual(0.5);
  expect(l.whole, `row ${id}: a mark, badge or count is cut`).toBe(true);
}

test('beside an open thread: the project, the pill and the time on line 1; the subject, then the marks, the badge and ?N on line 2; the card on keyboard focus', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.stopped}`);
  const narrow = page.locator(`.ib-nrow[data-thread-id="${world.holding}"]`);
  await expect(narrow).toBeVisible();
  // Line 1: the project, the thread's pill, the time; no count and no mark.
  expect(await narrow.locator('.ib-l1 > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['ib-pw', 'ib-key', 'ib-t']);
  await expect(narrow.locator('.ib-l1 :is(.ib-mk, .ib-c)')).toHaveCount(0);
  // The hover's Mark read sits on line 1 and stops above line 2 (and so above its marks and count).
  await narrow.locator('.ib-l1 .ib-p').hover();
  await expect(page.locator(`.ib-rw[data-row="${world.holding}"] [data-row-mark-read]`)).toBeVisible();
  const clearance = await page.evaluate((id) => {
    const rw = document.querySelector(`.ib-rw[data-row="${id}"]`)!;
    return rw.querySelector('.ib-l2')!.getBoundingClientRect().top - rw.querySelector('[data-row-mark-read]')!.getBoundingClientRect().bottom;
  }, world.holding);
  expect(clearance).toBeGreaterThanOrEqual(0);
  await page.mouse.move(5, 5);
  const rows = await page.evaluate(`[...document.querySelectorAll('.ib-nrow')].map((r) => ({ id: r.dataset.threadId, l2: (${lineTwo.toString()})(r.querySelector('.ib-l2')) }))`) as { id: string; l2: ReturnType<typeof lineTwo> }[];
  expect(rows.length).toBeGreaterThanOrEqual(5);
  for (const r of rows) expectLineTwo(r.l2, r.id);
  // A badge and a count: the marks, the badge, then ?N at the far right.
  expect(rows.find((r) => r.id === world.stopped)!.l2.order.slice(-3)).toEqual(['ib-mcol', 'badge', 'count']);
  // Nothing to count and no badge: the marks end the line.
  expect(rows.find((r) => r.id === world.news)!.l2.order.slice(-1)).toEqual(['ib-mcol']);
  // Two agents: both marks at the scale's 20 px, and neither tile covers the other's glyph.
  const pair = await page.locator(`.ib-nrow[data-thread-id="${world.pair}"] .ib-l2 > .ib-mcol .ib-mk`).evaluateAll((marks) =>
    marks.map((m) => ({ tile: m.getBoundingClientRect(), glyph: m.firstElementChild!.getBoundingClientRect() })),
  );
  expect(pair.length).toBe(2);
  for (const m of pair) expect(Math.round(m.tile.width)).toBe(20);
  expect(pair[0]!.glyph.right).toBeLessThanOrEqual(pair[1]!.tile.left);
  // The long row at the column's narrowest (380 px): the subject is cut, the marks, the badge and ?N are whole;
  // on line 1 the long project is cut before the pill, and the time ends the line whole.
  const long = rows.find((r) => r.id === world.long)!;
  expect(long.l2.subjectCut).toBe(true);
  const l1 = await page.locator(`.ib-nrow[data-thread-id="${world.long}"] .ib-l1`).evaluate((line) => {
    const p = line.querySelector<HTMLElement>('.ib-p')!;
    const t = line.querySelector<HTMLElement>('.ib-t')!;
    return { projectCut: p.scrollWidth > p.clientWidth, timeWhole: t.scrollWidth <= t.clientWidth + 0.5, timeEnd: line.getBoundingClientRect().right - t.getBoundingClientRect().right };
  });
  expect(l1.projectCut).toBe(true);
  expect(l1.timeWhole).toBe(true);
  expect(Math.abs(l1.timeEnd)).toBeLessThanOrEqual(0.5);
  // On hover the action covers line 1's right end: the pill gives way and ends before it, never under it.
  await page.locator(`.ib-nrow[data-thread-id="${world.long}"] .ib-l2`).hover();
  await expect(page.locator(`.ib-rw[data-row="${world.long}"] .ib-ract`)).toBeVisible();
  const cover = await page.locator(`.ib-rw[data-row="${world.long}"]`).evaluate((rw) => {
    const key = rw.querySelector<HTMLElement>('.ib-l1 .ib-key')!;
    const name = key.querySelector<HTMLElement>('.ib-keyt')!;
    return { keyRight: key.getBoundingClientRect().right, actionLeft: rw.querySelector('.ib-ract')!.getBoundingClientRect().left, cut: name.scrollWidth > name.clientWidth };
  });
  expect(cover.keyRight).toBeLessThanOrEqual(cover.actionLeft);
  expect(cover.cut).toBe(true);
  await page.mouse.move(5, 5);
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

test('an iPhone (WebKit): icons only, no card; two lines, the subject then the marks, the badge and ?N', async () => {
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
      expect(m1).toEqual(['ib-pw', 'ib-key', 'ib-t']);
      // The rows skip paint until laid out (content-visibility): give WebKit a frame or two.
      await page.waitForTimeout(600);
      const rows = await page.evaluate(`[...document.querySelectorAll('.ib-mrow')].map((r) => ({ id: r.getAttribute('data-thread-id'), lines: [...r.children].filter((c) => !c.classList.contains('ib-sr')).map((c) => c.className), l2: (${lineTwo.toString()})(r.querySelector(':scope > .ib-ml2')) }))`) as { id: string; lines: string[]; l2: ReturnType<typeof lineTwo> }[];
      expect(rows.length).toBeGreaterThanOrEqual(5);
      for (const r of rows) {
        expect(r.lines, `row ${r.id}`).toEqual(['ib-m1', 'ib-ml2']);
        expectLineTwo(r.l2, r.id);
      }
      // The long row: its subject is cut, the marks, the badge and the count are whole.
      expect(rows.find((r) => r.id === world.long)!.l2.subjectCut).toBe(true);
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

test('a small phone (320, 360): the subject gives way first; the marks, the badge and ?N stay whole; the thread name keeps a readable width', async () => {
  const own = await webkit.launch({ args: [] });
  try {
    for (const width of [320, 360]) {
      const context = await own.newContext({ ...devices['iPhone 15'], viewport: { width, height: 1600 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(world.url);
      const row = page.locator(`.ib-mrow[data-thread-id="${world.guided}"]`);
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator('.ib-ml2 > [data-guide-mark]')).toBeVisible();
      await expect(row.locator('[data-row-badge]')).toHaveText('Holds up 3');
      // The rows skip paint until laid out (content-visibility): give WebKit a frame or two.
      await page.waitForTimeout(600);
      const l2 = (await row.locator('.ib-ml2').evaluate(`(${lineTwo.toString()})(document.querySelector('.ib-mrow[data-thread-id="${world.guided}"] .ib-ml2'))`)) as ReturnType<typeof lineTwo>;
      expectLineTwo(l2, `${world.guided} at ${width}`);
      const pill = await row.locator('.ib-m1 .ib-key').evaluate((el) => el.getBoundingClientRect().width);
      // At least 48 px of the pill's 11.5 px text, never a sliver.
      expect(pill).toBeGreaterThanOrEqual(48);
      await page.screenshot({ path: join(proofDir, `phone-${width}.png`) });
      await context.close();
    }
  } finally {
    await own.close();
  }
});

// Last, so its threads change no test above.
test('desktop, rows whose count has words (a draft, Undelivered) or open action items (the box pill): the full words, every column lined up at 1440 and 900, the subject the widest; beside a thread the short forms and the pill', async () => {
  const { page } = world;
  const deploy = scratchProject(world.src, 'deploy-app');
  const claude = world.agents[0]!;
  const action = [':::action', 'Approve the production deploy on Vercel', 'The build passed every check.', '', 'Stopped: the release cannot go out until it is approved', ':::'].join('\n');
  const one = await claude.send({ project_path: deploy, subject: 'Approve the deploy', thread: 'prod-deploy', body: action });
  const both = await claude.send({ project_path: deploy, subject: 'Deploy and a name', thread: 'release-name', body: [action, '', ':::question', 'Call it 4.2 or 5.0?', '', '- [ ] 4.2', '- [ ] 5.0', ':::'].join('\n') });
  // A draft and replies waiting on a busy agent (14 minutes, and 1,500: stuck overnight, review D1), put on rows the
  // server sent: each needs a live session or the window's own reply box to arise for real
  // (tests/e2e/inbox-undelivered.spec.ts, inbox-replaced.spec.ts).
  const waitFor = (min: number) => ({ kind: 'reply', state: 'queued', reason: 'working', send_now: false, message_id: 'msg_waiting', at: null, host: 'claude-code', name: 'Claude Code', waiting_since: new Date(Date.now() - min * 60_000).toISOString(), steerable: false, auto_send_at: null });
  await page.route('**/api/inbox/threads?archived=exclude', async (route) => {
    const response = await route.fetch();
    const model = (await response.json()) as { sections: { threads: Record<string, unknown>[] }[] };
    for (const row of model.sections.flatMap((s) => s.threads)) {
      if (row.thread_id === world.news) row.unsent = { reply_at: new Date().toISOString(), picks: 2, comments: 3 };
      if (row.thread_id === world.pair) row.delivery = waitFor(14);
      if (row.thread_id === world.long) row.delivery = waitFor(1500);
    }
    await route.fulfill({ response, json: model });
  });
  // The full words in a row's name (a draft's "·" is not read: "Draft Your reply, …").
  const named = (full: RegExp) => new RegExp(full.source.slice(1, -1).replace(' · ', ' (?:· )?'));
  // Open action items are no words (approval "inbox-row-action-icon", 2026-10-29): the box pill, beside `?N`, in the
  // open counts' column before the time. [row, its pill's number, its `?N` (0: none), the row's name]
  const counted: [string, number, number, RegExp][] = [
    [one.thread_id as string, 1, 0, /1 action to do/],
    [both.thread_id as string, 1, 1, /1 action to do 1 question/],
  ];
  // [row, the two-line row's short form, the wide row's full words (also the row's name)]
  const expected: [string, RegExp, RegExp][] = [
    [world.news, /^Draft$/, /^Draft · Your reply, 2 picks, 3 comments$/],
    [world.pair, /^Undelivered 1[45]m$/, /^Undelivered 1[45] min$/],
    [world.long, /^Undelivered 1d$/, /^Undelivered 1 day$/],
  ];
  try {
    // A list of 1150 px or more (1440, a 1192 px list; the owner, 2026-10-29): the full words and the badge's words,
    // drawn and read as they are. A wide list under that (1000 and 900 px) keeps option A: the short forms in their
    // 124 px column, the bare triangle, the full words in the row's name. Every column lines up at each width, and
    // the subject has the widest column.
    for (const viewport of [1440, 1248, 1148]) {
      const full = viewport === 1440;
      await page.setViewportSize({ width: viewport, height: 900 });
      await page.goto(world.url);
      for (const [id, short, words] of expected) {
        const row = page.locator(`.ib-row[data-thread-id="${id}"]`);
        const drawn = row.locator('.ib-cw > .ib-c > .ib-cs');
        await expect(drawn).toHaveText(full ? words : short);
        await expect(drawn).toBeVisible();
        if (full) await expect(row.locator('.ib-cw > .ib-c > [aria-hidden="true"], .ib-cw .ib-sr')).toHaveCount(0);
        else expect(await row.locator('.ib-cw > .ib-c').evaluate((c) => c.getBoundingClientRect().width)).toBeLessThanOrEqual(124.5);
        await expect(row).toHaveAccessibleName(named(words));
      }
      for (const [id, actions, questions, name] of counted) {
        const row = page.locator(`.ib-row[data-thread-id="${id}"]`);
        await expect(row.locator('.ib-cw')).toHaveText('');
        await expect(row.locator('.ib-cq > [data-action-count]')).toHaveAttribute('data-action-count', String(actions));
        await expect(row.locator('.ib-cq > .ib-qn')).toHaveCount(questions);
        await expect(row).toHaveAccessibleName(name);
      }
      if (full) await expect(page.locator('.ib-row .ib-bwords').first()).toBeVisible();
      else await expect(page.locator('.ib-row .ib-bwords')).toHaveCount(0);
      const layout = await page.evaluate(() => ({
        list: document.querySelector('.ib-lbody')!.clientWidth,
        rows: [...document.querySelectorAll<HTMLElement>('.ib-row')].map((r) => {
          const box = (sel: string) => r.querySelector(sel)!.getBoundingClientRect();
          const pill = r.querySelector('.ib-cw [data-undelivered]')?.getBoundingClientRect();
          return {
            id: r.dataset.threadId,
            rights: ['.ib-subj', '.ib-cw', '.ib-mcol', '.ib-bcol', '.ib-cq', '.ib-t'].map((sel) => Math.round(box(sel).right)),
            subj: Math.round(box('.ib-subj').left),
            subjWidth: box('.ib-subj').width,
            others: Math.max(...['.ib-p', '.ib-cw', '.ib-mcol', '.ib-bcol', '.ib-cq', '.ib-t'].map((sel) => box(sel).width)),
            // The Undelivered pill itself, not just its slot (review D1): inside its column, clear of the marks.
            pill: pill ? pill.left >= box('.ib-cw').left - 0.5 && pill.right <= box('.ib-cw').right + 0.5 && pill.right <= box('.ib-mcol').left : null,
          };
        }),
      }));
      const where = `at ${viewport}px (a ${layout.list} px list)`;
      expect(layout.list, where).toBeGreaterThanOrEqual(full ? 1150 : 900);
      if (!full) expect(layout.list, where).toBeLessThan(1150);
      expect(layout.rows.length).toBeGreaterThanOrEqual(9);
      for (let i = 0; i < 6; i++) expect(new Set(layout.rows.map((g) => g.rights[i])).size, `column ${i} ${where}: ${JSON.stringify(layout.rows)}`).toBe(1);
      expect(new Set(layout.rows.map((g) => g.subj)).size).toBe(1);
      for (const g of layout.rows) {
        expect(g.subjWidth, `the subject is the widest column ${where}`).toBeGreaterThan(g.others);
        if (g.pill !== null) expect(g.pill, `${g.id}: the pill stays in its column ${where}`).toBe(true);
      }
    }
    // Hover: the action covers the time and ?N; the marks and the badge stay.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(world.url);
    const stopped = page.locator(`.ib-row[data-thread-id="${world.stopped}"]`);
    await stopped.locator('.ib-subj').hover();
    await expect(page.locator(`.ib-rw[data-row="${world.stopped}"] .ib-ract`)).toBeVisible();
    const shown = await stopped.evaluate((r) => Object.fromEntries(['.ib-mcol', '.ib-bcol', '.ib-cq', '.ib-t'].map((sel) => [sel, getComputedStyle(r.querySelector(sel)!).visibility])));
    expect(shown).toEqual({ '.ib-mcol': 'visible', '.ib-bcol': 'visible', '.ib-cq': 'hidden', '.ib-t': 'hidden' });
    await page.mouse.move(5, 5);
    await shot(page, 'desktop-words');

    // One project's list under 900 px keeps the wide row, with the short forms in their 124 px column, so the
    // subject keeps its room (tests/e2e/inbox-guides.spec.ts measures it with a long thread name).
    const projects = (await (await page.request.get(`${world.url}api/inbox/projects`)).json()).projects as { id: string; name: string }[];
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto(`${world.url}#project=${projects.find((p) => p.name === 'deploy-app')!.id}`);
    await expect.poll(() => page.locator('.ib-lbody').evaluate((el) => el.clientWidth)).toBeLessThan(900);
    for (const [id, actions] of counted) {
      const row = page.locator(`.ib-row[data-thread-id="${id}"]`);
      await expect(row.locator('.ib-cq > [data-action-count]')).toHaveAttribute('data-action-count', String(actions));
      await expect(row.locator('.ib-cfull, .ib-bwords')).toHaveCount(0);
      expect(await row.locator('.ib-cw').evaluate((c) => c.getBoundingClientRect().width)).toBeLessThanOrEqual(124.5);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // Beside a thread (the 380 px list): the short form (approval "inbox-row-byline", option A) ends line 2 in at
    // most 124 px, the Undelivered pill whole inside it, and the subject keeps its room (the full "Draft · Your
    // reply, 2 picks, 3 comments" would leave it a sliver).
    await page.goto(`${world.url}#thread=${world.stopped}`);
    await expect(page.locator(`.ib-nrow[data-thread-id="${world.news}"] [data-draft-label]`)).toHaveText('Draft');
    // The open counts end line 2: the action pill, then `?N` when a question waits too, never cut.
    for (const [id, actions, questions, name] of counted) {
      const row = page.locator(`.ib-nrow[data-thread-id="${id}"]`);
      await expect(row).toHaveAccessibleName(name);
      const tail = await row.locator('.ib-l2').evaluate((l) => {
        const kids = [...l.children];
        const pill = l.querySelector<HTMLElement>(':scope > [data-action-count]')!;
        const lr = l.getBoundingClientRect();
        return {
          order: kids.slice(kids.indexOf(pill)).map((c) => (c === pill ? `action ${pill.dataset.actionCount}` : c.classList.contains('ib-qn') ? `?${(c as HTMLElement).dataset.openCount}` : c.className)),
          inside: kids.every((c) => c.getBoundingClientRect().right <= lr.right + 0.5),
        };
      });
      expect(tail.order, id).toEqual(questions ? [`action ${actions}`, `?${questions}`] : [`action ${actions}`]);
      expect(tail.inside, id).toBe(true);
    }
    for (const [id, short, full] of expected) {
      await expect(page.locator(`.ib-nrow[data-thread-id="${id}"]`)).toHaveAccessibleName(named(full));
      const line = await page.locator(`.ib-nrow[data-thread-id="${id}"] .ib-l2`).evaluate((l) => {
        const words = l.querySelector(':scope > .ib-c')!;
        const subject = l.querySelector<HTMLElement>('.ib-s .ib-st')!;
        const pill = words.querySelector<HTMLElement>('[data-undelivered]');
        const text = pill?.querySelector<HTMLElement>('.ib-bwt');
        const lr = l.getBoundingClientRect();
        return {
          short: words.querySelector('.ib-cs')!.textContent,
          last: l.lastElementChild === words,
          wordsWidth: words.getBoundingClientRect().width,
          pill: pill ? { width: pill.getBoundingClientRect().width, inside: pill.getBoundingClientRect().right <= lr.right + 0.5, whole: text!.scrollWidth <= text!.clientWidth + 0.5 } : null,
          subject: subject.getBoundingClientRect().width,
          whole: subject.scrollWidth <= subject.clientWidth + 0.5,
          line: lr.width,
        };
      });
      expect(line.short, id).toMatch(short);
      expect(line.last, id).toBe(true);
      expect(line.wordsWidth, id).toBeLessThanOrEqual(124.5);
      if (line.pill) {
        expect(line.pill.width, `${id}: the pill fits the slot`).toBeLessThanOrEqual(124.5);
        expect(line.pill.inside, `${id}: the pill ends inside line 2`).toBe(true);
        expect(line.pill.whole, `${id}: the pill's words are whole`).toBe(true);
      }
      // Whole, or cut no shorter than 120 px.
      if (!line.whole) expect(line.subject, `${id}: the subject keeps its room in a ${line.line} px line`).toBeGreaterThanOrEqual(120);
    }
  } finally {
    await page.unroute('**/api/inbox/threads?archived=exclude');
  }
  expect(world.errors).toEqual([]);
});
