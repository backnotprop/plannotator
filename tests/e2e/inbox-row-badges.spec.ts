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
  src: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  stopped: string;
  holding: string;
  long: string;
  news: string;
  pair: string;
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

const filled = (page: Page, threadId: string, shape = '') => page.locator(`${shape}[data-thread-id="${threadId}"] [data-wait-step]:not([data-wait-step="open"])`).first();

async function hoverBadge(page: Page, threadId: string): Promise<void> {
  await page.mouse.move(5, 5);
  await expect(card(page)).toHaveCount(0);
  const words = page.locator(`[data-thread-id="${threadId}"] [data-wait-words]`);
  await ((await words.count()) ? words : filled(page, threadId)).hover();
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
  const fcm = await pi.send({ project_path: relay, subject: 'FCM token migration', body: DEMO_MESSAGES.news });
  const news = await opencode.send({ project_path: relay, subject: 'Release notes are up', body: DEMO_MESSAGES.news });
  const long = await opencode.send({
    project_path: northwind,
    subject: "Approve the ledger reconciliation plan before Friday's cutover and the audit",
    thread: 'ledger-migration-dry-run-before-the-q3-close-and-audit',
    body: ['Two calls.', '', ':::question', 'Run the dry run on Friday?', '', '- [ ] Yes', '- [ ] No', ':::', '', ':::question', 'Keep the old ledger?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n'),
  });
  await pi.send({ project_path: northwind, reply_to: long.message_id ?? long.thread_id, body: "Pi here: the dry run needs the audit sign-off first, and Friday's cutover waits on the ledger reconciliation plan." });
  const named = await claude.send({ project_path: billing, body: DEMO_MESSAGES.named, thread: 'refund-webhooks' });
  await pi.send({ project_path: billing, reply_to: named.message_id ?? named.thread_id, body: 'Pi here: the webhook is signed, so trusting it is safe.' });
  await pi.send({
    project_path: relay,
    reply_to: fcm.message_id,
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

test('desktop: one question mark in its fill step, the words in full-width mode, the marks before the project, each column on one edge', async () => {
  const { page } = world;
  await page.goto(world.url);
  const stop = page.locator(`.ib-row[data-thread-id="${world.stopped}"] .ib-cq > .ib-qn`);
  const hold = page.locator(`.ib-row[data-thread-id="${world.holding}"] .ib-cq > .ib-qn`);
  const open = page.locator(`.ib-row[data-thread-id="${world.pair}"] .ib-cq > .ib-qn`);
  await expect(stop).toHaveAttribute('data-wait-step', 'stop');
  await expect(stop).toHaveClass(/\bib-b-stop\b/);
  await expect(stop.locator('.ib-sr')).toHaveText('Stopped on you: 2 questions');
  await expect(hold).toHaveAttribute('data-wait-step', 'hold');
  await expect(hold).toHaveClass(/\bib-b-hold\b/);
  await expect(hold.locator('.ib-sr')).toHaveText('Holding up work: 1 question');
  await expect(open).toHaveAttribute('data-wait-step', 'open');
  await expect(open.locator('.ib-sr')).toHaveText('1 question');
  const fills = await Promise.all([stop, hold, open].map((m) => m.evaluate((el) => getComputedStyle(el).backgroundColor)));
  expect(fills[0]).not.toBe('rgba(0, 0, 0, 0)');
  expect(fills[1]).not.toBe('rgba(0, 0, 0, 0)');
  expect(fills[2]).toBe('rgba(0, 0, 0, 0)');
  await expect(page.locator('.ib-row :is([data-row-badge], svg.ib-tri)')).toHaveCount(0);
  for (const [id, words] of [[world.stopped, 'Stopped'], [world.holding, 'Holds up 3']] as const) {
    const cell = page.locator(`.ib-row[data-thread-id="${id}"] .ib-bcol > [data-wait-words]`);
    await expect(cell).toHaveText(words);
    await expect(cell).toBeVisible();
    const fit = await cell.evaluate((b) => ({ width: b.getBoundingClientRect().width, whole: b.scrollWidth <= b.clientWidth + 0.5 }));
    expect(fit.whole, words).toBe(true);
    expect(fit.width, words).toBeLessThanOrEqual(110);
  }
  const row = page.locator(`.ib-row[data-thread-id="${world.stopped}"]`);
  const described = await row.getAttribute('aria-describedby');
  expect(described).toBeTruthy();
  await expect(page.locator(`[id="${described}"]`)).toHaveText(/^Stopped: The retry worker cannot ship without this\. Also holds up: The retry worker; The admin retry view\.$/);

  const geometry = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.ib-row')].map((r) => {
      const box = (sel: string) => r.querySelector(sel)!.getBoundingClientRect();
      const badge = r.querySelector('.ib-bcol > [data-wait-words]');
      return {
        id: r.dataset.threadId,
        cells: [...r.children].map((c) => c.className.split(' ')[0]),
        from: [...r.querySelector('.ib-from')!.children].map((c) => c.className.split(' ')[0]),
        rights: ['.ib-cw', '.ib-bcol', '.ib-cq', '.ib-t'].map((sel) => Math.round(box(sel).right)),
        lefts: ['.ib-cw', '.ib-bcol', '.ib-cq', '.ib-t'].map((sel) => box(sel).left),
        cell: box('.ib-from').left,
        project: box('.ib-p').left,
        markCount: r.querySelectorAll('.ib-ags .ib-atile').length,
        marks: box('.ib-ags').toJSON() as DOMRect,
        subjRight: box('.ib-subj').right,
        subj: box('.ib-subj').left,
        badgeEnd: badge ? Math.abs(badge.getBoundingClientRect().right - box('.ib-bcol').right) : 0,
        inSubject: r.querySelector('.ib-subj :is(.ib-mk, .ib-ags, [data-wait-words], [data-wait-step])') !== null,
      };
    }),
  );
  expect(geometry.length).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < 4; i++) expect(new Set(geometry.map((g) => g.rights[i])).size, `column ${i}`).toBe(1);
  expect(new Set(geometry.map((g) => Math.round(g.subj))).size).toBe(1);
  expect(new Set(geometry.map((g) => g.markCount))).toEqual(new Set([1, 2]));
  for (const g of geometry) {
    expect(Math.abs(g.project - g.marks.right - 6), `row ${g.id}: the project 6px after its own marks`).toBeLessThanOrEqual(0.5);
    expect(g.cells.slice(-6), `row ${g.id}`).toEqual(['ib-from', 'ib-subj', 'ib-cw', 'ib-bcol', 'ib-cq', 'ib-t']);
    expect(g.from, `row ${g.id}`).toEqual(['ib-p', 'ib-ags']);
    expect(Math.abs(g.marks.left - g.cell), `row ${g.id}: the marks start the project's column`).toBeLessThanOrEqual(0.5);
    expect(g.marks.right, `row ${g.id}: the marks end before the project`).toBeLessThan(g.project);
    expect(g.marks.right, `row ${g.id}: the marks stay in the project's column`).toBeLessThanOrEqual(g.subj);
    expect(g.inSubject).toBe(false);
    expect(g.lefts[0]).toBeGreaterThanOrEqual(g.subjRight - 0.5);
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
  await expect(stop.locator('.ib-wc-tri')).toHaveAttribute('data-wait-card-glyph', 'question');
  await expect(stop.locator('svg.ib-tri')).toHaveCount(0);
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
  await page.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(card(page)).toHaveCount(0);

  await page.locator(`.ib-row[data-thread-id="${world.stopped}"] .ib-p`).click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await expect(card(page)).toHaveCount(0);
});

