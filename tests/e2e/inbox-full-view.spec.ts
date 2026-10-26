/**
 * Full screen for files (approval "inbox-one-fullscreen", Drawer), proved in a
 * real browser against the compiled binary. Nothing is mocked: `plannotator
 * inbox --background` runs under a temp PLANNOTATOR_DATA_DIR and HOME with a
 * tailscale trap first on PATH; one agent sends an HTML page, a markdown plan
 * and a screenshot in one message through `plannotator inbox mcp`; Chromium
 * (and WebKit as an iPhone) drives the window.
 *
 * Proves: one full-screen mode. An HTML file opens full screen with its
 * toolbar showing (pen, count, N/M, ⋯, Side by side, » Hide tools, × Exit
 * full screen), the
 * page filling the window, and plan review's shared hide-tools cookie neither
 * read nor written; a pin and a comment work and the count goes up without
 * opening the drawer; Hide tucks the toolbar into its corner handle, the
 * corner and the keyboard bring it back, the pin keeps it out; the count
 * opens the comments drawer and the page narrows beside it (remembered across
 * a reload); ⋯ holds Open in and Download; Side by side puts the file beside
 * the thread and Full screen brings the toolbar back showing; × leaves full
 * screen as Escape's last step does (HTML, markdown and the image), its
 * tooltip showing Esc, and the corner that reveals a tucked toolbar puts the
 * pointer on the pin, never on ×; Escape climbs one rung per press (a draft, typed words asked about, the drawer, Annotate, the
 * page's own Escape left to the page) and only then leaves full screen;
 * ⌘⇧X from the window and the page tucks and shows; `]` keeps full screen
 * with the chip; N/M opens the peek; a changed file keeps its chip and dots
 * the handle; on an iPhone the toolbar sits bottom right with 44 px targets.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-full-view.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/full-view):
 * html-, markdown- and image-{showing,tucked,revealed,pinned,drawer}-{light,dark}
 * and phone-{showing,tucked,revealed,comments}-{light,dark}, among others.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { forgetFileViewChoice } from './file-view';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/full-view'));

const TURNKEY = `<!doctype html><meta charset="utf-8"><title>The step log</title><style>
body{margin:0;font:18px/1.5 Georgia,serif;background:#151413;color:#efe9e1}
main{max-width:1100px;margin:0 auto;padding:80px 90px}
.eyebrow{font:600 13px system-ui;letter-spacing:.2em;color:#a39d94}
h1{font-size:76px;line-height:1.02;margin:18px 0 28px}
p{font:22px/1.6 system-ui;color:#d6d0c7;max-width:820px}
.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-top:40px;padding:28px;border:1px solid #2c2a27;border-radius:16px}
.card{background:#24221f;border-radius:12px;padding:18px 20px;font:16px system-ui}
#flagged{background:#2e2619}
</style><main><div class="eyebrow">THE STEP LOG · TURNKEY VERSION</div>
<h1 id="headline">Send us your logs. Get back the record.</h1>
<p><b>No changes to how the agent works.</b> The customer switches on the activity logs their agent framework already produces, and stores sessions with us.</p>
<div class="grid"><div class="card">Activity logs</div><div class="card">We store everything, hashed</div><div class="card" id="flagged">Actions flagged; repeats and gaps caught</div></div>
<p><label>Search <input id="q" placeholder="type here"></label> <button id="menu" type="button" onclick="document.body.dataset.menu='open'">Menu</button></p></main>
<script>document.addEventListener('keydown',function(e){if(e.key==='Escape'&&document.body.dataset.menu==='open'){e.preventDefault();delete document.body.dataset.menu;}});</script>`;

const PLAN = ['# Rollout plan', '', 'Ship the step log behind a flag, then to every customer.', '', '## Steps', '', '1. Turn on activity logs.', '2. Store sessions.', '3. Flag repeats and gaps.', ''].join('\n');

interface World {
  root: string;
  url: string;
  project: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  ids: Record<string, string>;
}

let world: World;

/** Light and dark, with reduced motion so the chip and the shots hold still. */
async function shot(page: Page, name: string, schemes: ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const pane = (page = world.page) => page.locator('[data-attachment-pane]');
const bar = (page = world.page) => page.locator('[data-full-view-bar]');
const frame = (page = world.page) => page.frameLocator('[data-attachment-pane] iframe').first();
const composer = (page = world.page) => page.locator('[data-comment-popover] textarea[data-pn-mobile-editable="true"]').last();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-full-view-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  // Nothing here may reach the real tailscale CLI.
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-full-view: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'steplog');
  mkdirSync(join(project, 'site'));
  mkdirSync(join(project, 'docs'));
  mkdirSync(join(project, 'shots'));
  writeFileSync(join(project, 'site', 'turnkey.html'), TURNKEY);
  writeFileSync(join(project, 'docs', 'rollout.md'), PLAN);
  const maker = await browser.newContext({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
  const makerPage = await maker.newPage();
  await makerPage.setContent(TURNKEY);
  writeFileSync(join(project, 'shots', 'landing.png'), await makerPage.screenshot());
  await maker.close();

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = {
    root,
    url,
    project,
    claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude', host: 'claude-code' }),
    context,
    page,
    errors,
    threadId: '',
    ids: {},
  };
  const sent = await world.claude.send({
    project_path: project,
    subject: 'The step log: landing page, rollout and a screenshot',
    body: 'The landing page, the rollout plan and how the page looks at 900 px.',
    attachments: ['site/turnkey.html', 'docs/rollout.md', 'shots/landing.png'],
  });
  world.threadId = sent.thread_id;
  const model = (await (await fetch(new URL(`/api/inbox/threads/${sent.thread_id}/attachments`, url))).json()) as { attachments: { id: string; name: string }[] };
  for (const a of model.attachments) world.ids[a.name] = a.id;
});


