/**
 * On a desktop, a question's picture choices keep clear of the option card
 * (follows "inbox-option-card-phone"; the owner met it on desktop too): at Fit
 * the picture sits wholly above the card, the pan stops exactly at the card,
 * a zoomed picture may still slide under it, stepping between choices never
 * moves the card (it holds the end note's row on every choice), and Hide takes
 * the card with the rest so the picture refits to the whole pane, and so does
 * minimizing the comment box (restoring it brings the card back). The card is
 * one row (approval "inbox-option-card-lean"): ‹ Previous and Next › that step
 * like [ and ], marked disabled at the ends, the letter, the name (a long one
 * cut with its full name on hover), "Recommended" when there is one. Zooming
 * in and out and panning to all four edges keep working. A plain picture (no
 * card) keeps today's Fit.
 *
 * Boxes are measured, never fitted to text, so fonts of any runner do. Build
 * the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-option-card-desktop.spec.ts`.
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { png } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_OPTION_CARD_DESKTOP_SHOTS ? resolve(process.env.PLANNOTATOR_OPTION_CARD_DESKTOP_SHOTS) : null;

const QUESTION = [
  ':::question',
  'Where should Back to draft sit?',
  '',
  '- [ ] A tall page — ![Option A](shots/a.png) a tall picture',
  '- [ ] B wide — ![Option B](shots/b.png) a wide picture',
  '- [ ] C A panorama with a very long name that goes on and on about where the quiet link should sit on a waiting thread — ![Option C](shots/c.png) a very wide picture',
  '- [ ] D photo — ![Option D](shots/d.png) a photo',
  '',
  'Recommended: B wide',
  ':::',
].join('\n');

async function world() {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-optcard-desktop-');
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
    a: [600, 1800, [150, 60, 230]],
    b: [1440, 900, [40, 170, 80]],
    c: [2000, 400, [230, 150, 40]],
    d: [1000, 700, [60, 110, 240]],
    plain: [1440, 900, [40, 180, 190]],
  };
  for (const [name, [width, height, hue]] of Object.entries(pictures)) writeFileSync(join(project, 'shots', `${name}.png`), png(width, height, hue));
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await agent.send({
    project_path: project,
    subject: 'Back to draft',
    thread: 'draft',
    body: ['Four ways to place Back to draft. A mockup is attached too.', '', QUESTION].join('\n'),
    attachments: ['shots/plain.png'],
  });
  return { root, url, agent, thread: sent.thread_id as string };
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function layout(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el || el.closest('[inert]') || getComputedStyle(el).visibility === 'hidden') return null;
      const { top, bottom, left, right, width, height } = el.getBoundingClientRect();
      return width === 0 || height === 0 ? null : { top, bottom, left, right };
    };
    return {
      image: box('.ib-imgstage .ib-zoomimg')!,
      stage: box('.ib-imgstage')!,
      card: box('.ib-optcap'),
      scale: parseInt(document.querySelector('[data-image-zoom]')?.textContent?.replace(/\D/g, '') ?? '0', 10),
    };
  });
}
type Layout = Awaited<ReturnType<typeof layout>>;

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

const pane = (page: Page) => page.locator('[data-attachment-pane]');
const caption = (page: Page) => page.locator('[data-option-caption]');

async function open(page: Page, url: string, thread: string, letter: string) {
  await page.goto('about:blank');
  await page.goto(`${url}#thread=${thread}`);
  const zoom = page.getByRole('button', { name: `Zoom: Option ${letter}` }).first();
  await zoom.scrollIntoViewIfNeeded();
  await zoom.click();
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  await expect(caption(page)).toHaveAttribute('data-option-caption', letter);
  await expect(pane(page).locator('[data-image-zoom]')).toBeVisible();
  await atRest(page);
}

async function step(page: Page, key: ']' | '[', letter: string) {
  await page.keyboard.press(key);
  await expect(caption(page)).toHaveAttribute('data-option-caption', letter);
  await atRest(page);
}

const same = (a: Box, b: Box) => {
  for (const side of ['top', 'bottom', 'left', 'right'] as const) expect(Math.abs(a[side] - b[side]), side).toBeLessThan(1.5);
};
/** The card keeps its row and its middle; its width follows the name. */
const sameRow = (a: Box, b: Box) => {
  expect(Math.abs(a.top - b.top), 'top').toBeLessThan(1.5);
  expect(Math.abs(a.bottom - b.bottom), 'bottom').toBeLessThan(1.5);
  expect(Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2), 'middle').toBeLessThan(1.5);
};
const clearOfCard = (l: Layout) => expect(l.image.bottom).toBeLessThanOrEqual(l.card!.top + 0.5);