function lineThree(line: Element) {
  const kids = [...line.children];
  const named = (c: Element) =>
    c.classList.contains('ib-qn') ? 'count' : c.matches('[data-action-count]') ? 'action' : c.classList.contains('ib-c') ? 'words' : c.classList.contains('ib-pv') ? 'preview' : c.matches('[data-guide-mark]') ? 'guide' : c.matches('[data-pin-mark]') ? 'pin' : c.className.split(' ')[0]!;
  const box = (c: Element | null | undefined) => (c ? c.getBoundingClientRect() : null);
  const lr = line.getBoundingClientRect();
  const preview = line.querySelector<HTMLElement>(':scope > .ib-pv');
  const badge = line.querySelector(':scope > [data-action-count]');
  const count = line.querySelector(':scope > :is(.ib-qn, .ib-c)');
  const whole = [badge, count].filter((c): c is Element => c !== null).every((c) => {
    const r = c.getBoundingClientRect();
    return c.scrollWidth <= c.clientWidth + 0.5 && r.left >= lr.left - 0.5 && r.right <= lr.right + 0.5;
  });
  return {
    order: kids.map(named),
    shown: getComputedStyle(line).display !== 'none' && lr.height > 0,
    lineRight: lr.right,
    lineLeft: lr.left,
    lastRight: kids.length ? kids[kids.length - 1]!.getBoundingClientRect().right : null,
    previewLeft: preview ? preview.getBoundingClientRect().left : null,
    previewCut: preview ? preview.scrollWidth > preview.clientWidth + 0.5 : null,
    preview: box(preview)?.toJSON() as DOMRect | undefined,
    badge: box(badge)?.toJSON() as DOMRect | undefined,
    count: box(count)?.toJSON() as DOMRect | undefined,
    whole,
  };
}

