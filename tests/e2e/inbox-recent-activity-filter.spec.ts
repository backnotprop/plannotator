/**
 * The list filter's "Recent activity" (approval "inbox-recent-activity-filter") in a real Chromium against the
 * compiled binary, agents writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - before anything else, three threads seeded with the person's replies minutes apart (Ada Novak's 4 min ago, Bob
 *    Tully's 18, Charlie Dunn's 41, which its agent has answered since): with the pick on they draw newest first, the
 *    row times reading 4m, 18m, 30m down the list (pictures 04b and 05b), though Smart groups put Charlie Dunn's first;
 *  - the person opens two threads by clicking their rows (Charlie Dunn's, then Bob Tully's: both wait on them), gives
 *    a third a 👍 Looks good (Ada Novak's, which goes to Quiet), stars a fourth (tidying, which never counts) and
 *    leaves a fifth alone (only an agent wrote there);
 *  - the funnel's menu offers Recent activity beside Not seen, with a mark of its own (not Updated's clock), counting
 *    the three;
 *  - on, the list holds those three only, as one list with no group bands, newest act first: Ada Novak's (the 👍, in
 *    Quiet), Bob Tully's, Charlie Dunn's (though Charlie Dunn's has the newest message); a reload keeps it, and so does
 *    the Agents view;
 *  - with the pick on, the person opens a row: it stays where it is while the thread is open and through the opening
 *    look's list read, and a thread acted in meanwhile (a film played in another window) is not drawn yet; closing
 *    the thread settles the list, both now at the top;
 *  - ticked again, it turns off: the Smart groups back as they were, every thread in the list's own order, no badge.
 *
 * What this catches: an open by the person that the server never records (the opening look without `opened`), a 👍
 * that does not count, a star that does, the filter sorting by the newest message instead of the person's own act, a
 * pick that does not hold a reload or does not turn off from the same row, the pick drawn with Updated's clock, a
 * filtered list that still draws groups (a fresh act in Quiet under an old one waiting), a view that does not come back,
 * the opened row jumping to the top under the pointer, a thread pushed in at the top while the list holds.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/recent-activity-filter: 01 the menu open, 02 the list with the filter on,
 * 03 the list after turning it off, 04b (dark) and 05b (light) the seeded threads filtered, one list newest first by
 * replies minutes apart (no pointer, no focus ring on them), 06 (dark) and 07 (light) the same on a phone 390 wide.
 * Build the
 * binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { InboxStore } from '../../packages/shared/inbox/store';
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
  /** Seeded before the Inbox starts: the person's replies minutes apart (`seed`). */
  seeded: { ada: string; bob: string; charlie: string };
  /** Claude Code's connection and the project it writes in, to write into a live thread. */
  claude: SimAgent;
  billing: string;
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

/**
 * Three threads whose last act is the person's own reply, minutes apart, so the row times read the order: Ada Novak's
 * reply 4 min ago (Sent), Bob Tully's 18 (Sent), Charlie Dunn's 41, which its agent answered 30 min ago with a
 * question (Waiting on you, so Smart groups draw it first). Written before the Inbox starts, as inbox-tidy.spec.ts does.
 */
