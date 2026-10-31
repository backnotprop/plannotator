/**
 * The list's look options (approval "inbox-list-options", 2026-10-30; packages/inbox/listLook.ts), proved in a real
 * Chromium against the compiled binary under a temp HOME and PLANNOTATOR_DATA_DIR; agents write through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts). Nothing is mocked.
 *
 *  - Beside an open thread, by mouse: the ⋮ menu's four checkboxes start unchecked and the list is today's. Each
 *    one, ticked, changes the rows at once and leaves the menu open: the title in its pill on one line; compact rows
 *    about 20 px shorter, the title on line 1, the project cut first (down to its floor), the time never; no agents'
 *    tiles at the same height. A reload keeps all three. Sent and pinned rows keep their marks; a wider column too.
 *  - By keyboard: Enter opens the menu, the arrows reach an option, Space and Enter tick it, the menu stays open,
 *    Escape closes it and gives focus back to ⋮.
 *  - The wide one-line list: the title in its pill, compact changes nothing, the marks go; in one project's list
 *    the title takes the agents' column.
 *  - A 390 px phone, from the ⋮ sheet: compact rows on two lines, the time never cut.
 *  - A 320 px phone with the worst rows (a long project with a long name: unread, pinned, Sent): compact keeps
 *    about ten characters of each name visible (the project's floor drops on a narrow phone), the time never cut.
 *  - With the agents' icons hidden, Chromium's accessibility tree still names them on every shape (a display: none
 *    would drop them).
 *  - Smaller thread names: an unread name at the read size (13.5 px beside a thread, 14 px on a phone), still bold,
 *    in its pill too; read rows, Sent rows and the wide one-line row are the same with it on or off; off is today's
 *    bigger unread name (15 px, 16 px on a phone); a reload keeps it.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-list-options.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_PROOF_DIR/list-options, or .local/proof/list-options/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'list-options');

const LONG_PROJECT = 'northwind-industries-reconciliation-platform';

let url = '';
let agents: SimAgent[] = [];
let post: (path: string, body: object) => Promise<void> = async () => {};
let say: (agent: SimAgent, name: string, thread: string, subject: string, body: string) => Promise<string> = async () => '';
const threads = { ledger: '', token: '', rate: '', spacing: '', opened: '', csv: '', refund: '', release: '' };
const projectIds: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-list-options-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  rememberInboxOf(dataDir);
  for (const [name, host] of [['Claude Code', 'claude-code'], ['Codex', 'codex'], ['Pi', 'pi'], ['OpenCode', 'opencode']]) agents.push(await SimAgent.connect({ binary, env, name, host }));
  const [claude, codex, pi, opencode] = agents;
  const src = join(root, 'src');
  const project = (name: string) => scratchProject(src, name);
  const ask = (q: string) => [':::question', q, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
  say = async (agent: SimAgent, name: string, thread: string, subject: string, body: string) => (await agent.send({ project_path: project(name), thread, subject, body })).thread_id;
  // The approved pictures' rows: a long project with a long name, short projects, a long name that wraps today.
  threads.release = await say(pi!, 'plannotator', 'Release 0.28.41', 'Release notes for 0.28.41: check the contributor credits', 'Release notes are drafted.');
  threads.refund = await say(claude!, 'billing-svc', 'Refund events', 'Trust the webhook or poll Stripe every 10 minutes?', 'Webhook or poll.');
  threads.csv = await say(codex!, LONG_PROJECT, 'CSV export', 'Approve the CSV column order for the finance export', 'Column order attached.');
  threads.opened = await say(claude!, 'plannotator', 'Thread items again', 'The list shows the subject in bold and the thread name as a pill', ask('Which row should I build?'));
  await codex!.send({ project_path: project('plannotator'), reply_to: threads.opened, body: 'Codex: I drew the phone rows.' });
  threads.spacing = await say(codex!, 'design-system-tokens', 'Spacing scale', 'Drop the 6 px step from the spacing scale?', ask('Drop the 6 px step?'));
  threads.rate = await say(pi!, 'api', 'Raise the batch import rate limit before the Friday migration window opens', 'The import hits 429s at 400 requests a minute', ask('Raise it to 800?'));
  threads.token = await say(claude!, 'workspaces-cli', 'Token refresh', 'Token refresh fails after the laptop sleeps: pick a retry', ask('Retry on wake?'));
  threads.ledger = await say(claude!, LONG_PROJECT, 'Ledger reconciliation dry run for the quarter-end close across every subsidiary', 'Dry run the ledger reconciliation against last quarter', ask('Run it tonight?'));
  for (const agent of [codex!, pi!, opencode!]) await agent.send({ project_path: project(LONG_PROJECT), reply_to: threads.ledger, body: `${agent.name} checked its part.` });
  expect(new Set(Object.values(threads)).size, 'eight threads').toBe(8);
  // Read rows (the Quiet ones and the open thread), a Sent row (the person replied to Refund events), a pin.
  const health = (await (await fetch(new URL('/api/inbox/health', url))).json()) as { serverSession: string };
  post = async (path: string, body: object) => {
    const res = await fetch(new URL(path, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, serverSession: health.serverSession }) });
    expect(res.ok, `${path}: ${res.status} ${await res.text()}`).toBe(true);
  };
  for (const id of [threads.csv, threads.release, threads.opened]) await post(`/api/inbox/threads/${id}/read`, {});
  await post(`/api/inbox/messages/${threads.refund}/reply`, { idempotency_key: 'list-options-sent', words: 'Poll every 10 minutes for now.', questions: [] });
  await post(`/api/inbox/threads/${threads.token}/pin`, { pinned: true });
  const model = (await (await fetch(new URL('/api/inbox/projects', url))).json()) as { projects: { id: string; name: string }[] };
  for (const p of model.projects) projectIds[p.name] = p.id;
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    agents = [];
  } finally {
    await removeInboxScratch();
  }
});

const desktop = (browser: Browser, width = 1440): Promise<BrowserContext> => browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });

async function openQuiet(page: Page) {
  const band = page.locator('.ib-lbody [data-section-id="quiet"] button.ib-band');
  if ((await band.getAttribute('aria-expanded')) !== 'true') await band.click();
  await expect(band).toHaveAttribute('aria-expanded', 'true');
}

async function lookClasses(page: Page): Promise<string[]> {
  return page.locator('.ib-listcol').evaluate((el) => [...el.classList].filter((c) => c.startsWith('ib-lk-')));
}

const option = (page: Page, key: string) => page.locator(`[data-tidy-menu-popup] [data-list-look="${key}"]`);

/** The Ledger row's agents, as the accessibility tree names them (its first message and three replies). */
const LEDGER_AGENTS = 'img "Claude Code, Codex, Pi and OpenCode"';

