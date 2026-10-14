/**
 * The project menu (design record "inbox-project-menu", approved
 * 2026-10-14), in a real browser against the compiled binary, with agents
 * writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - ⋯ shows on keyboard focus; Enter opens the menu, the arrows move, and
 *    Escape puts focus back on ⋯;
 *  - Mark all as read takes every waiting thread of the project, warns that
 *    an agent was stopped, and Z undoes the whole batch;
 *  - Archive all from the keyboard hides the project, focus lands on Inbox
 *    (never the page), and the agent's next reply brings the project back;
 *  - a phone: ⋯ always shown in the navigation sheet, the menu a sheet.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in .local/proof/project-menu/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'project-menu');

const STOPPED = ['The retry worker waits on you.', '', ':::question', 'Retry on a 409?', '', 'Stopped: the worker cannot ship without this.', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
const ASK = ['One call for the docs.', '', ':::question', 'Which search index?', '', '- [ ] Pagefind', '- [ ] Orama', ':::'].join('\n');

interface World {
  url: string;
  billing: string;
  docs: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { worker: string; search: string; news: string; docs: string };
  messages: { search: string };
}

let world: World;

test.describe.configure({ mode: 'serial' });

const row = (page: Page, name: string) => page.locator('.ib-projrow', { has: page.locator('.ib-name', { hasText: new RegExp(`^${name}$`) }) });

async function sectionOf(page: Page, threadId: string): Promise<string | null> {
  return page.evaluate((id) => document.querySelector(`.ib-lbody [data-row="${id}"]`)?.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null, threadId);
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-projmenu-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const billing = scratchProject(join(root, 'src'), 'billing');
  const docs = scratchProject(join(root, 'src'), 'docs');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const worker = await agent.send({ project_path: billing, subject: 'Retry worker', thread: 'worker', body: STOPPED });
  const search = await agent.send({ project_path: billing, subject: 'Docs search', thread: 'search', body: ASK });
  const news = await agent.send({ project_path: billing, subject: 'Nightly is green', thread: 'news', body: 'The nightly build is green.' });
  const other = await agent.send({ project_path: docs, subject: 'Docs index', thread: 'docs', body: ASK });
  world = {
    url: started.stdout.trim(),
    billing,
    docs,
    agent,
    context,
    page,
    errors,
    threads: { worker: worker.thread_id as string, search: search.thread_id as string, news: news.thread_id as string, docs: other.thread_id as string },
    messages: { search: search.message_id as string },
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the keyboard reaches ⋯, Enter opens the menu, Escape gives focus back', async () => {
  const { page } = world;
  await page.goto(world.url);
  const billing = row(page, 'billing');
  await expect(billing).toBeVisible();
  const more = billing.locator('.ib-pmore');
  await expect(more).toHaveCSS('opacity', '0');
  await billing.locator('.ib-proj').focus();
  // The count steps aside for ⋯ for the eye only: a screen reader still hears it with the project.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(billing.locator('.ib-proj')).toBeFocused();
  await expect(more).toHaveCSS('opacity', '1');
  await expect(billing.locator('.ib-proj')).toHaveAccessibleName('billing 2');
  await page.keyboard.press('Tab');
  await expect(more).toBeFocused();
  await expect(more).toHaveCSS('opacity', '1');
  await expect(billing.locator('.ib-proj')).toHaveAccessibleName('billing 2');
  await page.keyboard.press('Enter');
  const menu = page.locator('[data-project-menu]');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Mark all as read', 'Archive all']);
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.screenshot({ path: join(proofDir, '01-menu-keyboard.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
});

test('Mark all as read takes every waiting thread, warns, and Z undoes the batch', async () => {
  const { page, threads } = world;
  await row(page, 'billing').locator('.ib-proj').click({ button: 'right' });
  await page.locator('[data-project-action="read"]').click();
  const toast = page.locator('[data-inbox-toast]');
  await expect(toast).toContainText('Marked 3 threads read');
  await expect(toast).toContainText('billing');
  await expect(toast).toContainText('Claude Code was stopped');
  await page.screenshot({ path: join(proofDir, '02-mark-all-read.png') });
  await page.locator('[data-section-id="quiet"] .ib-band').click();
  for (const id of [threads.worker, threads.search, threads.news]) await expect.poll(() => sectionOf(page, id)).toBe('quiet');
  // The other project is untouched.
  await expect.poll(() => sectionOf(page, threads.docs)).toBe('waiting');
  await page.keyboard.press('z');
  await expect.poll(() => sectionOf(page, threads.worker)).toBe('stopped');
  await expect.poll(() => sectionOf(page, threads.search)).toBe('waiting');
  await expect.poll(() => sectionOf(page, threads.news)).toBe('new');
});

test('Archive all hides the project, focus lands on Inbox, and the next reply brings it back', async () => {
  const { page, threads } = world;
  const billing = row(page, 'billing');
  await billing.locator('.ib-proj').focus();
  await page.keyboard.press('Tab');
  await expect(billing.locator('.ib-pmore')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-project-menu]')).toBeVisible();
  // Focus moves into the menu (its first item) a frame after it opens.
  await expect(page.locator('[data-project-action="read"]')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('[data-project-action="archive"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-inbox-toast]')).toContainText('Archived 3 threads');
  await expect(billing).toHaveCount(0);
  await expect(page.locator('.ib-nav', { hasText: 'Inbox' }).first()).toBeFocused();
  await page.screenshot({ path: join(proofDir, '03-archive-all-hidden.png') });
  // The agent answers in one of the archived threads: it comes back, and the project with it.
  await world.agent.send({ project_path: world.billing, body: 'One more thing on search.', reply_to: world.messages.search });
  await page.reload();
  await expect(row(page, 'billing')).toBeVisible();
  await expect.poll(() => sectionOf(page, threads.search)).toBe('new');
  expect(world.errors).toEqual([]);
});

test('a phone: ⋯ always shown in the sheet, the menu a sheet titled by the project', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(world.url);
  await page.locator('[data-sidebar="trigger"]').first().tap();
  const docs = row(page, 'docs');
  await expect(docs.locator('.ib-pmore')).toHaveCSS('opacity', '1');
  await docs.locator('.ib-pmore').tap();
  const menu = page.locator('[data-project-menu]');
  await expect(menu.locator('.ib-pm-title')).toHaveText('docs');
  const box = await menu.boundingBox();
  // A sheet from the bottom edge, across the screen.
  expect(box!.width).toBeGreaterThan(360);
  expect(box!.y + box!.height).toBeGreaterThan(844 - 24);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(proofDir, '04-phone-sheet.png') });
  await context.close();
});