/** Drags the picture the same way until it stops moving. */
async function panTo(page: Page, side: 'top' | 'bottom' | 'left' | 'right') {
  const dx = side === 'left' ? 120 : side === 'right' ? -120 : 0;
  const dy = side === 'top' ? 120 : side === 'bottom' ? -120 : 0;
  let last = await layout(page);
  const x = (last.stage.left + last.stage.right) / 2;
  const y = (last.stage.top + (last.card?.top ?? last.stage.bottom)) / 2;
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
    await page.mouse.move(x + dx, y + dy, { steps: 4 });
    await page.mouse.up();
    await atRest(page);
    const now = await layout(page);
    if (Math.abs(now.image.top - last.image.top) < 0.5 && Math.abs(now.image.left - last.image.left) < 0.5) return now;
    last = now;
  }
  return last;
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1000, height: 700 },
])
  test(`desktop ${width} × ${height}: a picture choice is clear of the card at Fit, zoom and pan work, the card never moves`, async () => {
    test.setTimeout(240_000);
    const { root, url, agent, thread } = await world();
    const browser: Browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));

      // Fit, wide picture: wholly above the card, and the card has the same box on every choice.
      await open(page, url, thread, 'B');
      const fit = await layout(page);
      clearOfCard(fit);
      const card = fit.card!;
      expect(card.bottom - card.top, 'one row').toBeLessThan(60);
      await expect(page.locator('[data-option-caption] .ib-optcap-letter')).toHaveText('B');
      await expect(page.locator('[data-option-recommended]')).toHaveText('Recommended');
      for (const gone of ['.ib-optcap-q', '.ib-optcap-dots', '[data-option-end]', '.ib-optcap-hold']) await expect(page.locator(gone)).toHaveCount(0);
      await shot(page, `${width}x${height}-B-fit`);

      // Zoom in (Actual size is bigger than the clear space), pan to all four edges; out again to the same Fit.
      await page.locator('[data-image-fit]').click();
      await expect(page.locator('[data-image-zoom-stage]')).toHaveAttribute('data-image-zoom-stage', 'actual');
      await atRest(page);
      const bottom = await panTo(page, 'bottom');
      expect(Math.abs(bottom.image.bottom - card.top), 'the bottom stops at the card').toBeLessThan(1);
      const top = await panTo(page, 'top');
      expect(top.image.top, 'the top reaches the pane').toBeLessThan(top.stage.top + 30);
      const right = await panTo(page, 'right');
      expect(Math.abs(right.image.right - right.stage.right), 'the right edge reaches the pane').toBeLessThan(1);
      const left = await panTo(page, 'left');
      expect(Math.abs(left.image.left - left.stage.left), 'the left edge reaches the pane').toBeLessThan(1);
      await page.locator('[data-image-fit]').click();
      await expect(page.locator('[data-image-zoom-stage]')).toHaveAttribute('data-image-zoom-stage', 'fit');
      await atRest(page);
      same((await layout(page)).image, fit.image);

      // The wheel zooms about the pointer, in and out; zoomed in, the picture slides under the card.
      await page.mouse.move((fit.stage.left + fit.stage.right) / 2, (fit.image.top + fit.image.bottom) / 2);
      await page.keyboard.down('Control');
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -200);
      await page.keyboard.up('Control');
      await atRest(page);
      const zoomed = await layout(page);
      expect(zoomed.scale).toBeGreaterThan(fit.scale * 2);
      expect(zoomed.image.bottom, 'under the card').toBeGreaterThan(card.top);
      await shot(page, `${width}x${height}-B-zoomed`);
      await page.keyboard.down('Control');
      for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 200);
      await page.keyboard.up('Control');
      await atRest(page);
      const out = await layout(page);
      expect(out.scale).toBeLessThan(zoomed.scale);

      // Stepping: every picture clear of the card, and the card where it was.
      for (const letter of ['C', 'D']) {
        await step(page, ']', letter);
        const l = await layout(page);
        sameRow(l.card!, card);
        if (letter === 'D') clearOfCard(l);
        // A panorama is as wide as it likes: its height is above the card.
        expect(l.image.bottom).toBeLessThanOrEqual(card.top + 0.5);
      }
      await step(page, '[', 'C');
      await step(page, '[', 'B');
      await step(page, '[', 'A');
      const tall = await layout(page);
      sameRow(tall.card!, card);
      // A tall picture reads from the top, so its lower part starts under the card; a pan brings every part clear.
      expect(tall.image.top).toBeGreaterThanOrEqual(tall.stage.top - 0.5);
      const tallBottom = await panTo(page, 'bottom');
      expect(Math.abs(tallBottom.image.bottom - card.top), 'a tall picture stops at the card').toBeLessThan(1);
      const tallTop = await panTo(page, 'top');
      expect(tallTop.image.top).toBeGreaterThanOrEqual(tallTop.stage.top - 0.5);
      await shot(page, `${width}x${height}-A-bottom-stop`);

      // Hide takes the card with the rest, and the picture refits to the whole pane.
      await step(page, ']', 'B');
      await page.locator('[data-full-view-bar] button[aria-label="Hide tools"]').click();
      await expect(page.locator('[data-tools="tucked"]')).toHaveCount(1);
      await atRest(page);
      const hidden = await layout(page);
      expect(hidden.card).toBeNull();
      expect(hidden.image.bottom).toBeGreaterThan(card.top);
      expect(errors).toEqual([]);
      await context.close();
    } finally {
      await browser.close().catch(() => {});
      await agent.close().catch(() => {});
      await removeInboxScratch(root);
    }
  });