/** With the icons hidden, a screen reader still hears who: the row's accessibility tree keeps the agents. */
async function agentsAnnounced(page: Page, rowClass: string) {
  const snapshot = await page.locator(`.ib-lbody .${rowClass}[data-thread-id="${threads.ledger}"]`).ariaSnapshot();
  expect(snapshot, 'the agents are still in the accessibility tree').toContain(LEDGER_AGENTS);
}

interface Geometry {
  h: number;
  lines: string[];
  title: { inL1: boolean; pill: boolean; cut: boolean; h: number; right: number };
  project: { w: number; cut: boolean } | null;
  tiles: number;
  time: { cut: boolean; left: number; right: number };
  rowRight: number;
  rowLeft: number;
  projectLeft: number | null;
}

/** A row's measured shape: its height, its lines, its title, project, tiles and time. */
async function geometry(page: Page, rowClass: string, id: string): Promise<Geometry> {
  return page.evaluate(
    ([rowClass, id]) => {
      const row = document.querySelector<HTMLElement>(`.ib-lbody .${rowClass}[data-thread-id="${id}"]`)!;
      const box = (el: Element) => el.getBoundingClientRect();
      const cut = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 0.5;
      const title = row.querySelector<HTMLElement>('.ib-title, .ib-m2')!;
      const l1 = row.querySelector<HTMLElement>('.ib-l1, .ib-m1')!;
      const p = row.querySelector<HTMLElement>('.ib-p');
      const tiles = row.querySelector<HTMLElement>('.ib-atiles');
      const time = row.querySelector<HTMLElement>('.ib-t')!;
      const timeText = time.querySelector<HTMLElement>('.ib-tickt') ?? time;
      const style = getComputedStyle(row);
      return {
        h: box(row).height,
        lines: [...row.children].filter((c) => !c.classList.contains('ib-sr')).map((c) => c.className),
        title: { inL1: l1.contains(title), pill: !!title.closest('.ib-rowkey'), cut: cut(title), h: box(title).height, right: box(title.closest('.ib-rowkey') ?? title).right },
        project: p ? { w: box(p).width, cut: cut(p) } : null,
        tiles: tiles ? box(tiles).width : 0,
        time: { cut: cut(time) || cut(timeText), left: box(time).left, right: box(time).right },
        rowRight: box(row).right - parseFloat(style.paddingRight),
        rowLeft: box(row).left + parseFloat(style.paddingLeft),
        projectLeft: p ? box(p).left : null,
      };
    },
    [rowClass, id] as const,
  );
}

