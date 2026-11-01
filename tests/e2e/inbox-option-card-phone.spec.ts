/**
 * A picture on a phone keeps clear of what floats over it (approval
 * "inbox-option-card-phone", 2026-11-01), proved against the compiled binary
 * under a temp data dir. Standing up, Fit and the pan's limits work between the
 * size bar and the option card (or the toolbar on a plain picture), so the
 * whole picture can always be seen, with no gap or overlap at the pan's stop.
 * Everything the fingers could do before still works: a pinch in and out (one
 * finger under the card included), a pan to all four edges at Actual size and
 * zoomed, a tall picture or a panorama zoomed below its Fit, a double tap, a
 * swipe between pictures and a drag down to close. A zoomed picture still
 * slides under the bars. Hide takes the card too and gives the picture the
 * whole screen. The card is one row and one height (approval
 * "inbox-option-card-lean": the letter and the name, no arrows on a phone, no
 * question, dots or end note), a long name giving way with an ellipsis, and the
 * last option is said in the live region on the step onto it. A phone on its
 * side stays as it was; a desktop has its own spec.
 *
 * Chromium: real touches, through the DevTools protocol. WebKit has no way to
 * send them from Playwright (phone-touch.ts): its checks use the mouse for a
 * pan and hand-made pointer events for a pinch, so they prove the layout and
 * the arithmetic in WebKit, not a finger on Safari.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-option-card-phone.spec.ts`.
 * PNGs land in PLANNOTATOR_OPTION_CARD_SHOTS (default .local/proof/option-card-phone).
 */

import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { finger, pinch, png, type Finger, type Point } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_OPTION_CARD_SHOTS ?? join(repo, '.local/proof/option-card-phone'));

const QUESTION = [
  ':::question',
  'Where should Back to draft sit on a waiting thread?',
  '',
  '- [ ] A link in the header — ![Option A](shots/opt-a.png) a quiet link',
  '- [ ] A line in the thread — ![Option B](shots/opt-b.png) under the last message',
  '- [ ] A band and a line — ![Option C](shots/opt-c.png) both for one release',
  '- [ ] A long page — ![Option D](shots/opt-d.png) a tall picture',
  '- [ ] A panorama — ![Option E](shots/opt-e.png) a very wide picture',
  '',
  'Recommended: A line in the thread',
  ':::',
].join('\n');

async function world() {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-option-card-');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'web-app');
  mkdirSync(join(project, 'shots'), { recursive: true });
  const pictures: Record<string, [number, number, [number, number, number]]> = {
    'opt-a': [1440, 900, [60, 110, 240]],
    'opt-b': [1440, 900, [40, 170, 80]],
    'opt-c': [900, 1350, [220, 50, 50]],
    'opt-d': [600, 1800, [150, 60, 230]],
    'opt-e': [2000, 400, [230, 150, 40]],
    plain: [1440, 900, [40, 180, 190]],
    'plain-2': [1200, 900, [120, 120, 130]],
  };
  for (const [name, [width, height, hue]] of Object.entries(pictures)) writeFileSync(join(project, 'shots', `${name}.png`), png(width, height, hue));
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await agent.send({
    project_path: project,
    subject: 'Back to draft',
    thread: 'draft',
    body: ['Five ways to place Back to draft. Two mockups are attached too.', '', QUESTION].join('\n'),
    attachments: ['shots/plain.png', 'shots/plain-2.png'],
  });
  return { root, url, agent, thread: sent.thread_id as string };
}

const pane = (page: Page) => page.locator('[data-attachment-pane]');
const caption = (page: Page) => page.locator('[data-option-caption]');
const zoomStage = (page: Page) => pane(page).locator('[data-image-zoom-stage]');
const pill = (page: Page) => page.locator('[data-full-view-bar] [data-full-view-position]');

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/** Everything on screen that matters, as drawn; null for what is not there or hidden. */
function layout(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el || el.closest('[inert]') || getComputedStyle(el).visibility === 'hidden') return null;
      const { top, bottom, left, right, width, height } = el.getBoundingClientRect();
      return width === 0 || height === 0 ? null : { top, bottom, left, right, width, height };
    };
    return {
      image: box('.ib-imgstage .ib-zoomimg')!,
      stage: box('.ib-imgstage')!,
      card: box('.ib-optcap'),
      sizeBar: box('.ib-imgbar'),
      toolbar: box('.ib-fvdock-phone .ib-fvbar'),
      composer: box('.ib-fcomp'),
      scale: parseInt(document.querySelector('[data-image-zoom]')?.textContent?.replace(/\D/g, '') ?? '0', 10),
    };
  });
}

