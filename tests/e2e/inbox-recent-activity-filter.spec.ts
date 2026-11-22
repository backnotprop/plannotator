/**
 * The list filter's "Recent activity" (approval "inbox-recent-activity-filter") in a real Chromium against the
 * compiled binary, agents writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - the person opens two threads by clicking their rows (Charlie Dunn's, then Bob Tully's: both wait on them), gives
 *    a third a 👍 Looks good (Ada Novak's, which goes to Quiet), stars a fourth (tidying, which never counts) and
 *    leaves a fifth alone (only an agent wrote there);
 *  - the funnel's menu offers Recent activity beside Not seen, with a mark of its own (not Updated's clock), counting
 *    the three;
 *  - on, the list holds those three only, as one list with no group bands, newest act first: Ada Novak's (the 👍, in
 *    Quiet), Bob Tully's, Charlie Dunn's (though Charlie Dunn's has the newest message); a reload keeps it, and so does
 *    the Agents view;
 *  - ticked again, it turns off: the Smart groups back as they were, every thread in the list's own order, no badge.
 *
 * What this catches: an open by the person that the server never records (the opening look without `opened`), a 👍
 * that does not count, a star that does, the filter sorting by the newest message instead of the person's own act, a
 * pick that does not hold a reload or does not turn off from the same row, the pick drawn with Updated's clock, a
 * filtered list that still draws groups (a fresh act in Quiet under an old one waiting), a view that does not come back.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/recent-activity-filter: 01 the menu open, 02 the list with the filter on,
 * 03 the list after turning it off, 04 (dark) and 05 (light) the filtered list, one list newest first. Build the
 * binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'recent-activity-filter');

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { ada: string; bob: string; charlie: string; starred: string; untouched: string };
  /** Ada Novak's agent message: the one the 👍 goes on. */
  adaMessage: string;
}

let world: World;

test.describe.configure({ mode: 'serial' });

const rowButton = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
const listFilter = (page: Page) => page.locator('.ib-lhead [data-list-filter]');
const recentPick = (page: Page) => page.locator('[data-list-filter-menu] [data-list-filter-recent]');
/** The list's thread ids, top to bottom. */
const listOrder = (page: Page) => page.locator('.ib-lbody [data-thread-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-thread-id')));

async function shot(page: Page, name: string) {
  // The menu's entrance has played.
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(proofDir, name) });
}

