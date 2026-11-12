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
const COUNTS_PX = 84;

let url = '';
let agents: SimAgent[] = [];
let post: (path: string, body: object) => Promise<void> = async () => {};
const pins = { short: '', shortQ: '', long: '', longQ: '', sent: '', bare: '', big: '', huge: '' };
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
  await say(claude, 'docs-site', 'Install page', 'The install page is up', `${actions(12)}\n\n${questions(12)}`);
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

type Shape = 'narrow' | 'wide' | 'solo' | 'phone';
const ROW: Record<Shape, string> = { narrow: 'ib-nrow', wide: 'ib-row', solo: 'ib-row', phone: 'ib-mrow' };
const wideShape = (shape: Shape) => shape === 'wide' || shape === 'solo';

const LOOKS: [string, string[]][] = [
  ['default', []],
  ['compact', ['compact']],
  ['highlight', ['highlight']],
  ['hide-agents', ['hide-agents']],
  ['all-three', ['highlight', 'compact', 'hide-agents']],
];
const LOOK_CLASS: Record<string, string> = { highlight: 'ib-lk-pill', compact: 'ib-lk-compact', 'hide-agents': 'ib-lk-noagents' };
const LOOK_ROW: Record<string, string> = { highlight: 'highlight', compact: 'compact', 'hide-agents': 'hideAgents' };

async function setLook(context: BrowserContext, looks: string[]) {
  await context.clearCookies();
  await post('/api/inbox/settings', { rows: looks.map((c) => LOOK_ROW[c]!) });
}

interface PinGeometry {
  id: string;
  unread: boolean;
  line: string | null;
  pinLeft: number;
  pinRight: number;
  pinTop: number;
  lineRight: number;
  after: string[];
  nextLeft: number | null;
  gap: number;
  previewRight: number | null;
  m3Shown: boolean;
  tick: boolean;
  timeEnd: number;
  lastEnd: number;
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
          after: after.map((c) => (c.matches('[data-action-count]') ? 'action' : c.classList.contains('ib-qn') ? 'count' : c.classList.contains('ib-c') ? 'words' : c.className.split(' ')[0]!)),
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

function expectPinsRight(rows: PinGeometry[], shape: Shape, label: string) {
  const at = (id: string) => rows.find((r) => r.id === id)!;
  for (const r of rows) {
    const name = `${label}: row ${nameOf(r.id)}`;
    if (r.previewRight !== null) expect(r.pinLeft, `${name}: the pin follows the preview`).toBeGreaterThanOrEqual(r.previewRight - 0.5);
    if (wideShape(shape)) {
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
      expect(r.line, `${name}: the pin on line 1`).toBe('ib-m1');
      expect(r.after, `${name}: the time after the pin`).toEqual(['ib-t']);
      expect(Math.abs(r.nextLeft! - r.gap - r.pinRight), `${name}: one gap before the time`).toBeLessThanOrEqual(0.5);
      expect(r.m3Shown, `${name}: no line 3 for the pin alone`).toBe(false);
      continue;
    }
    expect(r.line, `${name}: the pin's line`).toBe(shape === 'narrow' ? 'ib-l3' : 'ib-m3');
    if (r.nextLeft !== null) {
      expect(r.after.every((p) => ['action', 'count', 'words'].includes(p)), `${name}: after the pin: ${r.after}`).toBe(true);
      expect(r.gap, `${name}: the line's gap`).toBe(8);
      expect(Math.abs(r.nextLeft - r.gap - r.pinRight), `${name}: one gap before ${r.after[0]}`).toBeLessThanOrEqual(0.5);
    } else {
      expect(Math.abs(r.pinRight - r.lineRight), `${name}: on the line's right edge`).toBeLessThanOrEqual(0.5);
    }
    expect(r.lastEnd, `${name}: the line's last part ends on its edge`).toBeLessThanOrEqual(0.5);
  }
  for (const [a, b] of [[pins.short, pins.long], [pins.shortQ, pins.longQ]] as const) {
    expect(at(a).after, `${label}: the same trailing parts`).toEqual(at(b).after);
    expect(Math.abs(at(a).pinRight - at(b).pinRight), `${label}: a short and a long line put the pin at one x`).toBeLessThanOrEqual(0.5);
  }
  if (wideShape(shape)) expect(new Set(rows.map((r) => Math.round(r.pinRight))).size, `${label}: one x down the list`).toBe(1);
  const sent = at(pins.sent);
  expect(sent.tick, `${label}: the Sent row's ✓`).toBe(true);
  expect(sent.timeEnd, `${label}: the Sent row's time ends its line`).toBeLessThanOrEqual(0.5);
}

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

async function show(context: BrowserContext, page: Page, shape: Shape, cookies: string[]) {
  await setLook(context, cookies);
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
    for (const r of rows) if (r.id !== pins.sent) expect(r.unread, `${label}: ${nameOf(r.id)}`).toBe(state === 'unread');
    expectPinsRight(rows, shape, label);
    const bare = rows.find((r) => r.id === pins.bare)!;
    if (shape === 'phone') expect(bare.line, `${label}: the bare row's pin line`).toBe(state === 'unread' ? 'ib-m1' : 'ib-m3');
    for (const r of rows) if (r.id !== pins.bare) expect(r.line, `${label}: ${nameOf(r.id)}: only the bare row keeps its pin on line 1`).not.toBe('ib-m1');
    if (wideShape(shape)) {
      const cq = await expectWideGrid(page, label);
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
      await setLook(context, cookies);
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