type Layout = Awaited<ReturnType<typeof layout>>;

/** Where the picture's clear space ends: the card's top, or the toolbar's. */
const floor = (l: Layout) => (l.card ?? l.toolbar)!.top;
const ceiling = (l: Layout) => l.sizeBar!.bottom;
const same = (a: Box, b: Box) => {
  for (const side of ['top', 'bottom', 'left', 'right'] as const) expect(Math.abs(a[side] - b[side]), side).toBeLessThan(1.5);
};
/** The whole picture is in the clear space: nothing floats over any of it. */
const inTheClear = (l: Layout) => {
  expect(l.image.top).toBeGreaterThanOrEqual(ceiling(l) - 0.5);
  expect(l.image.bottom).toBeLessThanOrEqual(floor(l) + 0.5);
};

const settled = (page: Page, ms = 320) => page.waitForTimeout(ms);

/**
 * Nothing is moving: no transition running, and the picture where it was three frames ago. Counted in frames, not
 * time, so a slow renderer (WebKit on a CI runner) is measured as late as it needs: a fixed wait there reads the
 * card halfway through its fade.
 */
const atRest = (page: Page) =>
  page.evaluate(async () => {
    const image = document.querySelector('.ib-imgstage .ib-zoomimg')!;
    let still = 0;
    let was = '';
    while (still < 3) {
      await new Promise(requestAnimationFrame);
      const { top, left, width } = image.getBoundingClientRect();
      const now = `${top} ${left} ${width}`;
      const moving = document.getAnimations().some((a) => a instanceof CSSTransition && a.playState === 'running');
      still = !moving && now === was ? still + 1 : 0;
      was = now;
    }
  });

async function openChoice(page: Page, url: string, thread: string, letter: string) {
  await page.goto('about:blank');
  await page.goto(`${url}#thread=${thread}`);
  const zoom = page.getByRole('button', { name: `Zoom: Option ${letter}` }).first();
  await zoom.scrollIntoViewIfNeeded();
  await zoom.tap();
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  await expect(pane(page).locator('[data-image-zoom]')).toBeVisible();
  await expect(caption(page)).toHaveAttribute('data-option-caption', letter);
  await atRest(page);
}

/** The picture's middle, on the stage, where a finger lands without touching a button. */
const middle = (l: Layout): Point => ({ x: (l.stage.left + l.stage.right) / 2, y: (ceiling(l) + floor(l)) / 2 });

/** One finger drags the same way, again and again, until the picture is at the edge asked for. */
async function panTo(page: Page, touch: Finger, side: 'top' | 'bottom' | 'left' | 'right') {
  const dx = side === 'left' ? 90 : side === 'right' ? -90 : 0;
  const dy = side === 'top' ? 90 : side === 'bottom' ? -90 : 0;
  let last = await layout(page);
  const at = middle(last);
  for (let i = 0; i < 40; i++) {
    // Sideways, a drag from the edge steps to the next file, and one that reaches the edge hands the rest of itself to
    // the swipe: slowly, so it is no flick, and long enough for the picture to spring back before it is measured.
    const sideways = dx !== 0;
    const room = side === 'left' ? last.stage.left - last.image.left : side === 'right' ? last.image.right - last.stage.right : Infinity;
    if (room <= 0.5) break;
    await touch.down(at.x - dx / 2, at.y - dy / 2, dx, dy, sideways ? 20 : 6);
    await touch.up();
    await settled(page, sideways ? 340 : 90);
    const now = await layout(page);
    if (Math.abs(now.image.top - last.image.top) < 0.5 && Math.abs(now.image.left - last.image.left) < 0.5) return now;
    last = now;
  }
  return last;
}