function expectLineThree(l: ReturnType<typeof lineThree>, id: string) {
  if (l.order.length === 0) {
    expect(l.shown, `row ${id}: an empty line 3 is drawn`).toBe(false);
    return;
  }
  expect(l.shown, `row ${id}`).toBe(true);
  const parts = l.order.filter((p) => p !== 'preview');
  if (l.order.includes('preview')) {
    expect(l.order[0], `row ${id}`).toBe('preview');
    expect(Math.abs(l.previewLeft! - l.lineLeft), `row ${id}`).toBeLessThanOrEqual(0.5);
  }
  const rank = { guide: 0, pin: 1, badge: 2, words: 3, action: 3, count: 4 } as Record<string, number>;
  for (const p of parts) expect(rank[p], `row ${id}: ${l.order}`).toBeDefined();
  expect(parts.map((p) => rank[p]), `row ${id}: ${l.order}`).toEqual([...parts.map((p) => rank[p]!)].sort((a, b) => a - b));
  if (l.badge && l.preview) expect(l.badge.left, `row ${id}`).toBeGreaterThanOrEqual(l.preview.right - 0.5);
  if (l.count && l.badge) expect(l.count.left, `row ${id}`).toBeGreaterThanOrEqual(l.badge.right - 0.5);
  if (parts.length) expect(Math.abs(l.lastRight! - l.lineRight), `row ${id}`).toBeLessThanOrEqual(0.5);
  expect(l.whole, `row ${id}: a mark is cut`).toBe(true);
}

