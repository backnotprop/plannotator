/**
 * The Board card's right-click menu (approval "inbox-board-card-menu",
 * layout A, with the toast and Undo the owner said yes to) in a real Chromium
 * against the compiled binary, agents writing cards through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - a right-click on a lane card opens Open thread, the five lanes (its own
 *    checked), Shipped, Icebox, Drop…; on an iced card Restore to <where it
 *    was> and Drop…; it never opens the card;
 *  - a lane picked moves the card (the store too), with no toast, focus
 *    following the card into its new lane;
 *  - Icebox, Shipped and a Drop the menu started each show the one toast;
 *    its Undo (and `Z`) puts the card back where it was, in the store too,
 *    and focus on the card in its lane (a drop from the Icebox page back
 *    on ice); a card moved on while the toast is up: Undo sends nothing;
 *  - links in the Board body keep the platform's long-press callout;
 *  - Drop… opens the card with the reason field focused;
 *  - moves from the opened card (its Move menu, its foot) show no toast;
 *  - Shift+F10 on a focused card opens it; Escape and Tab give focus back;
 *  - empty lane space, a lane heading, the opened card and a Dropped row keep
 *    the browser's own menu;
 *  - a touch phone never opens it (a touch `contextmenu`, a long press);
 *  - the thread rows' menu, which shares the trigger's code, still works.
 *
 * The Inbox runs in a temp data dir with PLANNOTATOR_TEST_SANDBOX (its agent
 * home inside that dir) and PLANNOTATOR_INBOX_CONNECT=0; no card links a PR,
 * so nothing asks a forge. Full-window shots (1440 × 900 @2x) land in
 * PLANNOTATOR_BOARD_CARD_MENU_SHOTS (default /tmp/board-card-menu-shots).
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_BOARD_CARD_MENU_SHOTS ?? '/tmp/board-card-menu-shots');

interface World {
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  ids: Record<string, string>;
  ticksThread: string;
}

let world: World;

test.describe.configure({ mode: 'serial' });

const cardEl = (page: Page, id: string) => page.locator(`.ib-bcard[data-card-id="${id}"]`);
const cardButton = (page: Page, id: string) => cardEl(page, id).locator('[data-card-open]');
const laneCard = (page: Page, column: string, id: string) => page.locator(`.ib-blanes [data-lane="${column}"] .ib-bcard[data-card-id="${id}"]`);
const menu = (page: Page) => page.locator('[data-card-context-menu]');
const menuItems = (page: Page) => menu(page).locator('[role="menuitem"], [role="menuitemradio"]');
const toast = (page: Page) => page.locator('[data-inbox-toast]');

/** The card as the store has it now (the window's own read). */
const stored = (page: Page, id: string) =>
  page.evaluate(async (cardId) => {
    const model = (await (await fetch('/api/inbox/cards')).json()) as { cards: { id: string; column: string; aside_from: string | null; dropped: { reason: string | null } | null }[] };
    return model.cards.find((c) => c.id === cardId) ?? null;
  }, id);

