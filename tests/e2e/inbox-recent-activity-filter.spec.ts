/**
 * The list filter's "Recent activity" (approval "inbox-recent-activity-filter") in a real Chromium against the
 * compiled binary, agents writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - the funnel's menu offers Recent activity beside Not seen, counting the threads the person did something in;
 *  - the person opens two threads by clicking their rows (Charlie Dunn's, then Ada Novak's), stars a third (Bob
 *    Tully's: tidying, which never counts) and leaves a fourth alone (only an agent wrote there);
 *  - on, the list holds the two opened threads only, Ada Novak's first (opened last), though Charlie Dunn's has the
 *    newer message; the funnel counts one pick; a reload keeps it;
 *  - ticked again, it turns off: every thread back, in the list's own order, and no badge.
 *
 * What this catches: an open by the person that the server never records (the opening look without `opened`), a
 * star that counts, the filter sorting by the newest message instead of the person's own act, a pick that does not
 * hold a reload or does not turn off from the same row.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/recent-activity-filter: 01 the menu open, 02 the list with the filter on,
 * 03 the list after turning it off. Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
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
  threads: { ada: string; bob: string; charlie: string; untouched: string };
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
  // Oldest first: the list's own order is newest message first (untouched, Charlie Dunn's, Bob Tully's, Ada Novak's).
  const ada = await claude.send({ project_path: billing, subject: 'Ada Novak: refund retries', thread: 'ada', body: ask('Retry refunds after 24 hours?') });
  const bob = await codex.send({ project_path: billing, subject: 'Bob Tully: landing copy', thread: 'bob', body: ask('Ship the new hero line?') });
  const charlie = await claude.send({ project_path: billing, subject: 'Charlie Dunn: invoice export', thread: 'charlie', body: ask('Export invoices as CSV too?') });
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
    threads: { ada: ada.thread_id as string, bob: bob.thread_id as string, charlie: charlie.thread_id as string, untouched: untouched.thread_id as string },
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

test('the person opens two threads and stars a third; only the opens are recorded', async () => {
  const { page, threads } = world;
  await expect(rowButton(page, threads.charlie)).toBeVisible();
  // Nothing done yet: no thread carries a time (the page loading on the list opened none).
  expect(Object.values(await actedAt(page)).filter(Boolean)).toEqual([]);

  await rowButton(page, threads.charlie).click();
  await expect.poll(async () => (await actedAt(page))[threads.charlie]).not.toBeNull();
  await page.waitForTimeout(50);
  await rowButton(page, threads.ada).click();
  await expect.poll(async () => (await actedAt(page))[threads.ada]).not.toBeNull();
  // A star is tidying: it never counts.
  const starred = await page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) })).status, threads.bob);
  expect(starred).toBe(200);

  const acted = await actedAt(page);
  expect(acted[threads.bob]).toBeNull();
  expect(acted[threads.untouched]).toBeNull();
  expect(Date.parse(acted[threads.ada]!)).toBeGreaterThanOrEqual(Date.parse(acted[threads.charlie]!));
  expect(world.errors).toEqual([]);
});

test("the funnel's menu offers Recent activity beside Not seen, counting the two", async () => {
  const { page, threads } = world;
  // Back to the list with no thread open.
  await page.goto(world.url);
  await expect(rowButton(page, threads.charlie)).toBeVisible();
  await listFilter(page).click();
  await expect(recentPick(page)).toBeVisible();
  await expect(recentPick(page)).toHaveText(/Recent activity/);
  await expect(recentPick(page).locator('.ib-pmi-n')).toHaveText('2');
  await expect(recentPick(page)).toHaveAttribute('aria-checked', 'false');
  // It sits right under Not seen, before Updated.
  const words = await page.locator('[data-list-filter-menu] [role="menuitemcheckbox"], [data-list-filter-menu] [role="menuitem"]').evaluateAll((items) => items.map((item) => item.querySelector('.ib-pmi-l')?.textContent ?? ''));
  expect(words.slice(0, 3)).toEqual(['Not seen', 'Recent activity', 'Today']);
  await shot(page, '01-menu-open.png');
  expect(world.errors).toEqual([]);
});

test('on: only the opened threads, the one opened last first; a reload keeps it', async () => {
  const { page, threads } = world;
  await recentPick(page).click();
  await expect(recentPick(page)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(rowButton(page, threads.bob)).toHaveCount(0);
  await expect(rowButton(page, threads.untouched)).toHaveCount(0);
  await expect.poll(() => listOrder(page)).toEqual([threads.ada, threads.charlie]);
  await expect(page.locator('[data-list-filter-count]')).toHaveText('1');
  await shot(page, '02-filter-on.png');

  await page.reload();
  await expect(rowButton(page, threads.ada)).toBeVisible();
  await expect.poll(() => listOrder(page)).toEqual([threads.ada, threads.charlie]);
  expect(world.errors).toEqual([]);
});

test('ticked again it turns off: every thread back in the list order, no badge', async () => {
  const { page, threads } = world;
  await listFilter(page).click();
  await recentPick(page).click();
  await expect(recentPick(page)).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-list-filter-count]')).toHaveCount(0);
  for (const id of Object.values(threads)) await expect(rowButton(page, id)).toBeVisible();
  // The list's own order again: Charlie Dunn's newer message above Ada Novak's.
  const order = await listOrder(page);
  expect(order.indexOf(threads.charlie)).toBeLessThan(order.indexOf(threads.ada));
  await shot(page, '03-filter-off.png');
  expect(world.errors).toEqual([]);
});