/** A picture larger than the clear space reaches all four stops, each exactly at the clear space's or the stage's edge. */
async function panAllFour(page: Page, touch: Finger, file: string) {
  const bottom = await panTo(page, touch, 'bottom');
  expect(Math.abs(bottom.image.bottom - floor(bottom)), 'the bottom stops at the floating row').toBeLessThan(1);
  const top = await panTo(page, touch, 'top');
  expect(Math.abs(top.image.top - ceiling(top)), 'the top stops at the size bar').toBeLessThan(1);
  const right = await panTo(page, touch, 'right');
  expect(Math.abs(right.image.right - right.stage.right), 'the right edge reaches the stage').toBeLessThan(1);
  const left = await panTo(page, touch, 'left');
  expect(Math.abs(left.image.left - left.stage.left), 'the left edge reaches the stage').toBeLessThan(1);
  await expect(pane(page)).toHaveAttribute('aria-label', new RegExp(`^${file}`));
}

/** Two fingers either side of `at`, their distance going from `from` to `to`. */
const spread = (page: Page, at: Point, from: number, to: number) =>
  pinch(
    page,
    [
      { x: at.x, y: at.y - from / 2 },
      { x: at.x, y: at.y + from / 2 },
    ],
    [
      { x: at.x, y: at.y - to / 2 },
      { x: at.x, y: at.y + to / 2 },
    ],
  );

async function doubleTap(page: Page, at: Point) {
  await page.touchscreen.tap(at.x, at.y);
  await page.waitForTimeout(80);
  await page.touchscreen.tap(at.x, at.y);
  await settled(page);
}

/** The size bar's button (Fit to Actual size, anything else to Fit), once the picture has got there. */
async function tapFit(page: Page) {
  const was = await zoomStage(page).getAttribute('data-image-zoom-stage');
  await page.locator('[data-image-fit]').tap();
  await expect(zoomStage(page)).toHaveAttribute('data-image-zoom-stage', was === 'fit' ? 'actual' : 'fit');
  await atRest(page);
}

/** A tap that moves the tools to `state`, once the pane is there and what fades or refits with it has finished. */
async function tapTools(page: Page, button: string, state: 'tucked' | 'revealed' | 'pinned') {
  await page.locator(button).tap();
  await expect(page.locator(`[data-tools="${state}"]`)).toHaveCount(1);
  await atRest(page);
}

const hideTools = (page: Page) => tapTools(page, '[data-full-view-bar] button[aria-label="Hide tools"]', 'tucked');

