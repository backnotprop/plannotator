/**
 * Full screen goes back to where it was opened from (the owner's report,
 * 2026-10-27; packages/inbox/fullScreenOrigin.ts), proved in a real browser
 * against the compiled binary. Nothing is mocked: `plannotator inbox
 * --background` runs under a temp PLANNOTATOR_DATA_DIR and HOME with a
 * tailscale trap first on PATH; one agent sends a message whose text shows a
 * screenshot and which attaches another screenshot (the preview under the
 * message) and a markdown plan; Chromium (and WebKit as an iPhone) drives the
 * window.
 *
 * Proves: in a thread with no file open, the image preview under the message
 * opens full screen (Full screen chosen), and × (named Back to the thread),
 * Escape and the browser's Back each bring back the thread as it was, with
 * no file beside it; so does an image in the text (full screen by the rule).
 * A file beside the thread taken full screen with the switch goes back
 * beside it with ×, Escape and Back, and one more Back is the thread alone.
 * On an iPhone, ‹ Back to the thread and the browser's Back bring back the
 * thread.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-fullscreen-close.spec.ts`.
 * PNGs and a video of the owner's path land in PLANNOTATOR_E2E_SHOTS_DIR
 * (default .local/proof/fullscreen-close).
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
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/fullscreen-close'));
const VIEW_COOKIE = 'plannotator-inbox-file-view';

const screen = (title: string, accent: string) => `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:18px/1.5 system-ui;background:#f6f3ee;color:#1d1b19}
main{max-width:860px;margin:0 auto;padding:56px 64px}
h1{font:600 46px/1.05 Georgia,serif;margin:0 0 18px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:28px}
.card{background:#fff;border-radius:12px;padding:18px;border-top:4px solid ${accent}}
</style><main><h1>${title}</h1><p>Choose a plan, pay once, and get the receipt by email.</p>
<div class="cards"><div class="card">Basket</div><div class="card">Payment</div><div class="card">Receipt</div></div></main>`;

const PLAN = ['# Checkout rollout', '', 'Ship the single-page checkout behind a flag, then to everyone.', '', '1. Flag on for staff.', '2. Flag on for 10%.', '3. Everyone.', ''].join('\n');

interface World {
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  ids: Record<string, string>;
}

let world: World;

const pane = (p = world.page) => p.locator('[data-attachment-pane]');
const bar = (p = world.page) => p.locator('[data-full-view-bar]');
const preview = (p = world.page) => p.locator(`[data-gallery-image="${world.ids['receipt.png']}"]`);
const threadHash = () => `#thread=${world.threadId}`;

async function shot(p: Page, name: string): Promise<void> {
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(shotsDir, `${name}.png`) });
}

async function chooseView(view: 'full' | 'side' | null, context = world.context) {
  await context.clearCookies({ name: VIEW_COOKIE });
  if (view) await context.addCookies([{ name: VIEW_COOKIE, value: view, url: world.url }]);
}

/** The thread on screen with no file open, at the top of the history this test builds. */
async function freshThread(p = world.page) {
  await p.goto(`${world.url}${threadHash()}`);
  await expect(preview(p)).toBeVisible();
  await expect(pane(p)).toHaveCount(0);
}

