/**
 * The pin on a pinned thread's list row always sits on the row's right, beside the open counts (the action pill,
 * `?N`) and the count in words ("Read"), before them (the owner, 2026-10-31: "They should just always be to the
 * right. Just like the questions, just like the action items."). Before, the pin followed the grey preview: right
 * after a short last line ("/sharpen 📌"), and at the right edge only when a long one was cut. Proved in a real
 * Chromium against the compiled binary under a temp HOME and PLANNOTATOR_DATA_DIR; agents write through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts). Nothing is mocked.
 *
 * The pinned threads, all in one project: a short and a long last line, each with and without an open question; a
 * Sent row; an unnamed thread with no preview and no count; and rows with 12 + 12 and 99+ + 99+ open counts (action
 * items and questions). For every shape (the three-line row beside a thread, the wide list, the wide list of that
 * one project, a 390 px phone) and every list look (none, Compact rows, Highlight thread subject, Hide agent icons,
 * all three; each checked on the list column before measuring), unread and then read:
 *  - three-line and phone rows: the pin is on line 3 after the preview; with something after it (the badge, the
 *    counts, the words) it ends 8 px (the line's gap) before that, else on the line's right edge. A phone row with
 *    nothing else for line 3 keeps the pin on line 1, 8 px before the time, and has no line 3;
 *  - the wide row: the pin in its own column, ending 8 px before the open counts' column, at one x down the list,
 *    clear of the title cell; the counts never under it (the column widens for the whole list to the widest
 *    counts) and never over the time; every row has as many grid tracks as cells, and the time on the row's line;
 *  - a short and a long row with the same trailing parts put the pin at the same x;
 *  - the Sent row's ✓ and time end its time line;
 *  - the hover's Mark read still works beside a thread (line 1 only, away from the pin) and is never painted over
 *    by the pin on a wide row.
 * A list with no pinned row keeps today's six columns and its 84 px counts column (big counts or not), and a pinned
 * list whose counts fit keeps the 84 px column.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-row-pin.spec.ts`.
 * PNGs land in PLANNOTATOR_ROW_PIN_SHOTS, or PLANNOTATOR_E2E_PROOF_DIR/row-pin, or .local/proof/row-pin/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_ROW_PIN_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'row-pin'));

const LONG_SUBJECT =
  "Approve the ledger reconciliation plan before Friday's cutover, the audit sign-off and the quarter-end close across every subsidiary";
/** The wide rows' open counts column, as inbox.css draws it. */
const COUNTS_PX = 84;

