/**
 * The Board's one filter (approval "board-initiatives", take C; its project
 * part the owner's pick 2026-10-28) in a real browser against the compiled
 * binary, agents writing cards through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts), in eight projects (one with a long name), and a
 * scripted `gh` first on PATH:
 *
 *  - no filter: `#board` is today's Board, every card, the filter icon alone;
 *  - picking a project from the keyboard: `#board&project=prj_…`, the lanes
 *    (the Done lane too) and the All done page narrowed, the project's name
 *    as a token; Back undoes the pick; a reload keeps it;
 *  - initiatives: made from the filter menu, set on a card from its
 *    right-click menu and from the opened card, the menu's counts (No
 *    initiative too), `&initiative=` with the project, kept through a card's
 *    thread and back, New card starting in it, deleted (its cards back in No
 *    initiative, the filter gone);
 *  - opening a card, then its thread, then the way back: the same filtered
 *    Board;
 *  - New card opens on the filtered project;
 *  - a project with nothing in flight: the line and Show all projects;
 *  - an empty or unknown project in the address: no filter;
 *  - a filtered visit never records the look: another project's news stays
 *    bold for the next visit that shows every project;
 *  - a narrow window: the button on its own row; a long name whole;
 *  - an iPhone in WebKit: the button under the header, its menu a sheet at
 *    the bottom edge.
 *
 * Screenshots land in PLANNOTATOR_BOARD_FILTER_SHOTS (default /tmp/board-filter-built).
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { fakeForge } from './fake-forge';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_BOARD_FILTER_SHOTS ?? '/tmp/board-filter-built');
const LONG = 'customer-onboarding-analytics-pipeline-q4-migration';

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  ids: Record<string, string>;
  /** Project ids by name. */
  project: Record<string, string>;
  /** Project folders by name. */
  paths: Record<string, string>;
}

let world: World;

test.describe.configure({ mode: 'serial' });

const cardEl = (page: Page, id: string) => page.locator(`.ib-bcard[data-card-id="${id}"]`);
const filterButton = (page: Page) => page.locator('[data-board-filter-button]');
/** A token's words (the picked project's or initiative's name), or null when none of that kind is picked. */
const tokenWords = async (page: Page, kind: 'project' | 'initiative') => {
  const token = page.locator(`[data-board-filter-token="${kind}"] .ib-bflt-tok-l`);
  return (await token.count()) === 0 ? null : token.textContent();
};
const hashOf = (page: Page) => page.evaluate(() => window.location.hash);

async function shot(page: Page, name: string, keepFocus = false) {
  if (!keepFocus) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(5, 5);
  }
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(shots, name) });
}

async function both(page: Page, name: string, keepFocus = false) {
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(page, `${name}-light.png`, keepFocus);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, `${name}-dark.png`, keepFocus);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The Board as the server has it: the person's last look and the store's cursor. */
const boardSeen = (page: Page) =>
  page.evaluate(async () => {
    const board = (await (await fetch('/api/inbox/cards')).json()) as { seen_seq?: number | null; cursor: number };
    return { seen: board.seen_seq ?? null, cursor: board.cursor };
  });

