/**
 * The side-by-side view, named and remembered (approval "inbox-side-by-side",
 * packages/inbox/fileView.ts), proved in a real browser against the compiled
 * binary. Nothing is mocked: `plannotator inbox --background` runs under a
 * temp PLANNOTATOR_DATA_DIR and HOME with a tailscale trap first on PATH; one
 * agent sends a message whose text shows a screenshot and which carries two
 * HTML pages and a markdown plan, through `plannotator inbox mcp`; Chromium
 * (and WebKit as an iPhone) drives the window.
 *
 * Proves: before any choice, an image from the message's text opens full
 * screen with a labelled "Side by side" in the toolbar; pressing it puts the
 * file beside the thread, remembers the choice (the toast says so once, with
 * Undo) and the header shows "Side by side | Full screen" with Side by side
 * pressed; the next HTML page opens side by side too, a step keeps it, and a
 * reload keeps it (`&view=side` in the address); a link without `view` uses
 * the choice; a tile's ⋯ "Open full screen" opens that one file full screen
 * and leaves the choice alone, as Escape's way out does; on an iPhone the
 * file is always full screen, with no switch, no tile ⋯ items and nothing
 * saved.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-side-by-side.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/side-by-side),
 * light and dark: desktop-01 to desktop-06 at 1440 px, phone-01 and phone-02.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/side-by-side'));
const VIEW_COOKIE = 'plannotator-inbox-file-view';

const page = (title: string, accent: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>
body{margin:0;font:18px/1.5 system-ui;background:#f6f3ee;color:#1d1b19}
main{max-width:980px;margin:0 auto;padding:64px 72px}
h1{font:600 52px/1.05 Georgia,serif;margin:0 0 20px}
p{font-size:20px;color:#4a4540;max-width:720px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:32px}
.card{background:#fff;border-radius:12px;padding:18px;border-top:4px solid ${accent}}
</style><main><h1 id="headline">${title}</h1><p>Choose a plan, pay once, and get the receipt by email.</p>
<div class="cards"><div class="card">Basket</div><div class="card">Payment</div><div class="card">Receipt</div></div></main>`;

const PLAN = ['# Checkout rollout', '', 'Ship the single-page checkout behind a flag, then to everyone.', '', '1. Flag on for staff.', '2. Flag on for 10%.', '3. Everyone.', ''].join('\n');

interface World {
  root: string;
  url: string;
  env: Record<string, string>;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  ids: Record<string, string>;
}

let world: World;

async function shot(p: Page, name: string, schemes: ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await p.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await p.waitForTimeout(350);
    await p.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await p.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const pane = (p = world.page) => p.locator('[data-attachment-pane]');
const bar = (p = world.page) => p.locator('[data-full-view-bar]');
const header = (p = world.page) => pane(p).locator('.ib-vhead');
const toast = (p = world.page) => p.locator('.ib-toast');
const choiceOf = async (context = world.context) => (await context.cookies()).find((c) => c.name === VIEW_COOKIE)?.value ?? null;
const addressView = (p = world.page) => p.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('view'));
const openTile = (name: string, p = world.page) => p.getByRole('button', { name: `Open ${name}` }).first().click();

/**
 * Escape until full screen ends (an HTML page goes to Interact first): opened from the thread alone, the file
 * closes and the thread is as it was (fullScreenOrigin.ts). Escape's way out saves nothing.
 */
