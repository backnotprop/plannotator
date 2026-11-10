/**
 * Starred threads as pills above the list (approval "inbox-starred-pills") in a real browser against the compiled
 * binary, with agents writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - off in an untouched browser: the sidebar's Starred section, no pills;
 *  - "Keep starred above the list" in the list's ⋮ menu puts the pills above the first section and takes the
 *    sidebar's section away, and a reload keeps it;
 *  - a pill's state (Stopped, Holds N, a question count, a dot), its name, its tooltip's agent;
 *  - a click on the star unstars with the toast and opens nothing; Undo puts it back in place; a click on the pill
 *    opens the thread and its pill stays pressed;
 *  - the right-click menu's Move right and Move left change the server's order, which the sidebar shows again
 *    with the choice off;
 *  - Shift+F10 on a focused pill opens the menu (Unstar without a pointer);
 *  - 24 starred in the narrow list: two lines at most, then "+N" and its menu;
 *  - an iPhone in WebKit: one line that scrolls sideways and never widens the page; a tap on the star opens.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const STOPPED = ['Before the TestFlight build:', '', ':::question', 'Which APNs environment should TestFlight builds use?', '', 'Stopped: the build cannot be signed without this.', '', '- [ ] Sandbox', '- [ ] Production', ':::'].join('\n');
const HOLDING = ['The index rewrite is ready to land.', '', ':::question', 'Move postings to varint blocks?', '', 'Holds up: the 0.29 release; the docs deploy', '', '- [ ] Yes', '- [ ] Not yet', ':::'].join('\n');
const ONE = ['The guided reviews need a default.', '', ':::question', 'Default diff style for guided reviews?', '', '- [ ] Split', '- [ ] Unified', ':::'].join('\n');

interface World {
  url: string;
  env: Record<string, string>;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { apns: string; postings: string; diff: string; nightly: string; notes: string };
  project: string;
}

let world: World;

test.describe.configure({ mode: 'serial' });

const pill = (page: Page, id: string) => page.locator(`[data-starred-pill="${id}"]`);
const shownPills = (page: Page) => page.locator('li[data-pill-item]:not([data-over]) [data-starred-pill]');
const pillOrder = (page: Page) => shownPills(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-starred-pill')));
const sidebarOrder = (page: Page) => page.locator('[data-pinned-row]').evaluateAll((els) => els.map((el) => el.getAttribute('data-pinned-row')));

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

/** The list's ⋮ menu, then its "Keep starred above the list" item. */
async function tickStarredAbove(page: Page) {
  await page.locator('.ib-listcol [data-tidy-menu]').click();
  await page.locator('[data-starred-above-option]').click();
  await page.keyboard.press('Escape');
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-starred-pills-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const src = join(root, 'src');
  const relay = scratchProject(src, 'relay');
  const plannotator = scratchProject(src, 'plannotator');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const notes = await claude.send({ project_path: plannotator, thread: 'Release notes', subject: 'The draft for 0.29', body: 'The draft for 0.29 is up.' });
  const nightly = await codex.send({ project_path: plannotator, thread: 'Nightly e2e', subject: 'Two flaky specs quarantined', body: 'Two specs were flaky overnight; I quarantined them.' });
  const diff = await claude.send({ project_path: plannotator, thread: 'Diff style', subject: 'A default for guided reviews', body: ONE });
  const postings = await codex.send({ project_path: plannotator, thread: 'Search index', subject: 'Move postings to varint blocks', body: HOLDING });
  const apns = await claude.send({ project_path: relay, thread: 'Relay deploy', subject: 'Which APNs environment should TestFlight builds use?', body: STOPPED });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = {
    url: started.stdout.trim(),
    env,
    agents: [claude, codex],
    context,
    page,
    errors,
    threads: { apns: apns.thread_id as string, postings: postings.thread_id as string, diff: diff.thread_id as string, nightly: nightly.thread_id as string, notes: notes.thread_id as string },
    project: plannotator,
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

test('off by default; the ⋮ menu item moves the starred threads from the sidebar to pills above the list, and a reload keeps it', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  await expect(page.locator(`.ib-lbody [data-thread-id="${threads.apns}"]`)).toBeVisible();
  for (const id of [threads.apns, threads.postings, threads.diff, threads.nightly]) await pinFromPage(page, id);
  const starred = [threads.apns, threads.postings, threads.diff, threads.nightly];
  await expect.poll(() => sidebarOrder(page)).toEqual(starred);
  await expect(page.locator('[data-starred-pills]')).toHaveCount(0);

  await page.locator('.ib-listcol [data-tidy-menu]').click();
  const item = page.locator('[data-starred-above-option]');
  await expect(item).toHaveRole('menuitemcheckbox');
  await expect(item).toHaveAccessibleName('Keep starred above the list');
  await expect(item).toHaveAttribute('aria-checked', 'false');
  await item.click();
  await expect(item).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  await expect.poll(() => pillOrder(page)).toEqual(starred);
  await expect(page.locator('[data-pinned-section]')).toHaveCount(0);
  // Above the first section, under the header.
  const nav = (await page.locator('[data-starred-pills]').boundingBox())!;
  const head = (await page.locator('.ib-listcol .ib-lhead').boundingBox())!;
  const band = (await page.locator('.ib-listcol .ib-band').first().boundingBox())!;
  expect(nav.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
  expect(nav.y + nav.height).toBeLessThanOrEqual(band.y + 1);

  await page.reload();
  await expect.poll(() => pillOrder(page)).toEqual(starred);
  await expect(page.locator('[data-pinned-section]')).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test("a pill: the gold star, the name, the state, the agent in its tooltip", async () => {
  const { page, threads } = world;
  await expect(pill(page, threads.apns).locator('.ib-spill')).toHaveText('Stopped');
  await expect(pill(page, threads.postings).locator('.ib-spill')).toHaveText('Holds 2');
  await expect(pill(page, threads.diff).locator('.ib-star-q')).toHaveText('1');
  await expect(pill(page, threads.nightly).locator('.ib-pdot')).toBeVisible();
  await expect(pill(page, threads.diff)).toHaveAccessibleName('Diff style, plannotator, 1 question, starred');
  await expect(page.getByRole('navigation', { name: 'Starred' })).toBeVisible();
  // No agent mark on a pill, and no native title anywhere on it.
  await expect(page.locator('[data-starred-pills] li[data-pill-item] .ib-mk')).toHaveCount(0);
  expect(await page.locator('[data-starred-pills] [title]').count()).toBe(0);
  await pill(page, threads.diff).hover({ position: { x: 60, y: 13 } });
  await expect(page.locator('[data-pill-tip-agent]')).toHaveText('Claude Code in plannotator');
  await page.mouse.move(700, 700);
});

test('a click on the star unstars with the toast and opens nothing; Undo puts it back in place; a click on the pill opens the thread', async () => {
  const { page, threads } = world;
  const before = await serverPins(page);
  await page.locator(`[data-pill-unstar="${threads.postings}"]`).hover();
  await expect(page.locator('[data-pill-unstar-tip]')).toHaveText('Unstar');
  await page.locator(`[data-pill-unstar="${threads.postings}"]`).click();
  await expect(pill(page, threads.postings)).toHaveCount(0);
  await expect(page.locator('[data-inbox-toast]')).toContainText('Unstarred');
  expect(new URL(page.url()).hash).not.toContain('thread=');
  await expect.poll(() => serverPins(page)).toEqual(before.filter((id) => id !== threads.postings));
  await page.locator('[data-inbox-toast]').getByRole('button', { name: /Undo/ }).click();
  await expect.poll(() => serverPins(page)).toEqual(before);
  await expect.poll(() => pillOrder(page)).toEqual(before);

  await pill(page, threads.diff).click({ position: { x: 70, y: 13 } });
  await expect(page).toHaveURL(new RegExp(`#.*thread=${threads.diff}`));
  await expect(pill(page, threads.diff)).toHaveAttribute('aria-current', 'true');
  await expect.poll(() => serverPins(page)).toEqual(before);
  await page.keyboard.press('Escape');
});

test("the right-click menu: Move right and Move left change the stars' one order; Shift+F10 opens it for Unstar", async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  const start = [threads.apns, threads.postings, threads.diff, threads.nightly];
  await expect.poll(() => pillOrder(page)).toEqual(start);
  await pill(page, threads.apns).click({ button: 'right' });
  const menu = page.locator('[data-pill-menu]');
  await expect(menu.getByRole('menuitem')).toHaveText(['Unstar', 'Move left', 'Move right', 'Copy link']);
  await expect(menu.locator('[data-pill-action="left"]')).toHaveAttribute('aria-disabled', 'true');
  expect(new URL(page.url()).hash).not.toContain('thread=');
  await menu.locator('[data-pill-action="right"]').click();
  const moved = [threads.postings, threads.apns, threads.diff, threads.nightly];
  await expect.poll(() => serverPins(page)).toEqual(moved);
  await expect.poll(() => pillOrder(page)).toEqual(moved);
  // Focus stays on the pill that moved.
  await expect(pill(page, threads.apns)).toBeFocused();

  await pill(page, threads.nightly).click({ button: 'right' });
  await expect(menu.locator('[data-pill-action="right"]')).toHaveAttribute('aria-disabled', 'true');
  await menu.locator('[data-pill-action="left"]').click();
  const again = [threads.postings, threads.apns, threads.nightly, threads.diff];
  await expect.poll(() => serverPins(page)).toEqual(again);

  // The keyboard: Shift+F10 on a focused pill, Unstar first.
  await pill(page, threads.nightly).focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await menu.locator('[data-pill-action="unpin"]').press('Enter');
  await expect.poll(() => serverPins(page)).toEqual([threads.postings, threads.apns, threads.diff]);
  await expect(page.locator('[data-inbox-toast]')).toContainText('Unstarred');
  await page.locator('[data-inbox-toast]').getByRole('button', { name: /Undo/ }).click();
  await expect.poll(() => serverPins(page)).toEqual(again);

  // Off again: the sidebar's Starred section shows the same order.
  await tickStarredAbove(page);
  await expect.poll(() => sidebarOrder(page)).toEqual(again);
  await expect(page.locator('[data-starred-pills]')).toHaveCount(0);
  await tickStarredAbove(page);
  await expect.poll(() => pillOrder(page)).toEqual(again);
  expect(world.errors).toEqual([]);
});

test('24 starred in the narrow list: two lines at most, then "+N" and its menu', async () => {
  const { page, threads } = world;
  const extra: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const sent = await world.agents[i % 2]!.send({ project_path: world.project, thread: `Work stream ${i + 1}`, subject: `Notes for stream ${i + 1}`, body: 'An update.' });
    extra.push(sent.thread_id as string);
  }
  await page.goto(`${world.url}#thread=${threads.diff}`);
  for (const id of extra) await pinFromPage(page, id);
  await expect.poll(async () => (await serverPins(page)).length).toBe(24);
  const more = page.locator('[data-pills-more]');
  await expect(more).toBeVisible();
  const tops = await page.locator('li.ib-star-i:not([data-over])').evaluateAll((els) => [...new Set(els.map((el) => (el as HTMLElement).offsetTop))]);
  expect(tops.length).toBe(2);
  const shown = await shownPills(page).count();
  await expect(more).toHaveText(`+${24 - shown}`);
  // Nothing spills past the list column.
  const nav = (await page.locator('[data-starred-pills]').boundingBox())!;
  const column = (await page.locator('.ib-listcol').boundingBox())!;
  expect(nav.x + nav.width).toBeLessThanOrEqual(column.x + column.width + 1);
  await more.click();
  const items = page.locator('[data-pills-more-item]');
  await expect(items).toHaveCount(24 - shown);
  const last = extra[extra.length - 1]!;
  await page.locator(`[data-pills-more-item="${last}"]`).click();
  await expect(page).toHaveURL(new RegExp(`thread=${last}`));
  expect(world.errors).toEqual([]);
});

test('an iPhone in WebKit: one line that scrolls sideways; a tap on the star opens the thread and unstars nothing', async () => {
  const phoneBrowser = await webkit.launch();
  try {
    const context = await phoneBrowser.newContext({ ...devices['iPhone 13'] });
    const page = await context.newPage();
    await page.goto(world.url);
    await page.locator('.ib-listcol [data-tidy-menu]').tap();
    await page.locator('[data-starred-above-option]').tap();
    await page.keyboard.press('Escape');
    const nav = page.locator('[data-starred-pills]');
    await expect(nav).toHaveAttribute('data-phone', '');
    await expect(page.locator('[data-pills-more]')).toHaveCount(0);
    const line = await nav.locator('ul').evaluate((ul) => ({ scroll: ul.scrollWidth, client: ul.clientWidth, tops: [...new Set([...ul.children].map((el) => (el as HTMLElement).offsetTop))].length }));
    expect(line.tops).toBe(1);
    expect(line.scroll).toBeGreaterThan(line.client);
    // The line scrolls inside itself: the page is no wider than the phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
    const before = await serverPins(page);
    const first = before[0]!;
    const star = (await page.locator(`[data-pill-unstar="${first}"]`).boundingBox())!;
    await page.touchscreen.tap(star.x + star.width / 2, star.y + star.height / 2);
    await expect(page).toHaveURL(new RegExp(`thread=${first}`));
    expect(await serverPins(page)).toEqual(before);
    await context.close();
  } finally {
    await phoneBrowser.close();
  }
});