/** Arrow down the open filter menu until `target` is highlighted (Base UI's menu keys; no shortcut of its own). */
async function arrowTo(page: Page, target: string) {
  for (let i = 0; i < 30; i++) {
    if ((await page.locator(target).getAttribute('data-highlighted')) !== null) return;
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`never highlighted: ${target}`);
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-board-filter-e2e-');
  const forge = fakeForge(join(root, 'bin'));
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  // The Board on, its first-visit dialog already seen (inbox-board.spec.ts proves both).
  writeFileSync(join(data, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, inboxBoard: true, inboxBoardIntro: { shownAt: new Date().toISOString() } }));
  const env = { PATH: `${forge.dir}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: data, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const src = join(root, 'src');
  const names = ['plannotator', 'workspaces', 'machine', LONG, 'guides-repo', 'pando', 'halftone', 'relay'];
  const paths = Object.fromEntries(names.map((name) => [name, scratchProject(src, name)]));
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  // A card call never makes a project: a message does.
  const ticks = await claude.send({ project_path: paths.plannotator, subject: 'Delivery ticks: screenshots before merge', thread: 'ticks', body: 'Ticks are drawn on Sent rows.' });
  const design = await codex.send({ project_path: paths.workspaces, subject: 'Design system notes', thread: 'design', body: 'Notes are up.' });
  await pi.send({ project_path: paths.machine, subject: 'Session list store', body: 'Writing the store.' });
  await claude.send({ project_path: paths[LONG], subject: 'Pipeline migration plan', body: 'Plan drafted.' });
  await codex.send({ project_path: paths['guides-repo'], subject: 'Guides landing copy', body: 'Copy drafted.' });
  await claude.send({ project_path: paths.pando, subject: 'Pando sync', body: 'Synced.' });
  await pi.send({ project_path: paths.halftone, subject: 'Halftone tokens', body: 'Tokens.' });
  await codex.send({ project_path: paths.relay, subject: 'Relay keepalive', body: 'Keepalive.' });
  const make = async (agent: SimAgent, project: string, title: string, fields: Record<string, unknown> = {}) =>
    ((await agent.card({ op: 'create', project_path: project, title, ...fields })).card as { id: string }).id;
  const ids: Record<string, string> = {};
  ids.auto = await make(claude, paths.plannotator, 'Auto-update for users');
  ids.company = await make(claude, paths.plannotator, 'Company agents and approvals', { column: 'in_progress' });
  ids.hero = await make(claude, paths.plannotator, 'Hero scene timers', { column: 'in_progress' });
  ids.address = await make(claude, paths.plannotator, 'One fixed Inbox address', { column: 'in_review', you: 'Pick a dialog (two options)' });
  ids.ticks = await make(claude, paths.plannotator, 'Delivery ticks', { column: 'in_review', you: 'Merge #14', thread_id: ticks.thread_id });
  ids.filter = await make(claude, paths.plannotator, 'Board project filter', { column: 'in_progress' });
  ids.tab = await make(claude, paths.plannotator, 'Unread count on the tab', { column: 'done' });
  ids.design = await make(codex, paths.workspaces, 'A design system like Linear’s', { column: 'in_review', you: 'Answer 11 questions', thread_id: design.thread_id });
  ids.tokens = await make(codex, paths.workspaces, 'Soft tokens for Workspaces', { column: 'in_progress' });
  ids.onboard = await make(codex, paths.workspaces, 'Workspaces onboarding');
  ids.wsDone = await make(codex, paths.workspaces, 'Workspaces colours', { column: 'done' });
  ids.poly = await make(pi, paths.machine, 'Polylane plan evaluation');
  ids.store = await make(pi, paths.machine, 'Session list store', { column: 'in_progress' });
  ids.long = await make(claude, paths[LONG], 'Warehouse cutover', { column: 'in_progress' });
  ids.landing = await make(codex, paths['guides-repo'], 'Landing copy', { column: 'done' });
  // Pando's one card is cancelled by the person: a project with nothing on the lanes (a card done this week would be on Done's lane).
  ids.pando = await make(claude, paths.pando, 'Pando sync idea');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = started.stdout.trim();
  await page.goto(url);
  await page.evaluate(async (id) => {
    const res = await fetch(`/api/inbox/cards/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'drop' }) });
    if (!res.ok) throw new Error(`drop: ${res.status}`);
  }, ids.pando);
  const listed = await page.evaluate(async () => ((await (await fetch('/api/inbox/projects')).json()).projects as { id: string; name: string }[]).map((p) => [p.name, p.id]));
  world = { url, agents: [claude, codex, pi], context, page, errors, ids, project: Object.fromEntries(listed), paths };
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