/** A view pressed in a test is remembered: forgotten after each, so the next opens by today's rule (file-view.ts). */
test.afterEach(async () => forgetFileViewChoice(world?.page));

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

const dock = (page = world.page) => page.locator('[data-full-view-dock]');
const handle = (page = world.page) => page.locator('[data-full-view-handle]');
const hide = (page = world.page) => page.locator('[data-full-view-hide]');
const count = (page = world.page) => bar(page).locator('[data-full-view-comments]');

/** Put the pointer where it reaches nothing of the toolbar. */
async function pointerAway(page = world.page) {
  await page.mouse.move(400, 500);
}

/**
 * The approved states, in light and dark: the toolbar showing, tucked into its
 * handle, revealed by the corner, pinned, and the comments drawer open. Starts
 * and ends with the toolbar showing and the drawer closed.
 */
async function stateShots(name: string) {
  const page = world.page;
  // No focus ring or tooltip left on a toolbar button from the steps before (focus leaving to nothing tucks nothing).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pointerAway();
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  await shot(page, `${name}-showing`);
  await hide().click();
  await expect(dock()).toHaveAttribute('data-bar', 'tucked');
  await pointerAway();
  await page.waitForTimeout(600);
  await expect(dock()).toHaveAttribute('data-bar', 'tucked');
  await shot(page, `${name}-tucked`);
  // The corner: the toolbar comes out with the pin as its last button.
  await page.mouse.move(1270, 20);
  await expect(dock()).toHaveAttribute('data-bar', 'revealed');
  await expect(hide()).toHaveAttribute('data-full-view-hide', 'pin');
  await shot(page, `${name}-revealed`);
  await hide().click();
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  await pointerAway();
  await page.waitForTimeout(600);
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  await shot(page, `${name}-pinned`);
  await count().click();
  await expect(pane()).toHaveClass(/ib-drawer/);
  await pointerAway();
  await shot(page, `${name}-drawer`);
  await count().click();
  await expect(pane()).not.toHaveClass(/ib-drawer/);
}

