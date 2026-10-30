/**
 * The thread row's right-click menu, in a real Chromium against the compiled
 * binary, with an agent writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts):
 *
 *  - a right-click on a row opens the menu without opening the thread; Copy
 *    link puts the thread's address on the clipboard (read back here), Copy
 *    thread ID its id, each with a toast;
 *  - the keyboard: Shift+F10 on a focused row opens it, Escape and Tab put
 *    focus back on the row;
 *  - Mark read and Archive from the menu, with the row's own toasts.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * Screenshots at 1440, light and dark, land in /tmp/row-menu-shots/ (or
 * PLANNOTATOR_ROW_MENU_SHOTS).
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
const shots = resolve(process.env.PLANNOTATOR_ROW_MENU_SHOTS ?? '/tmp/row-menu-shots');

const ASK = ['One call for the docs.', '', ':::question', 'Which search index?', '', '- [ ] Pagefind', '- [ ] Orama', ':::'].join('\n');

interface World {
  url: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { search: string; news: string; release: string };
}

let world: World;

test.describe.configure({ mode: 'serial' });

const rowButton = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
const menu = (page: Page) => page.locator('[data-row-menu]');
/** A screenshot once the menu's and the toast's entrances have played. */
async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, name) });
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-rowmenu-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const billing = scratchProject(join(root, 'src'), 'billing');
  const docs = scratchProject(join(root, 'src'), 'docs');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const search = await agent.send({ project_path: docs, subject: 'Docs search', thread: 'search', body: ASK });
  const news = await agent.send({ project_path: billing, subject: 'Nightly is green', thread: 'news', body: 'The nightly build is green.' });
  const release = await agent.send({ project_path: billing, subject: 'Release notes drafted', thread: 'release', body: 'The 0.29 notes are drafted.' });
  world = {
    url,
    agent,
    context,
    page,
    errors,
    threads: { search: search.thread_id as string, news: news.thread_id as string, release: release.thread_id as string },
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

test('a right-click opens the menu without opening the thread; Copy link copies the thread address', async () => {
  const { page, threads } = world;
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(world.url);
  const row = rowButton(page, threads.search);
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Pin thread', 'Copy thread', 'Copy link', 'Copy thread ID', 'Mark read', 'Archive']);
  await expect(page.locator(`[data-row="${threads.search}"]`)).toHaveAttribute('data-menu', '');
  expect(page.url()).not.toContain('thread=');
  await shot(page, '01-menu-light.png');
  await page.locator('[data-row-action="copy-link"]').click();
  await expect(page.locator('[data-inbox-toast]')).toContainText('Link copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`${new URL(world.url).origin}/#thread=${threads.search}`);
  expect(copied).toMatch(/^http:\/\/localhost:\d+\/#thread=msg_/);
  expect(page.url()).not.toContain('thread=');
  await shot(page, '02-link-copied-light.png');
  await expect(page.locator(`[data-row="${threads.search}"]`)).not.toHaveAttribute('data-menu', '');
});

test('Copy thread ID copies the id', async () => {
  const { page, threads } = world;
  await rowButton(page, threads.news).click({ button: 'right' });
  await page.locator('[data-row-action="copy-id"]').click();
  await expect(page.locator('[data-inbox-toast]')).toContainText('Thread ID copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(threads.news);
});

test('the keyboard: Shift+F10 on a focused row opens the menu, Escape and Tab give focus back to the row', async () => {
  const { page, threads } = world;
  const row = rowButton(page, threads.news);
  await row.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toHaveAttribute('data-row-menu', threads.news);
  // Focus moves into the menu; the arrows walk its items.
  await expect(menu(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  // Pin thread leads (approval "inbox-pinned-threads"), then Copy thread and Copy link.
  await expect(page.locator('[data-row-action="pin"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-row-action="copy-thread"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-row-action="copy-link"]')).toBeFocused();
  await shot(page, '03-menu-keyboard-light.png');
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(row).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu(page)).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(page.url()).not.toContain('thread=');
});

test('focus held elsewhere (Search): Escape and Copy put it on the row, not back on Search', async () => {
  const { page, threads } = world;
  const search = page.locator('[data-open-search]').first();
  await search.focus();
  await rowButton(page, threads.search).click({ button: 'right' });
  await expect(menu(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(rowButton(page, threads.search)).toBeFocused();
  await search.focus();
  await rowButton(page, threads.search).click({ button: 'right' });
  await page.locator('[data-row-action="copy-id"]').click();
  await expect(rowButton(page, threads.search)).toBeFocused();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(threads.search);
  await expect(rowButton(page, threads.search)).toHaveAttribute('aria-keyshortcuts', 'Shift+F10');
});

test('Mark read from the menu moves the row to Quiet with its toast', async () => {
  const { page, threads } = world;
  await rowButton(page, threads.news).click({ button: 'right' });
  await page.locator('[data-row-action="read"]').click();
  const toast = page.locator('[data-inbox-toast]');
  await expect(toast).toContainText('Moved to Quiet');
  await expect(toast).toContainText('Nightly is green');
  await expect(page.locator('[data-section-id="quiet"]')).toBeVisible();
});

test('Archive from the menu takes the row out with the Archived toast; dark look', async () => {
  const { page, threads } = world;
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  const row = rowButton(page, threads.release);
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  await shot(page, '04-menu-dark.png');
  await page.locator('[data-row-action="archive"]').click();
  const toast = page.locator('[data-inbox-toast]');
  await expect(toast).toContainText('Archived');
  await expect(toast).toContainText('Release notes drafted');
  await expect(rowButton(page, threads.release)).toHaveCount(0);
  await shot(page, '05-archived-dark.png');
  // The search row's menu in dark, opened on the row at its right edge.
  await rowButton(page, threads.search).click({ button: 'right', position: { x: 1000, y: 10 } });
  await expect(menu(page)).toBeVisible();
  await page.locator('[data-row-action="copy-link"]').hover();
  await shot(page, '06-menu-hover-dark.png');
  await page.keyboard.press('Escape');
  expect(world.errors).toEqual([]);
});