const ALL_IN_FLIGHT = 12;
/** On the lanes: those, and the three cards done this week on Done's lane. */
const ON_LANES = ALL_IN_FLIGHT + 3;

test('no filter: the Board as before, every card, the filter icon alone', async () => {
  const { page, ids } = world;
  await page.locator('[data-board-nav]').click();
  await expect(page.locator('[data-board-page][data-board-view="lanes"]')).toBeVisible();
  expect(await hashOf(page)).toBe('#board');
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(ON_LANES);
  // No counts in the header (owner, 2026-11-02): the lanes keep theirs.
  await expect(page.locator('[data-board-summary]')).toHaveCount(0);
  await expect(page.locator('.ib-blanes [data-lane="done"] .ib-lane-n')).toHaveText('3');
  await expect(page.locator('[data-board-link="done"]')).toHaveText('All done');
  await expect(page.locator('[data-board-link="cancelled"]')).toHaveText('Cancelled 1');
  await expect(filterButton(page)).toHaveAccessibleName('Filter');
  await expect(page.locator('[data-board-filter-token]')).toHaveCount(0);
  for (const id of [ids.auto, ids.design, ids.store, ids.long]) await expect(cardEl(page, id)).toBeVisible();
  await both(page, 'none-1440');
});

test('picking a project from the keyboard narrows the lanes (the Done lane too) and All done; Back undoes it; a reload keeps it', async () => {
  const { page, ids, project } = world;
  // Keyboard only: Tab-reachable, Enter opens, arrows move, Enter picks (Base UI's menu; no shortcut of its own).
  await filterButton(page).focus();
  await page.keyboard.press('Enter');
  const menu = page.locator('[data-board-filter-menu]');
  await expect(menu).toBeVisible();
  // Only projects with a card: halftone and relay have threads but no card.
  const options = menu.locator('[data-board-project-option] .ib-pmi-l');
  await expect(options).toHaveText(['All projects', 'plannotator', 'workspaces', 'machine', LONG, 'guides-repo', 'pando']);
  await expect(menu.locator('[data-board-project-option=""]')).toHaveAttribute('aria-checked', 'true');
  await both(page, 'menu-1440', true);
  await arrowTo(page, `[data-board-project-option="${project.workspaces}"]`);
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  // Focus back on the button.
  await expect(filterButton(page)).toBeFocused();

  expect(await hashOf(page)).toBe(`#board&project=${project.workspaces}`);
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(4);
  for (const id of [ids.design, ids.tokens, ids.onboard, ids.wsDone]) await expect(cardEl(page, id)).toBeVisible();
  await expect(cardEl(page, ids.auto)).toHaveCount(0);
  await expect(page.locator('.ib-blanes [data-lane="done"] .ib-lane-n')).toHaveText('1');
  // The name alone, no "in" (the owner, 2026-10-28), and ×.
  expect(await tokenWords(page, 'project')).toBe('workspaces');
  await expect(page.locator('[data-board-filter-clear="project"]')).toBeVisible();
  // The polite live region names the pick (its wording is free to change).
  await expect(page.locator('[data-board-live]')).toContainText('workspaces');
  await both(page, 'filtered-1440');

  // Done keeps the filter.
  await page.locator('[data-board-link="done"]').click();
  expect(await hashOf(page)).toBe(`#board=done&project=${project.workspaces}`);
  await expect(page.locator('.ib-bcard')).toHaveCount(1);
  await expect(cardEl(page, ids.wsDone)).toBeVisible();
  await page.goBack();
  expect(await hashOf(page)).toBe(`#board&project=${project.workspaces}`);

  // A reload keeps it (the address is the state; nothing is stored).
  await page.reload();
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(4);
  expect(await tokenWords(page, 'project')).toBe('workspaces');

  // Back undoes the pick: the Board shows every project again.
  await page.goBack();
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(ON_LANES);
  expect(await hashOf(page)).toBe('#board');
  await page.goForward();
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(4);
});