test('an HTML file opens full screen: the page fills the window, one toolbar is left, showing', async () => {
  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.getByRole('button', { name: 'Open turnkey.html' }).click();
  await expect(pane()).toHaveClass(/ib-full/);
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(pane().locator('.ib-vhead')).toHaveCount(0);
  await expect(pane().locator('[data-view-foot]')).toHaveCount(0);
  await expect(page.locator('[data-html-tools-toggle]')).toHaveCount(0);
  await expect(frame().locator('#headline')).toHaveText('Send us your logs. Get back the record.');
  // The page fills the window.
  const box = await pane().locator('iframe').first().boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  // The toolbar: top right, showing; pen (armed), the count, the position, ⋯, Side by side, » Hide tools.
  await expect(bar()).toHaveAttribute('role', 'toolbar');
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  const barBox = (await bar().boundingBox())!;
  expect(barBox.x + barBox.width).toBeGreaterThan(1250);
  expect(barBox.y).toBeLessThan(20);
  await expect(bar().locator('[data-full-view-pen]')).toHaveAttribute('aria-pressed', 'true');
  await expect(count()).toHaveAccessibleName('Comments, 0');
  await expect(bar().locator('[data-full-view-position]')).toHaveText('1/3');
  await expect(bar().getByRole('button', { name: 'Side by side' })).toBeVisible();
  await expect(hide()).toHaveAccessibleName('Hide tools');
  // × Exit full screen sits just before », which keeps the corner.
  await expect(bar().locator('button').nth(-2)).toHaveAccessibleName('Exit full screen');
  await expect(bar().locator('button').last()).toHaveAccessibleName('Hide tools');
  await expect(pane().locator('[data-full-view-changed]')).toHaveCount(0);
  // The shared plan-review choice is neither read nor written.
  expect((await world.context.cookies(world.url)).find((c) => c.name === 'plannotator-html-chrome')).toBeUndefined();
});

test('annotating works as before: a pin opens the composer, Save adds a marker; the drawer does not open, the count goes up', async () => {
  const page = world.page;
  await frame().locator('#flagged').click();
  await composer().fill('"Repeats" reads like duplicate charges to a claims team. Say "repeated tool calls".');
  await shot(page, 'html-annotating', ['dark']);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(count()).toHaveAccessibleName('Comments, 1');
  await expect(pane()).not.toHaveClass(/ib-drawer/);
  await expect(pane()).toHaveAttribute('data-full-view', '');
});