function topLines(row: Element) {
  const line = (row.querySelector(':scope > .ib-l1') ?? row.querySelector(':scope > .ib-m1'))!;
  const project = line.querySelector<HTMLElement>('.ib-p');
  const marks = line.querySelector<HTMLElement>('.ib-atiles')!;
  const time = line.querySelector<HTMLElement>('.ib-t')!;
  const title = (row.querySelector<HTMLElement>('.ib-l2 > .ib-title') ?? row.querySelector<HTMLElement>(':scope > .ib-m2'))!;
  const rr = row.getBoundingClientRect();
  const p = project?.getBoundingClientRect();
  const m = marks.getBoundingClientRect();
  const t = title.getBoundingClientRect();
  return {
    line1: [...line.children].map((c) => c.className.split(' ')[0]),
    from: [...line.querySelector(':scope > .ib-from')!.children].map((c) => c.className.split(' ')[0]),
    projectLines: project && p ? Math.round(p.height / parseFloat(getComputedStyle(project).lineHeight)) : 0,
    projectCut: project ? project.scrollWidth > project.clientWidth + 0.5 : false,
    marksBefore: !p || (m.right <= p.left + 0.5 && Math.abs((m.top + m.bottom) / 2 - (p.top + p.bottom) / 2) <= 2),
    marksDrawn: marks.querySelectorAll(':scope > .ib-atile:not(.ib-atmore)').length,
    marksName: marks.getAttribute('aria-label'),
    marksInside: m.width > 0 && m.left >= rr.left - 0.5 && m.right <= rr.right + 0.5,
    timeWhole: time.scrollWidth <= time.clientWidth + 0.5,
    timeEnd: Math.abs(line.getBoundingClientRect().right - time.getBoundingClientRect().right),
    title: title.textContent,
    titleCut: title.scrollWidth > title.clientWidth + 0.5,
    titleInside: t.right <= rr.right + 0.5,
    titleLines: Math.round(t.height / parseFloat(getComputedStyle(title).lineHeight)),
  };
}