function seed(dataDir: string, project: string): World['seeded'] {
  const now = Date.now();
  let clock = now;
  const store = InboxStore.open(dataDir, { now: () => new Date(clock) });
  const at = (minutesAgo: number) => void (clock = now - minutesAgo * 60_000);
  const projectId = store.ensureProject({ root: project, name: 'billing-svc' }).id;
  const agent = { kind: 'agent', host: 'claude-code', session: 'ses-seeded-claude', name: 'Claude Code' } as const;
  const send = (subject: string, body: string) => store.sendMessage({ project_id: projectId, author: agent, subject, thread: subject, body } as never).message;
  const reply = (messageId: string, words: string, key: string) => store.sendReply(messageId, { words, idempotency_key: key });
  at(180);
  const ada = send('Ada Novak: billing emails', 'The billing email templates are updated.');
  at(150);
  const bob = send('Bob Tully: pricing page', 'The pricing page copy is in review.');
  at(120);
  const charlie = send('Charlie Dunn: CSV import', 'The CSV import handles quoted commas now.');
  at(41);
  reply(charlie.id, 'Does it keep empty columns?', 'seed-charlie');
  at(30);
  const again = send('Charlie Dunn: CSV import', ask('Keep empty columns as blank fields?'));
  at(18);
  reply(bob.id, 'Looks good, ship the copy.', 'seed-bob');
  at(4);
  reply(ada.id, 'Thanks, these read well.', 'seed-ada');
  for (const id of [ada.thread_id, bob.thread_id, charlie.thread_id, again.thread_id]) store.markSeen(id);
  return { ada: ada.thread_id, bob: bob.thread_id, charlie: charlie.thread_id };
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
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const seeded = seed(data, billing);
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: data, PLANNOTATOR_TEST_SANDBOX: '1', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
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
    seeded,
    claude,
    billing,
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

/** No pointer over a row (no tooltip, no hover) and no focus ring: the list as it reads. */
async function still(page: Page) {
  const size = page.viewportSize();
  // Below the rows, at the right, clear of the phone's corner button.
  await page.mouse.move((size?.width ?? 1440) - 10, (size?.height ?? 900) - 200);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test('the seeded replies minutes apart: one list newest first, the row times reading it down the list', async () => {
  const { page, seeded } = world;
  await expect(rowButton(page, seeded.charlie)).toBeVisible();
  await listFilter(page).click();
  await recentPick(page).click();
  await expect(recentPick(page)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect.poll(() => listOrder(page)).toEqual([seeded.ada, seeded.bob, seeded.charlie]);
  await expect(bands(page)).toHaveCount(0);
  await still(page);
  await shotBoth(page, '04b-flat-minutes-apart.png', '05b-flat-minutes-apart-light.png');
  // A phone, 390 wide: the same one list.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => listOrder(page)).toEqual([seeded.ada, seeded.bob, seeded.charlie]);
  await expect(bands(page)).toHaveCount(0);
  await still(page);
  await shotBoth(page, '06-phone-flat-minutes-apart.png', '07-phone-flat-minutes-apart-light.png');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(listFilter(page)).toBeVisible();
  // Off again for what follows.
  await listFilter(page).click();
  await recentPick(page).click();
  await expect(recentPick(page)).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-list-filter-count]')).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test('the person opens two threads, gives a third a 👍 and stars a fourth; only the opens and the 👍 are recorded', async () => {
  const { page, threads } = world;
  await expect(rowButton(page, threads.charlie)).toBeVisible();
  // Nothing done yet in the agents' threads: none carries a time (the page loading on the list opened none).
  const first = await actedAt(page);
  expect(Object.values(threads).map((id) => first[id])).toEqual(Object.values(threads).map(() => null));

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

test("the funnel's menu offers Recent activity beside Not seen, with its own mark, counting the six", async () => {
  const { page, threads } = world;
  // Back to the list with no thread open.
  await page.goto(world.url);
  await expect(rowButton(page, threads.charlie)).toBeVisible();
  await listFilter(page).click();
  await expect(recentPick(page)).toBeVisible();
  await expect(recentPick(page)).toHaveText(/Recent activity/);
  // The three just done and the three seeded.
  await expect(recentPick(page).locator('.ib-pmi-n')).toHaveText('6');
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

test('on: only the six, one list newest first by the act, no group bands; a reload and the Agents view keep it', async () => {
  const { page, threads, seeded } = world;
  const newestFirst = [threads.ada, threads.bob, threads.charlie, seeded.ada, seeded.bob, seeded.charlie];
  await recentPick(page).click();
  await expect(recentPick(page)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(rowButton(page, threads.starred)).toHaveCount(0);
  await expect(rowButton(page, threads.untouched)).toHaveCount(0);
  await expect(page.locator('[data-list-filter-count]')).toHaveText('1');
  // One list: Ada Novak's 👍 (in Quiet) first, then Bob Tully's and Charlie Dunn's opens (both waiting on the person),
  // then the seeded replies, minutes old.
  await expect.poll(() => listOrder(page)).toEqual(newestFirst);
  await expect(bands(page)).toHaveCount(0);
  await still(page);
  await shot(page, '02-filter-on.png');

  await page.reload();
  await expect(rowButton(page, threads.bob)).toBeVisible();
  await expect.poll(() => listOrder(page)).toEqual(newestFirst);
  // The Agents view draws the same one list while the pick is on, and the groups' view is chosen back.
  await chooseView(page, 'agents');
  await expect.poll(() => listOrder(page)).toEqual(newestFirst);
  await expect(bands(page)).toHaveCount(0);
  await chooseView(page, 'grouped');
  expect(world.errors).toEqual([]);
});

test('on, an opened row stays put through its look and the read after it; a thread acted in meanwhile waits; both go to the top at the close', async () => {
  const { page, threads, seeded } = world;
  const before = [threads.ada, threads.bob, threads.charlie, seeded.ada, seeded.bob, seeded.charlie];
  await expect.poll(() => listOrder(page)).toEqual(before);
  const opened = (await actedAt(page))[threads.charlie]!;
  await page.waitForTimeout(50);
  // The person opens Charlie Dunn's thread from the list: an act, which the opening look records.
  await rowButton(page, threads.charlie).click();
  await expect(page.locator('section.ib-pane [aria-label="Close the thread"]')).toBeVisible();
  await expect.poll(async () => Date.parse((await actedAt(page))[threads.charlie]!)).toBeGreaterThan(Date.parse(opened));
  // A film played in the untouched thread in another window: it is now an act there too.
  const played = await page.evaluate(async (id) => (await fetch(`/api/inbox/threads/${id}/acted`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, threads.untouched);
  expect(played).toBe(200);
  await expect.poll(async () => (await actedAt(page))[threads.untouched]).not.toBeNull();
  // Charlie Dunn's agent writes in the open thread: the window reads the list again, with both new times.
  await world.claude.send({ project_path: world.billing, thread: 'charlie', body: 'CSV is in the export too.' });
  await expect(page.locator('section.ib-pane')).toContainText('CSV is in the export too.');
  await page.waitForTimeout(1_000);
  // Held: nothing moved, and the untouched thread is not drawn yet.
  expect(await listOrder(page)).toEqual(before);
  await expect(rowButton(page, threads.untouched)).toHaveCount(0);
  // The close settles the list: the film's thread and the opened one on top, newest first.
  await page.locator('section.ib-pane [aria-label="Close the thread"]').click();
  await expect.poll(() => listOrder(page)).toEqual([threads.untouched, threads.charlie, threads.ada, threads.bob, seeded.ada, seeded.bob, seeded.charlie]);
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
