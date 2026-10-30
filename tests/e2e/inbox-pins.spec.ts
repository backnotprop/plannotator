/**
 * Pinned threads (approval "inbox-pinned-threads", variant Count) in a real
 * browser against the compiled binary, with agents writing through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - right-click a row: Pin thread leads the menu, in its own group; the
 *    thread appears under Pinned above Projects, and its list row keeps its
 *    place with a pin;
 *  - the Count rows: Stopped and Holds N pills, a question count, a dot;
 *  - the header ⋯ menu's Pin thread / Unpin thread (no pin button in the header);
 *    the open thread's pinned row wears the selection;
 *  - the pinned row's ⋯: Move down, Move up (focus kept), Unpin with its
 *    toast and Z putting it back;
 *  - archiving a pinned thread keeps it pinned, shown archived, and it opens;
 *  - 24 pins: the sidebar scrolls, Settings stays on screen, nothing overflows;
 *  - an iPhone in WebKit: 44 px pinned rows with ⋯ always shown, the menu a
 *    bottom sheet, the header ⋯ menu's Pin thread.
 *
 * Light and dark screenshots land in PLANNOTATOR_PINS_SHOTS (default
 * .local/proof/pins). Build the binary first (see inbox.spec.ts), then
 * `bun run test:e2e:inbox`.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_PINS_SHOTS ?? join(repo, '.local/proof/pins'));

const STOPPED = ['Before the TestFlight build:', '', ':::question', 'Which APNs environment should TestFlight builds use?', '', 'Stopped: the build cannot be signed without this.', '', '- [ ] Sandbox', '- [ ] Production', ':::'].join('\n');
const HOLDING = ['The index rewrite is ready to land.', '', ':::question', 'Move postings to varint blocks?', '', 'Holds up: the 0.29 release; the docs deploy', '', '- [ ] Yes', '- [ ] Not yet', ':::'].join('\n');
const THREE = [
  'Step 2 needs names for the columns.',
  '',
  ':::question',
  'What should the lane waiting on your review be called?',
  '',
  '- [ ] Your review',
  '- [ ] In review',
  ':::',
  '',
  ':::question',
  'What should the lane for your first look be called?',
  '',
  '- [ ] Your look',
  '- [ ] First look',
  ':::',
  '',
  ':::question',
  'Keep an Icebox column?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');
const ONE = ['The guided reviews need a default.', '', ':::question', 'Default diff style for guided reviews?', '', '- [ ] Split', '- [ ] Unified', ':::'].join('\n');

interface World {
  url: string;
  env: Record<string, string>;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { apns: string; postings: string; board: string; diff: string; nightly: string; notes: string };
  projects: string[];
}

let world: World;

test.describe.configure({ mode: 'serial' });

const rowButton = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
const pinned = (page: Page, id: string) => page.locator(`[data-pinned-row="${id}"]`);
const pinnedOrder = (page: Page) => page.locator('[data-pinned-row]').evaluateAll((els) => els.map((el) => el.getAttribute('data-pinned-row')));

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, name) });
}

/** The open thread's header ⋯ menu, opened; its first item is the pin. */
async function openThreadMenu(page: Page) {
  await page.locator('[data-thread-more]').click();
  const item = page.locator('[data-thread-menu] [data-thread-pin-item]');
  await expect(item).toBeVisible();
  return item;
}