let url = '';
let agents: SimAgent[] = [];
let post: (path: string, body: object) => Promise<void> = async () => {};
/** The pinned rows, all in the project "workspaces". */
const pins = { short: '', shortQ: '', long: '', longQ: '', sent: '', bare: '', big: '', huge: '' };
/** The thread opened to draw the three-line rows beside it (not pinned, another project). */
let opener = '';
const projects = { pinned: '', unpinned: '', ordinary: '' };
let ordinaryPin = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-row-pin-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  rememberInboxOf(dataDir);
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  agents = [claude, codex];
  const src = join(root, 'src');
  const ask = (q: string) => [':::question', q, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
  const questions = (n: number) => Array.from({ length: n }, (_, i) => ask(`Question ${i}?`)).join('\n\n');
  const actions = (n: number) => Array.from({ length: n }, (_, i) => [':::action', `Approve thing ${i}`, ':::'].join('\n')).join('\n\n');
  const say = async (agent: SimAgent, project: string, thread: string | undefined, subject: string, body: string) =>
    (await agent.send({ project_path: scratchProject(src, project), ...(thread ? { thread } : {}), subject, body })).thread_id as string;
  opener = await say(codex, 'billing-svc', 'Token refresh', 'Token refresh fails after the laptop sleeps', 'Retry on wake is in.');
  // No pin in docs-site, and counts wider than the column: its list keeps today's columns.
  await say(claude, 'docs-site', 'Install page', 'The install page is up', `${actions(12)}\n\n${questions(12)}`);
  // One pin, a one-digit count: the counts' column keeps its 84 px.
  ordinaryPin = await say(codex, 'ops', 'Rotate keys', 'Rotate the signing keys', ask('Rotate tonight?'));
  pins.huge = await say(claude, 'workspaces', 'Backlog triage', 'Triage the backlog', `${actions(100)}\n\n${questions(100)}`);
  pins.big = await say(codex, 'workspaces', 'Release checklist', 'Release checklist', `${actions(12)}\n\n${questions(12)}`);
  pins.sent = await say(claude, 'workspaces', 'Refund events', 'Webhook or poll', 'Trust the webhook or poll Stripe?');
  pins.bare = await say(codex, 'workspaces', undefined, 'Nightly build passed', 'All green.');
  pins.long = await say(codex, 'workspaces', 'Ledger dry run', LONG_SUBJECT, 'The dry run is ready.');
  pins.longQ = await say(claude, 'workspaces', 'Ledger cutover', LONG_SUBJECT, ask('Run the dry run on Friday?'));
  pins.short = await say(claude, 'workspaces', 'System', '/sharpen', 'Sharpened.');
  pins.shortQ = await say(codex, 'workspaces', 'Production Launch', 'Production Release Plan', ask('Ship on Monday?'));
  expect(new Set([opener, ordinaryPin, ...Object.values(pins)]).size, 'ten threads').toBe(10);
  const health = (await (await fetch(new URL('/api/inbox/health', url))).json()) as { serverSession: string };
  post = async (path: string, body: object) => {
    const res = await fetch(new URL(path, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, serverSession: health.serverSession }) });
    expect(res.ok, `${path}: ${res.status} ${await res.text()}`).toBe(true);
  };
  await post(`/api/inbox/messages/${pins.sent}/reply`, { idempotency_key: 'row-pin-sent', words: 'Poll every 10 minutes for now.', questions: [] });
  for (const id of [...Object.values(pins), ordinaryPin]) await post(`/api/inbox/threads/${id}/pin`, { pinned: true });
  const model = (await (await fetch(new URL('/api/inbox/projects', url))).json()) as { projects: { id: string; name: string }[] };
  const project = (name: string) => model.projects.find((p) => p.name === name)!.id;
  projects.pinned = project('workspaces');
  projects.unpinned = project('docs-site');
  projects.ordinary = project('ops');
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    agents = [];
  } finally {
    await removeInboxScratch();
  }
});

/** `solo`: the wide list of the pinned rows' one project. */
type Shape = 'narrow' | 'wide' | 'solo' | 'phone';
const ROW: Record<Shape, string> = { narrow: 'ib-nrow', wide: 'ib-row', solo: 'ib-row', phone: 'ib-mrow' };
const wideShape = (shape: Shape) => shape === 'wide' || shape === 'solo';

/** The list looks, as the ⋮ menu's cookies (packages/inbox/listLook.ts), and the classes each puts on the list column. */
const LOOKS: [string, string[]][] = [
  ['default', []],
  ['compact', ['compact']],
  ['highlight', ['highlight']],
  ['hide-agents', ['hide-agents']],
  ['all-three', ['highlight', 'compact', 'hide-agents']],
];
const LOOK_CLASS: Record<string, string> = { highlight: 'ib-lk-pill', compact: 'ib-lk-compact', 'hide-agents': 'ib-lk-noagents' };

interface PinGeometry {
  id: string;
  unread: boolean;
  /** The class of the pin's line (or the wide row's pin cell), null without a pin. */
  line: string | null;
  pinLeft: number;
  pinRight: number;
  pinTop: number;
  lineRight: number;
  /** What follows the pin on its line, and where the first of it starts. */
  after: string[];
  nextLeft: number | null;
  /** The line's gap between parts. */
  gap: number;
  previewRight: number | null;
  /** A phone row's line 3 is drawn. */
  m3Shown: boolean;
  /** The row's time line: its ✓ is there and its time ends it. */
  tick: boolean;
  timeEnd: number;
  /** The last part of the pin's line ends on its right edge. */
  lastEnd: number;
  /** A wide row: its title cell's right edge, its open counts' column, the counts drawn in it, and the time. */
  subjRight: number | null;
  cqLeft: number | null;
  cqRight: number | null;
  countsLeft: number | null;
  countsRight: number | null;
  timeLeft: number | null;
}