async function all(page: Page, rowClass: string): Promise<Record<string, Geometry>> {
  const out: Record<string, Geometry> = {};
  for (const [name, id] of Object.entries(threads)) if (await page.locator(`.ib-lbody .${rowClass}[data-thread-id="${id}"]`).count()) out[name] = await geometry(page, rowClass, id);
  return out;
}

/** The time is whole and inside its row, after the title: it never gives way. */
function timeWhole(g: Geometry, name: string) {
  expect(g.time.cut, `${name}: time cut`).toBe(false);
  expect(g.time.right, `${name}: time inside the row`).toBeLessThanOrEqual(g.rowRight + 0.5);
  if (g.title.inL1) expect(g.title.right, `${name}: title before the time`).toBeLessThanOrEqual(g.time.left);
}

test('beside a thread, by mouse: each option changes the rows at once, keeps the menu open, and survives a reload', async ({ browser }) => {
  const context = await desktop(browser);
  try {
    const page = await context.newPage();
    await page.goto(`${url}#thread=${threads.opened}`);
    await expect(page.locator(`.ib-nrow[data-thread-id="${threads.ledger}"]`)).toBeVisible();
    await openQuiet(page);
    await page.evaluate(() => document.fonts.ready);

    // Today's list: no option on, three lines, the title plain on its own line.
    expect(await lookClasses(page)).toEqual([]);
    const today = await all(page, 'ib-nrow');
    for (const [name, g] of Object.entries(today)) {
      expect(g.title.inL1 || g.title.pill, `${name}: today's title`).toBe(false);
      expect(g.tiles, `${name}: tiles`).toBeGreaterThan(15);
    }
    expect(today.ledger!.title.h, 'the long name wraps today').toBeGreaterThan(30);

    await page.locator('[data-tidy-menu]').click();
    await expect(page.locator('[data-tidy-menu-popup] [role="menuitemcheckbox"]')).toHaveText(['Highlight thread subject', 'Compact rows', 'Hide agent icons', 'Smaller thread names']);
    for (const key of ['highlight', 'compact', 'hideAgents', 'smallNames']) await expect(option(page, key)).toHaveAttribute('aria-checked', 'false');
    await page.screenshot({ path: join(proofDir, 'menu-open.png') });

    // Highlight thread subject: the title in its pill, one line, cut with "…"; the menu stays open.
    await option(page, 'highlight').click();
    await expect(option(page, 'highlight')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-tidy-menu-popup]')).toBeVisible();
    expect(await lookClasses(page)).toEqual(['ib-lk-pill']);
    const pill = await all(page, 'ib-nrow');
    for (const [name, g] of Object.entries(pill)) {
      expect(g.title.pill, `${name}: in its pill`).toBe(true);
      expect(g.title.h, `${name}: one line`).toBeLessThan(25);
    }
    expect(pill.ledger!.title.cut, 'a long name is cut').toBe(true);
    const fill = await page.locator(`.ib-nrow[data-thread-id="${threads.token}"] .ib-rowkey`).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(fill, 'the pill has its fill').not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

    // Compact rows: two lines, about 20 px shorter; the project gives way first, the time never.
    await option(page, 'compact').click();
    await expect(option(page, 'compact')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.ib-lbody .ib-l2')).toHaveCount(0);
    const compact = await all(page, 'ib-nrow');
    for (const [name, g] of Object.entries(compact)) {
      expect(g.title.inL1, `${name}: title on line 1`).toBe(true);
      expect(pill[name]!.h - g.h, `${name}: about 20 px shorter`).toBeGreaterThanOrEqual(16);
      expect(pill[name]!.h - g.h, `${name}: about 20 px shorter`).toBeLessThanOrEqual(24);
      timeWhole(g, name);
    }
    // Long project, long name: the project is cut to its floor (136 px with its tiles), then the name.
    expect(compact.ledger!.project).toMatchObject({ cut: true });
    expect(compact.ledger!.project!.w + compact.ledger!.tiles + 6).toBeGreaterThanOrEqual(135);
    expect(compact.ledger!.title.cut).toBe(true);
    // A short project and a short name: nothing is cut.
    for (const name of ['token', 'refund', 'release']) expect([compact[name]!.project!.cut, compact[name]!.title.cut], name).toEqual([false, false]);
    // A Sent row keeps its words on line 2; a pinned row its pin.
    await expect(page.locator(`.ib-lbody [data-section-id="sent"] .ib-nrow[data-thread-id="${threads.refund}"] .ib-l1 .ib-title`)).toBeVisible();
    await expect(page.locator(`.ib-nrow[data-thread-id="${threads.token}"] [data-pin-mark]`)).toBeVisible();

    // Hide agent icons: no tiles, the project starts the row, the height is kept; a screen reader still hears who.
    await option(page, 'hideAgents').click();
    await expect(option(page, 'hideAgents')).toHaveAttribute('aria-checked', 'true');
    const hidden = await all(page, 'ib-nrow');
    for (const [name, g] of Object.entries(hidden)) {
      expect(g.tiles, `${name}: no tiles`).toBeLessThanOrEqual(1);
      expect(Math.abs(g.projectLeft! - g.rowLeft), `${name}: the project starts the row`).toBeLessThan(1);
      expect(Math.abs(g.h - compact[name]!.h), `${name}: same height`).toBeLessThan(0.5);
      timeWhole(g, name);
    }
    await agentsAnnounced(page, 'ib-nrow');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-tidy-menu-popup]')).toHaveCount(0);
    await page.screenshot({ path: join(proofDir, 'all-three.png') });

    // A reload keeps all three.
    await page.reload();
    await expect(page.locator(`.ib-nrow[data-thread-id="${threads.ledger}"]`)).toBeVisible();
    expect(await lookClasses(page)).toEqual(['ib-lk-pill', 'ib-lk-compact', 'ib-lk-noagents']);
    await expect(page.locator('.ib-lbody .ib-l2')).toHaveCount(0);
    await page.locator('[data-tidy-menu]').click();
    for (const key of ['highlight', 'compact', 'hideAgents']) await expect(option(page, key)).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');

    // A wider column (still under the wide rows' 900 px): nothing is cut on the short rows, the time still whole.
    await context.addCookies([{ name: 'plannotator-inbox-list-width', value: '760', url }]);
    await page.reload();
    await openQuiet(page);
    await expect(page.locator(`.ib-nrow[data-thread-id="${threads.ledger}"]`)).toBeVisible();
    const wider = await all(page, 'ib-nrow');
    for (const [name, g] of Object.entries(wider)) timeWhole(g, name);
    for (const name of ['token', 'spacing', 'opened', 'csv', 'refund', 'release']) expect([wider[name]!.project!.cut, wider[name]!.title.cut], name).toEqual([false, false]);
    await page.screenshot({ path: join(proofDir, 'all-three-wider.png') });
  } finally {
    await context.close();
  }
});