async function expectThreadAsItWas(p = world.page) {
  await expect(pane(p)).toHaveCount(0);
  await expect(p.locator('[data-view-switch]')).toHaveCount(0);
  expect(new URL(p.url()).hash).toBe(threadHash());
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-fullscreen-close-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-fullscreen-close: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'checkout');
  for (const folder of ['docs', 'shots']) mkdirSync(join(project, folder));
  writeFileSync(join(project, 'docs', 'rollout.md'), PLAN);
  const maker = await browser.newContext({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
  const makerPage = await maker.newPage();
  await makerPage.setContent(screen('One page to pay', '#c2410c'));
  writeFileSync(join(project, 'shots', 'checkout.png'), await makerPage.screenshot());
  await makerPage.setContent(screen('Your receipt', '#2563eb'));
  writeFileSync(join(project, 'shots', 'receipt.png'), await makerPage.screenshot());
  await maker.close();

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', recordVideo: { dir: join(shotsDir, 'video'), size: { width: 1440, height: 900 } } });
  const p = await context.newPage();
  await p.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  p.on('pageerror', (error) => errors.push(error.message));
  world = { url, claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude', host: 'claude-code' }), context, page: p, errors, threadId: '', ids: {} };
  const sent = await world.claude.send({
    project_path: project,
    subject: 'Checkout: the page and the receipt',
    body: ['How the single-page checkout looks at 900 px:', '', '![Single-page checkout](shots/checkout.png)', '', 'The receipt and the rollout plan are attached.'].join('\n'),
    attachments: ['shots/receipt.png', 'docs/rollout.md'],
  });
  world.threadId = sent.thread_id;
  await p.goto(`${url}${threadHash()}`);
  const thread = await p.evaluate(async (id) => (await (await fetch(`/api/inbox/threads/${id}`)).json()).thread, sent.thread_id);
  for (const message of thread.messages) {
    for (const file of [...(message.inline_images ?? []), ...(message.attachments ?? [])] as { name: string; id: string }[]) world.ids[file.name] = file.id;
  }
  expect(Object.keys(world.ids).sort()).toEqual(['checkout.png', 'receipt.png', 'rollout.md']);
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

test("the owner's path: the preview under a message opens full screen; × brings back the thread as it was", async () => {
  const p = world.page;
  await chooseView('full');
  await freshThread();
  await shot(p, 'desktop-01-thread');
  await preview().click();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['receipt.png']!);
  await shot(p, 'desktop-02-full-screen');
  const close = bar().locator('[data-full-view-close]');
  await close.click();
  await shot(p, 'desktop-03-after-x');
  await expectThreadAsItWas();
  // The × names where it goes.
  await preview().click();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(close).toHaveAccessibleName('Back to the thread');
  await close.hover();
  await expect(p.locator('[data-side].bg-popover')).toContainText('Back to the thread');
  await shot(p, 'desktop-04-x-tooltip');
  await close.click();
  await expectThreadAsItWas();
  expect(world.errors).toEqual([]);
});

test('Escape and the browser’s Back agree with ×: the thread as it was; an image in the text too', async () => {
  const p = world.page;
  await chooseView('full');
  await freshThread();
  await preview().click();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await p.keyboard.press('Escape');
  await expectThreadAsItWas();
  await preview().click();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await p.goBack();
  await expectThreadAsItWas();
  // An image in the text: full screen by the rule, whatever the choice.
  await chooseView(null);
  await freshThread();
  const inline = p.locator(`.ib-body img[data-inline-image="${world.ids['checkout.png']}"]`);
  await inline.click();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await bar().locator('[data-full-view-close]').click();
  await expectThreadAsItWas();
  await inline.click();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await p.keyboard.press('Escape');
  await expectThreadAsItWas();
});

test('beside the thread first, then the switch: ×, Escape and Back go back beside the thread; one more Back is the thread alone', async () => {
  const p = world.page;
  await chooseView('side');
  await freshThread();
  await p.getByRole('button', { name: 'Open rollout.md' }).first().click();
  await expect(pane()).not.toHaveClass(/ib-full/);
  const toFull = () => pane().locator('.ib-vhead [data-full-screen-toggle]').click();
  const beside = async () => {
    await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids['rollout.md']!);
    await expect(pane()).not.toHaveClass(/ib-full/);
    await expect(pane().locator('.ib-vhead [data-view-side]')).toBeVisible();
  };
  await shot(p, 'desktop-05-beside');
  await toFull();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await expect(bar().locator('[data-full-view-close]')).toHaveAccessibleName('Exit full screen');
  await bar().locator('[data-full-view-close]').click();
  await beside();
  await shot(p, 'desktop-06-switch-then-x-beside');
  await toFull();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await p.keyboard.press('Escape');
  await beside();
  await toFull();
  await expect(pane()).toHaveAttribute('data-full-view', '');
  await p.goBack();
  await beside();
  // Full screen left no entry behind: one Back from beside the thread is the thread alone.
  await p.goBack();
  await expectThreadAsItWas();
  expect(world.errors).toEqual([]);
});

test('on an iPhone (WebKit): ‹ Back to the thread and the browser’s Back bring back the thread', async () => {
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  const browser = await webkit.launch({ args: [] });
  try {
    const context = await browser.newContext({ ...device, colorScheme: 'light' });
    await chooseView(null, context);
    const p = await context.newPage();
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await freshThread(p);
    await preview(p).click();
    await expect(pane(p)).toHaveAttribute('data-full-view', '');
    await shot(p, 'phone-01-full-screen');
    await bar(p).locator('[data-full-view-exit="back"]').click();
    await expectThreadAsItWas(p);
    await shot(p, 'phone-02-after-back');
    await preview(p).click();
    await expect(pane(p)).toHaveAttribute('data-full-view', '');
    await p.goBack();
    await expectThreadAsItWas(p);
    await context.close();
  } finally {
    await browser.close();
  }
});