test('opening a card, then its thread, then the way back lands on the same filtered Board', async () => {
  const { page, ids, project } = world;
  await cardEl(page, ids.design).locator('[data-card-open]').click();
  const panel = page.locator(`[data-card-panel="${ids.design}"]`);
  await expect(panel).toBeVisible();
  expect(await hashOf(page)).toBe(`#board&project=${project.workspaces}&card=${ids.design}`);
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(4);
  await panel.locator('[data-card-thread]').first().click();
  await expect(page.locator('[data-thread-card]')).toBeVisible();
  expect(await hashOf(page)).toContain(`board-project=${project.workspaces}`);
  await page.locator('[data-thread-card]').click();
  await expect(panel).toBeVisible();
  expect(await hashOf(page)).toBe(`#board&project=${project.workspaces}&card=${ids.design}`);
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(4);
  expect(await tokenWords(page, 'project')).toBe('workspaces');
  await panel.locator('[data-card-close]').click();
  await expect(panel).toHaveCount(0);
  expect(await hashOf(page)).toBe(`#board&project=${project.workspaces}`);
});

test('New card opens on the filtered project', async () => {
  const { page, project } = world;
  await page.locator('[data-board-new]').click();
  const dialog = page.locator('dialog[data-dialog="new-card"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-new-card-project]')).toHaveAttribute('data-new-card-project', project.workspaces);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('initiatives: made from the filter, set from a card\'s menu and the opened card, counted, filtered with the project, kept through a thread, deleted', async () => {
  const { page, ids, project } = world;
  const cardsRead = () =>
    page.evaluate(async () => (await (await fetch('/api/inbox/cards')).json()) as { cards: { id: string; initiative: string | null }[]; initiatives: { id: string; name: string; deleted_at: string | null }[] });
  // Two made from the filter menu's New initiative….
  await filterButton(page).click();
  await page.locator('[data-board-initiative-new]').click();
  const dialog = page.locator('dialog[data-dialog="initiatives"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-initiative-new-name]')).toBeFocused();
  for (const name of ['Design system', 'Onboarding']) {
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect(dialog.locator('[data-initiative-name]')).toHaveCount(name === 'Design system' ? 1 : 2);
  }
  await dialog.locator('[data-initiatives-done]').click();
  await expect(dialog).toHaveCount(0);
  // The menu item that opened it is gone: focus lands on the filter button.
  await expect(filterButton(page)).toBeFocused();
  const made = (await cardsRead()).initiatives;
  expect(made.map((i) => i.name)).toEqual(['Design system', 'Onboarding']);
  const design = made[0]!.id;

  // From the card's right-click menu: Initiative ▸ Design system.
  await cardEl(page, ids.design).locator('[data-card-open]').click({ button: 'right' });
  await page.locator('[data-card-context-menu] [data-card-menu-action="initiative"]').hover();
  await page.locator(`[data-card-initiative-menu] [data-card-initiative-option="${design}"]`).click();
  await expect.poll(async () => (await cardsRead()).cards.find((c) => c.id === ids.design)?.initiative).toBe(design);
  // From the opened card: its who line's Initiative.
  await cardEl(page, ids.tokens).locator('[data-card-open]').click();
  const panel = page.locator(`[data-card-panel="${ids.tokens}"]`);
  await panel.locator('[data-card-initiative]').click();
  await page.locator(`[data-card-initiative-menu] [data-card-initiative-option="${design}"]`).click();
  await expect(panel.locator('[data-card-initiative]')).toHaveAttribute('data-card-initiative', design);
  await expect(panel.locator('.ib-crdp-hist')).toContainText('Initiative: Design system by you');
  await panel.locator('[data-card-close]').click();

  // The menu counts workspaces' lanes: two in Design system, none in Onboarding, two in none.
  await filterButton(page).click();
  const counts = page.locator('[data-board-filter-menu] [data-board-initiative-option]');
  await expect(counts.locator('.ib-pmi-l')).toHaveText(['All initiatives', 'Design system', 'Onboarding', 'No initiative']);
  await expect(counts.locator('.ib-bflt-n')).toHaveText(['2', '0', '2']);
  await page.locator(`[data-board-initiative-option="${design}"]`).click();
  expect(await hashOf(page)).toBe(`#board&project=${project.workspaces}&initiative=${design}`);
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(2);
  expect(await tokenWords(page, 'initiative')).toBe('Design system');
  expect(await tokenWords(page, 'project')).toBe('workspaces');
  await page.reload();
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(2);

  // A card's thread and back: the same filtered Board.
  await cardEl(page, ids.design).locator('[data-card-open]').click();
  await page.locator(`[data-card-panel="${ids.design}"] [data-card-thread]`).first().click();
  await expect(page.locator('[data-thread-card]')).toBeVisible();
  expect(await hashOf(page)).toContain(`board-initiative=${design}`);
  await page.locator('[data-thread-card]').click();
  expect(await hashOf(page)).toBe(`#board&project=${project.workspaces}&initiative=${design}&card=${ids.design}`);
  await page.locator(`[data-card-panel="${ids.design}"] [data-card-close]`).click();

  // New card starts in it.
  await page.locator('[data-board-new]').click();
  await expect(page.locator('dialog[data-dialog="new-card"] [data-new-card-initiative]')).toHaveAttribute('data-new-card-initiative', design);
  await page.keyboard.press('Escape');

  // The project's × keeps the initiative: Design system across every project.
  await page.locator('[data-board-filter-clear="project"]').click();
  expect(await hashOf(page)).toBe(`#board&initiative=${design}`);
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(2);

  // No initiative: every lane card but those two.
  await page.goto(`${world.url}#board&initiative=none`);
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(ON_LANES - 2);
  expect(await tokenWords(page, 'initiative')).toBe('No initiative');

  // Deleted in one click, no question: its cards are in none again, and a link to it is no filter.
  const onboarding = made[1]!.id;
  const deleteOf = (id: string) => dialog.locator(`[data-initiative-row="${id}"] [data-initiative-delete]`);
  await filterButton(page).click();
  await page.locator('[data-board-initiative-edit]').click();
  await deleteOf(design).click();
  await expect(dialog.locator(`[data-initiative-row="${design}"]`)).toHaveCount(0);
  // Focus on the next row's Delete; the toast's Undo, drawn inside the modal, can be pressed and brings it back.
  await expect(deleteOf(onboarding)).toBeFocused();
  await dialog.locator('.ib-toast [data-toast-undo]').click();
  await expect(dialog.locator(`[data-initiative-row="${design}"]`)).toHaveCount(1);
  await expect.poll(async () => (await cardsRead()).cards.filter((c) => c.initiative === design).length).toBe(2);
  await deleteOf(design).click();
  await expect(deleteOf(onboarding)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.locator('[data-initiative-row]')).toHaveCount(0);
  await expect(dialog.locator('[data-initiative-new-name]')).toBeFocused();
  await dialog.locator('[data-initiatives-done]').click();
  await expect(filterButton(page)).toBeFocused();
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(ON_LANES);
  const after = await cardsRead();
  expect(after.cards.filter((c) => c.initiative !== null)).toEqual([]);
  await page.goto(`${world.url}#board&initiative=${design}`);
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(ON_LANES);
  await expect(page.locator('[data-board-filter-token]')).toHaveCount(0);
  // The next step on the Board drops the deleted id from the address.
  await cardEl(page, ids.design).locator('[data-card-open]').click();
  expect(await hashOf(page)).toBe(`#board&card=${ids.design}`);
  await page.goto(`${world.url}#board`);
  expect(world.errors).toEqual([]);
});