async function measure(page: Page, shape: Shape): Promise<PinGeometry[]> {
  return page.evaluate(
    ([rowClass, ids]) =>
      ids.map((id) => {
        const row = document.querySelector<HTMLElement>(`.ib-lbody .${rowClass}[data-thread-id="${id}"]`)!;
        const pin = row.querySelector<HTMLElement>('[data-pin-mark]');
        const line = pin?.parentElement ?? null;
        const box = (el: Element) => el.getBoundingClientRect();
        const shown = (el: Element) => box(el).width > 1;
        const after: Element[] = [];
        for (let next = pin?.nextElementSibling ?? null; next; next = next.nextElementSibling) if (shown(next)) after.push(next);
        const preview = row.querySelector(':scope > :is(.ib-l3, .ib-m3, .ib-subj) > .ib-pv');
        const m3 = row.querySelector(':scope > .ib-m3');
        // The time's line: line 1, or the wide row itself (its time column ends the row's content box).
        const l1 = row.querySelector<HTMLElement>(':scope > :is(.ib-l1, .ib-m1)') ?? row;
        const time = l1.querySelector(':scope > .ib-t')!;
        const kids = line ? [...line.children].filter(shown) : [];
        const cq = row.querySelector(':scope > .ib-cq');
        const counts = cq ? [...cq.children].filter(shown).map(box) : [];
        return {
          id,
          unread: row.classList.contains('ib-u'),
          line: line ? line.className.split(' ')[0]! : null,
          pinLeft: pin ? box(pin).left : 0,
          pinRight: pin ? box(pin).right : 0,
          pinTop: pin ? box(pin).top : 0,
          lineRight: line ? box(line).right : 0,
          after: after.map((c) => (c.matches('[data-row-badge]') ? 'badge' : c.matches('[data-action-count]') ? 'action' : c.classList.contains('ib-qn') ? 'count' : c.classList.contains('ib-c') ? 'words' : c.className.split(' ')[0]!)),
          nextLeft: after[0] ? box(after[0]).left : null,
          gap: line ? parseFloat(getComputedStyle(line).columnGap) || 0 : 0,
          previewRight: preview ? box(preview).right : null,
          m3Shown: !!m3 && getComputedStyle(m3).display !== 'none' && box(m3).height > 0,
          tick: !!time.querySelector('.ib-tick'),
          timeEnd: Math.abs(box(time).right - (box(l1).right - parseFloat(getComputedStyle(l1).paddingRight))),
          lastEnd: kids.length && line ? Math.abs(box(kids[kids.length - 1]!).right - box(line).right) : 0,
          subjRight: row.querySelector(':scope > .ib-subj') ? box(row.querySelector(':scope > .ib-subj')!).right : null,
          cqLeft: cq ? box(cq).left : null,
          cqRight: cq ? box(cq).right : null,
          countsLeft: counts.length ? Math.min(...counts.map((c) => c.left)) : null,
          countsRight: counts.length ? Math.max(...counts.map((c) => c.right)) : null,
          timeLeft: rowClass === 'ib-row' ? box(time).left : null,
        };
      }),
    [ROW[shape], Object.values(pins)] as const,
  );
}

const nameOf = (id: string) => Object.entries(pins).find(([, v]) => v === id)?.[0] ?? id;

