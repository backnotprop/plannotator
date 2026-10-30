/**
 * A phone's swipe between images (approval "inbox-image-swipe", 2026-10-28),
 * proved against the compiled binary under a temp data dir, on an iPhone 15
 * (WebKit) and a Pixel 7 (Chromium): the zoom on a question's picture choice
 * opens that question's choices only, in choice order (A → B → C → D), with
 * the caption naming the choice on screen and the pill counting the choices;
 * the set rides the address (a reload keeps it); the image follows the
 * finger with the next one beside it and steps past a third of the width; at
 * the last choice it stays and says so; the pill's sheet still lists every
 * file; a zoomed image pans to its edge before a swipe steps (Chromium: real
 * touches, so the image's own pan runs); a drag down closes the viewer, back
 * to the thread; under reduced motion nothing follows the finger and a
 * release still steps. An attached image keeps the thread-wide order.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-image-swipe.spec.ts`.
 * PNGs land in PLANNOTATOR_IMAGE_SWIPE_SHOTS (default .local/proof/image-swipe).
 */

import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { finger, png } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_IMAGE_SWIPE_SHOTS ?? join(repo, '.local/proof/image-swipe'));

const QUESTION = [
  ':::question',
  'Which copy-message design should ship?',
  '',
  '- [ ] Gmail-style ⋯ — ![Option A](shots/opt-a.png) a ⋯ menu on every message',
  '- [ ] Quiet hover menu — ![Option B](shots/opt-b.png) appears on hover only',
  '- [ ] Hover copy icon — ![Option C](shots/opt-c.png) a single copy icon',
  '- [ ] Header menu only — ![Option D](shots/opt-d.png) one menu in the thread header',
  '',
  'Recommended: Gmail-style ⋯',
  ':::',
].join('\n');

async function world() {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-image-swipe-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'web-app');
  mkdirSync(join(project, 'shots'), { recursive: true });
  // Wide pictures (1200 × 900), each its own colour; an earlier screenshot and two attachments around them.
  const hues: Record<string, [number, number, number]> = { 'opt-a': [60, 110, 240], 'opt-b': [40, 170, 80], 'opt-c': [220, 50, 50], 'opt-d': [150, 60, 230], today: [120, 120, 130], 'att-1': [230, 150, 40], 'att-2': [40, 180, 190] };
  for (const [name, hue] of Object.entries(hues)) writeFileSync(join(project, 'shots', `${name}.png`), png(1200, 900, hue));
  writeFileSync(join(project, 'NOTES.md'), '# Notes\n\nThe evaluation notes.\n');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const first = await agent.send({ project_path: project, subject: 'Copy-message designs', thread: 'designs', body: 'How it looks today:\n\n![Today](shots/today.png)\n' });
  await agent.send({
    project_path: project,
    thread: 'designs',
    body: ['Four designs for copying a message. The mockups are attached too.', '', QUESTION].join('\n'),
    attachments: ['shots/att-1.png', 'shots/att-2.png', 'NOTES.md'],
  });
  return { root, url, agent, thread: first.thread_id as string };
}

const pane = (page: Page) => page.locator('[data-attachment-pane]');
const pill = (page: Page) => page.locator('[data-full-view-bar] [data-full-view-position]');
const caption = (page: Page) => page.locator('[data-option-caption]');
const docArea = (page: Page) => pane(page).locator('.ib-docarea');
/** The picture on screen: what follows the finger (its size bar and comment box stay put). */
const picture = (page: Page) => pane(page).locator('.ib-imgstage > .ib-zoomstage');
const transformOf = (el: HTMLElement | SVGElement) => (el as HTMLElement).style.transform;
/** Which picture is on screen, by its file name (the pane's name for it). */
const onScreen = (page: Page) => pane(page).getAttribute('aria-label').then((label) => label?.split(',')[0] ?? null);

