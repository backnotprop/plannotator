import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { removeInboxScratch } from './inbox-scratch';
import { seedShapeWorld, type ShapeWorld } from './inbox-shape-seed';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_SHAPE_SHOTS ?? '/tmp/shape-inbox');
const { defaultBrowserType: _phoneBrowser, ...phone } = devices['iPhone 15'];

const worlds: ShapeWorld[] = [];
test.beforeAll(() => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
});
test.afterAll(async () => {
  for (const world of worlds) for (const agent of world.agents) await agent.close().catch(() => {});
  await removeInboxScratch();
});

async function world(options: Parameters<typeof seedShapeWorld>[0] extends infer O ? Omit<O, 'binary'> : never): Promise<ShapeWorld> {
  const w = await seedShapeWorld({ binary, ...options });
  worlds.push(w);
  return w;
}

async function open(browser: Browser, w: ShapeWorld, options: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await context.grantPermissions(['notifications', 'clipboard-read', 'clipboard-write'], { origin: new URL(w.url).origin });
  await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => route.abort());
  await context.addInitScript(() => {
    (window as unknown as { __opened: unknown[] }).__opened = [];
    window.open = ((...args: unknown[]) => {
      (window as unknown as { __opened: unknown[] }).__opened.push(args);
      return null;
    }) as typeof window.open;
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

async function shot(page: Page, name: string, scheme: 'light' | 'dark' | 'both' = 'both') {
  for (const s of scheme === 'both' ? (['light', 'dark'] as const) : [scheme]) {
    await page.emulateMedia({ colorScheme: s });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, `${name}-${s}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const navOrder = (page: Page) => page.locator('.ib-side .ib-nav').evaluateAll((els) => els.map((el) => el.getAttribute('data-shape-nav') !== null ? 'Shape' : el.getAttribute('data-board-nav') !== null ? 'Board' : el.classList.contains('ib-nav-inbox') ? 'Inbox' : null).filter(Boolean));

test('on with 4 boards: the row under Board, the grid, the Pebble, the board over the thread, links kept in, a change delivered', async ({ browser }) => {
  const w = await world({ shape: true, boards: 'many' });
  const { context, page, errors } = await open(browser, w);
  const ownStreams: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/shapes/events') ownStreams.push(request.url());
  });
  await page.goto(w.url);
  const row = page.locator('[data-shape-nav]');
  await expect(row).toBeVisible();
  expect(await navOrder(page)).toEqual(['Inbox', 'Board', 'Shape']);
  await expect(row.locator('.ib-n')).toHaveText('4');

  await page.goto(`${w.url}#thread=${w.threads.snooze}`);
  const pebble = page.locator(`[data-shape-pebble="${w.boards.snooze}"]`);
  await expect(pebble).toBeVisible();
  await expect(pebble.locator('.ib-shape-dot')).toBeVisible();
  await shot(page, 'thread-pebble');

  await pebble.click();
  const layer = page.locator(`[data-shape-layer="${w.boards.snooze}"]`);
  await expect(layer.getByRole('heading', { name: 'A one-time Snooze announcement' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#thread=${w.threads.snooze}&shape=${w.boards.snooze}$`));
  await page.waitForTimeout(2500);
  await shot(page, 'board-over-thread');
  await expect(row.locator('.ib-n')).toHaveText('3');

  const before = page.url();
  await layer.locator('[data-link="hash"]').click();
  await page.waitForTimeout(200);
  expect(page.url()).toBe(before);
  await layer.locator('[data-link="out"]').click();
  expect(page.url()).toBe(before);
  expect(await page.evaluate(() => (window as unknown as { __opened: unknown[][] }).__opened)).toEqual([['https://example.com/notes', '_blank', 'noopener,noreferrer']]);

  await layer.getByRole('button', { name: 'Chat' }).click();
  await layer.getByRole('tab', { name: 'Thread' }).click();
  await expect(layer.locator('[data-shape-message]')).toContainText('It shows once, ever, after 2 days of use.');
  await page.waitForTimeout(400);
  await shot(page, 'board-thread-tab', 'light');
  await layer.getByRole('button', { name: 'Close panel' }).click();

  const noted = await page.request.post(`${w.url}api/shapes/${w.boards.snooze}/notes`, { data: { kind: 'change', v: 1, view: 'picture', part: 'row-1', text: 'Make it Thursday' } });
  expect(noted.status()).toBe(200);
  await expect(layer.locator('.shp-pill.waits')).toHaveText(/1 change waits for the agent/);
  const read = w.shape(['read', w.boards.snooze!, '--notes']);
  expect(read.status, read.stderr).toBe(0);
  expect(read.stdout).toContain('Make it Thursday');
  await expect(layer.locator('.shp-pill.waits')).toHaveCount(0);

  await layer.getByRole('button', { name: 'Close Shape' }).click();
  await expect(layer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#thread=${w.threads.snooze}$`));
  await pebble.click();
  await expect(layer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
  await pebble.click();
  await expect(layer).toBeVisible();
  await page.goBack();
  await expect(layer).toHaveCount(0);

  await row.click();
  await expect(page).toHaveURL(/#shapes$/);
  const cards = page.locator('[data-shape-page] .shp-gcard');
  await expect(cards).toHaveCount(4);
  await page.waitForTimeout(800);
  await shot(page, 'sidebar-row-and-grid');
  await page.getByRole('searchbox', { name: 'Find by title or project' }).fill('relay');
  await expect(cards).toHaveCount(1);
  await cards.first().click();
  await expect(page).toHaveURL(new RegExp(`#thread=${w.threads.kettle}&shape=${w.boards.kettle}$`));
  await expect(page.locator(`[data-shape-layer="${w.boards.kettle}"]`)).toBeVisible();

  expect(ownStreams).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

test('Board off: the Shape row sits directly under Inbox', async ({ browser }) => {
  const w = await world({ shape: true, board: false, boards: 'many' });
  const { context, page } = await open(browser, w);
  await page.goto(w.url);
  await expect(page.locator('[data-shape-nav]')).toBeVisible();
  expect(await navOrder(page)).toEqual(['Inbox', 'Shape']);
  await shot(page, 'board-off');
  await context.close();
});

test('fewer than 3 boards: no row, and ⌘K finds a board with its project and "no thread"', async ({ browser }) => {
  const w = await world({ shape: true, boards: 'few' });
  const { context, page } = await open(browser, w);
  await page.goto(w.url);
  await expect(page.locator('[data-board-nav]')).toBeVisible();
  await expect(page.locator('[data-shape-nav]')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.locator('[data-search-palette]');
  await palette.getByRole('combobox').fill('night');
  const found = palette.locator('[data-result="shape"]');
  await expect(found).toHaveCount(1);
  await expect(found).toContainText('Night mode for the reader');
  await expect(found).toContainText('pando · no thread');
  await expect(found.locator('.shp-thumb-in')).toHaveCount(1);
  await expect(palette.getByText('Shape', { exact: true })).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, 'cmdk-shape');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#shapes&shape=${w.boards.night}$`));
  await expect(page.locator(`[data-shape-layer="${w.boards.night}"]`)).toBeVisible();
  await context.close();
});

test('Shape off: no row, no Pebble, no ⌘K group, #shapes goes to the Inbox, every route a 404', async ({ browser }) => {
  const w = await world({ shape: false, boards: 'many' });
  const { context, page } = await open(browser, w);
  const shapeReads: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/shapes')) shapeReads.push(request.url());
  });
  await page.goto(`${w.url}#thread=${w.threads.snooze}`);
  await expect(page.getByText('It shows once, ever, after 2 days of use.')).toBeVisible();
  await expect(page.locator('[data-shape-pebble]')).toHaveCount(0);
  await expect(page.locator('[data-shape-nav]')).toHaveCount(0);
  await shot(page, 'shape-off');
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('[data-search-palette]').getByRole('combobox').fill('night');
  await page.waitForTimeout(800);
  await expect(page.locator('[data-result="shape"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto(`${w.url}#shapes`);
  await expect(page).not.toHaveURL(/#shapes/);
  expect(shapeReads).toEqual([]);
  for (const path of ['api/shapes', `api/shapes/${w.boards.snooze}`, 'api/shapes/events']) expect((await page.request.get(`${w.url}${path}`)).status()).toBe(404);
  expect((await page.request.post(`${w.url}api/shapes/${w.boards.snooze}/notes`, { data: { kind: 'change', v: 1, view: 'picture', text: 'x' } })).status()).toBe(404);
  const cli = w.shape(['--help']);
  expect(cli.status).toBe(1);
  expect(cli.stdout).toBe('');
  await context.close();
});

test('phone: the Pebble in the thread header, the board over the thread, the grid', async ({ browser }) => {
  const w = await world({ shape: true, boards: 'many' });
  const { context, page, errors } = await open(browser, w, { ...phone });
  await page.goto(`${w.url}#thread=${w.threads.snooze}`);
  const pebble = page.locator(`[data-shape-pebble="${w.boards.snooze}"]`);
  await expect(pebble).toBeVisible();
  await shot(page, 'phone-thread-pebble');
  await pebble.click();
  await expect(page.locator(`[data-shape-layer="${w.boards.snooze}"]`)).toBeVisible();
  await page.waitForTimeout(2500);
  await shot(page, 'phone-board-over-thread');
  await page.goto(`${w.url}#shapes`);
  await expect(page.locator('[data-shape-page] .shp-gcard')).toHaveCount(4);
  await page.waitForTimeout(800);
  await shot(page, 'phone-grid');
  expect(errors).toEqual([]);
  await context.close();
});