test('Hide tucks the toolbar into its corner handle; the corner brings it back; the pin keeps it out; the keyboard reaches it all', async () => {
  const page = world.page;
  await hide().focus();
  await page.keyboard.press('Enter');
  await expect(dock()).toHaveAttribute('data-bar', 'tucked');
  // Tucked: the toolbar is inert and off to the right; the handle is a button with the count, focused.
  await expect(bar()).toHaveJSProperty('inert', true);
  await expect(handle()).toBeFocused();
  await expect(handle()).toHaveAccessibleName('Show tools, 1 comment');
  await expect(page.locator('[data-step-live]')).toHaveText('Tools hidden. They are in the top right corner.');
  const handleBox = (await handle().boundingBox())!;
  expect(handleBox.x + handleBox.width).toBeGreaterThanOrEqual(1279);
  // Enter on the handle: out, focus on the first button; Escape tucks it again, focus back on the handle.
  await page.keyboard.press('Enter');
  await expect(dock()).toHaveAttribute('data-bar', 'revealed');
  await expect(bar().locator('[data-full-view-pen]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dock()).toHaveAttribute('data-bar', 'tucked');
  await expect(handle()).toBeFocused();
  // The pointer in the corner reveals it; leaving tucks it again (a mouse user: nothing in the corner holds focus).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pointerAway();
  await page.mouse.move(1265, 30);
  await expect(dock()).toHaveAttribute('data-bar', 'revealed');
  await pointerAway();
  await expect(dock()).toHaveAttribute('data-bar', 'tucked', { timeout: 3000 });
  // Out again, and the pin keeps it out.
  await page.mouse.move(1265, 30);
  await expect(hide()).toHaveAccessibleName('Keep tools out');
  await hide().click();
  await pointerAway();
  await page.waitForTimeout(700);
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
});

test('the count opens the comments drawer: the page narrows beside it, its foot rides the next Send; Escape closes it; it is remembered', async () => {
  const page = world.page;
  await count().click();
  await expect(pane()).toHaveClass(/ib-drawer/);
  // Not covered: the page narrows by the drawer's width.
  const frameBox = (await pane().locator('iframe').first().boundingBox())!;
  const drawer = (await pane().locator('.ib-apanel').boundingBox())!;
  expect(frameBox.width).toBe(1280 - 320);
  expect(drawer.x).toBe(960);
  // The toolbar sits left of it.
  const barBox = (await bar().boundingBox())!;
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(drawer.x);
  const foot = pane().locator('[data-full-view-foot]');
  await expect(foot).toContainText('1 annotation rides your next Send to Claude.');
  await expect(foot.getByRole('button', { name: 'Write the reply' })).toBeVisible();
  // Remembered across a reload.
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.reload();
  await page.getByRole('button', { name: 'Open turnkey.html' }).click();
  await expect(pane()).toHaveClass(/ib-drawer/);
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  await count().focus();
  await page.keyboard.press('Escape');
  await expect(pane()).not.toHaveClass(/ib-drawer/);
  await expect(count()).toBeFocused();
  await expect(pane()).toHaveAttribute('data-full-view', '');
});

test('⋯ holds Open in and Download; Side by side puts the file beside the thread, and Full screen brings the toolbar back showing', async () => {
  const page = world.page;
  await bar().locator('[data-full-view-more]').click();
  const menu = page.locator(`[data-full-view-menu="${world.ids['turnkey.html']}"]`);
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-attachment-download]')).toBeVisible();
  await expect(menu.getByText('Open in')).toBeVisible();
  await shot(page, 'html-menu', ['dark']);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await hide().click();
  await handle().click();
  await bar().getByRole('button', { name: 'Side by side' }).click();
  await expect(pane()).not.toHaveClass(/ib-full/);
  await expect(pane().locator('.ib-vhead [data-view-side]')).toBeFocused();
  await expect(page.locator('[data-html-tools-toggle]')).toHaveCount(0);
  await shot(page, 'html-beside', ['dark']);
  await pane().locator('.ib-vhead [data-full-screen-toggle]').focus();
  await page.keyboard.press('Enter');
  await expect(pane()).toHaveClass(/ib-full/);
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  await expect(bar().locator('[data-full-view-pen]')).toBeFocused();
});

/** The component tooltip open now (ui's Tooltip popup, portaled out of the window's root). */
const tooltip = (page = world.page) => page.locator('[data-side].bg-popover');

test('× Exit full screen, just before », leaves full screen as Escape\'s last step does (HTML, markdown, the image): beside the thread, focus on the view switch, nothing remembered', async () => {
  const page = world.page;
  for (const name of ['turnkey.html', 'rollout.md', 'landing.png'] as const) {
    await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids[name]!);
    await expect(pane()).toHaveAttribute('data-full-view', '');
    const close = bar().locator('[data-full-view-close]');
    await expect(bar().locator('button').nth(-2)).toHaveAttribute('data-full-view-close', '');
    await expect(close).toHaveAccessibleName('Exit full screen');
    await expect(close).not.toHaveAttribute('title');
    // Its component tooltip names it and shows the key that does the same: Esc.
    await close.hover();
    await expect(tooltip()).toContainText('Exit full screen');
    await expect(tooltip().locator('kbd')).toHaveText('Esc');
    if (name === 'turnkey.html') await shot(page, 'html-exit-tooltip');
    await close.click();
    await expect(pane()).not.toHaveClass(/ib-full/);
    await expect(bar()).toHaveCount(0);
    await expect(pane().locator('.ib-vhead [data-view-side]')).toBeFocused();
    // Not a pick, as with Escape: no view is remembered.
    expect((await world.context.cookies(world.url)).find((c) => c.name === 'plannotator-inbox-file-view')).toBeUndefined();
    // Back to full screen, then on to the next file.
    await pane().locator('.ib-vhead [data-full-screen-toggle]').click();
    await expect(pane()).toHaveAttribute('data-full-view', '');
    // That press was a pick: forgotten, so the next file's check starts clean.
    await forgetFileViewChoice(page);
    if (name === 'rollout.md') {
      // One Escape with focus on × leaves too: its open tooltip does not keep the press.
      await close.hover();
      await close.focus();
      await expect(tooltip()).toContainText('Exit full screen');
      await page.keyboard.press('Escape');
      await expect(bar()).toHaveCount(0);
      await expect(pane().locator('.ib-vhead [data-view-side]')).toBeFocused();
      await pane().locator('.ib-vhead [data-full-screen-toggle]').click();
      await expect(pane()).toHaveAttribute('data-full-view', '');
      await forgetFileViewChoice(page);
    }
    if (name !== 'landing.png') {
      await bar().locator('[data-full-view-position]').focus();
      await page.keyboard.press(']');
    }
  }
  // The page again, for the next test.
  await bar().locator('[data-full-view-position]').focus();
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['turnkey.html']!);
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
});

