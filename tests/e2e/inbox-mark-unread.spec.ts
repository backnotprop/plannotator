/**
 * Mark unread (the owner's ask, 2026-10-31: "I need a way to mark a message
 * unread"). Proved in a real browser against the compiled binary, with agents
 * writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - Mark read moves a plain update to Quiet; the row menu then offers Mark
 *    unread, which puts the row back in New, bold; a reload keeps it there;
 *    no message is written to the thread (nothing reaches the agent);
 *  - on a thread read by opening it, the header's Mark unread closes the
 *    thread and the row is back in New, bold;
 *  - the row's hover action toggles: on a read row it is Mark unread, which
 *    puts the row back in New, bold, without opening the thread;
 *  - the owner's report (2026-11-02): the open row (while its look is still
 *    on its way) and the row just left offer Mark unread on hover, and
 *    marking it unread sticks through the close and a reload; the open
 *    thread's header says Mark unread there too.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-mark-unread.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const SEARCH = ['Search for the docs site.', '', ':::question', 'Which search index should the docs use?', '', '- [ ] Pagefind', '- [ ] Orama', ':::'].join('\n');

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { nightly: string; deploy: string; search: string };
}

let world: World;

/** The sections on screen, top to bottom, each with its thread ids. */
async function sectionOf(page: Page, threadId: string): Promise<string | null> {
  const groups = await page.locator('.ib-lbody [data-section-id]').evaluateAll((els) =>
    els.map((g) => ({ id: g.getAttribute('data-section-id') ?? '', rows: [...g.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row') ?? '') })),
  );
  return groups.find((g) => g.rows.includes(threadId))?.id ?? null;
}

const openQuiet = async (page: Page) => {
  const band = page.locator('[data-section-id="quiet"] .ib-band');
  if ((await band.getAttribute('aria-expanded')) !== 'true') await band.click();
};

const row = (page: Page, threadId: string) => page.locator(`.ib-lbody [data-thread-id="${threadId}"]`);

/** The thread's messages as the Inbox stores them. */
async function messageCount(threadId: string): Promise<number> {
  const model = (await (await fetch(new URL(`/api/inbox/threads/${threadId}`, world.url))).json()) as { thread: { messages: unknown[] } };
  return model.thread.messages.length;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-markunread-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = scratchProject(join(root, 'src'), 'billing');
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const nightly = await pi.send({ project_path: project, subject: 'Nightly build is green', thread: 'nightly', body: 'The nightly build is green again.' });
  const deploy = await pi.send({ project_path: project, subject: 'Docs deploy finished', thread: 'deploy', body: 'The docs deploy finished; the new search page is live.' });
  const search = await codex.send({ project_path: project, subject: 'Search for the docs site', body: SEARCH });
  world = {
    url,
    agents: [pi, codex],
    context,
    page,
    errors,
    threads: { nightly: nightly.thread_id as string, deploy: deploy.thread_id as string, search: search.thread_id as string },
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
    await world.context.close();
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

test('Mark read, then the row menu’s Mark unread: the row is bold in place, back in New after a reload, and nothing is sent', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  await expect(row(page, threads.nightly)).toBeVisible();
  expect(await sectionOf(page, threads.nightly)).toBe('new');
  await expect(row(page, threads.nightly)).toHaveClass(/\bib-u\b/);

  // Mark read, from the row's hover action: the row stays in New, read (the list holds still, approval
  // "inbox-list-view", R7); the list's title tidies it into Quiet (folded).
  await row(page, threads.nightly).hover();
  await page.locator(`.ib-lbody [data-row="${threads.nightly}"] [data-row-mark-read]`).click();
  await expect(page.locator('[data-inbox-toast]')).toContainText('Marked read');
  await expect(row(page, threads.nightly)).not.toHaveClass(/\bib-u\b/);
  expect(await sectionOf(page, threads.nightly)).toBe('new');
  await page.locator('[data-list-refresh]').click();
  await expect.poll(() => sectionOf(page, threads.nightly)).toBe(null);

  // The row menu on the read row: Mark unread.
  await openQuiet(page);
  await expect.poll(() => sectionOf(page, threads.nightly)).toBe('quiet');
  await expect(row(page, threads.nightly)).not.toHaveClass(/\bib-u\b/);
  await row(page, threads.nightly).click({ button: 'right' });
  const item = page.locator(`[data-row-menu="${threads.nightly}"] [data-row-action="mark-unread"]`);
  await expect(item).toHaveText('Mark unread');
  // Move back stays beside it: only Move back reopens what the Mark read closed.
  await expect(page.locator(`[data-row-menu="${threads.nightly}"] [data-row-action="unread"]`)).toHaveText('Move back');
  await item.click();

  // Bold where it is, in Quiet (R7), and the toast does not say it moved; the next tidy puts it in New.
  await expect(row(page, threads.nightly)).toHaveClass(/\bib-u\b/);
  expect(await sectionOf(page, threads.nightly)).toBe('quiet');
  await expect(page.locator('[data-inbox-toast]')).toContainText('Marked unread');
  await expect(page.locator('[data-inbox-toast]')).not.toContainText('back in New');
  expect(await messageCount(threads.nightly)).toBe(1);

  // A reload reads the list from the Inbox: still New, still bold.
  await page.reload();
  await expect(row(page, threads.nightly)).toBeVisible();
  expect(await sectionOf(page, threads.nightly)).toBe('new');
  await expect(row(page, threads.nightly)).toHaveClass(/\bib-u\b/);
  expect(world.errors).toEqual([]);
});

test('a thread read by opening it: the header’s Mark unread closes it, and the row is back in New, bold', async () => {
  const { page, threads } = world;
  // Read it by opening it, then leave: the list settles it into Quiet.
  await page.goto(`${world.url}#thread=${threads.deploy}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Docs deploy finished' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await openQuiet(page);
  await expect.poll(() => sectionOf(page, threads.deploy)).toBe('quiet');

  // Opened from Quiet: the header's ⋯ offers Mark unread, and no Mark read (nothing waits).
  await row(page, threads.deploy).click();
  await pane.locator('[data-thread-more]').click();
  const button = page.locator('[data-thread-menu] [data-thread-unread-item]');
  await expect(button).toHaveAccessibleName('Mark unread');
  await expect(page.locator('[data-thread-menu] [data-thread-read-item]')).toHaveCount(0);
  await button.click();

  await expect(pane).toHaveCount(0);
  await expect.poll(() => sectionOf(page, threads.deploy)).toBe('new');
  await expect(row(page, threads.deploy)).toHaveClass(/\bib-u\b/);
  expect(await messageCount(threads.deploy)).toBe(1);
  // The question thread is untouched.
  expect(await sectionOf(page, threads.search)).toBe('waiting');
  expect(world.errors).toEqual([]);
});

test('the row’s hover action on a read row is Mark unread: the row is bold in place, in New after a tidy, and the thread stays closed', async () => {
  const { page, threads } = world;
  // Read it again by opening it, then leave: Quiet.
  await page.goto(`${world.url}#thread=${threads.nightly}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Nightly build is green' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await openQuiet(page);
  await expect.poll(() => sectionOf(page, threads.nightly)).toBe('quiet');

  // A row that waits keeps Mark read; the read row's action is Mark unread.
  await row(page, threads.search).hover();
  await expect(page.locator(`.ib-lbody [data-row="${threads.search}"] [data-row-mark-read]`)).toBeVisible();
  await row(page, threads.nightly).hover();
  const action = page.locator(`.ib-lbody [data-row="${threads.nightly}"] [data-row-mark-unread]`);
  await expect(action).toBeVisible();
  await expect(action).toHaveText('Mark unread');
  await expect(page.locator(`.ib-lbody [data-row="${threads.nightly}"] [data-row-mark-read]`)).toHaveCount(0);
  await action.click();

  // Bold where it is, in Quiet (the list holds still, R7); the list's title tidies it into New.
  await expect(row(page, threads.nightly)).toHaveClass(/\bib-u\b/);
  expect(await sectionOf(page, threads.nightly)).toBe('quiet');
  await expect(page.locator('[data-inbox-toast]')).toContainText('Marked unread');
  await page.locator('[data-list-refresh]').click();
  await expect.poll(() => sectionOf(page, threads.nightly)).toBe('new');
  await expect(row(page, threads.nightly)).toHaveClass(/\bib-u\b/);
  await expect(pane).toHaveCount(0);
  expect(await messageCount(threads.nightly)).toBe(1);
  expect(world.errors).toEqual([]);
});

/** Where the Inbox itself puts the thread (not the list on screen, which holds still while a thread is open). */
async function serverSection(threadId: string): Promise<string | null> {
  const list = (await (await fetch(new URL('/api/inbox/threads', world.url))).json()) as { sections: { id: string; threads: { thread_id: string }[] }[] };
  return list.sections.find((s) => s.threads.some((t) => t.thread_id === threadId))?.id ?? null;
}

test('the owner’s report (2026-11-02): the open row, and the row just left, offer Mark unread on hover at once, and it sticks', async () => {
  const { page, threads } = world;
  // Deploy: read by opening it and marked unread before, never marked read (nightly's Mark read from the first
  // test still stands, and a thread marked read keeps its pressed Read button in the header).
  const first = threads.deploy;
  const other = threads.nightly;
  await page.goto(world.url);
  await expect.poll(() => sectionOf(page, first)).toBe('new');
  await expect(row(page, first)).toHaveClass(/\bib-u\b/);
  // The look on its way: held back a moment, so the hover is checked before the server has it.
  let releaseLook: () => void = () => {};
  const lookHeld = new Promise<void>((done) => (releaseLook = done));
  const seen = `**/api/inbox/threads/${first}/seen`;
  await page.route(seen, async (route) => {
    await lookHeld;
    await route.continue();
  });
  const pane = page.locator('section.ib-pane');
  const action = (id: string, kind: 'read' | 'unread') => page.locator(`.ib-lbody [data-row="${id}"] [data-row-mark-${kind}]`);

  // Open it: the row is drawn read and its hover action is Mark unread while the look is still on its way
  // (v0.28.45: Mark read, bold, until the look and the list read after it landed).
  await row(page, first).click();
  await expect(pane.getByRole('heading', { name: 'Docs deploy finished' })).toBeVisible();
  await row(page, first).hover();
  await expect(action(first, 'unread')).toBeVisible();
  await expect(action(first, 'read')).toHaveCount(0);
  await expect(row(page, first)).not.toHaveClass(/\bib-u\b/);
  // The header's ⋯ says the same (the owner, 2026-11-02).
  await pane.locator('[data-thread-more]').click();
  await expect(page.locator('[data-thread-menu] [data-thread-unread-item]')).toBeVisible();
  await page.locator('[data-thread-menu]').press('Escape');
  expect(await serverSection(first)).toBe('new');
  releaseLook();
  await expect.poll(() => serverSection(first)).toBe('quiet');
  await page.unroute(seen);
  // The look landed; the list still holds the row in New, and it still offers Mark unread (v0.28.45: Mark read).
  await row(page, first).hover();
  await expect(action(first, 'unread')).toBeVisible();
  await pane.locator('[data-thread-more]').click();
  await expect(page.locator('[data-thread-menu] [data-thread-unread-item]')).toBeVisible();
  await page.locator('[data-thread-menu]').press('Escape');
  expect(await sectionOf(page, first)).toBe('new');

  // Move to another thread: the row just left keeps Mark unread (v0.28.45: Mark read).
  await row(page, other).click();
  await expect(pane.getByRole('heading', { name: 'Nightly build is green' })).toBeVisible();
  await row(page, first).hover();
  await expect(action(first, 'unread')).toBeVisible();
  await expect(action(first, 'read')).toHaveCount(0);
  await action(first, 'unread').click();

  // It sticks: bold in place with the other thread still open, New on the server, after the close and a reload.
  await expect(row(page, first)).toHaveClass(/\bib-u\b/);
  await expect(page.locator('[data-inbox-toast]')).toContainText('Marked unread');
  await expect(pane.getByRole('heading', { name: 'Nightly build is green' })).toBeVisible();
  expect(await serverSection(first)).toBe('new');
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await page.waitForTimeout(600);
  expect(await sectionOf(page, first)).toBe('new');
  await expect(row(page, first)).toHaveClass(/\bib-u\b/);
  await page.reload();
  await expect(row(page, first)).toBeVisible();
  expect(await sectionOf(page, first)).toBe('new');
  await expect(row(page, first)).toHaveClass(/\bib-u\b/);
  expect(await messageCount(first)).toBe(1);
  expect(world.errors).toEqual([]);
});