/** Every pinned row's pin on the right, before its counts, at one x for a short and a long last line. */
function expectPinsRight(rows: PinGeometry[], shape: Shape, label: string) {
  const at = (id: string) => rows.find((r) => r.id === id)!;
  for (const r of rows) {
    const name = `${label}: row ${nameOf(r.id)}`;
    if (r.previewRight !== null) expect(r.pinLeft, `${name}: the pin follows the preview`).toBeGreaterThanOrEqual(r.previewRight - 0.5);
    if (wideShape(shape)) {
      // Its own column just left of the open counts' column: 8 px before it, clear of the title cell; the counts
      // never under the pin (8 px or more from it) and never past their column into the time.
      expect(r.line, `${name}: the pin's cell`).toBe('ib-cpin');
      expect(r.after, `${name}: the pin alone in its cell`).toEqual([]);
      expect(Math.abs(r.cqLeft! - 8 - r.pinRight), `${name}: 8 px before the counts' column`).toBeLessThanOrEqual(0.5);
      expect(r.pinLeft, `${name}: clear of the title cell`).toBeGreaterThanOrEqual(r.subjRight! - 0.5);
      if (r.countsLeft !== null) {
        expect(r.countsLeft - r.pinRight, `${name}: the counts 8 px or more from the pin`).toBeGreaterThanOrEqual(8 - 0.5);
        expect(r.countsRight!, `${name}: the counts inside their column`).toBeLessThanOrEqual(r.cqRight! + 0.5);
        expect(r.countsRight!, `${name}: the counts clear of the time`).toBeLessThanOrEqual(r.timeLeft! + 0.5);
      }
      continue;
    }
    if (shape === 'phone' && r.line === 'ib-m1') {
      // Nothing else for line 3: the pin stays on line 1, 8 px before the time, and the row has no line 3.
      expect(r.line, `${name}: the pin on line 1`).toBe('ib-m1');
      expect(r.after, `${name}: the time after the pin`).toEqual(['ib-t']);
      expect(Math.abs(r.nextLeft! - r.gap - r.pinRight), `${name}: one gap before the time`).toBeLessThanOrEqual(0.5);
      expect(r.m3Shown, `${name}: no line 3 for the pin alone`).toBe(false);
      continue;
    }
    expect(r.line, `${name}: the pin's line`).toBe(shape === 'narrow' ? 'ib-l3' : 'ib-m3');
    if (r.nextLeft !== null) {
      // Before the badge, the counts or the words, one 8 px gap from them.
      expect(r.after.every((p) => ['badge', 'action', 'count', 'words'].includes(p)), `${name}: after the pin: ${r.after}`).toBe(true);
      expect(r.gap, `${name}: the line's gap`).toBe(8);
      expect(Math.abs(r.nextLeft - r.gap - r.pinRight), `${name}: one gap before ${r.after[0]}`).toBeLessThanOrEqual(0.5);
    } else {
      expect(Math.abs(r.pinRight - r.lineRight), `${name}: on the line's right edge`).toBeLessThanOrEqual(0.5);
    }
    // Whatever ends the line (the pin, a count, the words) ends on its right edge.
    expect(r.lastEnd, `${name}: the line's last part ends on its edge`).toBeLessThanOrEqual(0.5);
  }
  // A short and a long last line: the pin at one x, with and without an open question.
  for (const [a, b] of [[pins.short, pins.long], [pins.shortQ, pins.longQ]] as const) {
    expect(at(a).after, `${label}: the same trailing parts`).toEqual(at(b).after);
    expect(Math.abs(at(a).pinRight - at(b).pinRight), `${label}: a short and a long line put the pin at one x`).toBeLessThanOrEqual(0.5);
  }
  if (wideShape(shape)) expect(new Set(rows.map((r) => Math.round(r.pinRight))).size, `${label}: one x down the list`).toBe(1);
  // The Sent row: its ✓ before the time, the time ending its line.
  const sent = at(pins.sent);
  expect(sent.tick, `${label}: the Sent row's ✓`).toBe(true);
  expect(sent.timeEnd, `${label}: the Sent row's time ends its line`).toBeLessThanOrEqual(0.5);
}