test('the corner that reveals a tucked toolbar puts the pointer on the pin, never on ×: a habitual corner click keeps full screen', async () => {
  const page = world.page;
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await hide().click();
  await expect(dock()).toHaveAttribute('data-bar', 'tucked');
  await pointerAway();
  await page.waitForTimeout(400);
  const tab = (await handle().boundingBox())!;
  const corner = { x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 };
  await page.mouse.move(corner.x, corner.y);
  await expect(dock()).toHaveAttribute('data-bar', 'revealed');
  // Once the toolbar has slid out, what sits under the pointer is the pin.
  await page.waitForTimeout(400);
  const under = await page.evaluate(({ x, y }) => {
    const button = document.elementFromPoint(x, y)?.closest('button');
    return button ? { close: button.hasAttribute('data-full-view-close'), hide: button.getAttribute('data-full-view-hide') } : null;
  }, corner);
  expect(under).toEqual({ close: false, hide: 'pin' });
  await shot(page, 'corner-revealed', ['light']);
  await page.mouse.click(corner.x, corner.y);
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
});

test('the approved states of an HTML page, in light and dark', async () => {
  await stateShots('html');
});

/**
 * Escape, one rung per press, on an HTML file opened full screen and armed
 * (the toolbar showing, the drawer closed), until full screen ends: an empty
 * draft closes by its own key; typed words are asked about (Discard it);
 * the drawer closes before Annotate (from inside the page); Annotate goes to
 * Interact; in Interact the page's own Escape (its menu, its text field) stays
 * the page's; one it does not use leaves full screen.
 */