test('a project with nothing in flight says so; Show all projects clears the filter', async () => {
  const { page, project } = world;
  await filterButton(page).click();
  await page.locator(`[data-board-project-option="${project.pando}"]`).click();
  const empty = page.locator('[data-board-empty="project"]');
  await expect(empty).toBeVisible();
  await expect(empty.locator('b')).toHaveText('pando');
  await expect(page.locator('[data-board-link="cancelled"]')).toHaveText('Cancelled 1');
  await both(page, 'empty-1440');
  await empty.locator('[data-board-show-all]').click();
  await expect(empty).toHaveCount(0);
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(ON_LANES);
  expect(await hashOf(page)).toBe('#board');
  // Focus lands on the Board's heading, never the page (the line and its button are gone).
  await expect(page.locator('.ib-bhead h1')).toBeFocused();
});

test('an empty or unknown project in the address is no filter', async () => {
  const { page } = world;
  for (const hash of ['#board&project=', '#board&project=prj_gone']) {
    await page.goto('about:blank');
    await page.goto(`${world.url}${hash}`);
    await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(ON_LANES);
    await expect(page.locator('[data-board-filter]')).not.toHaveAttribute('data-set', '');
    await expect(page.locator('[data-board-filter-token]')).toHaveCount(0);
    await expect(page.locator('[data-board-empty="project"]')).toHaveCount(0);
  }
});