/** Every wide row of the list: as many grid tracks as cells, the time on the row's one line at its content edge. */
async function expectWideGrid(page: Page, label: string) {
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.ib-lbody .ib-row')].map((r) => {
      const cells = (el: Element): Element[] => [...el.children].flatMap((c) => (getComputedStyle(c).display === 'contents' ? cells(c) : getComputedStyle(c).position === 'absolute' ? [] : [c]));
      const style = getComputedStyle(r);
      const rb = r.getBoundingClientRect();
      const tb = r.querySelector(':scope > .ib-t')!.getBoundingClientRect();
      return {
        id: r.dataset.threadId,
        cells: cells(r).length,
        tracks: style.gridTemplateColumns.split(' ').length,
        pinCell: !!r.querySelector(':scope > .ib-cpin'),
        timeMid: Math.abs((tb.top + tb.bottom) / 2 - (rb.top + rb.bottom) / 2),
        timeEnd: Math.abs(tb.right - (rb.right - parseFloat(style.paddingRight))),
        cq: Math.round(r.querySelector(':scope > .ib-cq')!.getBoundingClientRect().width * 2) / 2,
      };
    }),
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.cells, `${label}: row ${nameOf(r.id!)}: a grid track per cell`).toBe(r.tracks);
    expect(r.pinCell, `${label}: row ${nameOf(r.id!)}: the pin's column`).toBe(true);
    expect(r.timeMid, `${label}: row ${nameOf(r.id!)}: the time on the row's line`).toBeLessThanOrEqual(2);
    expect(r.timeEnd, `${label}: row ${nameOf(r.id!)}: the time at the content edge`).toBeLessThanOrEqual(0.5);
  }
  expect(new Set(rows.map((r) => r.cq)).size, `${label}: one counts column width`).toBe(1);
  return rows[0]!.cq;
}

const desktop = (browser: Browser): Promise<BrowserContext> => browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
const phone = (browser: Browser): Promise<BrowserContext> => browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce' });

async function openQuiet(page: Page) {
  const band = page.locator('.ib-lbody [data-section-id="quiet"] button.ib-band');
  if ((await band.count()) === 0) return;
  if ((await band.getAttribute('aria-expanded')) !== 'true') await band.click();
  await expect(band).toHaveAttribute('aria-expanded', 'true');
}

const SHAPE_URL = (shape: Shape) => (shape === 'narrow' ? `${url}#thread=${opener}` : shape === 'solo' ? `${url}#project=${projects.pinned}` : url);

/**
 * Open the list in one shape and look, with every pinned row drawn. The look is read once per page load, and a goto
 * that changes only the fragment does not load the page, so the page goes to about:blank first; the list column's
 * classes then prove the look is the one asked for.
 */
