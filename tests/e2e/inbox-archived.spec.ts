/**
 * Archived threads leave the list for Settings (owner ruling 2026-10-12:
 * "Archived messages should move out of the Quiet list … only visible within
 * a panel on the Settings page … the ability to unarchive them"). Proved in a
 * real browser against the compiled binary, with agents writing through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - Settings says "Nothing archived." before anything is;
 *  - archiving the open thread keeps its row in place, shown archived, until
 *    the person leaves the thread; then it is in no section, Quiet included,
 *    while a thread marked read stays in Quiet;
 *  - Settings' Archived block lists the archived threads newest first, with a
 *    small header per project ("billing · 2") when several projects have
 *    some, and no dropdown;
 *  - Unarchive opens the thread back in the main list;
 *  - an agent's reply_to reply into an archived thread brings it back to the
 *    list (placed by its question) and out of the Archived block; its foot
 *    says it came back, and the person answers it without unarchiving.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs at 1440 by 900 land in .local/proof/archived/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'archived');

const SEARCH = ['Search for the docs site.', '', ':::question', 'Which search index should the docs use?', '', '- [ ] Pagefind', '- [ ] Orama', ':::'].join('\n');

interface World {
  url: string;
  billing: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { search: string; build: string; deploy: string; notes: string; read: string };
}

let world: World;

async function shot(name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  const page = world.page;
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Every thread id in the list, in any section. */
async function listed(page: Page): Promise<string[]> {
  return page.locator('.ib-lbody [data-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-row') ?? ''));
}

/**
 * Unfold Quiet, every caller's list holds it. Waits for the band first: right
 * after a reload the list may not be drawn yet, and a bare count() then read 0,
 * skipped the click, and left Quiet folded (its rows missing from `listed`).
 */
const openQuiet = async (page: Page) => {
  const band = page.locator('[data-section-id="quiet"] .ib-band');
  await expect(band).toBeVisible();
  if ((await band.getAttribute('aria-expanded')) !== 'true') await band.click();
  await expect(band).toHaveAttribute('aria-expanded', 'true');
};

/** Archive a thread through the window's own route (the thread id is its first message's). */
async function archive(page: Page, threadId: string): Promise<void> {
  const status = await page.evaluate(async (id) => {
    const health = (await (await fetch('/api/inbox/health')).json()) as { serverSession: string };
    const res = await fetch(`/api/inbox/messages/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: true, serverSession: health.serverSession }),
    });
    return res.status;
  }, threadId);
  expect(status).toBe(200);
  await page.waitForTimeout(20);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-archived-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const billing = scratchProject(join(root, 'src'), 'billing');
  const docs = scratchProject(join(root, 'src'), 'docs-site');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pause = () => new Promise((r) => setTimeout(r, 20));
  const notes = await claude.send({ project_path: billing, subject: 'Release notes drafted', thread: 'notes', body: 'The release notes are drafted in docs/RELEASE.md.' });
  await pause();
  const deploy = await codex.send({ project_path: docs, subject: 'Preview deploy is up', thread: 'deploy', body: 'The preview deploy is up for the docs site.' });
  await pause();
  const build = await claude.send({ project_path: billing, subject: 'Nightly build is green', thread: 'build', body: 'The nightly build is green again.' });
  await pause();
  const read = await codex.send({ project_path: docs, subject: 'Link checker found nothing', thread: 'links', body: 'The link checker found no broken links.' });
  await pause();
  const search = await codex.send({ project_path: docs, subject: 'Search for the docs site', thread: 'search', body: SEARCH });
  world = {
    url,
    billing,
    agents: [claude, codex],
    context,
    page,
    errors,
    threads: {
      search: search.thread_id as string,
      build: build.thread_id as string,
      deploy: deploy.thread_id as string,
      notes: notes.thread_id as string,
      read: read.thread_id as string,
    },
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('Settings says nothing is archived yet', async () => {
  const { page } = world;
  await page.goto(new URL('#settings/archived', world.url).href);
  const block = page.locator('[data-settings-archived]');
  await expect(block.locator('[data-archived-empty]')).toContainText('Nothing archived.');
  await block.scrollIntoViewIfNeeded();
  await shot('01-settings-empty');
});

test('the archived open thread keeps its row until the person leaves; then no section holds it, while a read thread stays in Quiet', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  await expect(page.locator(`.ib-lbody [data-row="${threads.search}"]`)).toBeVisible();
  // Mark read (stays in Quiet) and archive three others from behind the window, through its own routes.
  await page.evaluate(async (id) => {
    const health = (await (await fetch('/api/inbox/health')).json()) as { serverSession: string };
    await fetch(`/api/inbox/threads/${id}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: health.serverSession }) });
  }, threads.read);
  await page.reload();
  await openQuiet(page);
  await expect(page.locator(`.ib-lbody [data-row="${threads.build}"]`)).toBeVisible();
  await shot('02-list-before');

  await page.locator(`.ib-lbody [data-thread-id="${threads.build}"]`).click();
  await page.locator('section.ib-pane').getByRole('button', { name: 'Archive the thread' }).click();
  await expect(page.locator('.ib-pfoot')).toContainText('Archived. The next message from');
  const held = page.locator(`.ib-lbody [data-row="${threads.build}"]`);
  await expect(held).toBeVisible();
  await expect(held).toContainText('Archived');
  await shot('03-archived-held', ['light']);

  await page.keyboard.press('Escape');
  await expect(page.locator(`.ib-lbody [data-row="${threads.build}"]`)).toHaveCount(0);
  await archive(page, threads.deploy);
  await archive(page, threads.notes);
  await page.reload();
  await openQuiet(page);
  await expect(page.locator(`.ib-lbody [data-row="${threads.search}"]`)).toBeVisible();
  const rows = await listed(page);
  for (const id of [threads.build, threads.deploy, threads.notes]) expect(rows).not.toContain(id);
  expect(rows).toContain(threads.read);
  await expect(page.locator('[data-section-id="quiet"]')).toContainText('Read');
  await shot('04-list-after');
});

