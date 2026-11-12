import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'project-rename');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

interface World {
  url: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { main: string; featX: string; fixY: string };
}

let world: World;

test.describe.configure({ mode: 'serial' });

const row = (page: Page, name: string) => page.locator('.ib-projrow', { has: page.locator('.ib-name', { hasText: new RegExp(`^${name}$`) }) });
const sidebarNames = (page: Page) => page.locator('.ib-projs .ib-name').allTextContents();
const field = (page: Page) => page.locator('[data-project-name-field]');
const menu = (page: Page) => page.locator('[data-project-menu]');

async function lightContext(browser: Browser, url: string, scheme: 'light' | 'dark' = 'light'): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  await context.addCookies([{ name: 'plannotator-theme', value: scheme, url }]);
  return context;
}

async function expectWholeRing(page: Page): Promise<void> {
  const room = await field(page).evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const clip = el.closest('.ib-sidescroll')!.getBoundingClientRect();
    const reach = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    return {
      drawn: style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) >= 2,
      left: box.left - reach - clip.left,
      right: clip.right - (box.right + reach),
      top: box.top - reach - clip.top,
      bottom: clip.bottom - (box.bottom + reach),
    };
  });
  expect(room.drawn).toBe(true);
  for (const side of ['left', 'right', 'top', 'bottom'] as const) expect(room[side], `the ring's ${side} edge`).toBeGreaterThanOrEqual(0);
}

async function rowProject(page: Page, threadId: string): Promise<string> {
  return (await page.locator(`.ib-lbody [data-row="${threadId}"] .ib-p`).first().textContent())?.trim() ?? '';
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-rename-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const main = join(root, 'code', 'acme', 'main');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  const featX = join(root, 'code', 'acme', 'feat-x');
  const fixY = join(root, 'code', 'acme', 'fix-y');
  git(main, 'worktree', 'add', '-q', featX, '-b', 'feat-x');
  git(main, 'worktree', 'add', '-q', fixY, '-b', 'fix-y');
  const billing = scratchProject(join(root, 'code'), 'billing-svc');
  const notes = scratchProject(join(root, 'code'), 'field-notes');
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await lightContext(browser, url);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const fromMain = await agent.send({ project_path: realpathSync(main), subject: 'Release notes drafted', thread: 'release', body: 'The 2.4 release notes are drafted from main.' });
  const fromFeat = await agent.send({ project_path: realpathSync(featX), subject: 'Export to CSV works', thread: 'csv', body: 'The CSV export on feat-x passes its worktree tests.' });
  const fromFix = await agent.send({ project_path: realpathSync(fixY), subject: 'Flaky retry test fixed', thread: 'retry', body: 'The retry test on fix-y is stable now.' });
  await agent.send({ project_path: billing, subject: 'Invoices reconciled', thread: 'invoices', body: 'The October invoices are reconciled.' });
  await agent.send({ project_path: notes, subject: 'Interview notes filed', thread: 'notes', body: 'Three interviews are filed under research.' });
  world = { url, agent, context, page, errors, threads: { main: fromMain.thread_id as string, featX: fromFeat.thread_id as string, fixY: fromFix.thread_id as string } };
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

test('Rename… from the sidebar menu: the sidebar, the rows, search and the project page read the new name', async ({ browser }: { browser: Browser }) => {
  const { page, threads } = world;
  await page.goto(world.url);
  await expect.poll(() => sidebarNames(page)).toEqual(expect.arrayContaining(['main', 'billing-svc', 'field-notes']));
  expect((await sidebarNames(page)).filter((name) => name === 'main')).toHaveLength(1);
  for (const id of [threads.main, threads.featX, threads.fixY]) await expect.poll(() => rowProject(page, id)).toBe('main');

  const main = row(page, 'main');
  await main.hover();
  await main.locator('.ib-pmore').click();
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Mark all as read', 'Archive all', 'Rename…']);
  await menu(page).locator('[data-project-action="rename"]').hover();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, '01-menu-rename-light.png') });
  await menu(page).locator('[data-project-action="rename"]').click();

  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue('main');
  await expect(field(page)).toHaveAttribute('placeholder', 'main');
  await page.keyboard.type('acme');
  await expect(field(page)).toHaveValue('acme');
  await page.mouse.move(900, 700);
  await expect(field(page)).toBeFocused();
  await page.screenshot({ path: join(proofDir, '02-field-typing-light.png') });
  await page.keyboard.press('Enter');

  await expect(field(page)).toHaveCount(0);
  await expect(row(page, 'acme')).toBeVisible();
  await expect(row(page, 'main')).toHaveCount(0);
  await expect(row(page, 'acme').locator('.ib-pmore')).toBeFocused();
  await expect(page.locator('[data-inbox-live]')).toHaveText('Renamed to acme.');
  for (const id of [threads.main, threads.featX, threads.fixY]) await expect.poll(() => rowProject(page, id)).toBe('acme');
  await page.mouse.move(900, 600);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, '03-sidebar-renamed-light.png') });

  await page.locator('.ib-side .ib-sp-entry').first().click();
  const palette = page.locator('dialog[data-search-palette]');
  await expect(palette).toBeVisible();
  await page.keyboard.type('acme');
  await expect(palette.locator('[data-search-group="projects"] [data-result="project"] .ib-sp-p').first()).toHaveText('acme');
  await palette.getByRole('combobox').fill('worktree');
  const hit = palette.locator('[data-result]').filter({ hasText: 'feat-x passes' }).first();
  await expect(hit).toContainText('acme');
  await expect(hit).not.toContainText('main');
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  await row(page, 'acme').locator('.ib-proj').click();
  await expect(page.locator('.ib-lhead-tt')).toHaveText('acme');

  const dark = await lightContext(browser, world.url, 'dark');
  const darkPage = await dark.newPage();
  await darkPage.goto(world.url);
  await expect(row(darkPage, 'acme')).toBeVisible();
  await darkPage.waitForTimeout(300);
  await darkPage.screenshot({ path: join(proofDir, '04-sidebar-renamed-dark.png') });
  await dark.close();
});

