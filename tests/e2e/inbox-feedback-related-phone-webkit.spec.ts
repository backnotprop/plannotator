/**
 * "These might help" on a phone, in WebKit: a 390 px sheet with the keyboard up,
 * both ways this can be stood in for here. A real keyboard is a different thing
 * (iOS scrolls and pans the page on its own): this spec proves the layout, and
 * the owner's iPhone proves the rest.
 *
 * - 390 by 844 with the visual viewport losing 336 px, as phone.ts sees a
 *   keyboard rise (the same simulation as inbox-fullscreen-keyboard.spec.ts);
 * - a 390 by 470 window.
 *
 * Each requires: the box and the line show above the keyboard and the box does
 * not move when the line appears. With the keyboard up Send and the "what is
 * sent" line show too, with no scrolling; in the short window Send is a scroll
 * away.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-feedback-related-phone-webkit.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const KEYBOARD = 336;

let url = '';

test.beforeAll(() => {
  const root = inboxScratch('inbox-feedback-related-phone-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const env = {
    ...process.env,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_TEST_SANDBOX: dataDir,
    PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
  };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
});

test.afterAll(async () => {
  await removeInboxScratch();
});

test.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

async function openSheet(page: Page) {
  await page.goto(url);
  await page.locator('.ib-lhead .ib-sb-trigger').tap();
  await page.locator('[data-feedback-nav]').tap();
  await expect(page.locator('dialog.ib-fbk-phone')).toBeVisible();
  await page.locator('[data-feedback-message]').focus();
}

const bottomOfScreen = (page: Page) => page.evaluate(() => window.visualViewport!.offsetTop + window.visualViewport!.height);

/** The sheet is the one thing that scrolls: Send, scrolled to, ends on screen above the keyboard. */
async function sendReachable(page: Page) {
  const send = page.locator('[data-feedback-send]');
  await send.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  const at = (await send.boundingBox())!;
  expect(at.y + at.height).toBeLessThanOrEqual((await bottomOfScreen(page)) + 0.5);
}

/** Fully inside the sheet as it is now, nothing scrolled by hand: the sheet clips what it scrolls. */
async function showsInSheet(page: Page, selector: string) {
  const sheet = (await page.locator('dialog.ib-fbk-phone').boundingBox())!;
  const at = (await page.locator(selector).first().boundingBox())!;
  expect(at.y, selector).toBeGreaterThanOrEqual(sheet.y);
  expect(at.y + at.height, selector).toBeLessThanOrEqual(sheet.y + sheet.height);
}

async function lineAboveKeyboard(page: Page) {
  const box = page.locator('[data-feedback-message]');
  const before = (await box.boundingBox())!;
  await page.keyboard.type('need a done button', { delay: 15 });
  await expect(page.locator('[data-feedback-related] a')).toHaveCount(1);
  const after = (await box.boundingBox())!;
  expect(after.y).toBe(before.y);
  expect(after.y).toBeGreaterThanOrEqual(0);
  const line = (await page.locator('[data-feedback-related] li').boundingBox())!;
  expect(line.y + line.height).toBeLessThanOrEqual(await bottomOfScreen(page));
}

async function keyboardUp(page: Page) {
  await page.evaluate((keyboard) => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight - keyboard });
    vv.dispatchEvent(new Event('resize'));
  }, KEYBOARD);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--ib-vvh'))).toBe(`${844 - KEYBOARD}px`);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