test('beside an open thread: the agents\' tiles, the project and the time on line 1; the title on line 2, never cut; the preview and ?N on line 3; the card on keyboard focus', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.stopped}`);
  const narrow = page.locator(`.ib-nrow[data-thread-id="${world.holding}"]`);
  await expect(narrow).toBeVisible();
  expect(await narrow.locator('.ib-l1 > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]))).toEqual(['ib-from', 'ib-t']);
  await expect(narrow.locator('.ib-l1 :is(.ib-c, .ib-badge, [data-wait-step])')).toHaveCount(0);
  const before = await narrow.evaluate((r) => r.getBoundingClientRect().height);
  await narrow.locator('.ib-l1 .ib-p').hover();
  await expect(page.locator(`.ib-rw[data-row="${world.holding}"] [data-row-mark-read]`)).toBeVisible();
  const clearance = await page.evaluate((id) => {
    const rw = document.querySelector(`.ib-rw[data-row="${id}"]`)!;
    return rw.querySelector('.ib-l2')!.getBoundingClientRect().top - rw.querySelector('[data-row-mark-read]')!.getBoundingClientRect().bottom;
  }, world.holding);
  expect(clearance).toBeGreaterThanOrEqual(0);
  expect(await narrow.evaluate((r) => r.getBoundingClientRect().height)).toBe(before);
  await page.mouse.move(5, 5);
  const rows = await page.evaluate(`[...document.querySelectorAll('.ib-nrow')].map((r) => ({ id: r.dataset.threadId, top: (${topLines.toString()})(r), l3: (${lineThree.toString()})(r.querySelector('.ib-l3')) }))`) as { id: string; top: ReturnType<typeof topLines>; l3: ReturnType<typeof lineThree> }[];
  expect(rows.length).toBeGreaterThanOrEqual(5);
  for (const r of rows) {
    expectLineThree(r.l3, r.id);
    expect(r.top.line1, `row ${r.id}`).toEqual(['ib-from', 'ib-t']);
    expect(r.top.from, `row ${r.id}`).toEqual(['ib-p', 'ib-atiles']);
    expect(r.top.marksBefore, `row ${r.id}: the tiles come before the project`).toBe(true);
    expect(r.top.projectLines, `row ${r.id}: the project wrapped`).toBe(1);
    expect(r.top.marksInside, `row ${r.id}: the marks leave the row`).toBe(true);
    expect(r.top.timeWhole && r.top.timeEnd <= 0.5, `row ${r.id}: the time ends line 1 whole`).toBe(true);
    expect(r.top.titleCut, `row ${r.id}: the title is cut`).toBe(false);
    expect(r.top.titleInside, `row ${r.id}: the title leaves the row`).toBe(true);
  }
  expect(rows.find((r) => r.id === world.stopped)!.l3.order).toEqual(['preview', 'count']);
  await expect(page.locator(`.ib-nrow[data-thread-id="${world.stopped}"] .ib-l3 > .ib-qn`)).toHaveAttribute('data-wait-step', 'stop');
  await hoverBadge(page, world.holding);
  await page.mouse.move(5, 5);
  expect(rows.find((r) => r.id === world.news)!.l3.order).toEqual([]);
  const pair = await page.locator(`.ib-nrow[data-thread-id="${world.pair}"] .ib-l1 .ib-atiles > .ib-atile`).evaluateAll((marks) => marks.map((m) => m.getBoundingClientRect().toJSON() as DOMRect));
  expect(pair.length).toBe(2);
  for (const m of pair) expect(Math.round(m.width)).toBe(20);
  expect(Math.round(pair[0]!.right - pair[1]!.left)).toBe(5);
  const logos = await page.locator(`.ib-nrow[data-thread-id="${world.pair}"] .ib-l1 .ib-atiles > .ib-atile`).evaluateAll((tiles) =>
    tiles.map((t) => {
      const logo = t.querySelector('.ib-mk')!.getBoundingClientRect();
      return { cut: getComputedStyle(t).maskImage !== 'none', whole: document.elementFromPoint(logo.right - 0.5, (logo.top + logo.bottom) / 2)?.closest('.ib-atile') === t };
    }),
  );
  expect(logos).toEqual([{ cut: false, whole: true }, { cut: false, whole: true }]);
  await expect(page.locator(`.ib-nrow[data-thread-id="${world.pair}"] .ib-atiles`)).toHaveAttribute('aria-label', 'Claude Code and Pi');
  const long = rows.find((r) => r.id === world.long)!;
  expect(long.top.projectLines).toBe(1);
  expect(long.top.marksDrawn).toBe(2);
  expect(long.top.marksName).toBe('OpenCode and Pi');
  expect(long.top.title).toBe('ledger-migration-dry-run-before-the-q3-close-and-audit');
  expect(long.top.titleLines).toBeGreaterThan(1);
  expect(long.l3.previewCut).toBe(true);
  const longRow = page.locator(`.ib-nrow[data-thread-id="${world.long}"]`);
  const longHeight = await longRow.evaluate((r) => r.getBoundingClientRect().height);
  await longRow.locator('.ib-l2').hover();
  await expect(page.locator(`.ib-rw[data-row="${world.long}"] .ib-ract`)).toBeVisible();
  const cover = await page.locator(`.ib-rw[data-row="${world.long}"]`).evaluate((rw) => ({
    height: rw.querySelector('.ib-nrow')!.getBoundingClientRect().height,
    clearance: rw.querySelector('.ib-l2')!.getBoundingClientRect().top - rw.querySelector('.ib-ract')!.getBoundingClientRect().bottom,
  }));
  expect(cover.height).toBe(longHeight);
  expect(cover.clearance).toBeGreaterThanOrEqual(0);
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
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(narrow).toBeFocused();
  await page.waitForTimeout(300);
  expect(page.url()).toContain(`#thread=${world.stopped}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(new RegExp(`thread=${world.stopped}`));
});

