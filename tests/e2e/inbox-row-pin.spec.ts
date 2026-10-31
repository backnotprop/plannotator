/**
 * The pin on a pinned thread's list row always sits in the row's right-hand trailing slot, where the open counts
 * (the action pill, `?N`) and the count in words ("Read", "To Claude Code") sit, before them (the owner, 2026-10-31:
 * "They should just always be to the right. Just like the questions, just like the action items."). Before, the
 * pin followed the grey preview: right after a short last line ("/sharpen 📌"), and at the right edge only when a
 * long one was cut. Proved in a real Chromium against the compiled binary under a temp HOME and
 * PLANNOTATOR_DATA_DIR; agents write through `plannotator inbox mcp` (scripts/inbox-sim.ts). Nothing is mocked.
 *
 * Four pinned threads: a short last line and a long one, each with and without an open question; and a pinned Sent
 * row (its ✓ before the time). For every row shape (the three-line row
 * beside a thread, the wide one-line list at 1440 px, a 390 px phone) and every list look (none, Compact rows,
 * Highlight thread subject, Hide agent icons, all three), unread and then read:
 *  - three-line and phone rows: the pin is on line 3 after the preview; with something after it (the badge, a
 *    count, the words) it ends 8 px (the line's gap) before that, else on the line's right edge;
 *  - the wide row: the pin in its own column, ending 8 px before the open counts' column, clear of the title cell,
 *    at one x down the list; every row of the list has that column, so the badge and counts columns line up; a
 *    list with no pinned row (one project's) keeps today's six columns, with no pin column;
 *  - a short and a long row with the same trailing parts put the pin at the same x;
 *  - the Sent row's ✓ and time end line 1;
 *  - read, "Read" takes the slot's end and the pin sits before it;
 *  - beside a thread, the hover's Mark read still covers line 1 only, away from the pin, and marks the row read.
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

let url = '';
let agents: SimAgent[] = [];
let post: (path: string, body: object) => Promise<void> = async () => {};
/** The pinned rows: a short or long last line, with (`Q`) or without an open question; a pinned Sent row. */
const pins = { short: '', shortQ: '', long: '', longQ: '', sent: '' };
/** The thread opened to draw the three-line rows beside it (not pinned). */
let opener = '';
/** A project none of whose threads is pinned. */
let unpinnedProject = '';

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
  const say = async (agent: SimAgent, project: string, thread: string, subject: string, body: string) =>
    (await agent.send({ project_path: scratchProject(src, project), thread, subject, body })).thread_id as string;
  opener = await say(codex, 'workspaces', 'Token refresh', 'Token refresh fails after the laptop sleeps', 'Retry on wake is in.');
  pins.sent = await say(claude, 'workspaces', 'Refund events', 'Webhook or poll', 'Trust the webhook or poll Stripe?');
  pins.long = await say(codex, 'billing-svc', 'Ledger dry run', LONG_SUBJECT, 'The dry run is ready.');
  pins.longQ = await say(claude, 'billing-svc', 'Ledger cutover', LONG_SUBJECT, ask('Run the dry run on Friday?'));
  pins.short = await say(claude, 'workspaces', 'System', '/sharpen', 'Sharpened.');
  pins.shortQ = await say(codex, 'workspaces', 'Production Launch', 'Production Release Plan', ask('Ship on Monday?'));
  // A project with no pin: its wide list keeps today's columns, no pin column.
  await say(claude, 'docs-site', 'Install page', 'The install page is up', ask('Ship it?'));
  expect(new Set([opener, ...Object.values(pins)]).size, 'six threads').toBe(6);
  const health = (await (await fetch(new URL('/api/inbox/health', url))).json()) as { serverSession: string };
  post = async (path: string, body: object) => {
    const res = await fetch(new URL(path, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, serverSession: health.serverSession }) });
    expect(res.ok, `${path}: ${res.status} ${await res.text()}`).toBe(true);
  };
  await post(`/api/inbox/messages/${pins.sent}/reply`, { idempotency_key: 'row-pin-sent', words: 'Poll every 10 minutes for now.', questions: [] });
  for (const id of Object.values(pins)) await post(`/api/inbox/threads/${id}/pin`, { pinned: true });
  const model = (await (await fetch(new URL('/api/inbox/projects', url))).json()) as { projects: { id: string; name: string }[] };
  unpinnedProject = model.projects.find((p) => p.name === 'docs-site')!.id;
  expect(unpinnedProject).toBeTruthy();
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    agents = [];
  } finally {
    await removeInboxScratch();
  }
});

type Shape = 'narrow' | 'wide' | 'phone';
const ROW: Record<Shape, string> = { narrow: 'ib-nrow', wide: 'ib-row', phone: 'ib-mrow' };