test('by keyboard: Enter opens ⋮, the arrows reach an option, Space and Enter tick it, Escape gives focus back', async ({ browser }) => {
  const context = await desktop(browser);
  try {
    const page = await context.newPage();
    await page.goto(`${url}#thread=${threads.opened}`);
    await expect(page.locator(`.ib-nrow[data-thread-id="${threads.ledger}"]`)).toBeVisible();
    // A fresh browser: today's list.
    expect(await lookClasses(page)).toEqual([]);
    const trigger = page.locator('[data-tidy-menu]');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-tidy-menu-popup]')).toBeVisible();
    const highlighted = () => page.locator('[data-tidy-menu-popup] [data-highlighted]').getAttribute('data-list-look');
    for (let i = 0; i < 8 && (await highlighted()) !== 'compact'; i++) await page.keyboard.press('ArrowDown');
    expect(await highlighted()).toBe('compact');
    await page.keyboard.press(' ');
    await expect(option(page, 'compact')).toHaveAttribute('aria-checked', 'true');
    expect(await lookClasses(page)).toEqual(['ib-lk-compact']);
    await page.keyboard.press('ArrowDown');
    expect(await highlighted()).toBe('hideAgents');
    await page.keyboard.press('Enter');
    await expect(option(page, 'hideAgents')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-tidy-menu-popup]')).toBeVisible();
    // Space again unticks.
    await page.keyboard.press(' ');
    await expect(option(page, 'hideAgents')).toHaveAttribute('aria-checked', 'false');
    expect(await lookClasses(page)).toEqual(['ib-lk-compact']);
    // The fourth option, the last one, by the arrows too.
    await page.keyboard.press('ArrowDown');
    expect(await highlighted()).toBe('smallNames');
    await page.keyboard.press(' ');
    await expect(option(page, 'smallNames')).toHaveAttribute('aria-checked', 'true');
    expect(await lookClasses(page)).toEqual(['ib-lk-compact', 'ib-lk-small']);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-tidy-menu-popup]')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await context.close();
  }
});