test('Settings lists the archived threads newest first, grouped by project with counts', async () => {
  const { page, threads } = world;
  await page.goto(new URL('#settings/archived', world.url).href);
  const block = page.locator('[data-settings-archived]');
  await expect(block.locator('[data-archived-thread]')).toHaveCount(3);
  const order = await block.locator('[data-archived-thread]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-archived-thread')));
  // Grouped by project (newest archived project first), newest archived first inside each.
  expect(order).toEqual([threads.notes, threads.build, threads.deploy]);
  await expect(block.locator('[data-archived-count]')).toHaveText('3 archived threads');
  await expect(block.locator('select')).toHaveCount(0);
  await expect(block.locator('[data-archived-group] h3')).toHaveText(['billing · 2', 'docs-site · 1']);
  const billing = block.locator('[data-archived-group]').first().locator('[data-archived-thread]');
  expect(await billing.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-archived-thread')))).toEqual([threads.notes, threads.build]);
  await expect(block.locator('[data-archived-group]').nth(1)).toContainText('Preview deploy is up');
  await block.scrollIntoViewIfNeeded();
  await shot('05-settings-archived');
});

test('Unarchive opens the thread back in the main list', async () => {
  const { page, threads } = world;
  const block = page.locator('[data-settings-archived]');
  await block.locator(`[data-archived-thread="${threads.deploy}"]`).getByRole('button', { name: 'Unarchive Preview deploy is up' }).click();
  await expect(page).toHaveURL(new RegExp(`#thread=${threads.deploy}$`));
  await expect(page.locator('section.ib-pane').getByRole('heading', { name: 'Preview deploy is up' })).toBeVisible();
  await expect(page.locator('[data-inbox-toast]')).toContainText('Back in your Inbox');
  // Back in the list, in whatever section its state puts it: opening it was a look, so a news-only thread is Quiet.
  await openQuiet(page);
  await expect(page.locator(`.ib-lbody [data-row="${threads.deploy}"]`)).toBeVisible();
  await shot('06-unarchived-open', ['light']);
  await page.goto(new URL('#settings/archived', world.url).href);
  await expect(page.locator('[data-settings-archived] [data-archived-thread]')).toHaveCount(2);
  expect(world.errors).toEqual([]);
});

test("an agent's reply into an archived thread brings it back to the list and out of the Archived block", async () => {
  const { page, threads } = world;
  await page.goto(new URL('#settings/archived', world.url).href);
  const block = page.locator('[data-settings-archived]');
  await expect(block.locator(`[data-archived-thread="${threads.build}"]`)).toBeVisible();
  const claude = world.agents[0]!;
  await claude.send({
    project_path: world.billing,
    reply_to: threads.build,
    body: 'The nightly build broke again.\n\n:::question\nRoll back the last deploy?\n\n- [ ] Yes\n- [ ] No\n:::',
  });
  // The block reads again as the store moves: the thread leaves it.
  await expect(block.locator(`[data-archived-thread="${threads.build}"]`)).toHaveCount(0);
  await expect(block.locator('[data-archived-thread]')).toHaveCount(1);
  // Leaving Settings is an action: the list on screen catches up (held order).
  await page.locator('[data-settings-back]').click();
  const row = page.locator(`.ib-lbody [data-row="${threads.build}"]`);
  await expect(row).toBeVisible();
  await expect(page.locator(`[data-section-id="waiting"] [data-row="${threads.build}"]`)).toBeVisible();
  await shot('07-agent-reply-back');
  await page.locator(`.ib-lbody [data-thread-id="${threads.build}"]`).click();
  const pane = page.locator('section.ib-pane');
  await expect(page.locator('[data-came-back]')).toContainText('wrote after you archived it. Your reply goes to it; the thread stays archived.');
  await expect(pane).toContainText('Roll back the last deploy?');
  await shot('08-agent-reply-thread', ['light']);

  // Answered without unarchiving: pick, then Send.
  await pane.getByRole('radio', { name: /^Yes/ }).click();
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  await expect(pane.getByText(/^Sent /).first()).toBeVisible();
  await shot('09-came-back-answered', ['light']);
  const thread = await page.evaluate(async (id) => (await (await fetch(`/api/inbox/threads/${id}`)).json()) as { thread: { resolved_at: string | null; messages: { author: { kind: string }; body: string }[] } }, threads.build);
  expect(thread.thread.resolved_at).not.toBeNull();
  expect(thread.thread.messages.at(-1)).toMatchObject({ author: { kind: 'person' } });
  expect(thread.thread.messages.at(-1)!.body).toContain('Yes');
  expect(world.errors).toEqual([]);
});