/** The list looks, as the ⋮ menu's cookies (packages/inbox/listLook.ts). */
const LOOKS: [string, string[]][] = [
  ['default', []],
  ['compact', ['compact']],
  ['highlight', ['highlight']],
  ['hide-agents', ['hide-agents']],
  ['all-three', ['highlight', 'compact', 'hide-agents']],
];

interface PinGeometry {
  id: string;
  unread: boolean;
  /** The class of the pin's line (or the title cell), null without a pin. */
  line: string | null;
  pinLeft: number;
  pinRight: number;
  lineRight: number;
  /** What follows the pin on its line, and where the first of it starts. */
  after: string[];
  nextLeft: number | null;
  /** The line's gap between parts. */
  gap: number;
  previewRight: number | null;
  /** The Sent row's line 1: its ✓ is there and its time ends it. */
  tick: boolean;
  timeEnd: number;
  /** The last part of the pin's line ends on its right edge. */
  lastEnd: number;
  /** A wide row: its title cell's right edge and its open counts' column's left edge. */
  subjRight: number | null;
  cqLeft: number | null;
}

async function measure(page: Page, shape: Shape): Promise<PinGeometry[]> {
  return page.evaluate(
    ([rowClass, ids]) =>
      ids.map((id) => {
        const row = document.querySelector<HTMLElement>(`.ib-lbody .${rowClass}[data-thread-id="${id}"]`)!;
        const pin = row.querySelector<HTMLElement>('[data-pin-mark]');
        const line = pin?.parentElement ?? null;
        const box = (el: Element) => el.getBoundingClientRect();
        const after: Element[] = [];
        for (let next = pin?.nextElementSibling ?? null; next; next = next.nextElementSibling) if (box(next).width > 0) after.push(next);
        const preview = line?.querySelector(':scope > .ib-pv') ?? null;
        // The time's line: line 1, or the wide row itself (its time column ends the row's content box).
        const l1 = row.querySelector<HTMLElement>(':scope > :is(.ib-l1, .ib-m1)') ?? row;
        const time = l1.querySelector(':scope > .ib-t')!;
        const kids = line ? [...line.children].filter((c) => box(c).width > 0) : [];
        return {
          id,
          unread: row.classList.contains('ib-u'),
          line: line ? line.className.split(' ')[0]! : null,
          pinLeft: pin ? box(pin).left : 0,
          pinRight: pin ? box(pin).right : 0,
          lineRight: line ? box(line).right : 0,
          after: after.map((c) => (c.matches('[data-row-badge]') ? 'badge' : c.matches('[data-action-count]') ? 'action' : c.classList.contains('ib-qn') ? 'count' : c.classList.contains('ib-c') ? 'words' : c.className.split(' ')[0]!)),
          nextLeft: after[0] ? box(after[0]).left : null,
          gap: line ? parseFloat(getComputedStyle(line).columnGap) || 0 : 0,
          previewRight: preview ? box(preview).right : null,
          tick: !!time.querySelector('.ib-tick'),
          timeEnd: Math.abs(box(time).right - (box(l1).right - parseFloat(getComputedStyle(l1).paddingRight))),
          lastEnd: kids.length && line ? Math.abs(box(kids[kids.length - 1]!).right - box(line).right) : 0,
          subjRight: row.querySelector(':scope > .ib-subj') ? box(row.querySelector(':scope > .ib-subj')!).right : null,
          cqLeft: row.querySelector(':scope > .ib-cq') ? box(row.querySelector(':scope > .ib-cq')!).left : null,
        };
      }),
    [ROW[shape], Object.values(pins)] as const,
  );
}