/** A row's name as drawn: its size, weight and tracking. */
async function nameFont(page: Page, rowClass: string, id: string): Promise<{ size: string; weight: string; spacing: string }> {
  return page.locator(`.ib-lbody .${rowClass}[data-thread-id="${id}"]`).first().evaluate((row) => {
    const name = row.querySelector<HTMLElement>('.ib-title, .ib-m2')!;
    const style = getComputedStyle(name);
    return { size: style.fontSize, weight: style.fontWeight, spacing: style.letterSpacing };
  });
}

test('smaller thread names: unread names at the read size, still bold; read, Sent and wide rows the same; off is today\'s', async ({ browser }) => {
  const shapes = [
    { name: 'beside a thread', rowClass: 'ib-nrow', ctx: () => desktop(browser), go: `#thread=${threads.opened}`, big: '15px', small: '13.5px' },
    { name: 'a phone', rowClass: 'ib-mrow', ctx: () => browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce' }), go: '', big: '16px', small: '14px' },
  ];
  for (const shape of shapes) {
    const context = await shape.ctx();
    try {
      const page = await context.newPage();
      await page.goto(`${url}${shape.go}`);
      await expect(page.locator(`.ib-lbody .${shape.rowClass}[data-thread-id="${threads.ledger}"]`)).toBeVisible();
      await openQuiet(page);
      // Off (a fresh browser): today's bigger unread name; a read row (CSV export) and a Sent row (Refund events) at the read size.
      const unread = await nameFont(page, shape.rowClass, threads.ledger);
      const read = await nameFont(page, shape.rowClass, threads.csv);
      const sent = await nameFont(page, shape.rowClass, threads.refund);
      expect(unread, `${shape.name}: today's unread name`).toMatchObject({ size: shape.big, weight: '600' });
      expect(read.size, `${shape.name}: a read name`).toBe(shape.small);
      await page.mouse.move(1, 1);
      await page.screenshot({ path: join(proofDir, `small-names-off-${shape.rowClass}.png`) });

      await page.locator('[data-tidy-menu]').click();
      await option(page, 'smallNames').click();
      await expect(option(page, 'smallNames')).toHaveAttribute('aria-checked', 'true');
      await expect(page.locator('[data-tidy-menu-popup]')).toBeVisible();
      expect(await lookClasses(page)).toEqual(['ib-lk-small']);
      // On: the unread name drops to the read size, still bold; read and Sent rows unchanged.
      expect(await nameFont(page, shape.rowClass, threads.ledger), `${shape.name}: smaller unread name`).toEqual({ size: shape.small, weight: '600', spacing: 'normal' });
      expect(await nameFont(page, shape.rowClass, threads.csv)).toEqual(read);
      expect(await nameFont(page, shape.rowClass, threads.refund)).toEqual(sent);
      // In its pill too.
      await option(page, 'highlight').click();
      await expect(page.locator(`.ib-lbody .${shape.rowClass}[data-thread-id="${threads.ledger}"] .ib-rowkey`)).toBeVisible();
      expect((await nameFont(page, shape.rowClass, threads.ledger)).size, `${shape.name}: in its pill`).toBe(shape.small);
      await option(page, 'highlight').click();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-tidy-menu-popup]')).toHaveCount(0);
      await page.mouse.move(1, 1);
      await page.screenshot({ path: join(proofDir, `small-names-on-${shape.rowClass}.png`) });
      // A reload keeps it; turned off, today's again.
      await page.reload();
      await expect(page.locator(`.ib-lbody .${shape.rowClass}[data-thread-id="${threads.ledger}"]`)).toBeVisible();
      expect(await lookClasses(page)).toEqual(['ib-lk-small']);
      expect((await nameFont(page, shape.rowClass, threads.ledger)).size).toBe(shape.small);
      await page.locator('[data-tidy-menu]').click();
      await option(page, 'smallNames').click();
      await expect(option(page, 'smallNames')).toHaveAttribute('aria-checked', 'false');
      expect(await nameFont(page, shape.rowClass, threads.ledger)).toEqual(unread);
    } finally {
      await context.close();
    }
  }

  // The wide one-line list was never bigger: the same with it on.
  const context = await desktop(browser);
  try {
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator(`.ib-row[data-thread-id="${threads.ledger}"]`)).toBeVisible();
    const before = await nameFont(page, 'ib-row', threads.ledger);
    await context.addCookies([{ name: 'plannotator-inbox-list-small-names', value: '1', url }]);
    await page.reload();
    await expect(page.locator(`.ib-row[data-thread-id="${threads.ledger}"]`)).toBeVisible();
    expect(await lookClasses(page)).toEqual(['ib-lk-small']);
    expect(await nameFont(page, 'ib-row', threads.ledger)).toEqual(before);
  } finally {
    await context.close();
  }
});