/** Pin or unpin through the window's own route, from the page (same origin, its serverSession). */
async function pinFromPage(page: Page, id: string, on = true) {
  await page.evaluate(
    async ([threadId, value]) => {
      const list = (await (await fetch('/api/inbox/threads?archived=exclude')).json()) as { serverSession: string };
      const res = await fetch(`/api/inbox/threads/${threadId}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: list.serverSession, pinned: value }) });
      if (!res.ok) throw new Error(`pin ${res.status}`);
    },
    [id, on] as const,
  );
}

async function serverPins(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const list = (await (await fetch('/api/inbox/threads?archived=exclude')).json()) as { pins?: { thread_id: string }[] };
    return (list.pins ?? []).map((row) => row.thread_id);
  });
}

async function unpinAll(page: Page) {
  for (const id of await serverPins(page)) await pinFromPage(page, id, false);
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-pins-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const src = join(root, 'src');
  const relay = scratchProject(src, 'relay');
  const plannotator = scratchProject(src, 'plannotator');
  const pando = scratchProject(src, 'pando');
  const workspaces = scratchProject(src, 'workspaces');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const opencode = await SimAgent.connect({ binary, env, name: 'OpenCode', host: 'opencode' });
  const notes = await claude.send({ project_path: plannotator, subject: 'Release notes draft for 0.29', body: 'The draft for 0.29 is up.' });
  const nightly = await opencode.send({ project_path: workspaces, subject: 'Nightly e2e: two flaky specs quarantined', thread: 'nightly', body: 'Two specs were flaky overnight; I quarantined them.' });
  const diff = await pi.send({ project_path: pando, subject: 'Default diff style for guided reviews', body: ONE });
  const board = await claude.send({ project_path: plannotator, subject: 'Board step 2: names for the review columns', thread: 'board', body: THREE });
  const postings = await codex.send({ project_path: plannotator, subject: 'Search index: move postings to varint blocks', body: HOLDING });
  const apns = await claude.send({ project_path: relay, subject: 'Which APNs environment should TestFlight builds use?', thread: 'relay-deploy', body: STOPPED });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = {
    url: started.stdout.trim(),
    env,
    agents: [claude, codex, pi, opencode],
    context,
    page,
    errors,
    threads: {
      apns: apns.thread_id as string,
      postings: postings.thread_id as string,
      board: board.thread_id as string,
      diff: diff.thread_id as string,
      nightly: nightly.thread_id as string,
      notes: notes.thread_id as string,
    },
    projects: [relay, plannotator, pando, workspaces],
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

test('Pin thread leads the row menu; the thread appears under Pinned, above Projects, with its pin on the list row', async () => {
  const { page, threads } = world;
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(world.url);
  await expect(rowButton(page, threads.board)).toBeVisible();
  // Nothing pinned: no section at all.
  await expect(page.locator('[data-pinned-section]')).toHaveCount(0);
  await expect(page.locator('.ib-side-sec-l')).toHaveText(['Projects']);

  await rowButton(page, threads.board).click({ button: 'right' });
  const menu = page.locator('[data-row-menu]');
  await expect(menu.getByRole('menuitem').first()).toHaveText('Pin thread');
  await page.locator('[data-row-action="pin"]').click();
  await expect(pinned(page, threads.board)).toBeVisible();
  await expect(page.locator('.ib-side-sec-l')).toHaveText(['Pinned', 'Projects']);
  await expect(rowButton(page, threads.board).locator('[data-pin-mark]')).toBeVisible();
  await expect(rowButton(page, threads.board)).toHaveAccessibleName(/, pinned$/);
  // Pin shows no toast; the live region says it.
  await expect(page.locator('[data-inbox-live]')).toContainText('Pinned “Board step 2');
  await expect(page.locator('[data-inbox-toast]')).toHaveCount(0);

  // The menu as the record draws it: on the next row, before pinning it.
  await rowButton(page, threads.nightly).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await shot(page, 'desktop-menu-light.png');
  await page.locator('[data-row-action="pin"]').click();
  await rowButton(page, threads.apns).click({ button: 'right' });
  await page.locator('[data-row-action="pin"]').click();
  await pinFromPage(page, threads.postings);
  await expect.poll(() => pinnedOrder(page)).toEqual([threads.board, threads.nightly, threads.apns, threads.postings]);

  // Count: Stopped and Holds N pills, a question count, a dot for news.
  await expect(pinned(page, threads.apns).locator('.ib-spill')).toHaveText('Stopped');
  await expect(pinned(page, threads.postings).locator('.ib-spill')).toHaveText('Holds 2');
  await expect(pinned(page, threads.board).locator('.ib-n')).toHaveText('3');
  await expect(pinned(page, threads.nightly).locator('.ib-pdot')).toBeVisible();
  await expect(pinned(page, threads.board)).toHaveAccessibleName(/Board step 2: names for the review columns, plannotator, 3 questions/);
  // The cut subject shows whole in a component tooltip, never a native title.
  expect(await page.locator('.ib-pins [title]').count()).toBe(0);
  await pinned(page, threads.board).hover();
  await expect(page.locator('[data-pin-tip]')).toContainText('Board step 2: names for the review columns');
  await page.mouse.move(800, 600);
  await shot(page, 'desktop-pinned-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'desktop-pinned-dark.png');
  await rowButton(page, threads.diff).click({ button: 'right' });
  await expect(menu).toBeVisible();
  await shot(page, 'desktop-menu-dark.png');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'light' });
  expect(world.errors).toEqual([]);
});

test("a click opens the thread and keeps the filter; the header ⋯ menu pins and unpins; the open thread's row wears the selection", async () => {
  const { page, threads } = world;
  await page.locator('.ib-projrow .ib-proj', { hasText: 'pando' }).click();
  await expect(page).toHaveURL(/#project=/);
  await pinned(page, threads.board).click();
  await expect(page).toHaveURL(/#project=prj_.*thread=|thread=.*project=/);
  await expect(pinned(page, threads.board)).toHaveAttribute('aria-current', 'true');
  // No pin button in the header; the ⋯ menu leads with the pin, and says it is pinned.
  await expect(page.locator('[data-pin-toggle]')).toHaveCount(0);
  const item = await openThreadMenu(page);
  await expect(item).toHaveText('Unpin thread');
  await expect(page.locator('[data-thread-menu] [role="menuitem"]').first()).toHaveText('Unpin thread');
  await shot(page, 'desktop-thread-menu-light.png');
  await page.keyboard.press('Escape');
  await shot(page, 'desktop-thread-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'desktop-thread-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await (await openThreadMenu(page)).click();
  await expect(pinned(page, threads.board)).toHaveCount(0);
  await expect(page.locator('[data-inbox-toast]')).toContainText('Unpinned');
  await expect(page.locator('[data-inbox-toast]')).toContainText('Still in Waiting on you');
  const again = await openThreadMenu(page);
  await expect(again).toHaveText('Pin thread');
  await again.click();
  await expect(pinned(page, threads.board)).toBeVisible();
  await expect.poll(() => pinnedOrder(page)).toEqual([threads.nightly, threads.apns, threads.postings, threads.board]);
});

test("the pinned row's ⋯: Move up and down keep focus; Unpin shows the toast and Z puts it back where it was", async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  await page.reload();
  await expect(pinned(page, threads.board)).toBeVisible();
  const more = (id: string) => page.locator(`[data-pin-more="${id}"]`);
  await pinned(page, threads.apns).hover();
  await more(threads.apns).click();
  const menu = page.locator('[data-pin-menu]');
  await expect(menu.getByRole('menuitem')).toHaveText(['Unpin', 'Move up', 'Move down', 'Copy link']);
  await shot(page, 'desktop-pinned-menu-light.png');
  await page.locator('[data-pin-action="up"]').click();
  await expect.poll(() => pinnedOrder(page)).toEqual([threads.apns, threads.nightly, threads.postings, threads.board]);
  await expect(more(threads.apns)).toBeFocused();
  // The keyboard: Enter opens the menu on the focused ⋯ (Move up is disabled at the top); the arrows reach Move down.
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(page.locator('[data-pin-action="up"]')).toHaveAttribute('data-disabled', '');
  const down = page.locator('[data-pin-action="down"]');
  // The menu takes focus once it has opened (Base UI puts it on the first item).
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-pin-menu]') !== null)).toBe(true);
  const focusedAction = () => page.evaluate(() => document.activeElement?.getAttribute('data-pin-action') ?? null);
  for (let i = 0; i < 4 && (await focusedAction()) !== 'down'; i++) {
    const before = await focusedAction();
    await page.keyboard.press('ArrowDown');
    await expect.poll(focusedAction).not.toBe(before);
  }
  await expect(down).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => pinnedOrder(page)).toEqual([threads.nightly, threads.apns, threads.postings, threads.board]);
  await expect(more(threads.apns)).toBeFocused();

  // Unpin: the toast, focus on the next pin's ⋯, and Z undoes it.
  await page.keyboard.press('Enter');
  await page.locator('[data-pin-action="unpin"]').click();
  await expect.poll(() => pinnedOrder(page)).toEqual([threads.nightly, threads.postings, threads.board]);
  const toast = page.locator('[data-inbox-toast]');
  await expect(toast).toContainText('Unpinned');
  await expect(toast).toContainText('Still in Stopped on you');
  await expect(more(threads.postings)).toBeFocused();
  await shot(page, 'desktop-unpinned-light.png');
  await page.locator('body').focus();
  await page.keyboard.press('z');
  await expect.poll(() => pinnedOrder(page)).toEqual([threads.nightly, threads.apns, threads.postings, threads.board]);
});

test('archiving a pinned thread keeps it pinned, shown archived; it opens as an archived thread', async () => {
  const { page, threads } = world;
  await rowButton(page, threads.nightly).click({ button: 'right' });
  await page.locator('[data-row-action="archive"]').click();
  await expect(rowButton(page, threads.nightly)).toHaveCount(0);
  await expect(pinned(page, threads.nightly)).toHaveAttribute('data-state', 'archived');
  await expect(pinned(page, threads.nightly)).toHaveAccessibleName(/Archived$/);
  await expect(pinned(page, threads.nightly).locator('.ib-parch')).toBeVisible();
  await shot(page, 'desktop-archived-light.png');
  await pinned(page, threads.nightly).click();
  await expect(await openThreadMenu(page)).toHaveText('Unpin thread');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ib-pane')).toContainText('Unarchive');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'desktop-archived-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
});

test('24 pins: the sidebar scrolls Pinned with Projects; Settings stays on screen; nothing overflows', async () => {
  const { page, agents, projects } = world;
  await unpinAll(page);
  const ids: string[] = [];
  for (let i = 0; i < 24; i++) {
    const sent = await agents[i % agents.length]!.send({ project_path: projects[i % projects.length]!, subject: `Lane ${i + 1}: a long running piece of work with a long subject`, thread: `lane-${i + 1}`, body: `Lane ${i + 1} is moving.` });
    ids.push(sent.thread_id as string);
  }
  for (const id of ids) await pinFromPage(page, id);
  await page.goto(world.url);
  await page.reload();
  await expect(page.locator('[data-pinned-row]')).toHaveCount(24);
  const layout = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.ib-sidescroll')!;
    const settings = [...document.querySelectorAll<HTMLElement>('.ib-setrow .ib-nav')][0]!.getBoundingClientRect();
    const side = document.querySelector<HTMLElement>('.ib-side')!;
    return {
      scrolls: scroll.scrollHeight > scroll.clientHeight + 1,
      more: scroll.hasAttribute('data-more'),
      settingsBottom: settings.bottom,
      settingsHeight: settings.height,
      viewport: window.innerHeight,
      sideOverflow: side.scrollWidth > side.clientWidth + 1,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      rowHeights: [...document.querySelectorAll<HTMLElement>('.ib-pin')].map((el) => Math.round(el.getBoundingClientRect().height)),
    };
  });
  expect(layout.scrolls).toBe(true);
  expect(layout.more).toBe(true);
  expect(layout.settingsBottom).toBeLessThanOrEqual(layout.viewport);
  expect(layout.settingsHeight).toBeGreaterThanOrEqual(30);
  expect(layout.sideOverflow).toBe(false);
  expect(layout.pageOverflow).toBe(false);
  expect(new Set(layout.rowHeights)).toEqual(new Set([30]));
  await shot(page, 'desktop-many-pins-light.png');
  // The last pin and the projects are reachable by scrolling.
  await page.locator(`[data-pinned-row="${ids[23]}"]`).scrollIntoViewIfNeeded();
  await expect(page.locator(`[data-pinned-row="${ids[23]}"]`)).toBeInViewport();
  await page.locator('.ib-projrow').last().scrollIntoViewIfNeeded();
  await expect(page.locator('.ib-projrow').last()).toBeInViewport();
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'desktop-many-pins-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await unpinAll(page);
  for (const id of [world.threads.board, world.threads.apns, world.threads.nightly]) await pinFromPage(page, id);
  expect(world.errors).toEqual([]);
});

test.describe('iPhone 15 (WebKit)', () => {
  const { defaultBrowserType: _browser, ...device } = devices['iPhone 15'];
  let browser: Browser | null = null;
  test.beforeAll(async () => {
    // WebKit refuses the config's Chromium flags.
    browser = await webkit.launch({ args: [] });
  });
  test.afterAll(async () => {
    await browser?.close();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the sheet: 44 px pinned rows, ⋯ always shown, the menu a bottom sheet; the header menu's Pin thread (${scheme})`, async () => {
      const { threads } = world;
      const context = await browser!.newContext({ ...device, colorScheme: scheme });
      try {
        const page = await context.newPage();
        await page.goto(world.url);
        await expect(page.locator('.ib-mrow').first()).toBeVisible();
        await page.locator('[data-sidebar="trigger"]').first().tap();
        const row = page.locator(`[data-pinned-row="${threads.apns}"]`);
        await expect(row).toBeVisible();
        const box = await row.boundingBox();
        expect(Math.round(box!.height)).toBe(44);
        const more = page.locator(`[data-pin-more="${threads.apns}"]`);
        await expect(more).toHaveCSS('opacity', '1');
        const moreBox = await more.boundingBox();
        expect(Math.round(moreBox!.width)).toBeGreaterThanOrEqual(44);
        expect(Math.round(moreBox!.height)).toBeGreaterThanOrEqual(44);
        // The state stays visible beside ⋯.
        await expect(row.locator('.ib-spill')).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(shots, `phone-sheet-${scheme}.png`) });
        await more.tap();
        const menu = page.locator('[data-pin-menu]');
        await expect(menu.locator('.ib-pm-title')).toHaveText('relay-deploy');
        const sheet = await menu.boundingBox();
        expect(sheet!.width).toBeGreaterThan(360);
        expect(sheet!.y + sheet!.height).toBeGreaterThan(device.viewport.height - 40);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(shots, `phone-menu-${scheme}.png`) });
        await page.locator('[data-pin-action="copy-link"]').tap();
        await expect(menu).toHaveCount(0);
        // A pinned row opens its thread; the header ⋯ menu's Pin thread is the phone's way to pin.
        await page.locator('[data-sidebar="trigger"]').first().tap();
        await page.locator(`[data-pinned-row="${threads.board}"]`).tap();
        await expect(page.locator('[data-pin-toggle]')).toHaveCount(0);
        await page.locator('[data-thread-more]').tap();
        const pinItem = page.locator('[data-thread-menu] [data-thread-pin-item]');
        await expect(pinItem).toHaveText('Unpin thread');
        const itemBox = await pinItem.boundingBox();
        expect(Math.round(itemBox!.height)).toBeGreaterThanOrEqual(44);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(shots, `phone-thread-${scheme}.png`) });
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-thread-menu]')).toHaveCount(0);
        // The list row on a phone: the pin before the time.
        await page.locator('[data-phone-back]').tap();
        await expect(page.locator(`.ib-mrow[data-thread-id="${threads.board}"] [data-pin-mark]`)).toBeVisible();
      } finally {
        await context.close();
      }
    });
  }
});