test("a filtered visit leaves the other projects' news unread (the look is recorded only showing every project)", async () => {
  const { page, ids, project, paths } = world;
  const claude = world.agents[0]!;
  // An unfiltered visit records the look through everything so far.
  await page.goto('about:blank');
  await page.goto(`${world.url}#board`);
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(ON_LANES);
  await expect.poll(async () => { const b = await boardSeen(page); return b.seen === b.cursor; }).toBe(true);
  const looked = (await boardSeen(page)).seen;
  // Filtered to workspaces, an agent writes on a plannotator card: not on screen.
  await page.goto('about:blank');
  await page.goto(`${world.url}#board&project=${project.workspaces}`);
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(4);
  await claude.card({ op: 'say', card_id: ids.auto, say: 'Rebased on main', project_path: paths.plannotator });
  await expect.poll(async () => (await boardSeen(page)).cursor).toBeGreaterThan(looked ?? 0);
  // A new filtered visit (a reload) records nothing.
  await page.reload();
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(4);
  await page.waitForTimeout(1000);
  expect((await boardSeen(page)).seen).toBe(looked);
  // The next visit showing every project: the plannotator card is still bold.
  await page.goto('about:blank');
  await page.goto(`${world.url}#board`);
  await expect(cardEl(page, ids.auto)).toHaveAttribute('data-unread', '');
  // That visit records the look: the one after it shows the card read.
  await expect.poll(async () => { const b = await boardSeen(page); return b.seen === b.cursor; }).toBe(true);
  await page.goto('about:blank');
  await page.goto(`${world.url}#board`);
  await expect(cardEl(page, ids.auto)).toBeVisible();
  await expect(cardEl(page, ids.auto)).not.toHaveAttribute('data-unread', '');
});