async function shot(page: Page, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

const { defaultBrowserType: _pixelBrowser, ...pixel } = devices['Pixel 7'];
const { defaultBrowserType: _iphoneBrowser, ...iphone } = devices['iPhone 15'];
const sized = <T extends object>(device: T, width: number, height: number) => ({ ...device, viewport: { width, height }, screen: { width, height } });

for (const { name, width, height } of [
  { name: 'the owner\'s phone with its address bar', width: 402, height: 660 },
  { name: 'a phone at full height', width: 390, height: 844 },
])
  test(`real touches, ${name} (${width} × ${height}): a picture is never left under the card, and every gesture still works`, async () => {
    // Every gesture, one finger at a time: about two minutes on a laptop, longer on a CI runner.
    test.setTimeout(480_000);
    const { root, url, agent, thread } = await world();
    const browser: Browser = await chromium.launch();
    try {
      const context = await browser.newContext(sized(pixel, width, height));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const touch = await finger(page, 'chromium');
      const tag = `${width}x${height}`;

      // Fit: the whole picture, above the card.
      await openChoice(page, url, thread, 'A');
      const fit = await layout(page);
      inTheClear(fit);
      expect(fit.image.width).toBeGreaterThan(fit.stage.width - 30);
      await shot(page, `${tag}-A-fit`);

      // Actual size: all four stops, exactly at the rows (no gap, no overlap).
      await tapFit(page);
      await panAllFour(page, touch, 'opt-a.png');
      await panTo(page, touch, 'bottom');
      await shot(page, `${tag}-A-actual-bottom-stop`);
      await tapFit(page);
      same((await layout(page)).image, fit.image);

      // A pinch in, and the picture slides under the bars.
      const at = middle(fit);
      await spread(page, at, 90, 320);
      await settled(page);
      await expect(zoomStage(page)).toHaveAttribute('data-image-zoom-stage', 'zoom');
      const zoomed = await layout(page);
      expect(zoomed.scale).toBeGreaterThan(fit.scale * 2);
      expect(zoomed.image.top, 'under the size bar').toBeLessThan(zoomed.sizeBar!.bottom);
      expect(zoomed.image.bottom, 'under the card').toBeGreaterThan(zoomed.card!.bottom);
      await shot(page, `${tag}-A-pinched-in`);
      await panAllFour(page, touch, 'opt-a.png');
      await shot(page, `${tag}-A-pinched-all-four`);

      // A pinch out: back to Fit, where it stops for a picture Fit shows whole.
      await spread(page, at, 320, 50);
      await settled(page);
      await spread(page, at, 200, 60);
      await settled(page);
      const out = await layout(page);
      await expect(zoomStage(page)).toHaveAttribute('data-image-zoom-stage', 'fit');
      same(out.image, fit.image);

      // A second finger under the card still reaches the picture.
      const card = fit.card!;
      await pinch(
        page,
        [
          { x: at.x, y: at.y - 40 },
          { x: at.x, y: (card.top + card.bottom) / 2 },
        ],
        [
          { x: at.x, y: at.y - 120 },
          { x: at.x, y: (card.top + card.bottom) / 2 + 60 },
        ],
      );
      await settled(page);
      expect((await layout(page)).scale).toBeGreaterThan(fit.scale);
      await tapFit(page);
      same((await layout(page)).image, fit.image);

      // A double tap: 2× about the finger, and back.
      await doubleTap(page, at);
      await expect(zoomStage(page)).toHaveAttribute('data-image-zoom-stage', 'zoom');
      expect((await layout(page)).scale).toBeGreaterThanOrEqual(fit.scale * 2 - 1);
      await doubleTap(page, at);
      await expect(zoomStage(page)).toHaveAttribute('data-image-zoom-stage', 'fit');
      same((await layout(page)).image, fit.image);

      // A swipe: the next picture comes in level with where it will land, and lands there.
      await touch.down(fit.stage.right - 60, at.y, -fit.stage.width * 0.4, 0, 6);
      const incoming = await page.locator('.ib-imgpeek[data-image-peek="next"] img').evaluate((el) => {
        const { top, bottom } = el.getBoundingClientRect();
        return { top, bottom };
      });
      await touch.up();
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'B');
      await settled(page, 600);
      const landed = await layout(page);
      same(landed.image, fit.image);
      expect(Math.abs(incoming.top - landed.image.top)).toBeLessThan(1.5);
      expect(Math.abs(incoming.bottom - landed.image.bottom)).toBeLessThan(1.5);

      // The composer's other states keep the picture clear of the card too.
      await page.getByRole('radio', { name: /Reply/ }).first().tap();
      await settled(page);
      inTheClear(await layout(page));
      await page.getByRole('radio', { name: /Comment/ }).first().tap();
      await settled(page);
      await page.locator('.ib-fcomp-min').tap();
      await settled(page);
      const minimized = await layout(page);
      inTheClear(minimized);
      await page.locator('.ib-fcomp-pill').tap();
      await settled(page);

      // A tall picture reads from the top, reaches its end, and zooms below its Fit: the whole of it, in the clear.
      await openChoice(page, url, thread, 'D');
      const tall = await layout(page);
      expect(Math.abs(tall.image.top - ceiling(tall))).toBeLessThan(1);
      const end = await panTo(page, touch, 'bottom');
      expect(Math.abs(end.image.bottom - floor(end)), 'a tall picture reaches its end').toBeLessThan(1);
      await shot(page, `${tag}-D-tall-end`);
      await panTo(page, touch, 'top');
      for (let i = 0; i < 3; i++) {
        await spread(page, at, 300, 60);
        await settled(page, 120);
      }
      const small = await layout(page);
      expect(small.scale).toBeLessThan(tall.scale);
      inTheClear(small);

      // A panorama: Fit by its height, a pan to its far end, then below its Fit, the whole of it.
      await openChoice(page, url, thread, 'E');
      const pano = await layout(page);
      inTheClear(pano);
      expect(pano.image.width).toBeGreaterThan(pano.stage.width);
      const far = await panTo(page, touch, 'right');
      expect(Math.abs(far.image.right - far.stage.right)).toBeLessThan(1);
      for (let i = 0; i < 3; i++) {
        await spread(page, at, 300, 60);
        await settled(page, 120);
      }
      const wholePano = await layout(page);
      expect(wholePano.scale).toBeLessThan(pano.scale);
      expect(wholePano.image.width).toBeLessThanOrEqual(wholePano.stage.width + 0.5);

      // The picture standing up gets the room Hide gives, and the card goes with the tools.
      await openChoice(page, url, thread, 'C');
      const tools = await layout(page);
      inTheClear(tools);
      await shot(page, `${tag}-C-portrait`);
      await hideTools(page);
      const hidden = await layout(page);
      expect(hidden.card).toBeNull();
      expect(hidden.image.height).toBeGreaterThanOrEqual(tools.image.height);
      expect(hidden.image.bottom).toBeGreaterThan(tools.image.bottom - 1);
      expect(Math.abs(hidden.image.top - hidden.stage.top - (hidden.stage.bottom - hidden.image.bottom)), 'centred on the whole stage').toBeLessThan(1);
      expect(Math.min(hidden.image.top - hidden.stage.top, hidden.image.left - hidden.stage.left)).toBeLessThan(14);
      await shot(page, `${tag}-C-hidden`);
      // The handle brings the toolbar back for a moment: the picture stays, the card stays away, until the tools are kept out.
      await tapTools(page, '[data-full-view-handle]', 'revealed');
      await expect(caption(page)).toBeHidden();
      same((await layout(page)).image, hidden.image);
      await tapTools(page, '[data-full-view-bar] button[aria-label="Keep tools out"]', 'pinned');
      same((await layout(page)).image, tools.image);

      // A plain picture gets the same: the toolbar is the floor.
      await pill(page).tap();
      await page.locator('[data-image-peek-sheet]').getByRole('gridcell', { name: /^plain\.png/ }).click();
      await expect(caption(page)).toHaveCount(0);
      await expect(pane(page)).toHaveAttribute('aria-label', /^plain\.png/);
      await settled(page);
      const plain = await layout(page);
      inTheClear(plain);
      await shot(page, `${tag}-plain-fit`);
      await tapFit(page);
      await panAllFour(page, touch, 'plain.png');
      await panTo(page, touch, 'bottom');
      await shot(page, `${tag}-plain-actual-bottom-stop`);
      await tapFit(page);
      await hideTools(page);
      const plainHidden = await layout(page);
      expect(plainHidden.toolbar).toBeNull();
      expect(Math.abs(plainHidden.image.top - plainHidden.stage.top - (plainHidden.stage.bottom - plainHidden.image.bottom))).toBeLessThan(1);
      await tapTools(page, '[data-full-view-handle]', 'revealed');
      await tapTools(page, '[data-full-view-bar] button[aria-label="Keep tools out"]', 'pinned');

      // A drag down closes, back to the thread.
      const close = await layout(page);
      await touch.down(middle(close).x, close.stage.top + close.stage.height * 0.3, 0, close.stage.height * 0.4);
      await touch.up();
      await expect(pane(page)).toHaveCount(0);

      expect(errors).toEqual([]);
      await context.close();
    } finally {
      await browser.close().catch(() => {});
      await agent.close().catch(() => {});
      await removeInboxScratch(root);
    }
  });