async function shot(page: Page, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function openChoice(page: Page, url: string, thread: string, letter: string) {
  await page.goto(`${url}#thread=${thread}`);
  const zoom = page.getByRole('button', { name: `Zoom: Option ${letter}` }).first();
  await zoom.scrollIntoViewIfNeeded();
  await zoom.tap();
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  await expect(pane(page).locator('[data-image-zoom-stage]')).toBeVisible();
}

for (const phone of [
  { name: 'iPhone 15 (WebKit)', device: devices['iPhone 15'], browserName: 'webkit' as const, scheme: 'dark' as const },
  { name: 'Pixel 7 (Chromium)', device: devices['Pixel 7'], browserName: 'chromium' as const, scheme: 'light' as const },
])
  test(`on a phone, ${phone.name}: a question's picture choices are a set of their own, and an image follows the finger`, async () => {
    const { root, url, agent, thread } = await world();
    const { defaultBrowserType: _ignored, ...device } = phone.device;
    // (WebKit launches without the config's Chromium flags, which Linux WebKit exits on.)
    const browser: Browser = phone.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
    const tag = phone.browserName === 'webkit' ? 'iphone15' : 'pixel7';
    try {
      const context = await browser.newContext({ ...device, colorScheme: phone.scheme });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));

      // The zoom on B: the question's four choices, B second; the caption names it.
      await openChoice(page, url, thread, 'B');
      expect(await onScreen(page)).toBe('opt-b.png');
      expect(page.url()).toContain('&set=');
      await expect(pill(page)).toHaveAttribute('aria-label', '2/4: option 2 of 4, opt-b.png. Show every file');
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'B');
      await expect(caption(page)).toContainText('Quiet hover menu');
      await expect(caption(page)).toContainText('Which copy-message design should ship?');
      await shot(page, `${tag}-option-B`);

      // Mid-swipe: the image moves with the finger and C comes in beside it; the size bar and the comment box stay put
      // (approval mock 2).
      const touch = await finger(page, phone.browserName);
      const area = (await docArea(page).boundingBox())!;
      const mid = { x: area.x + area.width * 0.75, y: area.y + area.height * 0.4 };
      const bar = pane(page).locator('.ib-imgbar');
      const composer = pane(page).locator('[data-image-composer]');
      const controlsBefore = [await bar.boundingBox(), await composer.boundingBox()];
      await touch.down(mid.x, mid.y, -area.width * 0.45, 4);
      expect(await picture(page).evaluate(transformOf)).toMatch(/^translateX\(-\d/);
      expect(await docArea(page).evaluate(transformOf)).toBe('');
      expect([await bar.boundingBox(), await composer.boundingBox()]).toEqual(controlsBefore);
      await expect(bar).toBeInViewport();
      await expect(composer).toBeInViewport();
      const next = pane(page).locator('.ib-imgpeek[data-image-peek="next"] img');
      await expect(next).toBeVisible();
      expect(await next.getAttribute('src')).toContain('/image');
      await shot(page, `${tag}-mid-swipe-B-to-C`);
      await touch.up();
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'C');
      expect(await onScreen(page)).toBe('opt-c.png');
      await expect(page.locator('[data-step-live]')).toContainText('Option C of 4: Hover copy icon');

      // Back to B, then two quick flicks: the second comes while the first is still sliding, and is not lost.
      await touch.down(area.x + area.width * 0.25, mid.y, area.width * 0.5, 0);
      await touch.up();
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'B');
      await page.waitForTimeout(400);
      await touch.down(mid.x, mid.y, -area.width * 0.3, 0, 3);
      await touch.up();
      await touch.down(mid.x, mid.y, -area.width * 0.3, 0, 3);
      await touch.up();
      // D, the last: it stays there and says where the other files are.
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'D');
      await expect(caption(page).locator('[data-option-end]')).toHaveText("Last option · the thread's 4 other files are under 4/4");
      await touch.down(mid.x, mid.y, -area.width * 0.5, 0);
      await touch.up();
      await page.waitForTimeout(400);
      expect(await onScreen(page)).toBe('opt-d.png');
      await expect(page.locator('[data-step-live]')).toContainText('Last option');
      await shot(page, `${tag}-last-option-D`);

      // A reload keeps the set.
      await page.reload();
      await expect(pill(page)).toHaveAttribute('aria-label', '4/4: option 4 of 4, opt-d.png. Show every file');

      // The pill's sheet lists every file of the thread; a pick outside the set leaves it.
      await pill(page).tap();
      const sheet = page.locator('[data-image-peek-sheet]');
      await expect(sheet).toBeVisible();
      await expect(sheet.locator('[data-peek-item]')).toHaveCount(8);
      await expect(sheet.locator('[data-peek-step-prev]')).toHaveAttribute('aria-label', 'Previous option: opt-c.png');
      await sheet.getByRole('gridcell', { name: /^att-1\.png/ }).click();
      await expect(sheet).toBeHidden();
      expect(await onScreen(page)).toBe('att-1.png');
      await expect(caption(page)).toHaveCount(0);
      // An attached image keeps the thread-wide order: 6 of 8.
      await expect(pill(page)).toHaveAttribute('aria-label', '6/8: file 6 of 8, att-1.png. Show every file');
      expect(page.url()).not.toContain('&set=');

      if (phone.browserName === 'chromium') {
        // A zoomed image (a double tap) pans before a swipe steps; at its edge the next swipe steps.
        await openChoice(page, url, thread, 'C');
        const stage = (await pane(page).locator('.ib-imgstage').boundingBox())!;
        const centre = { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };
        await page.touchscreen.tap(centre.x, centre.y);
        await page.waitForTimeout(80);
        await page.touchscreen.tap(centre.x, centre.y);
        await expect(pane(page).locator('[data-image-zoom-stage]')).toHaveAttribute('data-image-zoom-stage', 'zoom');
        await touch.down(centre.x + 100, centre.y, -200, 0);
        await touch.up();
        await page.waitForTimeout(500);
        expect(await onScreen(page)).toBe('opt-c.png');
        let swipes = 1;
        while ((await onScreen(page)) === 'opt-c.png' && swipes < 6) {
          await touch.down(centre.x + 100, centre.y, -200, 0);
          await touch.up();
          await page.waitForTimeout(500);
          swipes++;
        }
        expect(await onScreen(page)).toBe('opt-d.png');
      }

      // A drag down closes the viewer, back to the thread.
      const stage = (await pane(page).locator('.ib-imgstage').boundingBox())!;
      await touch.down(stage.x + stage.width / 2, stage.y + stage.height * 0.3, 0, stage.height * 0.4);
      await touch.up();
      await expect(pane(page)).toHaveCount(0);
      expect(page.url()).not.toContain('&file=');

      expect(errors).toEqual([]);
      await context.close();

      // Reduced motion: nothing follows the finger; a release past the line still steps.
      const calm = await browser.newContext({ ...device, colorScheme: phone.scheme, reducedMotion: 'reduce' });
      const calmPage = await calm.newPage();
      await openChoice(calmPage, url, thread, 'A');
      const calmTouch = await finger(calmPage, phone.browserName);
      const calmArea = (await docArea(calmPage).boundingBox())!;
      await calmTouch.down(calmArea.x + calmArea.width * 0.75, calmArea.y + calmArea.height * 0.4, -calmArea.width * 0.5, 0);
      expect(await picture(calmPage).evaluate(transformOf)).toBe('');
      expect(await docArea(calmPage).evaluate(transformOf)).toBe('');
      await expect(calmPage.locator('.ib-imgpeek')).toHaveCount(0);
      await calmTouch.up();
      await expect(caption(calmPage)).toHaveAttribute('data-option-caption', 'B');
      await calm.close();
    } finally {
      await browser.close().catch(() => {});
      await agent.close().catch(() => {});
      await removeInboxScratch(root);
    }
  });