async function escapeOut(p = world.page) {
  for (let i = 0; i < 5; i++) {
    if ((await pane(p).count()) === 0) return;
    await p.keyboard.press('Escape');
    await p.waitForTimeout(150);
  }
  await expect(pane(p)).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-side-by-side-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-side-by-side: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'checkout');
  for (const folder of ['site', 'docs', 'shots']) mkdirSync(join(project, folder));
  writeFileSync(join(project, 'site', 'single-page.html'), page('One page to pay', '#c2410c'));
  writeFileSync(join(project, 'site', 'steps.html'), page('Three short steps', '#2563eb'));
  writeFileSync(join(project, 'docs', 'rollout.md'), PLAN);
  const maker = await browser.newContext({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
  const makerPage = await maker.newPage();
  await makerPage.setContent(page('One page to pay', '#c2410c'));
  writeFileSync(join(project, 'shots', 'checkout.png'), await makerPage.screenshot());
  await maker.close();

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const p = await context.newPage();
  const errors: string[] = [];
  p.on('pageerror', (error) => errors.push(error.message));
  world = {
    root,
    url,
    env,
    claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude', host: 'claude-code' }),
    context,
    page: p,
    errors,
    threadId: '',
    ids: {},
  };
  const sent = await world.claude.send({
    project_path: project,
    subject: 'Checkout: two layouts and the rollout',
    body: ['How the single-page checkout looks at 900 px:', '', '![Single-page checkout](shots/checkout.png)', '', 'Both layouts are attached, with the rollout plan.'].join('\n'),
    attachments: ['site/single-page.html', 'site/steps.html', 'docs/rollout.md'],
  });
  world.threadId = sent.thread_id;
  await p.goto(`${url}#thread=${sent.thread_id}`);
  const thread = await p.evaluate(async (id) => (await (await fetch(`/api/inbox/threads/${id}`)).json()).thread, sent.thread_id);
  for (const message of thread.messages) {
    for (const file of [...(message.inline_images ?? []), ...(message.attachments ?? [])] as { name: string; id: string }[]) world.ids[file.name] = file.id;
  }
  expect(Object.keys(world.ids).sort()).toEqual(['checkout.png', 'rollout.md', 'single-page.html', 'steps.html']);
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('an image from the text opens full screen, with "Side by side" named in its toolbar; pressing it puts the file beside the thread and remembers it', async () => {
  const p = world.page;
  expect(await choiceOf()).toBeNull();
  const inline = p.locator(`.ib-body img[data-inline-image="${world.ids['checkout.png']}"]`);
  await expect(inline).toBeVisible();
  await inline.click();
  await expect(pane()).toHaveClass(/ib-full/);
  const side = bar().getByRole('button', { name: 'Side by side' });
  await expect(side).toBeVisible();
  await expect(side).toHaveText('Side by side');
  await p.mouse.move(400, 500);
  await shot(p, 'desktop-01-full-screen-side-by-side-button');

  await side.click();
  await expect(pane()).not.toHaveClass(/ib-full/);
  expect(await choiceOf()).toBe('side');
  expect(await addressView()).toBe('side');
  // The header's two-part switch, Side by side pressed and focused.
  const group = header().getByRole('group', { name: 'View' });
  await expect(group.getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true');
  await expect(group.getByRole('button', { name: 'Full screen' })).toHaveAttribute('aria-pressed', 'false');
  await expect(group.getByRole('button', { name: 'Side by side' })).toBeFocused();
  await expect(toast().locator('.ib-tlead')).toHaveText('Files open side by side now');
  await expect(toast().locator('.ib-tdetail')).toHaveText('until you choose Full screen');
  await expect(p.locator('[data-inbox-live]')).toContainText('Files open side by side now, until you choose Full screen.');
  await p.mouse.move(400, 500);
  await shot(p, 'desktop-02-side-by-side-switch-and-toast');
  await toast().locator('[data-toast-dismiss]').click();
  await expect(toast()).toHaveCount(0);
});

test('the next HTML page opens side by side too; a step keeps it; a reload keeps it; a link without view uses the choice', async () => {
  const p = world.page;
  await openTile('single-page.html');
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['single-page.html']!);
  await expect(pane()).not.toHaveClass(/ib-full/);
  expect(await addressView()).toBe('side');
  await expect(p.frameLocator('[data-attachment-pane] iframe').first().locator('#headline')).toHaveText('One page to pay');
  await p.mouse.move(400, 500);
  await shot(p, 'desktop-03-html-side-by-side');

  // ] from inside the file: steps.html, still beside the thread.
  await pane().locator('.ib-vhead').click({ position: { x: 4, y: 4 } });
  await p.keyboard.press(']');
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['steps.html']!);
  await expect(pane()).not.toHaveClass(/ib-full/);
  expect(await addressView()).toBe('side');

  await p.reload();
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['steps.html']!);
  await expect(pane()).not.toHaveClass(/ib-full/);
  await expect(header().getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true');

  // A link with no view (an agent's link, a search result): the choice.
  await p.goto(`${world.url}#thread=${world.threadId}&file=${world.ids['single-page.html']}`);
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['single-page.html']!);
  await expect(pane()).not.toHaveClass(/ib-full/);
});

