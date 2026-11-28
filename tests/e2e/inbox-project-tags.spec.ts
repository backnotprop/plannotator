/**
 * Project tags in a real browser against the compiled binary, agents writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts), the Board on, in two projects (billing-svc with two threads and two cards, site with one of
 * each), and a scripted `gh` first on PATH:
 *
 *  - billing-svc's ⋯ → Add tag → tick Work: the toast says "Tagged Work";
 *  - the list's Filter → Tag → Work keeps billing-svc's threads (tagged by their project only) and hides site's; the
 *    Tag row counts billing-svc's two threads; a reload keeps it;
 *  - the Board's filter → Work keeps billing-svc's cards and hides site's, and counts them;
 *  - untick Work on billing-svc: the list filtered by Work holds none of its threads.
 *
 * What this catches: the list's or the Board's filter reading a row's or a card's own tags only (the project's tags
 * dropped on the way from the list to the filter), the project ⋯ not writing, and a tick that does not hold a reload.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { fakeForge } from './fake-forge';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  /** Project ids by name. */
  project: Record<string, string>;
  threads: { invoices: string; refunds: string; landing: string };
  cards: { ledger: string; payouts: string; hero: string };
  work: string;
}

let world: World;

test.describe.configure({ mode: 'serial' });

const rowButton = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
const projectRow = (page: Page, name: string) => page.locator('.ib-projrow', { has: page.locator('.ib-name', { hasText: new RegExp(`^${name}$`) }) });
const toast = (page: Page) => page.locator('[data-inbox-toast]');
const listFilter = (page: Page) => page.locator('.ib-lhead [data-list-filter]');
const cardEl = (page: Page, id: string) => page.locator(`.ib-bcard[data-card-id="${id}"]`);