test('a narrow window: the picks on their own row under the header, a long name whole, nothing cut in the header', async () => {
  const { page, ids, project } = world;
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto(`${world.url}#board&project=${project[LONG]}`);
  await expect(cardEl(page, ids.long)).toBeVisible();
  await expect(page.locator('.ib-bfbar [data-board-filter-token="project"]')).toBeVisible();
  await expect(page.locator('.ib-bhead [data-board-filter-token]')).toHaveCount(0);
  await expect(page.locator('.ib-bhead [data-board-filter-button]')).toBeVisible();
  // Nothing in the header runs past its edge.
  const headCut = await page.locator('.ib-bhead').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(headCut).toBe(false);
  expect(await tokenWords(page, 'project')).toBe(LONG);
  // Whole: the token is not cut (its words fit their box).
  expect(await page.locator('.ib-bfbar [data-board-filter-token="project"] .ib-bflt-tok-l').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await shot(page, 'long-900-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'long-900-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(world.errors).toEqual([]);
});

test.describe('iPhone 15 (WebKit)', () => {
  const { defaultBrowserType: _browser, ...device } = devices['iPhone 15'];
  let browser: Browser | null = null;
  test.beforeAll(async () => {
    browser = await webkit.launch({ args: [] });
  });
  test.afterAll(async () => {
    await browser?.close();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the filter icon in the header, its picks on a row under it; its menu a sheet at the bottom; picking narrows the list (${scheme})`, async () => {
      const { ids, project } = world;
      const context = await browser!.newContext({ ...device, colorScheme: scheme });
      try {
        const page = await context.newPage();
        await page.goto(`${world.url}#board`);
        await expect(page.locator('[data-board-view="phone"]')).toBeVisible();
        const button = page.locator('.ib-bhead [data-board-filter-button]');
        await expect(button).toBeVisible();
        // A whole 44 px touch target, unset and (below) picked.
        expect(Math.round((await button.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(shots, `phone-none-${scheme}.png`) });
        await button.tap();
        const sheet = page.locator('[data-board-filter-menu]');
        await expect(sheet).toBeVisible();
        const box = (await sheet.boundingBox())!;
        const viewport = page.viewportSize()!;
        // A sheet from the bottom edge, nearly full width.
        expect(box.y + box.height).toBeGreaterThan(viewport.height - 60);
        expect(box.width).toBeGreaterThan(viewport.width - 40);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(shots, `phone-menu-${scheme}.png`) });
        await page.locator(`[data-board-project-option="${project.workspaces}"]`).tap();
        await expect(sheet).toHaveCount(0);
        await expect(cardEl(page, ids.design)).toBeVisible();
        await expect(cardEl(page, ids.auto)).toHaveCount(0);
        expect(await page.evaluate(() => window.location.hash)).toBe(`#board&project=${project.workspaces}`);
        for (const target of [button, page.locator('.ib-bfbar [data-board-filter-clear="project"]')]) {
          const picked = (await target.boundingBox())!;
          expect(Math.round(picked.height)).toBeGreaterThanOrEqual(44);
          expect(Math.round(picked.width)).toBeGreaterThanOrEqual(44);
        }
        // Nothing scrolls sideways.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(shots, `phone-filtered-${scheme}.png`) });
      } finally {
        await context.close();
      }
    });
  }

  // A phone's toast is `absolute`: inside the dialog it would anchor to the dialog's foot and cover Done for its 7 s.
  test('one-click delete on a phone: the toast at the window foot, clear of Done, which closes and hands over the Undo', async () => {
    const context = await browser!.newContext({ ...device });
    try {
      const page = await context.newPage();
      await page.goto(`${world.url}#board`);
      // Made here: the initiatives test above deleted its own.
      await page.evaluate(async () => {
        const res = await fetch('/api/inbox/initiatives', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Phone toast' }) });
        if (!res.ok) throw new Error(`initiative: ${res.status}`);
      });
      await page.reload();
      await page.locator('.ib-bhead [data-board-filter-button]').tap();
      await page.locator('[data-board-initiative-edit]').tap();
      const dialog = page.locator('[data-dialog="initiatives"]');
      await dialog.locator('[data-initiative-delete]').first().tap();
      const toast = dialog.locator('.ib-toast');
      await expect(toast).toBeVisible();
      const done = dialog.locator('[data-initiatives-done]');
      const doneBox = (await done.boundingBox())!;
      expect((await toast.boundingBox())!.y).toBeGreaterThanOrEqual(doneBox.y + doneBox.height);
      await done.tap();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.ib-toast [data-toast-undo]')).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