test('the wide one-line list: the pill, compact changes nothing, the marks go; one project\'s list gives their column to the title', async ({ browser }) => {
  const context = await desktop(browser);
  try {
    const page = await context.newPage();
    await page.goto(url);
    const ledger = page.locator(`.ib-row[data-thread-id="${threads.ledger}"]`);
    await expect(ledger).toBeVisible();
    const before = (await ledger.boundingBox())!.height;
    await page.locator('[data-tidy-menu]').click();
    await option(page, 'highlight').click();
    await option(page, 'compact').click();
    await option(page, 'hideAgents').click();
    await page.keyboard.press('Escape');
    await expect(page.locator(`.ib-row[data-thread-id="${threads.ledger}"] .ib-subj > .ib-rowkey > .ib-title`)).toBeVisible();
    expect((await ledger.boundingBox())!.height).toBe(before);
    expect((await page.locator(`.ib-row[data-thread-id="${threads.ledger}"] .ib-ags`).boundingBox())!.width).toBeLessThanOrEqual(1);
    await agentsAnnounced(page, 'ib-row');
    await page.screenshot({ path: join(proofDir, 'wide-all-three.png') });

    // One project's list: the agents were its whole first cell; the title takes that column.
    expect(projectIds[LONG_PROJECT], 'the long project').toBeTruthy();
    await page.goto(`${url}#project=${projectIds[LONG_PROJECT]}`);
    const row = page.locator(`.ib-row[data-thread-id="${threads.ledger}"]`);
    await expect(row).toBeVisible();
    const [rowBox, pillBox] = await Promise.all([row.boundingBox(), page.locator(`.ib-row[data-thread-id="${threads.ledger}"] .ib-rowkey`).boundingBox()]);
    expect(pillBox!.x - rowBox!.x).toBeLessThan(13);
    await page.screenshot({ path: join(proofDir, 'wide-one-project.png') });
  } finally {
    await context.close();
  }
});