/** The same list in dark (`dark`) and light (`light`), then back to the page's light. */
async function shotBoth(page: Page, dark: string, light: string) {
  for (const [scheme, name] of [['dark', dark], ['light', light]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot(page, name);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The list's group bands (none while the list is one list). */
const bands = (page: Page) => page.locator('.ib-lbody .ib-band');

/** The ⋮ menu's View choice. */
async function chooseView(page: Page, view: 'grouped' | 'list' | 'agents') {
  await page.locator('.ib-listcol [data-tidy-menu]').first().click();
  await page.locator(`[data-tidy-menu-popup] [data-list-view="${view}"]`).click();
  await expect(page.locator(`[data-tidy-menu-popup] [data-list-view="${view}"]`)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tidy-menu-popup]')).toHaveCount(0);
}

/** Quiet's band, opened when it is folded. */
async function openQuiet(page: Page) {
  const band = page.locator('.ib-lbody [data-section-id="quiet"] .ib-band');
  await expect(band).toBeVisible();
  if ((await band.getAttribute('aria-expanded')) !== 'true') await band.click();
  await expect(band).toHaveAttribute('aria-expanded', 'true');
}

const ask = (prompt: string) => ['The draft is ready for a look.', '', ':::question', prompt, '', '- [ ] Yes', '- [ ] Not yet', ':::'].join('\n');

/** When the person last acted in each thread, as the window's list read says. */
const actedAt = (page: Page) =>
  page.evaluate(async () => {
    const model = (await (await fetch('/api/inbox/threads?archived=exclude')).json()) as { sections: { threads: { thread_id: string; acted_at?: string }[] }[] };
    return Object.fromEntries(model.sections.flatMap((s) => s.threads).map((row) => [row.thread_id, row.acted_at ?? null]));
  });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-recent-activity-e2e-');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify(E2E_LAUNCH_OFF));
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: data, PLANNOTATOR_TEST_SANDBOX: '1', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  // Oldest first: the list's own order is newest message first. Ada Novak's asks nothing, so a 👍 can close it.
  const ada = await claude.send({ project_path: billing, subject: 'Ada Novak: refund retries', thread: 'ada', body: 'Refund retries now wait 24 hours. CI is green.' });
  const bob = await codex.send({ project_path: billing, subject: 'Bob Tully: landing copy', thread: 'bob', body: ask('Ship the new hero line?') });
  const charlie = await claude.send({ project_path: billing, subject: 'Charlie Dunn: invoice export', thread: 'charlie', body: ask('Export invoices as CSV too?') });
  const starred = await codex.send({ project_path: billing, subject: 'Release notes for 2.4', thread: 'notes', body: ask('Lead with the export change?') });
  const untouched = await codex.send({ project_path: billing, subject: 'Nightly e2e run', thread: 'nightly', body: 'All green tonight.' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = started.stdout.trim();
  await page.goto(url);
  world = {
    url,
    agents: [claude, codex],
    context,
    page,
    errors,
    threads: { ada: ada.thread_id as string, bob: bob.thread_id as string, charlie: charlie.thread_id as string, starred: starred.thread_id as string, untouched: untouched.thread_id as string },
    adaMessage: ada.message_id as string,
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

test('the person opens two threads, gives a third a 👍 and stars a fourth; only the opens and the 👍 are recorded', async () => {
  const { page, threads } = world;
  await expect(rowButton(page, threads.charlie)).toBeVisible();
  // Nothing done yet: no thread carries a time (the page loading on the list opened none).
  expect(Object.values(await actedAt(page)).filter(Boolean)).toEqual([]);

  await rowButton(page, threads.charlie).click();
  await expect.poll(async () => (await actedAt(page))[threads.charlie]).not.toBeNull();
  await page.waitForTimeout(50);
  await rowButton(page, threads.bob).click();
  await expect.poll(async () => (await actedAt(page))[threads.bob]).not.toBeNull();
  await page.waitForTimeout(50);
  // 👍 Looks good on Ada Novak's thread, never opened: the press alone counts, and the thread goes to Quiet.
  const acked = await page.evaluate(async (id) => (await fetch(`/api/inbox/messages/${id}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, world.adaMessage);
  expect(acked).toBe(200);
  await expect.poll(async () => (await actedAt(page))[threads.ada]).not.toBeNull();
  // A star is tidying: it never counts.
  const pinned = await page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) })).status, threads.starred);
  expect(pinned).toBe(200);

  const acted = await actedAt(page);
  expect(acted[threads.starred]).toBeNull();
  expect(acted[threads.untouched]).toBeNull();
  expect(Date.parse(acted[threads.bob]!)).toBeGreaterThanOrEqual(Date.parse(acted[threads.charlie]!));
  expect(Date.parse(acted[threads.ada]!)).toBeGreaterThanOrEqual(Date.parse(acted[threads.bob]!));
  expect(world.errors).toEqual([]);
});

test("the funnel's menu offers Recent activity beside Not seen, with its own mark, counting the three", async () => {
  const { page, threads } = world;
  // Back to the list with no thread open.
  await page.goto(world.url);
  await expect(rowButton(page, threads.charlie)).toBeVisible();
  await listFilter(page).click();
  await expect(recentPick(page)).toBeVisible();
  await expect(recentPick(page)).toHaveText(/Recent activity/);
  await expect(recentPick(page).locator('.ib-pmi-n')).toHaveText('3');
  await expect(recentPick(page)).toHaveAttribute('aria-checked', 'false');
  // It sits right under Not seen, before Updated.
  const items = page.locator('[data-list-filter-menu] [role="menuitemcheckbox"], [data-list-filter-menu] [role="menuitem"]');
  const words = await items.evaluateAll((all) => all.map((item) => item.querySelector('.ib-pmi-l')?.textContent ?? ''));
  expect(words.slice(0, 3)).toEqual(['Not seen', 'Recent activity', 'Today']);
  // Its mark is its own, not the clock the Updated rows under it draw.
  const marks = await items.evaluateAll((all) => all.slice(1, 3).map((item) => item.querySelector('svg')?.innerHTML ?? ''));
  expect(marks[0]).not.toBe('');
  expect(marks[0]).not.toBe(marks[1]);
  await shot(page, '01-menu-open.png');
  expect(world.errors).toEqual([]);
});

test('on: only the three, one list newest first by the act, no group bands; a reload and the Agents view keep it', async () => {
  const { page, threads } = world;
  await recentPick(page).click();
  await expect(recentPick(page)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(rowButton(page, threads.starred)).toHaveCount(0);
  await expect(rowButton(page, threads.untouched)).toHaveCount(0);
  await expect(page.locator('[data-list-filter-count]')).toHaveText('1');
  // One list: Ada Novak's 👍 (in Quiet) first, then Bob Tully's and Charlie Dunn's opens (both waiting on the person).
  await expect.poll(() => listOrder(page)).toEqual([threads.ada, threads.bob, threads.charlie]);
  await expect(bands(page)).toHaveCount(0);
  await page.mouse.move(1300, 800);
  await shot(page, '02-filter-on.png');
  await shotBoth(page, '04-flat-newest-first.png', '05-flat-newest-first-light.png');

  await page.reload();
  await expect(rowButton(page, threads.bob)).toBeVisible();
  await expect.poll(() => listOrder(page)).toEqual([threads.ada, threads.bob, threads.charlie]);
  // The Agents view draws the same one list while the pick is on, and the groups' view is chosen back.
  await chooseView(page, 'agents');
  await expect.poll(() => listOrder(page)).toEqual([threads.ada, threads.bob, threads.charlie]);
  await expect(bands(page)).toHaveCount(0);
  await chooseView(page, 'grouped');
  expect(world.errors).toEqual([]);
});

test('ticked again it turns off: the Smart groups back, every thread in the list order, no badge', async () => {
  const { page, threads } = world;
  await listFilter(page).click();
  await recentPick(page).click();
  await expect(recentPick(page)).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-list-filter-count]')).toHaveCount(0);
  await openQuiet(page);
  for (const id of Object.values(threads)) await expect(rowButton(page, id)).toBeVisible();
  // The groups again: Ada Novak's in Quiet, and Charlie Dunn's newer message above Bob Tully's.
  await expect(page.locator(`.ib-lbody [data-section-id="quiet"] [data-thread-id="${threads.ada}"]`)).toBeVisible();
  const order = await listOrder(page);
  expect(order.indexOf(threads.charlie)).toBeLessThan(order.indexOf(threads.bob));
  await shot(page, '03-filter-off.png');
  expect(world.errors).toEqual([]);
});
