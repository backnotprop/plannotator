/**
 * "These might help" on a phone, with its keyboard up (the visual viewport
 * shrinks by the keyboard, as on an iPhone): the line lands in room kept for it,
 * so Send does not move, and Send and Cancel stay above the keyboard.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-feedback-search-phone-webkit.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(resolve(__dirname, '../..'), '.local/plannotator'));
const KEYBOARD = 336;
let url = '';

test.beforeAll(() => {
  const dataDir = join(inboxScratch('inbox-feedback-search-phone-'), 'data');
  mkdirSync(dataDir);
  const env = { ...process.env, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_TEST_SANDBOX: dataDir, PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, NO_ANON_PING: '1', PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
});
test.afterAll(() => removeInboxScratch());

test.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 2, viewport: { width: 390, height: 844 } });

async function openSheet(page: Page) {
  await page.goto(url);
  await page.locator('.ib-lhead .ib-sb-trigger').tap();
  await page.locator('[data-feedback-nav]').tap();
  await expect(page.locator('dialog.ib-fbk-phone')).toBeVisible();
  await page.locator('[data-feedback-message]').focus();
}

async function keyboardUp(page: Page) {
  await page.evaluate((keyboard) => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'height', { configurable: true, get: () => window.innerHeight - keyboard });
    viewport.dispatchEvent(new Event('resize'));
  }, KEYBOARD);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--ib-vvh'))).toBe(`${844 - KEYBOARD}px`);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

const rect = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
const cancel = '.ib-fbk-acts .ib-btn:not(.ib-left):not(.ib-pri)';
const send = '[data-feedback-send]';

test('keyboard up: one line lands, Send does not move, and nothing is under the keyboard', async ({ page }) => {
  await openSheet(page);
  await keyboardUp(page);
  const before = await rect(page, send);
  await page.keyboard.type('jira links', { delay: 15 });
  await expect(page.locator('[data-feedback-related] li:visible')).toHaveCount(1);
  expect(await rect(page, send)).toEqual(before);
  const aboveKeyboard = 844 - KEYBOARD;
  for (const part of [send, cancel, '[data-feedback-related] li', '[data-feedback-message]']) {
    const at = await rect(page, part);
    expect(at.y, part).toBeGreaterThanOrEqual(0);
    expect(at.y + at.height, part).toBeLessThanOrEqual(aboveKeyboard);
  }
});

test('the line is a full 44 px target', async ({ page }) => {
  await openSheet(page);
  await keyboardUp(page);
  await page.keyboard.type('jira links', { delay: 15 });
  const link = page.locator('[data-feedback-related] a').first();
  await expect(link).toBeVisible();
  const height = await link.evaluate((el) => el.parentElement!.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(44);
});

test('with the keyboard down, a few lines show and Send stays put', async ({ page }) => {
  await openSheet(page);
  const before = await rect(page, send);
  await page.keyboard.type('the diff view is slow', { delay: 15 });
  await expect(page.locator('[data-feedback-related] li:visible')).toHaveCount(3);
  expect(await rect(page, send)).toEqual(before);
});