test('the name survives a reload', async () => {
  const { page } = world;
  await page.goto(world.url);
  await expect(row(page, 'acme')).toBeVisible();
  expect(await sidebarNames(page)).not.toContain('main');
});

test('Escape cancels: the name stays, focus is back on ⋯', async () => {
  const { page } = world;
  const acme = row(page, 'acme');
  await acme.locator('.ib-proj').click({ button: 'right' });
  await page.locator('[data-project-action="rename"]').click();
  await expect(field(page)).toBeFocused();
  await page.keyboard.type('zzz');
  await page.keyboard.press('Escape');
  await expect(field(page)).toHaveCount(0);
  await expect(row(page, 'acme')).toBeVisible();
  await expect(row(page, 'zzz')).toHaveCount(0);
  await expect(row(page, 'acme').locator('.ib-pmore')).toBeFocused();
  await row(page, 'acme').locator('.ib-proj').click({ button: 'right' });
  await page.locator('[data-project-action="rename"]').click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await expect(field(page)).toBeVisible();
  await expect(field(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('[data-inbox-live]')).toHaveText('A name cannot be empty.');
  const emoji = '🚀'.repeat(65);
  await field(page).fill(emoji);
  await expect(field(page)).toHaveValue(emoji);
  await page.keyboard.press('Enter');
  await expect(field(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('[data-inbox-live]')).toHaveText('A name can be at most 64 characters.');
  await page.keyboard.press('Escape');
  await expect(row(page, 'acme')).toBeVisible();
});

test('clicking into the reply box closes the field and leaves focus in the reply box', async () => {
  const { page, threads } = world;
  await page.locator(`.ib-lbody [data-thread-id="${threads.featX}"]`).click();
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  const reply = page.locator('.ib-rtext');
  await expect(reply).toBeVisible();
  await row(page, 'acme').locator('.ib-proj').click({ button: 'right' });
  await page.locator('[data-project-action="rename"]').click();
  await expect(field(page)).toBeFocused();
  await page.keyboard.type('zzz');
  await reply.click();
  await expect(field(page)).toHaveCount(0);
  await expect(reply).toBeFocused();
  await page.waitForTimeout(200);
  await expect(reply).toBeFocused();
  await expect(row(page, 'acme')).toBeVisible();
  await page.goto(world.url);
});

test('keyboard only: ⋯, the arrows to Rename…, typing, Enter', async () => {
  const { page } = world;
  const acme = row(page, 'acme');
  await acme.locator('.ib-proj').focus();
  await page.keyboard.press('Tab');
  await expect(acme.locator('.ib-pmore')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Mark all as read', 'Archive all', 'Rename…', 'Reset name']);
  await expect(page.locator('[data-project-action="read"]')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('[data-project-action="reset"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-project-action="rename"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(field(page)).toBeFocused();
  await page.keyboard.type('Acme Platform');
  await page.keyboard.press('Enter');
  await expect(row(page, 'Acme Platform')).toBeVisible();
  await expect(row(page, 'Acme Platform').locator('.ib-pmore')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('.ib-lhead-tt')).toHaveText('Acme Platform');
});

test('the focus ring is whole on every side: on the first and last rows, light and dark', async ({ browser }: { browser: Browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const context = await lightContext(browser, world.url, scheme);
    const page = await context.newPage();
    await page.goto(world.url);
    await expect(row(page, 'Acme Platform')).toBeVisible();
    for (const [where, target] of [['first', page.locator('.ib-projs .ib-projrow').first()], ['last', page.locator('.ib-projs .ib-projrow').last()]] as const) {
      await target.locator('.ib-proj').click({ button: 'right' });
      await page.locator('[data-project-action="rename"]').click();
      await expect(field(page)).toBeFocused();
      await expectWholeRing(page);
      await page.mouse.move(900, 700);
      const box = (await field(page).boundingBox())!;
      await page.screenshot({ path: join(proofDir, `ring-${scheme}-${where}.png`), clip: { x: Math.max(0, box.x - 12), y: box.y - 12, width: box.width + 24, height: box.height + 24 } });
      await page.keyboard.press('Escape');
      await expect(field(page)).toHaveCount(0);
    }
    await context.close();
  }
});

test('Reset name brings back "main", and the item goes until a name is set again', async () => {
  const { page, threads } = world;
  await row(page, 'Acme Platform').locator('.ib-proj').click({ button: 'right' });
  await page.locator('[data-project-action="reset"]').click();
  await expect(row(page, 'main')).toBeVisible();
  await expect(row(page, 'Acme Platform')).toHaveCount(0);
  await expect(page.locator('.ib-lhead-tt')).toHaveText('main');
  await expect(page.locator('[data-inbox-live]')).toHaveText('Name reset to main.');
  await page.locator('.ib-nav', { hasText: 'Inbox' }).first().click();
  for (const id of [threads.main, threads.fixY]) await expect.poll(() => rowProject(page, id)).toBe('main');
  await row(page, 'main').locator('.ib-proj').click({ button: 'right' });
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Mark all as read', 'Archive all', 'Rename…']);
  await page.keyboard.press('Escape');
  expect(world.errors).toEqual([]);
});

test('a phone: Rename… in the menu sheet, the field in the navigation sheet', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, colorScheme: 'light' });
  await context.addCookies([{ name: 'plannotator-theme', value: 'light', url: world.url }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(world.url);
  await page.locator('[data-sidebar="trigger"]').first().tap();
  const main = row(page, 'main');
  await expect(main.locator('.ib-pmore')).toHaveCSS('opacity', '1');
  await main.locator('.ib-pmore').tap();
  await expect(menu(page).locator('.ib-pm-title')).toHaveText('main');
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Mark all as read', 'Archive all', 'Rename…']);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(proofDir, '05-phone-menu.png') });
  await page.locator('[data-project-action="rename"]').tap();
  await expect(field(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
  expect((await field(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expectWholeRing(page);
  await field(page).fill('acme');
  await page.screenshot({ path: join(proofDir, '06-phone-field.png') });
  await page.keyboard.press('Enter');
  await expect(row(page, 'acme')).toBeVisible();
  await expect(row(page, 'acme')).toBeInViewport();
  expect(errors).toEqual([]);
  await context.close();
});