/** billing-svc's ⋯ → Add tag → Work, ticked or unticked; the list stays open, so Escape closes it. */
async function tickWork(page: Page, on: boolean) {
  const { project, work } = world;
  const billing = projectRow(page, 'billing-svc');
  await billing.hover();
  await billing.locator('.ib-pmore').click();
  const menu = page.locator(`[data-project-menu="${project['billing-svc']}"]`);
  await expect(menu).toBeVisible();
  await menu.locator('[data-add-tag-item]').click();
  const pick = menu.locator(`[data-tag-pick="${work}"]`);
  await expect(pick).toHaveAttribute('aria-checked', on ? 'false' : 'true');
  await pick.click();
  await expect(pick).toHaveAttribute('aria-checked', on ? 'true' : 'false');
  await page.keyboard.press('Escape');
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-project-tags-e2e-');
  const forge = fakeForge(join(root, 'bin'));
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  // The Board on, its first-visit dialog already seen (inbox-board.spec.ts proves both).
  writeFileSync(join(data, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, inboxBoard: true, inboxBoardIntro: { shownAt: new Date().toISOString() } }));
  const env = { PATH: `${forge.dir}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: data, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const src = join(root, 'src');
  const billing = scratchProject(src, 'billing-svc');
  const site = scratchProject(src, 'site');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const invoices = await claude.send({ project_path: billing, subject: 'Invoices reconciled', thread: 'invoices', body: 'All 312 invoices match the ledger.' });
  const refunds = await claude.send({ project_path: billing, subject: 'Refund job', thread: 'refunds', body: 'The nightly refund job is green.' });
  const landing = await codex.send({ project_path: site, subject: 'Landing page copy', thread: 'landing', body: 'The hero copy is up for review.' });
  const make = async (agent: SimAgent, project: string, title: string, fields: Record<string, unknown> = {}) =>
    ((await agent.card({ op: 'create', project_path: project, title, ...fields })).card as { id: string }).id;
  const cards = {
    ledger: await make(claude, billing, 'Ledger export', { column: 'in_progress' }),
    payouts: await make(claude, billing, 'Payout retries'),
    hero: await make(codex, site, 'Hero scene', { column: 'in_progress' }),
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = started.stdout.trim();
  await page.goto(url);
  // The tag itself, made as the Board's Tags dialog makes one; nothing is tagged yet.
  const work = await page.evaluate(async () => {
    const res = await fetch('/api/inbox/initiatives', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Work' }) });
    if (!res.ok) throw new Error(`make Work: ${res.status}`);
    return ((await res.json()) as { initiative: { id: string } }).initiative.id;
  });
  const listed = await page.evaluate(async () => ((await (await fetch('/api/inbox/projects')).json()).projects as { id: string; name: string }[]).map((p) => [p.name, p.id]));
  world = {
    url,
    agents: [claude, codex],
    context,
    page,
    errors,
    project: Object.fromEntries(listed),
    threads: { invoices: invoices.thread_id as string, refunds: refunds.thread_id as string, landing: landing.thread_id as string },
    cards,
    work,
  };
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

test("a project's ⋯ → Add tag ticks Work, and the toast says so", async () => {
  const { page, threads } = world;
  await page.reload();
  await expect(rowButton(page, threads.invoices)).toBeVisible();
  await tickWork(page, true);
  await expect(toast(page)).toContainText('Tagged');
  await expect(toast(page)).toContainText('Work');
  // The project's threads carry no Work of their own: the tag is the project's.
  await expect.poll(() => page.evaluate(async (id) => ((await (await fetch('/api/inbox/projects')).json()).projects as { id: string; tags?: string[] }[]).find((p) => p.id === id)?.tags ?? [], world.project['billing-svc'])).toEqual([world.work]);
  expect(world.errors).toEqual([]);
});

test("the list's Filter → Tag → Work keeps the tagged project's threads and counts them; a reload keeps it", async () => {
  const { page, threads, work } = world;
  await listFilter(page).click();
  const pick = page.locator(`[data-list-filter-menu] [data-list-filter-tag="${work}"]`);
  await expect(pick).toBeVisible();
  // Two threads in Work, both through their project.
  await expect(pick.locator('.ib-pmi-n')).toHaveText('2');
  await pick.click();
  await page.keyboard.press('Escape');
  await expect(rowButton(page, threads.invoices)).toBeVisible();
  await expect(rowButton(page, threads.refunds)).toBeVisible();
  await expect(rowButton(page, threads.landing)).toHaveCount(0);

  await page.reload();
  await expect(rowButton(page, threads.invoices)).toBeVisible();
  await expect(rowButton(page, threads.refunds)).toBeVisible();
  await expect(rowButton(page, threads.landing)).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test("the Board's filter → Work keeps the tagged project's cards and counts them", async () => {
  const { page, cards, work } = world;
  await page.locator('[data-board-nav]').click();
  await expect(page.locator('[data-board-page][data-board-view="lanes"]')).toBeVisible();
  for (const id of [cards.ledger, cards.payouts, cards.hero]) await expect(cardEl(page, id)).toBeVisible();
  await page.locator('[data-board-filter-button]').click();
  const option = page.locator(`[data-board-filter-menu] [data-board-initiative-option="${work}"]`);
  await expect(option.locator('.ib-bflt-n')).toHaveText('2');
  await option.click();
  await expect(page).toHaveURL(new RegExp(`initiative=${work}`));
  await expect(cardEl(page, cards.ledger)).toBeVisible();
  await expect(cardEl(page, cards.payouts)).toBeVisible();
  await expect(cardEl(page, cards.hero)).toHaveCount(0);
  await expect(page.locator('.ib-blanes .ib-bcard')).toHaveCount(2);
  expect(world.errors).toEqual([]);
});

test('untick Work on the project: the list filtered by Work holds none of its threads', async () => {
  const { page, threads } = world;
  await page.locator('[data-inbox-nav]').click();
  await expect(rowButton(page, threads.invoices)).toBeVisible();
  await tickWork(page, false);
  await expect(toast(page)).toContainText('Removed');
  await expect(rowButton(page, threads.invoices)).toHaveCount(0);
  await expect(rowButton(page, threads.refunds)).toHaveCount(0);
  await expect(rowButton(page, threads.landing)).toHaveCount(0);
  expect(world.errors).toEqual([]);
});