test('an iPhone (WebKit): the marks only, no card; three lines, the agents\' tiles and the project, the title, then the preview and ?N', async () => {
  let own: Browser | null = null;
  try {
    own = await webkit.launch({ args: [] });
    for (const scheme of ['light', 'dark'] as const) {
      const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(world.url);
      const row = page.locator(`.ib-mrow[data-thread-id="${world.holding}"]`);
      await expect(row.locator('.ib-qn[data-wait-step="hold"] .ib-sr')).toHaveText('Holding up work: 1 question');
      await page.waitForTimeout(600);
      const rows = await page.evaluate(`[...document.querySelectorAll('.ib-mrow')].map((r) => ({ id: r.getAttribute('data-thread-id'), lines: [...r.children].filter((c) => !c.classList.contains('ib-sr')).map((c) => c.className), top: (${topLines.toString()})(r), l3: (${lineThree.toString()})(r.querySelector(':scope > .ib-m3')) }))`) as { id: string; lines: string[]; top: ReturnType<typeof topLines>; l3: ReturnType<typeof lineThree> }[];
      expect(rows.length).toBeGreaterThanOrEqual(5);
      for (const r of rows) {
        expect(r.lines, `row ${r.id}`).toEqual(['ib-m1', 'ib-m2', 'ib-m3']);
        expect(r.top.line1, `row ${r.id}`).toEqual(['ib-from', 'ib-t']);
        expect(r.top.from, `row ${r.id}`).toEqual(['ib-p', 'ib-atiles']);
        expect(r.top.marksBefore && r.top.marksInside, `row ${r.id}: the tiles come before the project, inside the row`).toBe(true);
        expect(r.top.projectLines, `row ${r.id}: the project wrapped`).toBe(1);
        expect(r.top.titleCut || !r.top.titleInside, `row ${r.id}: the title is cut`).toBe(false);
        expectLineThree(r.l3, r.id);
      }
      const long = rows.find((r) => r.id === world.long)!;
      expect(long.l3.previewCut).toBe(true);
      expect(long.top.projectCut).toBe(true);
      expect(long.top.marksDrawn).toBe(2);
      await row.locator('.ib-qn').tap();
      await page.waitForTimeout(400);
      await expect(card(page)).toHaveCount(0);
      await page.goto(world.url);
      await expect(page.locator(`.ib-mrow[data-thread-id="${world.stopped}"] .ib-qn`)).toHaveAttribute('data-wait-step', 'stop');
      await expect(page.locator(`.ib-mrow[data-thread-id="${world.stopped}"]`)).toBeVisible();
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(proofDir, `iphone-${scheme}.png`) });
      await context.close();
    }
  } finally {
    await own?.close();
  }
});