test('a 390 px phone, from the ⋮ sheet: compact rows on two lines, the time never cut', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator(`.ib-mrow[data-thread-id="${threads.ledger}"]`)).toBeVisible();
    await openQuiet(page);
    const today = await all(page, 'ib-mrow');
    await page.locator('[data-tidy-menu]').click();
    for (const key of ['highlight', 'compact', 'hideAgents']) {
      await option(page, key).click();
      await expect(option(page, key)).toHaveAttribute('aria-checked', 'true');
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-tidy-menu-popup]')).toHaveCount(0);
    const compact = await all(page, 'ib-mrow');
    for (const [name, g] of Object.entries(compact)) {
      expect(g.title.inL1 && g.title.pill, `${name}: the pill on line 1`).toBe(true);
      expect(g.lines, `${name}: two lines`).toEqual(['ib-m1', 'ib-m3']);
      expect(g.h, `${name}: shorter`).toBeLessThan(today[name]!.h - 10);
      timeWhole(g, name);
    }
    expect(compact.ledger!.project!.cut).toBe(true);
    expect(compact.ledger!.project!.w).toBeGreaterThanOrEqual(135);
    await agentsAnnounced(page, 'ib-mrow');
    await page.screenshot({ path: join(proofDir, 'phone-all-three.png') });
    await page.reload();
    await expect(page.locator(`.ib-mrow[data-thread-id="${threads.ledger}"] .ib-m1 .ib-rowkey`)).toBeVisible();
  } finally {
    await context.close();
  }
});

/** How many of a row's title characters show whole before its "…" (the title is one text node). */
async function shownChars(page: Page, id: string): Promise<{ shown: number; length: number }> {
  return page.locator(`.ib-lbody .ib-mrow[data-thread-id="${id}"] .ib-m2`).evaluate((el) => {
    const text = el.firstChild as Text;
    // The cut text's room, less the "…" (about 6 px at this size).
    const edge = el.getBoundingClientRect().left + el.clientWidth - (el.scrollWidth > el.clientWidth + 0.5 ? 6 : 0) + 0.5;
    const range = document.createRange();
    let shown = 0;
    for (; shown < text.length; shown++) {
      range.setStart(text, shown);
      range.setEnd(text, shown + 1);
      if (range.getBoundingClientRect().right > edge) break;
    }
    return { shown, length: text.length };
  });
}

test('a 320 px phone with the worst rows: compact keeps about ten characters of each name, the time whole', async ({ browser }) => {
  // The worst rows: a long project with a long name, unread (Ledger), pinned, and Sent.
  const [claude, codex] = agents;
  const vendor = await say(claude!, LONG_PROJECT, 'Pinned vendor invoices waiting on the accounts payable sign-off', 'Vendor invoices are waiting', 'Sign off today?');
  const audit = await say(codex!, LONG_PROJECT, 'Superseded audit trail entries from the old ledger importer', 'Old audit entries', 'Delete them?');
  await post(`/api/inbox/threads/${vendor}/pin`, { pinned: true });
  await post(`/api/inbox/messages/${audit}/reply`, { idempotency_key: 'list-options-sent-320', words: 'Keep them for a year.', questions: [] });
  const hard = { ledger: threads.ledger, vendor, audit, rate: threads.rate };

  const context = await browser.newContext({ viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    const looks: [string, string[]][] = [
      ['compact', ['compact']],
      ['all-three', ['highlight', 'compact', 'hide-agents']],
    ];
    for (const [shot, cookies] of looks) {
      await context.clearCookies();
      await context.addCookies(cookies.map((c) => ({ name: `plannotator-inbox-list-${c}`, value: '1', url })));
      await page.goto(url);
      await expect(page.locator(`.ib-mrow[data-thread-id="${vendor}"]`)).toBeVisible();
      await expect(page.locator(`.ib-lbody .ib-mrow[data-thread-id="${vendor}"] [data-pin-mark]`)).toBeVisible();
      await expect(page.locator(`.ib-lbody [data-section-id="sent"] .ib-mrow[data-thread-id="${audit}"]`)).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      for (const [name, id] of Object.entries(hard)) {
        const g = await geometry(page, 'ib-mrow', id);
        expect(g.lines, `${shot} ${name}: two lines`).toEqual(['ib-m1', 'ib-m3']);
        expect(g.title.inL1, `${shot} ${name}: the title on line 1`).toBe(true);
        timeWhole(g, `${shot} ${name}`);
        const { shown, length } = await shownChars(page, id);
        expect(shown, `${shot} ${name}: about ten characters of "${length}" show`).toBeGreaterThanOrEqual(Math.min(10, length));
        // The long project still gives way first: it is cut before the title.
        if (name !== 'rate') expect(g.project?.cut, `${shot} ${name}: the project gives way first`).toBe(true);
      }
      if (cookies.includes('hide-agents')) await agentsAnnounced(page, 'ib-mrow');
      await page.screenshot({ path: join(proofDir, `phone-320-${shot}.png`) });
    }
  } finally {
    await context.close();
  }
});
