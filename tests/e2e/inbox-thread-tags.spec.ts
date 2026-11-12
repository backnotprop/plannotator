/**
 * Thread tags (approval "inbox-thread-tags", step 1) in a real browser against the compiled binary, with agents
 * writing through `plannotator inbox mcp` (scripts/inbox-sim.ts), the Board off (its default):
 *
 *  - no Tags section until something is tagged;
 *  - right-click a row → Add tag → type a new name → Enter: the tag is made, the thread is in it, the toast says so,
 *    and the sidebar's Tags section appears under Starred, above Agents;
 *  - a second thread ticked into the same tag from its ⋯ menu; the menu stays open while ticking;
 *  - the tag's list (`#tag=`): its threads in the Inbox's groups, the header's "2 threads · 2 projects"; Remove from
 *    takes a thread out; Inbox leaves the list;
 *  - right-click the sidebar tag: Rename in place; Delete tag, then Undo brings it back with its thread.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { notes: string; signing: string; index: string };
}

let world: World;

test.describe.configure({ mode: 'serial' });

const rowButton = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
const rowMenu = (page: Page) => page.locator('[data-row-menu]');
const tagRows = (page: Page) => page.locator('[data-tag-row]');
const toast = (page: Page) => page.locator('[data-inbox-toast]');

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-thread-tags-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const src = join(root, 'src');
  const plannotator = scratchProject(src, 'plannotator');
  const installer = scratchProject(src, 'win-installer');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const index = await codex.send({ project_path: plannotator, subject: 'Search index rebuild', body: 'Rebuilt in 42 s. Results look right.' });
  const signing = await claude.send({ project_path: installer, subject: 'MSI signing', body: 'Signed with the new cert.' });
  const notes = await claude.send({ project_path: plannotator, subject: 'Release notes 0.29', body: 'Draft notes are ready. 14 PRs, 6 contributors.' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = {
    url: started.stdout.trim(),
    agents: [claude, codex],
    context,
    page,
    errors,
    threads: { notes: notes.thread_id as string, signing: signing.thread_id as string, index: index.thread_id as string },
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

test('Add tag from the row menu makes a tag and tags the thread; the Tags section appears above Agents', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  await expect(rowButton(page, threads.notes)).toBeVisible();
  // Nothing tagged: no section at all.
  await expect(page.locator('[data-tags-section]')).toHaveCount(0);

  await rowButton(page, threads.notes).click({ button: 'right' });
  await expect(rowMenu(page).getByRole('menuitem').nth(1)).toHaveText('Add tag');
  await rowMenu(page).locator('[data-add-tag-item]').click();
  const field = rowMenu(page).locator('[data-tag-find]');
  await expect(field).toBeFocused();
  await expect(rowMenu(page).locator('[data-add-tag-back]')).toHaveText('Add tag');
  await field.fill('Release');
  await expect(rowMenu(page).locator('[data-tag-new]')).toHaveText('New tag “Release”');
  await field.press('Enter');
  await expect(toast(page)).toContainText('Tagged');
  await expect(toast(page)).toContainText('Release');
  // The menu stays open, the new tag ticked.
  await expect(rowMenu(page).locator('[data-tag-pick][aria-checked="true"]')).toHaveText(/^Release/);
  await page.keyboard.press('Escape');

  await expect(tagRows(page)).toHaveText(['Release']);
  const headings = await page.locator('.ib-side-sec-l').allTextContents();
  expect(headings.indexOf('Tags')).toBe(headings.indexOf('Agents') - 1);
  expect(world.errors).toEqual([]);
});

test('the thread’s ⋯ ticks a second thread into the tag; the tag’s list shows both, then Remove from takes one out', async () => {
  const { page, threads } = world;
  await rowButton(page, threads.signing).click();
  await page.locator('[data-thread-more]').click();
  await page.locator('[data-thread-menu] [data-add-tag-item]').click();
  const pick = page.locator('[data-thread-menu] [data-tag-pick]').filter({ hasText: 'Release' });
  await pick.click();
  await expect(pick).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  await tagRows(page).filter({ hasText: 'Release' }).click();
  await expect(page).toHaveURL(/#tag=ini_/);
  await expect(page.locator('.ib-lhead h1')).toContainText('Release');
  await expect(page.locator('[data-list-title-note]')).toHaveText('2 threads · 2 projects');
  // MSI signing was read when it opened, so it sits in Quiet, folded by default: open the band to see its row.
  const quiet = page.locator('[data-section-id="quiet"] .ib-band');
  if ((await quiet.count()) > 0 && (await quiet.getAttribute('aria-expanded')) === 'false') await quiet.click();
  await expect(rowButton(page, threads.notes)).toBeVisible();
  await expect(rowButton(page, threads.signing)).toBeVisible();
  await expect(rowButton(page, threads.index)).toHaveCount(0);

  await rowButton(page, threads.signing).click({ button: 'right' });
  await rowMenu(page).locator('[data-tag-remove]').click();
  await expect(toast(page)).toContainText('Removed');
  await expect(rowButton(page, threads.signing)).toHaveCount(0);
  await expect(page.locator('[data-list-title-note]')).toHaveText('1 thread · 1 project');

  // Inbox leaves the tag's list.
  await page.locator('[data-inbox-nav]').click();
  await expect(rowButton(page, threads.index)).toBeVisible();
  expect(world.errors).toEqual([]);
});

test('a sidebar tag renames in place, and Delete tag’s Undo brings it back with its thread', async () => {
  const { page, threads } = world;
  await tagRows(page).filter({ hasText: 'Release' }).click({ button: 'right' });
  await page.locator('[data-tag-menu] [data-tag-action="rename"]').click();
  const name = page.locator('[data-tag-name-field]');
  await expect(name).toBeFocused();
  await name.fill('Ship 0.29');
  await name.press('Enter');
  await expect(tagRows(page)).toHaveText(['Ship 0.29']);

  await tagRows(page).first().click({ button: 'right' });
  await page.locator('[data-tag-menu] [data-tag-action="delete"]').click();
  await expect(toast(page)).toContainText('Deleted');
  await expect(page.locator('[data-tags-section]')).toHaveCount(0);
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(tagRows(page)).toHaveText(['Ship 0.29']);
  await tagRows(page).first().click();
  await expect(rowButton(page, threads.notes)).toBeVisible();
  expect(world.errors).toEqual([]);
});