test("a tile's ⋯ opens one file full screen and leaves the choice alone; so does Escape's way out", async () => {
  const p = world.page;
  await pane().getByRole('button', { name: /^Close / }).click();
  await expect(pane()).toHaveCount(0);
  const id = world.ids['steps.html']!;
  const tile = p.locator(`[data-open-in-tile="${id}"]`).last();
  await tile.hover();
  await tile.locator(`button[data-open-in-more="${id}"]`).click();
  const menu = p.locator(`[data-open-in-menu="${id}"]`);
  await expect(menu.getByRole('menuitem', { name: 'Open side by side' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Open full screen' })).toBeVisible();
  await shot(p, 'desktop-04-tile-menu');
  await menu.getByRole('menuitem', { name: 'Open full screen' }).click();
  await expect(pane()).toHaveAttribute('data-attachment-pane', id);
  await expect(pane()).toHaveClass(/ib-full/);
  expect(await addressView()).toBe('full');
  expect(await choiceOf()).toBe('side');
  await expect(toast()).toHaveCount(0);
  await p.mouse.move(400, 500);
  await shot(p, 'desktop-05-html-full-screen-from-tile');

  await escapeOut();
  expect(await choiceOf()).toBe('side');
  await expect(toast()).toHaveCount(0);

  // The plan, opened from its tile: by the choice, side by side.
  await openTile('rollout.md');
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['rollout.md']!);
  await expect(pane()).not.toHaveClass(/ib-full/);
  await p.mouse.move(400, 500);
  await shot(p, 'desktop-06-markdown-side-by-side');
});

test("Full screen in the switch makes full screen the choice; the toast's Undo puts the old choice and the view back", async () => {
  const p = world.page;
  await header().getByRole('button', { name: 'Full screen' }).click();
  await expect(pane()).toHaveClass(/ib-full/);
  expect(await choiceOf()).toBe('full');
  await expect(toast().locator('.ib-tlead')).toHaveText('Files open full screen now');
  // Undo: the choice and this file's view go back.
  await toast().locator('[data-toast-undo]').click();
  await expect(pane()).not.toHaveClass(/ib-full/);
  expect(await choiceOf()).toBe('side');
  expect(world.errors).toEqual([]);
});

test('on an iPhone (WebKit): always full screen, Back to the thread, no switch, no tile items, nothing saved', async () => {
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  const browser = await webkit.launch({ args: [] });
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ ...device, colorScheme: scheme });
      const p = await context.newPage();
      await p.emulateMedia({ reducedMotion: 'reduce' });
      // Even a link that names side by side shows a phone the file full screen.
      await p.goto(`${world.url}#thread=${world.threadId}&file=${world.ids['rollout.md']}&view=side`);
      await expect(pane(p)).toHaveAttribute('data-full-view', '');
      await expect(bar(p).locator('[data-full-view-exit="back"]')).toBeVisible();
      await expect(bar(p).getByRole('button', { name: 'Side by side' })).toHaveCount(0);
      await expect(p.locator('[data-view-switch]')).toHaveCount(0);
      await p.waitForTimeout(300);
      await p.screenshot({ path: join(shotsDir, `phone-01-markdown-full-screen-${scheme}.png`) });
      await bar(p).locator('[data-full-view-exit="back"]').click();
      await expect(pane(p)).toHaveCount(0);
      // An HTML tile: full screen, and no "Open side by side" anywhere in the thread.
      await expect(p.locator('[data-open-as]')).toHaveCount(0);
      await openTile('single-page.html', p);
      await expect(pane(p)).toHaveAttribute('data-full-view', '');
      await p.waitForTimeout(300);
      await p.screenshot({ path: join(shotsDir, `phone-02-html-full-screen-${scheme}.png`) });
      expect(await choiceOf(context)).toBeNull();
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
