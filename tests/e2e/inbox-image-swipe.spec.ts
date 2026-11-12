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
const picture = (page: Page) => pane(page).locator('.ib-imgstage > .ib-zoomstage');
const transformOf = (el: HTMLElement | SVGElement) => (el as HTMLElement).style.transform;
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
    const browser: Browser = phone.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
    const tag = phone.browserName === 'webkit' ? 'iphone15' : 'pixel7';
    try {
      const context = await browser.newContext({ ...device, colorScheme: phone.scheme });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));

      await openChoice(page, url, thread, 'B');
      expect(await onScreen(page)).toBe('opt-b.png');
      expect(page.url()).toContain('&set=');
      await expect(pill(page)).toHaveAttribute('aria-label', '2/4: option 2 of 4, opt-b.png. Show every file');
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'B');
      await expect(caption(page)).toContainText('Quiet hover menu');
      await expect(caption(page).locator('.ib-optcap-prompt')).toHaveCount(0);
      await shot(page, `${tag}-option-B`);

      const touch = await finger(page, phone.browserName);
      const area = (await docArea(page).boundingBox())!;
      const mid = { x: area.x + area.width * 0.75, y: area.y + area.height * 0.4 };
      const bar = pane(page).locator('.ib-imgbar');
      const composer = pane(page).locator('[data-fcomp]');
      const field = pane(page).locator('[data-image-composer] textarea');
      const controlsBefore = [await bar.boundingBox(), await composer.boundingBox()];
      expect(controlsBefore[0]).not.toBeNull();
      expect(controlsBefore[1]).not.toBeNull();
      await touch.down(mid.x, mid.y, -area.width * 0.45, 4);
      expect(await picture(page).evaluate(transformOf)).toMatch(/^translateX\(-\d/);
      expect(await docArea(page).evaluate(transformOf)).toBe('');
      expect([await bar.boundingBox(), await composer.boundingBox()]).toEqual(controlsBefore);
      await expect(bar).toBeInViewport();
      await expect(composer).toBeInViewport();
      await expect(field).toBeInViewport();
      const next = pane(page).locator('.ib-imgpeek[data-image-peek="next"] img');
      await expect(next).toBeVisible();
      expect(await next.getAttribute('src')).toContain('/image');
      await shot(page, `${tag}-mid-swipe-B-to-C`);
      await touch.up();
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'C');
      expect(await onScreen(page)).toBe('opt-c.png');
      await expect(page.locator('[data-step-live]')).toContainText('Option C of 4: Hover copy icon');

      await touch.down(area.x + area.width * 0.25, mid.y, area.width * 0.5, 0);
      await touch.up();
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'B');
      await page.waitForTimeout(400);
      await touch.down(mid.x, mid.y, -area.width * 0.3, 0, 3);
      await touch.up();
      await touch.down(mid.x, mid.y, -area.width * 0.3, 0, 3);
      await touch.up();
      await expect(caption(page)).toHaveAttribute('data-option-caption', 'D');
      await expect(page.locator('[data-step-live]')).toContainText('Last option. 4 other files under the 4/4 button');
      await touch.down(mid.x, mid.y, -area.width * 0.5, 0);
      await touch.up();
      await page.waitForTimeout(400);
      expect(await onScreen(page)).toBe('opt-d.png');
      await expect(page.locator('[data-step-live]')).toContainText('Last option');
      await shot(page, `${tag}-last-option-D`);

      await page.reload();
      await expect(pill(page)).toHaveAttribute('aria-label', '4/4: option 4 of 4, opt-d.png. Show every file');

      await pill(page).tap();
      const sheet = page.locator('[data-image-peek-sheet]');
      await expect(sheet).toBeVisible();
      await expect(sheet.locator('[data-peek-item]')).toHaveCount(8);
      await expect(sheet.locator('[data-peek-step-prev]')).toHaveAttribute('aria-label', 'Previous option: opt-c.png');
      await sheet.getByRole('gridcell', { name: /^att-1\.png/ }).click();
      await expect(sheet).toBeHidden();
      expect(await onScreen(page)).toBe('att-1.png');
      await expect(caption(page)).toHaveCount(0);
      await expect(pill(page)).toHaveAttribute('aria-label', '6/8: file 6 of 8, att-1.png. Show every file');
      expect(page.url()).not.toContain('&set=');

      if (phone.browserName === 'chromium') {
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

      const stage = (await pane(page).locator('.ib-imgstage').boundingBox())!;
      await touch.down(stage.x + stage.width / 2, stage.y + stage.height * 0.3, 0, stage.height * 0.4);
      await touch.up();
      await expect(pane(page)).toHaveCount(0);
      expect(page.url()).not.toContain('&file=');

      expect(errors).toEqual([]);
      await context.close();

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