test('a plain picture on a desktop keeps its Fit on the whole pane', async () => {
  const { root, url, agent, thread } = await world();
  const browser: Browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${url}#thread=${thread}`);
    await page.getByRole('button', { name: /plain\.png/ }).first().click();
    await pane(page).locator('[data-full-screen-toggle]').click();
    await expect(pane(page)).toHaveAttribute('data-full-view', '');
    await expect(pane(page).locator('[data-image-zoom]')).toBeVisible();
    await atRest(page);
    const l = await layout(page);
    expect(l.card).toBeNull();
    expect(Math.abs(l.image.top - l.stage.top - (l.stage.bottom - l.image.bottom))).toBeLessThan(1);
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await agent.close().catch(() => {});
    await removeInboxScratch(root);
  }
});

for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 1000, height: 700 },
])
  test(`desktop ${width} × ${height}: the arrows step like [ and ] and rest disabled at the ends, a long name is cut with its full name on hover, minimizing the comment box takes the card`, async () => {
    test.setTimeout(240_000);
    const { root, url, agent, thread } = await world();
    const browser: Browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      const next = page.locator('[data-option-step="next"]');
      const prev = page.locator('[data-option-step="prev"]');
      const heights = new Set<number>();
      const note = async (tall = false) => {
        const l = await layout(page);
        heights.add(Math.round(l.card!.bottom - l.card!.top));
        // A tall picture reads from the top: its lower part starts under the card until panned.
        if (!tall) clearOfCard(l);
        return l;
      };

      // The first option: Previous is disabled and does nothing; Next steps.
      await open(page, url, thread, 'A');
      await note(true);
      await expect(prev).toHaveAttribute('aria-disabled', 'true');
      await expect(next).not.toHaveAttribute('aria-disabled', 'true');
      // aria-disabled, not disabled: focus can stay on it, and a click is let through to do nothing (force: Playwright treats it as disabled).
      await prev.click({ force: true });
      await atRest(page);
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'A');
      await next.click();
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'B');
      await atRest(page);
      await note();
      // Focus stays on the arrow that was used.
      await expect(next).toBeFocused();

      // The long name (C) is cut, whole on hover, and the card is still one row and clear.
      await next.click();
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'C');
      await atRest(page);
      await note();
      const label = page.locator('.ib-optcap-label');
      expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth), 'cut').toBe(true);
      await label.hover();
      await expect(label).toHaveAttribute('title', /A panorama with a very long name/);
      await shot(page, `${width}x${height}-C-long-name`);

      // The last option: Next is disabled and does nothing; Previous steps back.
      await next.click();
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'D');
      await atRest(page);
      const last = await note();
      await expect(next).toHaveAttribute('aria-disabled', 'true');
      await next.click({ force: true });
      await atRest(page);
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'D');
      await shot(page, `${width}x${height}-D-last`);
      await prev.click();
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'C');
      await atRest(page);
      expect([...heights], 'one height on every option').toHaveLength(1);

      // Minimize the comment box: the card goes and the picture refits to the room it gets; restoring brings both back.
      await step(page, ']', 'D');
      const before = await layout(page);
      await page.locator('[data-fcomp-minimize]').click();
      await expect(page.locator('[data-fcomp-pill]')).toBeVisible();
      await expect(caption(page)).toBeHidden();
      await atRest(page);
      const minimized = await layout(page);
      expect(minimized.card).toBeNull();
      expect(minimized.image.bottom).toBeGreaterThan(last.card!.top);
      await shot(page, `${width}x${height}-D-minimized`);
      await page.locator('[data-fcomp-pill]').click();
      await expect(caption(page)).toBeVisible();
      await atRest(page);
      const restored = await layout(page);
      same(restored.image, before.image);
      sameRow(restored.card!, last.card!);
    } finally {
      await browser.close().catch(() => {});
      await agent.close().catch(() => {});
      await removeInboxScratch(root);
    }
  });