test('a small phone (320, 360): the preview gives way first; ?N stays whole; the title is never cut; a long project is cut on one line after its tiles, never dropped', async () => {
  const own = await webkit.launch({ args: [] });
  try {
    for (const width of [320, 360]) {
      const context = await own.newContext({ ...devices['iPhone 15'], viewport: { width, height: 1600 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(world.url);
      const row = page.locator(`.ib-mrow[data-thread-id="${world.guided}"]`);
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator('.ib-m3 > [data-guide-mark]')).toBeVisible();
      await expect(row.locator('.ib-qn')).toHaveAttribute('data-wait-step', 'hold');
      await page.waitForTimeout(600);
      const l3 = (await page.evaluate(`(${lineThree.toString()})(document.querySelector('.ib-mrow[data-thread-id="${world.guided}"] .ib-m3'))`)) as ReturnType<typeof lineThree>;
      expectLineThree(l3, `${world.guided} at ${width}`);
      expect(l3.preview!.width, `at ${width}`).toBeGreaterThanOrEqual(40);
      const longRow = page.locator(`.ib-mrow[data-thread-id="${world.long}"]`);
      await longRow.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const top = (await page.evaluate(`(${topLines.toString()})(document.querySelector('.ib-mrow[data-thread-id="${world.long}"]'))`)) as ReturnType<typeof topLines>;
      expect(top.projectCut, `at ${width}`).toBe(true);
      expect(top.projectLines, `at ${width}`).toBe(1);
      expect(top.marksDrawn, `at ${width}`).toBe(2);
      expect(top.marksBefore && top.marksInside, `at ${width}: the tiles come before the project, inside the row`).toBe(true);
      expect(top.timeWhole && top.timeEnd <= 0.5, `at ${width}: the time ends line 1 whole`).toBe(true);
      expect(top.titleCut, `at ${width}`).toBe(false);
      expect(top.titleInside, `at ${width}`).toBe(true);
      expect(top.titleLines, `at ${width}`).toBeGreaterThan(1);
      expect(await longRow.evaluate((r) => r.scrollWidth <= r.clientWidth + 0.5), `at ${width}: the row spills`).toBe(true);
      await page.screenshot({ path: join(proofDir, `phone-${width}.png`) });
      await context.close();
    }
  } finally {
    await own.close();
  }
});

test('desktop, rows whose count has words (a draft, Undelivered) or open action items (the box pill): the full words, every column lined up at 1440 and 900, the subject the widest; beside a thread the short forms and the pill', async () => {
  const { page } = world;
  const deploy = scratchProject(world.src, 'deploy-app');
  const claude = world.agents[0]!;
  const action = [':::action', 'Approve the production deploy on Vercel', 'The build passed every check.', '', 'Stopped: the release cannot go out until it is approved', ':::'].join('\n');
  const one = await claude.send({ project_path: deploy, subject: 'Approve the deploy', thread: 'prod-deploy', body: action });
  const both = await claude.send({ project_path: deploy, subject: 'Deploy and a name', thread: 'release-name', body: [action, '', ':::question', 'Call it 4.2 or 5.0?', '', '- [ ] 4.2', '- [ ] 5.0', ':::'].join('\n') });
  const waitFor = (min: number) => ({ kind: 'reply', state: 'queued', reason: 'working', send_now: false, message_id: 'msg_waiting', at: null, host: 'claude-code', name: 'Claude Code', waiting_since: new Date(Date.now() - min * 60_000).toISOString(), steerable: false, auto_send_at: null });
  await page.route('**/api/inbox/threads?archived=exclude*', async (route) => {
    const response = await route.fetch({ url: route.request().url().replace(/&since=[^&]*/, '') });
    const model = (await response.json()) as { sections: { threads: Record<string, unknown>[] }[] };
    for (const row of model.sections.flatMap((s) => s.threads)) {
      if (row.thread_id === world.news) row.unsent = { reply_at: new Date().toISOString(), picks: 2, comments: 3 };
      if (row.thread_id === world.pair) row.delivery = waitFor(14);
      if (row.thread_id === world.long) row.delivery = waitFor(1500);
    }
    await route.fulfill({ response, json: model });
  });
  const named = (full: RegExp) => new RegExp(full.source.slice(1, -1).replace(' · ', ' (?:· )?'));
  const counted: [string, number, number, RegExp][] = [
    [one.thread_id as string, 1, 0, /Stopped on you: 1 action item/],
    [both.thread_id as string, 1, 1, /Stopped on you: 1 action item 1 question/],
  ];
  const expected: [string, RegExp, RegExp][] = [
    [world.news, /^Draft$/, /^Draft · Your reply, 2 picks, 3 comments$/],
    [world.pair, /^Undelivered 1[45]m$/, /^Undelivered 1[45] min$/],
    [world.long, /^Undelivered 1d$/, /^Undelivered 1 day$/],
  ];
  try {
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
        await expect(row.locator('.ib-cq > [data-action-count]')).toHaveAttribute('data-wait-step', 'stop');
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
            rights: ['.ib-subj', '.ib-cw', '.ib-bcol', '.ib-cq', '.ib-t'].map((sel) => Math.round(box(sel).right)),
            subj: Math.round(box('.ib-subj').left),
            subjWidth: box('.ib-subj').width,
            others: Math.max(...['.ib-from', '.ib-cw', '.ib-bcol', '.ib-cq', '.ib-t'].map((sel) => box(sel).width)),
            pill: pill ? pill.left >= box('.ib-cw').left - 0.5 && pill.right <= box('.ib-cw').right + 0.5 && pill.right <= box('.ib-bcol').left : null,
          };
        }),
      }));
      const where = `at ${viewport}px (a ${layout.list} px list)`;
      expect(layout.list, where).toBeGreaterThanOrEqual(full ? 1150 : 900);
      if (!full) expect(layout.list, where).toBeLessThan(1150);
      expect(layout.rows.length).toBeGreaterThanOrEqual(9);
      for (let i = 0; i < 5; i++) expect(new Set(layout.rows.map((g) => g.rights[i])).size, `column ${i} ${where}: ${JSON.stringify(layout.rows)}`).toBe(1);
      expect(new Set(layout.rows.map((g) => g.subj)).size).toBe(1);
      for (const g of layout.rows) {
        expect(g.subjWidth, `the subject is the widest column ${where}`).toBeGreaterThan(g.others);
        if (g.pill !== null) expect(g.pill, `${g.id}: the pill stays in its column ${where}`).toBe(true);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(world.url);
    const stopped = page.locator(`.ib-row[data-thread-id="${world.stopped}"]`);
    await stopped.locator('.ib-subj').hover();
    await expect(page.locator(`.ib-rw[data-row="${world.stopped}"] .ib-ract`)).toBeVisible();
    const shown = await stopped.evaluate((r) => Object.fromEntries(['.ib-ags', '.ib-bcol', '.ib-cq', '.ib-t'].map((sel) => [sel, getComputedStyle(r.querySelector(sel)!).visibility])));
    expect(shown).toEqual({ '.ib-ags': 'visible', '.ib-bcol': 'visible', '.ib-cq': 'hidden', '.ib-t': 'hidden' });
    await page.mouse.move(5, 5);
    await shot(page, 'desktop-words');

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

    await page.goto(`${world.url}#thread=${world.stopped}`);
    await expect(page.locator(`.ib-nrow[data-thread-id="${world.news}"] [data-draft-label]`)).toHaveText('Draft');
    for (const [id, actions, questions, name] of counted) {
      const row = page.locator(`.ib-nrow[data-thread-id="${id}"]`);
      await expect(row).toHaveAccessibleName(name);
      const tail = await row.locator('.ib-l3').evaluate((l) => {
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
      const line = await page.locator(`.ib-nrow[data-thread-id="${id}"] .ib-l3`).evaluate((l) => {
        const words = l.querySelector(':scope > .ib-c')!;
        const subject = l.querySelector<HTMLElement>(':scope > .ib-pv');
        const pill = words.querySelector<HTMLElement>('[data-undelivered]');
        const text = pill?.querySelector<HTMLElement>('.ib-bwt');
        const lr = l.getBoundingClientRect();
        return {
          short: words.querySelector('.ib-cs')!.textContent,
          last: l.lastElementChild === words,
          wordsWidth: words.getBoundingClientRect().width,
          pill: pill ? { width: pill.getBoundingClientRect().width, inside: pill.getBoundingClientRect().right <= lr.right + 0.5, whole: text!.scrollWidth <= text!.clientWidth + 0.5 } : null,
          subject: subject ? subject.getBoundingClientRect().width : 0,
          whole: subject ? subject.scrollWidth <= subject.clientWidth + 0.5 : true,
          line: lr.width,
        };
      });
      expect(line.short, id).toMatch(short);
      expect(line.last, id).toBe(true);
      expect(line.wordsWidth, id).toBeLessThanOrEqual(124.5);
      if (line.pill) {
        expect(line.pill.width, `${id}: the pill fits the slot`).toBeLessThanOrEqual(124.5);
        expect(line.pill.inside, `${id}: the pill ends inside line 3`).toBe(true);
        expect(line.pill.whole, `${id}: the pill's words are whole`).toBe(true);
      }
      if (!line.whole) expect(line.subject, `${id}: the preview keeps its room in a ${line.line} px line`).toBeGreaterThanOrEqual(120);
    }
  } finally {
    await page.unroute('**/api/inbox/threads?archived=exclude*');
  }
  expect(world.errors).toEqual([]);
});