/** A person's move through the window's own route (setup only; the menu is what is under test). */
const personMove = (page: Page, id: string, change: Record<string, unknown>) =>
  page.evaluate(
    async ({ cardId, body }) => {
      const res = await fetch(`/api/inbox/cards/${encodeURIComponent(cardId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`move ${cardId}: ${res.status} ${await res.text()}`);
    },
    { cardId: id, body: change },
  );

/** Record every `contextmenu` at the window (capture), to read later whether the page cancelled it. */
const watchContextMenus = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __ctx: Event[] };
    w.__ctx = [];
    window.addEventListener('contextmenu', (event) => w.__ctx.push(event), true);
  });
/** Whether the last `contextmenu` was cancelled (ours opened) or left to the browser (its own menu). */
const lastContextMenuCancelled = (page: Page) => page.evaluate(() => (window as unknown as { __ctx: Event[] }).__ctx.at(-1)?.defaultPrevented ?? null);

async function shot(page: Page, name: string) {
  // The menu's and the toast's entrances have played.
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(shots, name) });
}

/** No toast shows within a moment (a move that should say nothing but the live region). */
async function expectNoToast(page: Page) {
  await page.waitForTimeout(600);
  await expect(toast(page)).toHaveCount(0);
}

async function openMenu(page: Page, id: string): Promise<Locator> {
  await cardEl(page, id).click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toHaveAttribute('data-card-context-menu', id);
  return menu(page);
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-board-card-menu-e2e-');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  // The Board on, its first-visit dialog already seen (inbox-board.spec.ts proves both).
  writeFileSync(join(data, 'config.json'), JSON.stringify({ inboxBoard: true, inboxBoardIntro: { shownAt: new Date().toISOString() } }));
  // No HOME of our own: PLANNOTATOR_TEST_SANDBOX gives the Inbox a scratch agent home inside its data dir.
  const env = {
    PATH: process.env.PATH ?? '',
    PLANNOTATOR_DATA_DIR: data,
    PLANNOTATOR_TEST_SANDBOX: '1',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const project = scratchProject(join(root, 'src'), 'plannotator');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  // A card call never makes a project: a message does.
  const ticks = await claude.send({ project_path: project, subject: 'Phone pairing: QR screens', thread: 'qr', body: 'The QR screens are drawn; screenshots next.' });
  await codex.send({ project_path: project, subject: 'Export a guided review', body: 'Export is wired.' });
  const make = async (agent: SimAgent, title: string, fields: Record<string, unknown> = {}) =>
    ((await agent.card({ op: 'create', project_path: project, title, ...fields })).card as { id: string }).id;
  const ids: Record<string, string> = {};
  // The designer's sandbox Board (NOTES.md pictures), oldest first so the lanes read as they did.
  ids.offline = await make(pi, 'Offline drafts');
  ids.slack = await make(claude, 'Slack bridge', { column: 'building' });
  ids.dark = await make(pi, 'Dark mode for guides');
  ids.retry = await make(codex, 'Retry on a flaky relay');
  ids.menu = await make(claude, 'Board card menu', { column: 'designing' });
  ids.search = await make(codex, 'Settings search', { column: 'your_look', you: 'Pick a layout' });
  ids.export = await make(pi, 'Export a guided review', { column: 'building' });
  ids.qr = await make(claude, 'Phone pairing QR', { column: 'building', thread_id: ticks.thread_id });
  ids.vite = await make(codex, 'vite 8 for the review app', { column: 'your_review', you: 'Merge #2412' });
  ids.tab = await make(claude, 'Unread count on the tab', { column: 'shipped' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { url: started.stdout.trim(), agents: [claude, codex, pi], context, page, errors, ids, ticksThread: ticks.thread_id as string };
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${world.url}#board`);
  await expect(cardEl(page, ids.qr)).toBeVisible();
  // One card already on ice, as the designer's Board had it.
  await personMove(page, ids.offline, { op: 'icebox' });
  await expect(cardEl(page, ids.offline)).toHaveCount(0);
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

test('a right-click on a lane card opens the approved items, its column checked, without opening the card', async () => {
  const { page, ids } = world;
  const popup = await openMenu(page, ids.qr);
  // The approved words and order (layout A), pinned on purpose: the opened card's Move menu, word for word.
  await expect(menuItems(page)).toHaveText(['Open thread', 'Backlog', 'Designing', 'Your look', 'Building', 'Your review', 'Shipped', 'Icebox', 'Drop…']);
  await expect(popup).toHaveAttribute('aria-label', 'Phone pairing QR');
  await expect(popup.getByRole('group', { name: 'Column' })).toBeVisible();
  await expect(popup.getByRole('menuitemradio', { name: 'Building' })).toHaveAttribute('aria-checked', 'true');
  await expect(popup.getByRole('menuitemradio', { name: 'Designing' })).toHaveAttribute('aria-checked', 'false');
  await expect(cardEl(page, ids.qr)).toHaveAttribute('data-menu', '');
  expect(page.url()).not.toContain('card=');
  await page.mouse.move(5, 5);
  await shot(page, '01-menu-lane-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, '02-menu-lane-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(cardEl(page, ids.qr)).not.toHaveAttribute('data-menu', '');
  // A card that links no thread has no Open thread.
  await openMenu(page, ids.dark);
  await expect(menuItems(page).first()).toHaveText('Backlog');
  await expect(menuItems(page)).toHaveCount(8);
  await page.keyboard.press('Escape');
});

test('Shift+F10 on a focused card opens it; Escape and Tab give focus back to the card', async () => {
  const { page, ids } = world;
  const button = cardButton(page, ids.qr);
  await expect(button).toHaveAttribute('aria-keyshortcuts', 'Shift+F10');
  // A click opens the card, so the card is never announced as a menu button.
  await expect(button).not.toHaveAttribute('aria-haspopup', /.*/);
  await button.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toHaveAttribute('data-card-context-menu', ids.qr);
  await expect(menu(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu(page).locator('[data-card-menu-action="thread"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu(page)).toHaveCount(0);
  await expect(button).toBeFocused();
  expect(page.url()).not.toContain('card=');
});

test('a lane picked moves the card, in the store too, with no toast; focus follows the card into its lane', async () => {
  const { page, ids } = world;
  await openMenu(page, ids.export);
  await menu(page).locator('[data-card-menu-to="your_review"]').click();
  await expect(laneCard(page, 'your_review', ids.export)).toBeVisible();
  await expect(laneCard(page, 'building', ids.export)).toHaveCount(0);
  expect((await stored(page, ids.export))?.column).toBe('your_review');
  await expect(cardButton(page, ids.export)).toBeFocused();
  await expectNoToast(page);
  // The card's own column does nothing.
  await openMenu(page, ids.export);
  await menu(page).locator('[data-card-menu-to="your_review"]').click();
  await expect(menu(page)).toHaveCount(0);
  expect((await stored(page, ids.export))?.column).toBe('your_review');
});

test('Icebox from the menu: the toast, then Undo (and Z) put the card back in its lane, the store too, focus on it', async () => {
  const { page, ids } = world;
  await openMenu(page, ids.slack);
  await menu(page).locator('[data-card-menu-to="icebox"]').click();
  await expect(toast(page)).toContainText('Moved to Icebox');
  await expect(toast(page)).toContainText('“Slack bridge”');
  await expect(cardEl(page, ids.slack)).toHaveCount(0);
  expect(await stored(page, ids.slack)).toMatchObject({ column: 'icebox', aside_from: 'building' });
  // The card left the lane: focus goes to the card now in its slot there.
  await expect(cardButton(page, ids.qr)).toBeFocused();
  await page.mouse.move(5, 5);
  await shot(page, '04-after-icebox-toast-light.png');
  await toast(page).locator('[data-toast-undo]').click();
  await expect(toast(page)).toHaveCount(0);
  await expect(laneCard(page, 'building', ids.slack)).toBeVisible();
  expect((await stored(page, ids.slack))?.column).toBe('building');
  await expect(cardButton(page, ids.slack)).toBeFocused();
  // The same with the toast's existing key.
  await openMenu(page, ids.slack);
  await menu(page).locator('[data-card-menu-to="icebox"]').click();
  await expect(toast(page)).toContainText('Moved to Icebox');
  await expect(cardEl(page, ids.slack)).toHaveCount(0);
  await page.keyboard.press('z');
  await expect(toast(page)).toHaveCount(0);
  await expect(laneCard(page, 'building', ids.slack)).toBeVisible();
  expect((await stored(page, ids.slack))?.column).toBe('building');
  await expect(cardButton(page, ids.slack)).toBeFocused();
});

test('Shipped from the menu: the toast, and Undo moves the card back to the lane it came from', async () => {
  const { page, ids } = world;
  await openMenu(page, ids.menu);
  await menu(page).locator('[data-card-menu-to="shipped"]').click();
  await expect(toast(page)).toContainText('Shipped');
  await expect(toast(page)).toContainText('“Board card menu”');
  await expect(cardEl(page, ids.menu)).toHaveCount(0);
  expect((await stored(page, ids.menu))?.column).toBe('shipped');
  await toast(page).locator('[data-toast-undo]').click();
  await expect(laneCard(page, 'designing', ids.menu)).toBeVisible();
  expect((await stored(page, ids.menu))?.column).toBe('designing');
  await expect(cardButton(page, ids.menu)).toBeFocused();
});

test('a card moved on while its toast is up: Undo sends nothing and says it has moved since', async () => {
  const { page, ids } = world;
  await openMenu(page, ids.menu);
  await menu(page).locator('[data-card-menu-to="shipped"]').click();
  await expect(toast(page)).toContainText('Shipped');
  // Moved on elsewhere (as an agent would) while the toast is up; the window hears of it.
  await personMove(page, ids.menu, { op: 'move', column: 'your_review' });
  await expect(laneCard(page, 'your_review', ids.menu)).toBeVisible();
  const posts: string[] = [];
  const watch = (request: import('@playwright/test').Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/inbox/cards/')) posts.push(request.url());
  };
  page.on('request', watch);
  await toast(page).locator('[data-toast-undo]').click();
  await expect(toast(page)).toContainText('It has moved since');
  await expect(toast(page)).toContainText('“Board card menu”');
  await page.waitForTimeout(600);
  page.off('request', watch);
  expect(posts).toEqual([]);
  expect((await stored(page, ids.menu))?.column).toBe('your_review');
  await toast(page).locator('[data-toast-dismiss]').click();
  await personMove(page, ids.menu, { op: 'move', column: 'designing' });
  await expect(laneCard(page, 'designing', ids.menu)).toBeVisible();
});

test('links in the Board body keep the platform’s long-press callout (Base UI’s trigger turns it off)', async () => {
  const { page, ids } = world;
  await personMove(page, ids.qr, { op: 'edit', notes: 'Spec: https://example.com/qr-spec' });
  await cardButton(page, ids.qr).click();
  const panel = page.locator(`[data-card-panel="${ids.qr}"]`);
  const link = panel.locator('a[href="https://example.com/qr-spec"]');
  await expect(link).toBeVisible();
  const callout = await link.evaluate((el) => {
    // The value the link inherits: the nearest inline one up the tree (Base UI's trigger sets `none` there).
    let inline: string | null = null;
    for (let node: HTMLElement | null = el as HTMLElement; node && !inline; node = node.parentElement) {
      const style = node.style as CSSStyleDeclaration & { WebkitTouchCallout?: string; webkitTouchCallout?: string };
      inline = style.WebkitTouchCallout || style.webkitTouchCallout || style.getPropertyValue('-webkit-touch-callout') || null;
    }
    const computed = getComputedStyle(el) as CSSStyleDeclaration & { webkitTouchCallout?: string };
    // iOS-only: desktop WebKit and Chromium do not know the property.
    return { inline, supported: CSS.supports('-webkit-touch-callout', 'none'), computed: computed.webkitTouchCallout ?? '' };
  });
  expect(callout.inline).toBe('default');
  if (callout.supported) expect(callout.computed).not.toBe('none');
  await page.evaluate(() => (location.hash = '#board'));
  await expect(panel).toHaveCount(0);
});

test('Drop… opens the card with the reason field focused; the drop shows the toast and Undo restores it', async () => {
  const { page, ids } = world;
  await openMenu(page, ids.dark);
  await menu(page).locator('[data-card-menu-action="drop"]').click();
  const panel = page.locator(`[data-card-panel="${ids.dark}"]`);
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-drop-reason]')).toBeFocused();
  await page.keyboard.type('Folded into the theme work');
  await page.keyboard.press('Enter');
  await expect(toast(page)).toContainText('Dropped');
  await expect(toast(page)).toContainText('“Dark mode for guides”');
  expect(await stored(page, ids.dark)).toMatchObject({ column: 'dropped', aside_from: 'backlog', dropped: { reason: 'Folded into the theme work' } });
  await toast(page).locator('[data-toast-undo]').click();
  await expect(toast(page)).toHaveCount(0);
  expect((await stored(page, ids.dark))?.column).toBe('backlog');
  await expect(laneCard(page, 'backlog', ids.dark)).toBeVisible();
  await expect(cardButton(page, ids.dark)).toBeFocused();
  // Closed and opened again later, the card is a plain open: its title, no reason field.
  await page.evaluate(() => (location.hash = '#board'));
  await expect(panel).toHaveCount(0);
  await cardButton(page, ids.dark).click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-drop-reason]')).toHaveCount(0);
  await page.evaluate(() => (location.hash = '#board'));
  await expect(panel).toHaveCount(0);
});

test('moves from the opened card stay as they were: no toast from its Move menu or its foot', async () => {
  const { page, ids } = world;
  const panel = page.locator(`[data-card-panel="${ids.retry}"]`);
  await cardButton(page, ids.retry).click();
  await expect(panel).toBeVisible();
  await panel.locator('[data-card-column]').click();
  await page.locator(`[data-card-menu="${ids.retry}"] [data-card-move-to="icebox"]`).click();
  await expect.poll(async () => (await stored(page, ids.retry))?.column).toBe('icebox');
  await expectNoToast(page);
  await panel.locator(`[data-card-restore="${ids.retry}"]`).click();
  await expect.poll(async () => (await stored(page, ids.retry))?.column).toBe('backlog');
  await page.evaluate(() => (location.hash = '#board'));
  await expect(panel).toHaveCount(0);
  // Drop… from the menu, then Cancel: the foot's own Drop… after it is the opened card's, so no toast.
  await openMenu(page, ids.retry);
  await menu(page).locator('[data-card-menu-action="drop"]').click();
  await expect(panel.locator('[data-drop-reason]')).toBeFocused();
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await panel.locator('[data-card-drop]').click();
  await panel.locator('[data-drop-confirm]').click();
  await expect.poll(async () => (await stored(page, ids.retry))?.column).toBe('dropped');
  await expectNoToast(page);
  await page.evaluate(() => (location.hash = '#board'));
  await expect(panel).toHaveCount(0);
});

test('the Icebox page: an iced card offers Restore to where it was and Drop…; Restore works; a Dropped row has no app menu', async () => {
  const { page, ids } = world;
  await openMenu(page, ids.slack);
  await menu(page).locator('[data-card-menu-to="icebox"]').click();
  await expect(toast(page)).toContainText('Moved to Icebox');
  await toast(page).locator('[data-toast-dismiss]').click();
  await page.locator('[data-board-link="icebox"]').click();
  await expect(cardEl(page, ids.slack)).toBeVisible();
  await openMenu(page, ids.slack);
  await expect(menuItems(page)).toHaveText(['Restore to Building', 'Drop…']);
  await page.mouse.move(5, 5);
  await shot(page, '03-menu-icebox-light.png');
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(cardButton(page, ids.slack)).toBeFocused();
  // Drop… on an iced card, confirmed: the toast's Undo puts it back on ice, still remembering its lane.
  await openMenu(page, ids.slack);
  await menu(page).locator('[data-card-menu-action="drop"]').click();
  const panel = page.locator(`[data-card-panel="${ids.slack}"]`);
  await expect(panel.locator('[data-drop-reason]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toast(page)).toContainText('Dropped');
  expect((await stored(page, ids.slack))?.column).toBe('dropped');
  await toast(page).locator('[data-toast-undo]').click();
  await expect(toast(page)).toHaveCount(0);
  await expect.poll(async () => (await stored(page, ids.slack))?.column).toBe('icebox');
  expect((await stored(page, ids.slack))?.aside_from).toBe('building');
  await page.evaluate(() => (location.hash = '#board=icebox'));
  await expect(panel).toHaveCount(0);
  await expect(page.locator(`.ib-blist .ib-bcard[data-card-id="${ids.slack}"]`)).toBeVisible();
  await cardButton(page, ids.slack).focus();
  // Restore from the menu: back to where it was (Backlog for a card iced from there), no toast.
  await openMenu(page, ids.offline);
  await expect(menuItems(page)).toHaveText(['Restore to Backlog', 'Drop…']);
  await menu(page).locator('[data-card-menu-action="restore"]').click();
  await expect(cardEl(page, ids.offline)).toHaveCount(0);
  expect((await stored(page, ids.offline))?.column).toBe('backlog');
  await expectNoToast(page);
  // The card left the Icebox list: focus goes to the card now in its slot.
  await expect(cardButton(page, ids.slack)).toBeFocused();
  // A Dropped row has Restore on the row: a right-click there is the browser's own.
  await watchContextMenus(page);
  await page.locator(`[data-dropped-row="${ids.retry}"]`).click({ button: 'right' });
  await page.waitForTimeout(300);
  await expect(menu(page)).toHaveCount(0);
  expect(await lastContextMenuCancelled(page)).toBe(false);
  await page.locator('[data-board-back]').click();
  await expect(cardEl(page, ids.qr)).toBeVisible();
});

test('empty lane space, a lane heading and the opened card keep the browser’s own menu', async () => {
  const { page, ids } = world;
  await watchContextMenus(page);
  // A card: ours (the control).
  await cardEl(page, ids.qr).click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  expect(await lastContextMenuCancelled(page)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  const lane = page.locator('.ib-blanes [data-lane="designing"]');
  const box = (await lane.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 40, { button: 'right' });
  await page.waitForTimeout(300);
  await expect(menu(page)).toHaveCount(0);
  expect(await lastContextMenuCancelled(page)).toBe(false);
  await page.locator('#ib-lane-backlog').click({ button: 'right' });
  await page.waitForTimeout(300);
  await expect(menu(page)).toHaveCount(0);
  expect(await lastContextMenuCancelled(page)).toBe(false);
  await cardButton(page, ids.vite).click();
  const panel = page.locator(`[data-card-panel="${ids.vite}"]`);
  await expect(panel).toBeVisible();
  await panel.locator('h2, h1').first().click({ button: 'right' });
  await page.waitForTimeout(300);
  await expect(menu(page)).toHaveCount(0);
  expect(await lastContextMenuCancelled(page)).toBe(false);
  await page.evaluate(() => (location.hash = '#board'));
  await expect(panel).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test('a touch phone never opens it: a touch contextmenu and a long press show nothing of ours', async ({ browser }) => {
  const { ids } = world;
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  try {
    const page = await phone.newPage();
    await page.goto(`${world.url}#board`);
    const card = cardEl(page, ids.qr);
    await expect(card).toBeVisible();
    await watchContextMenus(page);
    // A long press as Chromium on Android reports it: a `contextmenu` from a touch pointer.
    await card.evaluate((el) => el.dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: 'touch', button: 2 })));
    await page.waitForTimeout(300);
    await expect(menu(page)).toHaveCount(0);
    expect(await lastContextMenuCancelled(page)).toBe(false);
    // A `contextmenu` with no pointer type just after a touch on the card (Android WebViews): nothing of ours either.
    await card.evaluate((el) => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' }));
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    });
    await page.waitForTimeout(300);
    await expect(menu(page)).toHaveCount(0);
    // A held finger on the card: Base UI's own long press is off.
    const cdp = await phone.newCDPSession(page);
    const at = (await card.boundingBox())!;
    const point = { x: at.x + 30, y: at.y + at.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForTimeout(1000);
    await expect(menu(page)).toHaveCount(0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    await expect(menu(page)).toHaveCount(0);
  } finally {
    await phone.close();
  }
});

test('the thread rows’ menu, on the same trigger code, still opens, and Escape and Tab give focus back to the row', async () => {
  const { page, ticksThread } = world;
  await page.goto(world.url);
  const row = page.locator(`.ib-lbody [data-thread-id="${ticksThread}"]`);
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  const rowMenu = page.locator('[data-row-menu]');
  await expect(rowMenu).toBeVisible();
  await expect(rowMenu).toHaveAttribute('data-row-menu', ticksThread);
  await expect(rowMenu.getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
  expect(page.url()).not.toContain('thread=');
  await page.keyboard.press('Escape');
  await expect(rowMenu).toHaveCount(0);
  await expect(row).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(rowMenu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(rowMenu).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(world.errors).toEqual([]);
});