test.describe('390 by 844, the visual viewport loses the keyboard', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the box, the line, what is sent and Send all show, with no scrolling', async ({ page }) => {
    await openSheet(page);
    await keyboardUp(page);
    await lineAboveKeyboard(page);
    for (const part of ['[data-feedback-message]', '[data-feedback-related] li', '[data-feedback-what]', '[data-feedback-send]']) await showsInSheet(page, part);
  });

  test('before any line, the same: Send already shows', async ({ page }) => {
    await openSheet(page);
    await keyboardUp(page);
    for (const part of ['[data-feedback-message]', '[data-feedback-what]', '[data-feedback-send]']) await showsInSheet(page, part);
  });

  test('several matches show one line, and Send still shows', async ({ page }) => {
    await openSheet(page);
    await keyboardUp(page);
    await page.keyboard.type('quick labels please', { delay: 15 });
    await page.waitForTimeout(800);
    expect(await page.locator('[data-feedback-related] a').count()).toBeLessThanOrEqual(1);
    await showsInSheet(page, '[data-feedback-send]');
  });

  test('a release note or issue over the keyboard: one row, whatever its title, with Send still showing', async ({ page }) => {
    await openSheet(page);
    await keyboardUp(page);
    await page.keyboard.type('quick labels please', { delay: 15 });
    await expect(page.locator('[data-feedback-related] a')).toHaveCount(1);
    await page.locator('[data-feedback-related] a').evaluate((a) => (a.textContent = 'A title far too long for any row of this form, '.repeat(6)));
    expect((await page.locator('[data-feedback-related] li').boundingBox())!.height).toBe(24);
    await showsInSheet(page, '[data-feedback-send]');
  });

  test('over the keyboard the small row is still a 44 px target, and the tap opens the link', async ({ page }) => {
    await openSheet(page);
    await keyboardUp(page);
    await page.keyboard.type('need a done button', { delay: 15 });
    await expect(page.locator('[data-feedback-related] a')).toHaveCount(1);
    const hits = await page.locator('[data-feedback-related] li').evaluate((li) => {
      const row = li.getBoundingClientRect();
      const middle = row.top + row.height / 2;
      const opens = (y: number) => !!document.elementFromPoint(row.left + 2, y)?.closest('a');
      return { above: opens(middle - 21), below: opens(middle + 21), far: !!document.elementFromPoint(row.right - 2, middle)?.closest('a') };
    });
    expect(hits).toEqual({ above: true, below: true, far: true });
  });

  test('when the line lands nothing moves: the chips, Cancel and Send stay under the finger', async ({ page }) => {
    await openSheet(page);
    await keyboardUp(page);
    const spots = () => page.locator('[data-feedback-category], [data-feedback-contact], .ib-fbk-acts button').evaluateAll((all) => all.map((el) => el.getBoundingClientRect().y));
    const before = await spots();
    await page.keyboard.type('need a done button', { delay: 15 });
    await expect(page.locator('[data-feedback-related] a')).toHaveCount(1);
    expect(await spots()).toEqual(before);
    const landed = await spots();
    await page.locator('[data-feedback-message]').fill('');
    await page.keyboard.type('quick labels please', { delay: 15 });
    await page.waitForTimeout(800);
    expect(await spots()).toEqual(landed);
  });

  test('a real tap on Cancel as the line lands sends nothing, and a later tap cancels', async ({ page }) => {
    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/inbox/feedback')) sent.push(request.url());
    });
    await openSheet(page);
    await keyboardUp(page);
    const cancel = page.locator('.ib-fbk-acts button', { hasText: 'Cancel' });
    await cancel.scrollIntoViewIfNeeded();
    const at = (await cancel.boundingBox())!;
    await page.keyboard.type('need a done button', { delay: 15 });
    await expect(page.locator('[data-feedback-related] a')).toHaveCount(1);
    await page.touchscreen.tap(at.x + at.width / 2, Math.min(at.y + at.height - 4, 506));
    await page.waitForTimeout(450);
    expect(sent).toEqual([]);
    await page.touchscreen.tap(at.x + at.width / 2, Math.min(at.y + at.height - 4, 506));
    await expect(page.locator('dialog.ib-fbk-phone')).toHaveCount(0);
    expect(sent).toEqual([]);
  });

  test('a press in the instant the line lands opens no page', async ({ page, context }) => {
    await openSheet(page);
    await keyboardUp(page);
    const opened: unknown[] = [];
    context.on('page', (other) => opened.push(other));
    await page.evaluate(() => {
      const slot = document.querySelector('[data-feedback-related]')!;
      new MutationObserver((_, watch) => {
        const link = slot.querySelector('a');
        if (!link) return;
        watch.disconnect();
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      }).observe(slot, { childList: true, subtree: true });
    });
    await page.keyboard.type('need a done button', { delay: 15 });
    await expect(page.locator('[data-feedback-related] a')).toHaveCount(1);
    await page.waitForTimeout(200);
    expect(opened).toEqual([]);
  });

  test('from the email field the sheet stays where the person put it', async ({ page }) => {
    await openSheet(page);
    await page.locator('[data-feedback-contact]').focus();
    await keyboardUp(page);
    await showsInSheet(page, '[data-feedback-contact]');
  });
});

test.describe('a 390 by 470 window', () => {
  test.use({ viewport: { width: 390, height: 470 } });
  test('the line shows on screen, the box stays, Send can be reached', async ({ page }) => {
    await openSheet(page);
    await lineAboveKeyboard(page);
    await sendReachable(page);
  });
});

test.describe('390 by 844, no keyboard', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a row is a 44 px tap target, whole width: a long title changes neither', async ({ page }) => {
    await openSheet(page);
    await page.keyboard.type('quick labels please', { delay: 15 });
    const links = page.locator('[data-feedback-related] a');
    await expect(links.first()).toBeVisible();
    const before = (await page.locator('dialog.ib-fbk-phone').boundingBox())!;
    await links.evaluateAll((all) => all.forEach((a) => (a.textContent = 'A title far too long for any row of this form, '.repeat(6))));
    expect((await page.locator('dialog.ib-fbk-phone').boundingBox())!).toEqual(before);
    const hits = await page.locator('[data-feedback-related] li').evaluateAll((items) =>
      items.map((li) => {
        const row = li.getBoundingClientRect();
        // Both ends of the row open the link.
        const opens = (x: number) => !!document.elementFromPoint(x, row.top + row.height / 2)?.closest('a');
        return { height: row.height, left: opens(row.left + 2), right: opens(row.right - 2) };
      }),
    );
    for (const hit of hits) expect(hit).toEqual({ height: 44, left: true, right: true });
  });
  test('the sheet grows upward from its foot: Send stays where it was', async ({ page }) => {
    await openSheet(page);
    const send = page.locator('[data-feedback-send]');
    const before = (await send.boundingBox())!;
    await page.keyboard.type('need a done button', { delay: 15 });
    await expect(page.locator('[data-feedback-related] a')).toHaveCount(1);
    expect((await send.boundingBox())!.y).toBe(before.y);
  });
});