/** Every pinned row's pin in its trailing slot, at one x for a short and a long last line. */
function expectPinsRight(rows: PinGeometry[], shape: Shape, label: string) {
  const at = (id: string) => rows.find((r) => r.id === id)!;
  for (const r of rows) {
    const name = `${label}: row ${Object.entries(pins).find(([, id]) => id === r.id)![0]}`;
    expect(r.line, `${name}: the pin's line`).toBe(shape === 'wide' ? 'ib-cpin' : shape === 'narrow' ? 'ib-l3' : 'ib-m3');
    if (r.previewRight !== null) expect(r.pinLeft, `${name}: the pin follows the preview`).toBeGreaterThanOrEqual(r.previewRight - 0.5);
    if (shape === 'wide') {
      // Its own column just left of the open counts' column: it ends one 8 px gap before that column, clear of the
      // title cell, whether the row has counts or not.
      expect(r.after, `${name}: the pin alone in its column`).toEqual([]);
      expect(Math.abs(r.cqLeft! - 8 - r.pinRight), `${name}: one gap before the counts' column`).toBeLessThanOrEqual(0.5);
      expect(r.pinLeft, `${name}: clear of the title cell`).toBeGreaterThanOrEqual(r.subjRight! - 0.5);
      continue;
    } else if (r.nextLeft !== null) {
      // Before the badge, the counts or the words, one gap from them.
      expect(r.after.every((p) => ['badge', 'action', 'count', 'words'].includes(p)), `${name}: after the pin: ${r.after}`).toBe(true);
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
  if (shape === 'wide') expect(new Set(rows.map((r) => Math.round(r.pinRight))).size, `${label}: one x down the list`).toBe(1);
  // The Sent row: its ✓ before the time on line 1, the time ending it (its pin is checked with the others above).
  const sent = at(pins.sent);
  expect(sent.tick, `${label}: the Sent row's ✓`).toBe(true);
  expect(sent.timeEnd, `${label}: the Sent row's time ends line 1`).toBeLessThanOrEqual(0.5);
}

const desktop = (browser: Browser): Promise<BrowserContext> => browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
const phone = (browser: Browser): Promise<BrowserContext> => browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce' });

async function openQuiet(page: Page) {
  const band = page.locator('.ib-lbody [data-section-id="quiet"] button.ib-band');
  if ((await band.count()) === 0) return;
  if ((await band.getAttribute('aria-expanded')) !== 'true') await band.click();
  await expect(band).toHaveAttribute('aria-expanded', 'true');
}

/** Open the list in one shape and look, with every pinned row drawn. */
async function show(context: BrowserContext, page: Page, shape: Shape, cookies: string[]) {
  await context.clearCookies();
  if (cookies.length) await context.addCookies(cookies.map((c) => ({ name: `plannotator-inbox-list-${c}`, value: '1', url })));
  await page.goto(shape === 'narrow' ? `${url}#thread=${opener}` : url);
  await expect(page.locator(`.ib-lbody .${ROW[shape]}`).first()).toBeVisible();
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
    for (const r of rows) if (r.id !== pins.sent) expect(r.unread, `${label}: ${r.id}`).toBe(state === 'unread');
    expectPinsRight(rows, shape, label);
    if (shape === 'wide') {
      // Every row of a list with pins has the pin's column, so the badge and counts columns line up down the list.
      const columns = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.ib-lbody .ib-row')].map((r) => ({
          pinCell: !!r.querySelector(':scope > .ib-cpin'),
          bcolRight: Math.round(r.querySelector(':scope > .ib-bcol')!.getBoundingClientRect().right),
          cqLeft: Math.round(r.querySelector(':scope > .ib-cq')!.getBoundingClientRect().left),
        })),
      );
      expect(columns.every((c) => c.pinCell), `${label}: every row has the pin's column`).toBe(true);
      expect(new Set(columns.map((c) => `${c.bcolRight}/${c.cqLeft}`)).size, `${label}: the columns line up`).toBe(1);
    }
  }
}

test('unread pinned rows: the pin in the trailing slot on every shape and look; Mark read still works', async ({ browser }) => {
  for (const shape of ['narrow', 'wide'] as const) {
    const context = await desktop(browser);
    try {
      const page = await context.newPage();
      await everyLook(context, page, shape, 'unread');
    } finally {
      await context.close();
    }
  }
  const context = await phone(browser);
  try {
    await everyLook(context, await context.newPage(), 'phone', 'unread');
  } finally {
    await context.close();
  }

  // Beside a thread, the hover's Mark read covers line 1's right end only, never the pin on line 3, and marks read.
  const hover = await desktop(browser);
  try {
    const page = await hover.newPage();
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

test("a wide list with no pinned row keeps today's six columns: no pin column, no reserved gap", async ({ browser }) => {
  const context = await desktop(browser);
  try {
    const page = await context.newPage();
    await page.goto(`${url}#project=${unpinnedProject}`);
    const row = page.locator('.ib-lbody .ib-row').first();
    await expect(row).toBeVisible();
    await expect(page.locator('.ib-listcol')).not.toHaveClass(/\bib-pincol\b/);
    await expect(page.locator('.ib-lbody .ib-cpin')).toHaveCount(0);
    const cells = await row.evaluate((r) => ({ kids: [...r.children].map((c) => c.className.split(' ')[0]), tracks: getComputedStyle(r).gridTemplateColumns.split(' ').length }));
    expect(cells.kids).toEqual(['ib-from', 'ib-subj', 'ib-cw', 'ib-bcol', 'ib-cq', 'ib-t']);
    expect(cells.tracks).toBe(6);
  } finally {
    await context.close();
  }
});

test('read pinned rows ("Read" in the slot): the pin still before it, at one x', async ({ browser }) => {
  for (const id of [pins.short, pins.shortQ, pins.long, pins.longQ]) await post(`/api/inbox/threads/${id}/read`, {});
  for (const shape of ['narrow', 'wide'] as const) {
    const context = await desktop(browser);
    try {
      await everyLook(context, await context.newPage(), shape, 'read');
    } finally {
      await context.close();
    }
  }
  const context = await phone(browser);
  try {
    await everyLook(context, await context.newPage(), 'phone', 'read');
  } finally {
    await context.close();
  }
});