async function climbTheLadder(page: Page) {
  const pen = bar(page).locator('[data-full-view-pen]');
  const guard = pane(page).locator('[data-step-guard]');
  // An empty draft: its own Escape closes it; nothing else moves.
  await frame(page).locator('#headline').click();
  await expect(composer(page)).toBeVisible();
  await composer(page).press('Escape');
  await expect(composer(page)).toHaveCount(0);
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  // Typed words are never lost: the question asks; Discard it closes the draft, full screen stays.
  await frame(page).locator('#headline').click();
  await expect(composer(page)).toBeVisible();
  await page.waitForTimeout(200);
  await composer(page).fill('Shorter headline?');
  await expect(composer(page)).toHaveValue('Shorter headline?');
  await composer(page).press('Escape');
  await expect(guard).toBeVisible();
  await expect(guard.locator('[data-guard-save]')).toHaveText('Save it');
  await expect(guard.locator('[data-guard-save]')).toBeFocused();
  await expect(composer(page)).toHaveValue('Shorter headline?');
  await guard.locator('[data-guard-discard]').click();
  await expect(composer(page)).toHaveCount(0);
  await expect(guard).toHaveCount(0);
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  // The drawer, from inside the page: Escape there closes the drawer first, Annotate stays.
  await count(page).click();
  await expect(pane(page)).toHaveClass(/ib-drawer/);
  // The keyboard in the page (a click there would pin): focus on the frame itself.
  await page.locator('[data-attachment-pane] iframe').first().focus();
  await page.keyboard.press('Escape');
  await expect(pane(page)).not.toHaveClass(/ib-drawer/);
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  // Annotate goes to Interact (focus stayed in the page).
  await page.keyboard.press('Escape');
  await expect(pen).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-step-live]')).toHaveText('Interact: clicks reach the page.');
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  // In Interact the page's own Escape is the page's: its menu closes, full screen stays.
  await frame(page).locator('#menu').click();
  await expect(frame(page).locator('body')).toHaveAttribute('data-menu', 'open');
  await frame(page).locator('#menu').press('Escape');
  await expect(frame(page).locator('body')).not.toHaveAttribute('data-menu', 'open');
  await page.waitForTimeout(200);
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  // An Escape in the page's text field stays there too.
  await frame(page).locator('#q').press('Escape');
  await page.waitForTimeout(200);
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  // One the page does not use: full screen ends (nothing remembered), the file is beside the thread, focus on the switch's Side by side.
  // (A click on the headline moves the page's focus out of its field; in Interact it pins nothing.)
  await frame(page).locator('#headline').click();
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await expect(pane(page)).not.toHaveAttribute('data-full-view', '');
  await expect(pane(page).locator('.ib-vhead [data-view-side]')).toBeFocused();
  await expect(page.locator('[data-step-live]')).toHaveText('Side by side: the file is beside the thread.');
  expect((await page.context().cookies()).find((c) => c.name === 'plannotator-inbox-file-view')).toBeUndefined();
}

test('Escape climbs one rung per press (a draft, typed words asked about, the drawer, Annotate, then the page’s own Escape is respected) and then leaves full screen; ⌘⇧X from the window and from the page tucks and shows the toolbar', async () => {
  const page = world.page;
  await climbTheLadder(page);
  // Back in full screen (the toolbar showing) for the chord.
  await pane().locator('.ib-vhead [data-full-screen-toggle]').focus();
  await page.keyboard.press('Enter');
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  // From the window: tucked, focus on the handle (it was in the toolbar).
  await bar().locator('[data-full-view-pen]').focus();
  await page.keyboard.press('ControlOrMeta+Shift+X');
  await expect(dock()).toHaveAttribute('data-bar', 'tucked');
  await expect(handle()).toBeFocused();
  // From inside the page (Interact: the page has the keyboard): shown.
  await frame().locator('#q').click();
  await frame().locator('#q').press('ControlOrMeta+Shift+X');
  await expect(dock()).toHaveAttribute('data-bar', 'pinned');
  await expect(page.locator('[data-step-live]')).toHaveText('Tools shown.');
  // Re-arm with the pen for the rest.
  await bar().locator('[data-full-view-pen]').click();
  await expect(bar().locator('[data-full-view-pen]')).toHaveAttribute('aria-pressed', 'true');
});