async function show(context: BrowserContext, page: Page, shape: Shape, cookies: string[]) {
  await context.clearCookies();
  if (cookies.length) await context.addCookies(cookies.map((c) => ({ name: `plannotator-inbox-list-${c}`, value: '1', url })));
  await page.goto('about:blank');
  await page.goto(SHAPE_URL(shape));
  await expect(page.locator(`.ib-lbody .${ROW[shape]}`).first()).toBeVisible();
  const want = cookies.map((c) => LOOK_CLASS[c]!).sort();
  expect((await page.locator('.ib-listcol').evaluate((el) => [...el.classList].filter((c) => c.startsWith('ib-lk-')))).sort(), `${shape}: the look ${cookies}`).toEqual(want);
  await openQuiet(page);
  for (const id of Object.values(pins)) await expect(page.locator(`.ib-lbody .${ROW[shape]}[data-thread-id="${id}"] [data-pin-mark]`)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function everyLook(context: BrowserContext, page: Page, shape: Shape, state: 'unread' | 'read') {
  for (const [look, cookies] of LOOKS) {
    await show(context, page, shape, cookies);
    if (look === 'default') await page.screenshot({ path: join(proofDir, `${shape}-${state}.png`) });
    const rows = await measure(page, shape);
    const label = `${shape} ${look} ${state}`;
    // The rows are in the state this pass names (the Sent row is never bold).
    for (const r of rows) if (r.id !== pins.sent) expect(r.unread, `${label}: ${nameOf(r.id)}`).toBe(state === 'unread');
    expectPinsRight(rows, shape, label);
    // Only the phone row with nothing else for line 3 (unread, the unnamed row: no preview, no count) has its pin on
    // line 1; read, "Read" gives it a line 3.
    const bare = rows.find((r) => r.id === pins.bare)!;
    if (shape === 'phone') expect(bare.line, `${label}: the bare row's pin line`).toBe(state === 'unread' ? 'ib-m1' : 'ib-m3');
    for (const r of rows) if (r.id !== pins.bare) expect(r.line, `${label}: ${nameOf(r.id)}: only the bare row keeps its pin on line 1`).not.toBe('ib-m1');
    if (wideShape(shape)) {
      const cq = await expectWideGrid(page, label);
      // Wider counts than 84 px (the 99+ pair unread; docs-site's 12 + 12 in the whole list) widen the column for
      // the list; read, the one project's rows draw no counts and keep 84 px.
      if (shape === 'solo' && state === 'read') expect(cq, `${label}: no counts, the 84 px column`).toBe(COUNTS_PX);
      else expect(cq, `${label}: the counts' column holds the widest counts`).toBeGreaterThan(COUNTS_PX);
    }
  }
}

async function eachShape(browser: Browser, state: 'unread' | 'read') {
  for (const shape of ['narrow', 'wide', 'solo'] as const) {
    const context = await desktop(browser);
    try {
      await everyLook(context, await context.newPage(), shape, state);
    } finally {
      await context.close();
    }
  }
  const context = await phone(browser);
  try {
    await everyLook(context, await context.newPage(), 'phone', state);
  } finally {
    await context.close();
  }
}

test('unread pinned rows: the pin on the right of every shape and look; Mark read still works', async ({ browser }) => {
  await eachShape(browser, 'unread');

  const hover = await desktop(browser);
  try {
    const page = await hover.newPage();
    // A wide row: the hover's Mark read covers the time and the counts, right of the pin, which never paints over it.
    await show(hover, page, 'wide', []);
    const wideRow = page.locator(`.ib-lbody .ib-row[data-thread-id="${pins.short}"]`);
    await wideRow.locator('.ib-p').hover();
    const wideAction = page.locator(`.ib-lbody .ib-rw[data-row="${pins.short}"] [data-row-mark-read]`);
    await expect(wideAction).toBeVisible();
    const wide = await page.evaluate((id) => {
      const rw = document.querySelector(`.ib-lbody .ib-rw[data-row="${id}"]`)!;
      const button = rw.querySelector<HTMLElement>('[data-row-mark-read]')!;
      const b = button.getBoundingClientRect();
      const pin = rw.querySelector('[data-pin-mark]')!.getBoundingClientRect();
      const hit = (x: number, y: number) => button.contains(document.elementFromPoint(x, y));
      return { gap: b.left - pin.right, painted: hit(b.left + 2, (b.top + b.bottom) / 2) && hit((b.left + b.right) / 2, (b.top + b.bottom) / 2) && hit(b.right - 2, (b.top + b.bottom) / 2) };
    }, pins.short);
    expect(wide.gap, 'Mark read starts right of the pin').toBeGreaterThan(0);
    expect(wide.painted, 'Mark read is on top across its width').toBe(true);
    await page.screenshot({ path: join(proofDir, 'wide-hover-mark-read.png') });

    // Beside a thread: Mark read covers line 1's right end only, never the pin on line 3, and marks read.
    await show(hover, page, 'narrow', []);
    const row = page.locator(`.ib-lbody .ib-nrow[data-thread-id="${pins.short}"]`);
    await row.locator('.ib-l1 .ib-p').hover();
    const action = page.locator(`.ib-lbody .ib-rw[data-row="${pins.short}"] [data-row-mark-read]`);
    await expect(action).toBeVisible();
    const clear = await page.evaluate((id) => {
      const rw = document.querySelector(`.ib-lbody .ib-rw[data-row="${id}"]`)!;
      const button = rw.querySelector('[data-row-mark-read]')!.getBoundingClientRect();
      const pin = rw.querySelector('[data-pin-mark]')!.getBoundingClientRect();
      return { aboveTitle: rw.querySelector('.ib-l2')!.getBoundingClientRect().top - button.bottom, abovePin: pin.top - button.bottom };
    }, pins.short);
    expect(clear.aboveTitle, 'Mark read stays on line 1').toBeGreaterThanOrEqual(0);
    expect(clear.abovePin, 'Mark read never covers the pin').toBeGreaterThan(0);
    await page.screenshot({ path: join(proofDir, 'narrow-hover-mark-read.png') });
    await action.click();
    await expect(row).not.toHaveClass(/\bib-u\b/);
  } finally {
    await hover.close();
  }
});

test("a wide list with no pinned row keeps today's six columns and its 84 px counts column, big counts or not", async ({ browser }) => {
  const context = await desktop(browser);
  try {
    const page = await context.newPage();
    for (const [, cookies] of LOOKS) {
      await context.clearCookies();
      if (cookies.length) await context.addCookies(cookies.map((c) => ({ name: `plannotator-inbox-list-${c}`, value: '1', url })));
      await page.goto('about:blank');
      await page.goto(`${url}#project=${projects.unpinned}`);
      const row = page.locator('.ib-lbody .ib-row').first();
      await expect(row).toBeVisible();
      await expect(page.locator('.ib-listcol')).not.toHaveClass(/\bib-pincol\b/);
      await expect(page.locator('.ib-lbody .ib-cpin')).toHaveCount(0);
      const cells = await row.evaluate((r) => ({
        tracks: getComputedStyle(r).gridTemplateColumns.split(' ').length,
        cq: r.querySelector(':scope > .ib-cq')!.getBoundingClientRect().width,
        countsWider: r.querySelector(':scope > .ib-cq')!.scrollWidth,
        cqVar: getComputedStyle(r).getPropertyValue('--ib-cq-w'),
      }));
      // One project with Hide agent icons drops the first column: five tracks, else six.
      expect(cells.tracks, `${cookies}`).toBe(cookies.includes('hide-agents') ? 5 : 6);
      expect(Math.abs(cells.cq - COUNTS_PX), `${cookies}: the 84 px counts column`).toBeLessThanOrEqual(0.5);
      expect(cells.cqVar, `${cookies}: no widened column`).toBe('');
    }
  } finally {
    await context.close();
  }
});

test('a pinned wide list whose counts fit keeps the 84 px counts column, the pin 8 px before it', async ({ browser }) => {
  const context = await desktop(browser);
  try {
    const page = await context.newPage();
    await page.goto(`${url}#project=${projects.ordinary}`);
    const row = page.locator(`.ib-lbody .ib-row[data-thread-id="${ordinaryPin}"]`);
    await expect(row.locator('[data-pin-mark]')).toBeVisible();
    await expect(page.locator('.ib-listcol')).toHaveClass(/\bib-pincol\b/);
    const g = await row.evaluate((r) => {
      const cq = r.querySelector(':scope > .ib-cq')!.getBoundingClientRect();
      return { cq: cq.width, gap: cq.left - r.querySelector('[data-pin-mark]')!.getBoundingClientRect().right };
    });
    expect(Math.abs(g.cq - COUNTS_PX)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(g.gap - 8)).toBeLessThanOrEqual(0.5);
  } finally {
    await context.close();
  }
});

test('read pinned rows ("Read" in the slot): the pin still before it, at one x', async ({ browser }) => {
  for (const id of Object.values(pins)) if (id !== pins.sent) await post(`/api/inbox/threads/${id}/read`, {});
  await eachShape(browser, 'read');
});