test('a picture opens where it stays: it does not slide into place once the rows are known', async () => {
  const { root, url, agent, thread } = await world();
  const browser: Browser = await chromium.launch();
  try {
    const context = await browser.newContext(sized(pixel, 402, 660));
    const page = await context.newPage();
    await page.goto(`${url}#thread=${thread}`);
    const zoom = page.getByRole('button', { name: 'Zoom: Option A' }).first();
    await zoom.scrollIntoViewIfNeeded();
    // Every frame from the tap on: where the picture is drawn.
    await page.evaluate(() => {
      const tops: number[] = [];
      (window as unknown as { __tops: number[] }).__tops = tops;
      const frame = () => {
        const image = document.querySelector<HTMLImageElement>('.ib-imgstage .ib-zoomimg');
        const top = image?.getBoundingClientRect().top ?? 0;
        // (At 0 it is not laid out yet.)
        if (top > 0) tops.push(top);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await zoom.tap();
    await expect(pane(page).locator('[data-image-zoom]')).toBeVisible();
    await page.waitForTimeout(700);
    const tops = await page.evaluate(() => (window as unknown as { __tops: number[] }).__tops);
    const final = tops.at(-1)!;
    expect(tops.length).toBeGreaterThan(5);
    expect(tops.filter((top) => Math.abs(top - final) > 1), JSON.stringify(tops.slice(0, 20))).toHaveLength(0);
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await agent.close().catch(() => {});
    await removeInboxScratch(root);
  }
});

for (const [width, height] of [
  [402, 660],
  [390, 844],
  [360, 780],
  [320, 640],
] as const)
  test(`the card is one row and one height at ${width} × ${height}: the letter and the name, no arrows, question, dots or end note; the last option is said in the live region`, async () => {
    const { root, url, agent, thread } = await world();
    const browser: Browser = await chromium.launch();
    try {
      const context = await browser.newContext(sized(pixel, width, height));
      const page = await context.newPage();
      await openChoice(page, url, thread, 'B');
      const recommended = (await layout(page)).card!;
      expect(recommended.height, 'one row').toBeLessThan(60);
      await expect(caption(page).locator('.ib-optcap-letter')).toHaveText('B');
      await expect(caption(page).locator('[data-option-recommended]')).toHaveText('Recommended');
      for (const gone of ['[data-option-step]', '.ib-optcap-q', '.ib-optcap-prompt', '.ib-optcap-dots', '[data-option-end]']) await expect(caption(page).locator(gone)).toHaveCount(0);
      await shot(page, `${width}x${height}-B-lean`);

      // A swipe onto the last option: the card is where it was, and the live region says where the other files are.
      await openChoice(page, url, thread, 'D');
      const touch = await finger(page, 'chromium');
      const tall = await layout(page);
      await touch.down(tall.stage.right - 60, middle(tall).y, -tall.stage.width * 0.5, 0);
      await touch.up();
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'E');
      await expect(page.locator('[data-step-live]')).toHaveText('Option E of 5: A panorama. Last option. 2 other files under the 5/5 button');
      const last = (await layout(page)).card!;
      expect(last.height).toBe(recommended.height);
      expect(last.top).toBe(recommended.top);
      await shot(page, `${width}x${height}-E-lean`);

      // A swipe past the end (the panorama panned to its far end first) says it again, as the pane always has.
      const l = await panTo(page, touch, 'right');
      await touch.down(l.stage.right - 60, middle(l).y, -l.stage.width * 0.5, 0);
      await touch.up();
      await expect(page.locator('[data-step-live]')).toHaveText('Last option');
      expect((await layout(page)).card!.height).toBe(recommended.height);

      // The largest text size, and a very long name: the name gives way with an ellipsis, the letter and the card stay whole.
      await page.evaluate(() => document.documentElement.style.setProperty('--inbox-text-size', '15'));
      await caption(page).locator('.ib-optcap-label').evaluate((el) => {
        el.textContent = 'A very long choice name that goes on and on about where the quiet link should sit on a waiting thread';
      });
      await settled(page);
      const cut = await caption(page).evaluate((card) => {
        const label = card.querySelector<HTMLElement>('.ib-optcap-label')!;
        const letter = card.querySelector<HTMLElement>('.ib-optcap-letter')!.getBoundingClientRect();
        const box = card.getBoundingClientRect();
        return { cut: label.scrollWidth > label.clientWidth, ellipsis: getComputedStyle(label).textOverflow, letterIn: letter.left >= box.left && letter.right <= box.right, right: box.right, width: window.innerWidth };
      });
      expect(cut.cut).toBe(true);
      expect(cut.ellipsis).toBe('ellipsis');
      expect(cut.letterIn).toBe(true);
      expect(cut.right).toBeLessThanOrEqual(cut.width - 20);
      const large = await layout(page);
      inTheClear(large);
      await shot(page, `${width}x${height}-long-name`);

      await context.close();
    } finally {
      await browser.close().catch(() => {});
      await agent.close().catch(() => {});
      await removeInboxScratch(root);
    }
  });

test('in WebKit (mouse and hand-made pointers, not a finger): the clear space, the pan stops, a pinch and Hide', async () => {
  test.setTimeout(480_000);
  const { root, url, agent, thread } = await world();
  // (WebKit launches without the config's Chromium flags, which Linux WebKit exits on.)
  const browser: Browser = await webkit.launch({ args: [] });
  try {
    for (const [width, height] of [
      [402, 660],
      [390, 844],
    ] as const) {
      const context = await browser.newContext(sized(iphone, width, height));
      const page = await context.newPage();
      const tag = `webkit-${width}x${height}`;
      await openChoice(page, url, thread, 'A');
      const fit = await layout(page);
      inTheClear(fit);
      await shot(page, `${tag}-A-fit`);

      await tapFit(page);
      const at = middle(fit);
      const dragBy = async (dx: number, dy: number) => {
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.move(at.x + dx, at.y + dy, { steps: 4 });
        await page.mouse.up();
        await settled(page, 60);
      };
      for (let i = 0; i < 12; i++) await dragBy(0, -120);
      const bottom = await layout(page);
      expect(Math.abs(bottom.image.bottom - floor(bottom))).toBeLessThan(1);
      for (let i = 0; i < 12; i++) await dragBy(0, 120);
      const top = await layout(page);
      expect(Math.abs(top.image.top - ceiling(top))).toBeLessThan(1);
      for (let i = 0; i < 16; i++) await dragBy(-120, 0);
      const right = await layout(page);
      expect(Math.abs(right.image.right - right.stage.right)).toBeLessThan(1);
      for (let i = 0; i < 16; i++) await dragBy(120, 0);
      const left = await layout(page);
      expect(Math.abs(left.image.left - left.stage.left)).toBeLessThan(1);
      await tapFit(page);
      same((await layout(page)).image, fit.image);

      // A pinch by hand-made pointer events: in, and out again to Fit.
      const pointers = (from: number, to: number) =>
        page.evaluate(
          async ({ x, y, from, to }) => {
            const stage = document.querySelector('[data-image-zoom-stage]')!;
            const fire = (type: string, id: number, py: number) =>
              stage.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: py, bubbles: true, cancelable: true, button: 0 }));
            fire('pointerdown', 11, y - from / 2);
            fire('pointerdown', 12, y + from / 2);
            for (let i = 1; i <= 10; i++) {
              const d = from + ((to - from) * i) / 10;
              fire('pointermove', 11, y - d / 2);
              fire('pointermove', 12, y + d / 2);
              await new Promise((done) => setTimeout(done, 16));
            }
            fire('pointerup', 11, y - to / 2);
            fire('pointerup', 12, y + to / 2);
          },
          { x: at.x, y: at.y, from, to },
        );
      await pointers(90, 320);
      await settled(page);
      const zoomed = await layout(page);
      expect(zoomed.scale).toBeGreaterThan(fit.scale * 2);
      expect(zoomed.image.bottom).toBeGreaterThan(zoomed.card!.bottom);
      await pointers(320, 50);
      await pointers(200, 60);
      await settled(page);
      same((await layout(page)).image, fit.image);

      await openChoice(page, url, thread, 'C');
      const tools = await layout(page);
      inTheClear(tools);
      await hideTools(page);
      const hidden = await layout(page);
      expect(hidden.card).toBeNull();
      expect(hidden.image.height).toBeGreaterThanOrEqual(tools.image.height);
      expect(hidden.image.bottom).toBeGreaterThan(tools.image.bottom - 1);
      await shot(page, `${tag}-C-hidden`);

      await context.close();
    }
  } finally {
    await browser.close().catch(() => {});
    await agent.close().catch(() => {});
    await removeInboxScratch(root);
  }
});

test('a phone on its side stays as it was: the card still floats over the picture, and Hide clears it', async () => {
  const { root, url, agent, thread } = await world();
  const browser: Browser = await chromium.launch();
  try {
    const side = await browser.newContext(sized(pixel, 844, 390));
    const sidePage = await side.newPage();
    await openChoice(sidePage, url, thread, 'A');
    const onItsSide = await layout(sidePage);
    expect(onItsSide.card).not.toBeNull();
    expect(await sidePage.locator('[data-image-clear]').evaluate((el) => el.parentElement!.clientHeight - (el as HTMLElement).offsetHeight)).toBe(0);
    await hideTools(sidePage);
    expect((await layout(sidePage)).card).toBeNull();
    await side.close();
  } finally {
    await browser.close().catch(() => {});
    await agent.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