test('the same Escape ladder in WebKit (Safari), on a desktop window', async () => {
  const browser = await webkit.launch({ args: [] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${world.threadId}`);
    await page.getByRole('button', { name: 'Open turnkey.html' }).click();
    await expect(pane(page)).toHaveAttribute('data-full-view', '');
    await expect(frame(page).locator('#headline')).toBeVisible();
    await climbTheLadder(page);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('] steps keep full screen and the toolbar as it was: the chip names the new file; markdown and the image fill the window; "Last file" at the end', async () => {
  const page = world.page;
  await bar().locator('[data-full-view-pen]').focus();
  await page.keyboard.press(']');
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['rollout.md']!);
  await expect(pane()).toHaveAttribute('data-full-view', '');
  const chip = pane().locator('[data-full-view-chip]');
  await expect(chip).toHaveAttribute('data-full-view-chip', 'shown');
  await expect(chip).toContainText('2 of 3');
  await expect(chip).toContainText('rollout.md');
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shotsDir, 'step-chip-dark.png') });
  await expect(chip).toHaveAttribute('data-full-view-chip', 'hidden', { timeout: 4000 });
  await expect(pane().locator('.ib-docscroll')).toContainText('Ship the step log behind a flag');
  // Markdown has no pen.
  await expect(bar().locator('[data-full-view-pen]')).toHaveCount(0);
  await stateShots('markdown');
  await page.keyboard.press(']');
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['landing.png']!);
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(chip).toHaveAttribute('data-full-view-chip', 'hidden', { timeout: 4000 });
  await stateShots('image');
  await bar().locator('[data-full-view-position]').focus();
  await page.keyboard.press(']');
  await expect(chip).toContainText('Last file in this thread');
});

test('N/M opens the file peek under the toolbar; a pick goes there and full screen stays', async () => {
  const page = world.page;
  await bar().locator('[data-full-view-position]').click();
  const grid = bar().locator('[data-step-list] [role="grid"]');
  await expect(grid).toBeVisible();
  await shot(page, 'peek', ['dark']);
  await grid.getByRole('gridcell', { name: /^turnkey\.html/ }).click();
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['turnkey.html']!);
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(bar().locator('[data-full-view-position]')).toBeFocused();
  expect(world.errors).toEqual([]);
});

test('a file that changed since it was sent: the chip at the top left stays when the toolbar tucks, the handle carries an amber dot, ⋯ opens the version it sent', async () => {
  const page = world.page;
  writeFileSync(join(world.project, 'docs', 'rollout.md'), PLAN.replace('Ship the step log', 'Hold the step log'));
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.reload();
  await page.getByRole('button', { name: 'Open turnkey.html' }).click();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await bar().locator('[data-full-view-pen]').focus();
  await page.keyboard.press(']');
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['rollout.md']!);
  const changed = pane().locator('[data-full-view-changed]');
  await expect(changed.locator('.ib-fvver-t')).toHaveText('Changed since sent');
  await expect(pane().locator('.ib-docscroll')).toContainText('Hold the step log');
  await page.waitForTimeout(1800);
  await hide().click();
  await pointerAway();
  await expect(changed).toBeVisible();
  await expect(handle().locator('.ib-fvhandle-dot')).toBeVisible();
  await expect(handle()).toHaveAccessibleName('Show tools, file changed since sent');
  await shot(page, 'markdown-changed-tucked', ['dark']);
  await handle().click();
  await bar().locator('[data-full-view-more]').click();
  await page.locator('[data-full-view-version]').click();
  await expect(changed.locator('.ib-fvver-t')).toHaveText('Showing the sent version');
  await expect(pane().locator('.ib-docscroll')).toContainText('Ship the step log');
  await expect(pane()).toHaveAttribute('data-full-view', '');
});

test('on an iPhone (WebKit): the same mode, the toolbar bottom right with 44 px targets; Hide leaves a 44 px tab; the count opens the sheet with the position; ‹ goes back', async () => {
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  const browser = await webkit.launch({ args: [] });
  try {
    for (const scheme of ['dark', 'light'] as const) {
      const context = await browser.newContext({ ...device, colorScheme: scheme });
      const page = await context.newPage();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${world.url}#thread=${world.threadId}`);
      await page.getByRole('button', { name: 'Open turnkey.html' }).click();
      await expect(pane(page)).toHaveAttribute('data-full-view', '');
      await expect(frame(page).locator('#headline')).toBeVisible();
      await expect(dock(page)).toHaveAttribute('data-bar', 'pinned');
      const viewport = page.viewportSize()!;
      const barBox = (await bar(page).boundingBox())!;
      expect(barBox.x + barBox.width).toBeGreaterThan(viewport.width - 40);
      expect(barBox.y + barBox.height).toBeGreaterThan(viewport.height - 80);
      for (const control of ['[data-full-view-exit="back"]', '[data-full-view-pen]', '[data-full-view-comments]', '[data-full-view-position]', '[data-full-view-more]', '[data-full-view-hide]']) {
        const b = (await bar(page).locator(control).boundingBox())!;
        expect(b.width).toBeGreaterThanOrEqual(44);
        expect(b.height).toBeGreaterThanOrEqual(44);
      }
      // The position is the `1/3 ⌄` pill (one tap to every file); the whole toolbar stays on screen.
      await expect(bar(page).locator('[data-full-view-position]')).toHaveAttribute('aria-label', '1/3: file 1 of 3, turnkey.html. Show every file');
      expect(barBox.x).toBeGreaterThanOrEqual(0);
      await expect(bar(page).getByRole('button', { name: 'Side by side' })).toHaveCount(0);
      // ⋯'s rows are 44 px targets on a phone too (Download, the other version).
      await bar(page).locator('[data-full-view-more]').click();
      const rows = page.locator('[data-full-view-menu] [role="menuitem"]');
      await expect(rows.first()).toBeVisible();
      // Measured once the menu's opening scale has settled (0.95 → 1).
      for (const row of await rows.all()) await expect.poll(async () => (await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      if (scheme === 'dark') await page.screenshot({ path: join(shotsDir, 'phone-menu-dark.png') });
      await page.keyboard.press('Escape');
      await expect(rows).toHaveCount(0);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shotsDir, `phone-showing-${scheme}.png`) });
      await hide(page).click();
      await expect(dock(page)).toHaveAttribute('data-bar', 'tucked');
      const tab = (await handle(page).boundingBox())!;
      expect(tab.width).toBeGreaterThanOrEqual(44);
      expect(tab.height).toBeGreaterThanOrEqual(44);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shotsDir, `phone-tucked-${scheme}.png`) });
      await handle(page).click();
      await expect(dock(page)).toHaveAttribute('data-bar', 'revealed');
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shotsDir, `phone-revealed-${scheme}.png`) });
      await hide(page).click();
      await expect(dock(page)).toHaveAttribute('data-bar', 'pinned');
      await count(page).click();
      await expect(pane(page)).toHaveClass(/ib-panel-open/);
      await expect(pane(page).locator('[data-full-view-foot] [data-full-view-position]')).toContainText('1 of 3');
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shotsDir, `phone-comments-${scheme}.png`) });
      if (scheme === 'light') {
        await pane(page).locator('.ib-apanel').getByRole('button', { name: 'Close the comments' }).click();
        await bar(page).locator('[data-full-view-exit="back"]').click();
      } else {
        // A hardware keyboard: Escape closes the sheet, then takes Annotate to Interact, then goes back to the thread.
        await page.keyboard.press('Escape');
        await expect(pane(page)).not.toHaveClass(/ib-panel-open/);
        await expect(bar(page).locator('[data-full-view-pen]')).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('Escape');
        await expect(bar(page).locator('[data-full-view-pen]')).toHaveAttribute('aria-pressed', 'false');
        await page.keyboard.press('Escape');
      }
      await expect(pane(page)).toHaveCount(0);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
