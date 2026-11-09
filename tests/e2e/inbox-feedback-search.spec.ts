/**
 * "These might help" under the Feedback box, on the compiled binary, where
 * layout is real. Under a temp PLANNOTATOR_DATA_DIR; anything off this computer
 * is answered here, and Send is never pressed.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-feedback-search.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(resolve(__dirname, '../..'), '.local/plannotator'));
let url = '';

test.beforeAll(() => {
  const dataDir = join(inboxScratch('inbox-feedback-search-'), 'data');
  mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, HOME: join(dataDir, '..'), PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_TEST_SANDBOX: dataDir, PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, NO_ANON_PING: '1', PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
});
test.afterAll(() => removeInboxScratch());

interface Seen {
  url: string;
  body: string;
}

async function openForm(page: Page): Promise<Seen[]> {
  const seen: Seen[] = [];
  await page.context().route('**/*', (route) => {
    const request = route.request();
    seen.push({ url: request.url(), body: request.postData() ?? '' });
    if (['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' });
  });
  await page.goto(url);
  await page.locator('[data-feedback-nav]').click();
  await expect(page.locator('[data-feedback-message]')).toBeFocused();
  return seen;
}

const lines = (page: Page) => page.locator('[data-feedback-related] a');
const top = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!.y;

test('nothing typed leaves the window', async ({ page }) => {
  const seen = await openForm(page);
  await page.waitForLoadState('networkidle');
  const before = seen.length;
  await page.keyboard.type('need a done button zebrafish', { delay: 15 });
  await expect(lines(page).first()).toHaveText('Archive a thread from its ⋯ menu');
  expect(seen.slice(before).filter((request) => /zebrafish|button/i.test(request.url + request.body) || request.url.includes('/api/inbox/feedback'))).toEqual([]);
});

test('the list loads at the first search, not with the page', async ({ page }) => {
  const seen = await openForm(page);
  await page.waitForLoadState('networkidle');
  const loads = () => seen.filter((request) => request.url.includes('feedbackSearch'));
  expect(loads()).toEqual([]);
  await page.keyboard.type('jira links', { delay: 15 });
  await expect(lines(page).first()).toBeVisible();
  expect(loads()).toHaveLength(1);
});

test('erasing the box while the list still loads leaves no lines', async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  await page.route('**/*feedbackSearch*', async (route) => {
    await held;
    await route.continue();
  });
  await openForm(page);
  const box = page.locator('[data-feedback-message]');
  await page.keyboard.type('jira links', { delay: 5 });
  await page.waitForTimeout(500);
  await box.fill('');
  await page.waitForTimeout(500);
  release();
  await page.waitForTimeout(500);
  await expect(lines(page)).toHaveCount(0);
});

test('no match changes nothing on screen', async ({ page }) => {
  await openForm(page);
  const form = () => page.locator('.ib-fbk-form').boundingBox();
  const today = await form();
  await page.keyboard.type('translate the interface into Spanish', { delay: 15 });
  await page.waitForTimeout(600);
  await expect(page.locator('[data-feedback-related]')).toBeEmpty();
  expect(await form()).toEqual(today);
});

test('the box stays put when lines show', async ({ page }) => {
  await openForm(page);
  const before = await top(page, '[data-feedback-message]');
  await page.keyboard.type('jira links', { delay: 15 });
  await expect(lines(page).first()).toBeVisible();
  expect(await top(page, '[data-feedback-message]')).toBe(before);
});

test('a link opens in a new tab with no way back, and the words stay', async ({ page, context }) => {
  await openForm(page);
  await page.keyboard.type('need a done button', { delay: 15 });
  const opening = context.waitForEvent('page');
  await lines(page).first().click();
  const opened = await opening;
  expect(opened.url()).toContain('plannotator.ai/docs');
  expect(await opened.evaluate(() => window.opener)).toBeNull();
  await opened.close();
  await expect(page.locator('[data-feedback-message]')).toHaveValue('need a done button');
});

for (const height of [600, 625, 700, 768, 900]) {
  test(`at ${height} px high, Send and Cancel show with five lines, with no scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height });
    await openForm(page);
    await page.keyboard.type('mermaid diagram rendering', { delay: 15 });
    await expect(lines(page)).toHaveCount(5);
    const dialog = (await page.locator('dialog[open]').boundingBox())!;
    for (const button of ['[data-feedback-send]', '.ib-fbk-acts .ib-btn:not(.ib-left):not(.ib-pri)']) {
      const at = (await page.locator(button).boundingBox())!;
      expect(at.y + at.height, button).toBeLessThanOrEqual(Math.min(height, dialog.y + dialog.height));
    }
  });
}

test('in a very short window, Tab brings Send into view with five lines showing', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 480 });
  await openForm(page);
  await page.keyboard.type('mermaid diagram rendering', { delay: 15 });
  await expect(lines(page)).toHaveCount(5);
  await page.locator('[data-feedback-contact]').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-feedback-send]')).toBeFocused();
  const at = (await page.locator('[data-feedback-send]').boundingBox())!;
  const dialog = (await page.locator('dialog[open]').boundingBox())!;
  expect(at.y + at.height).toBeLessThanOrEqual(Math.min(480, dialog.y + dialog.height));
});

test('words survive a press on the backdrop, and a sent message clears them', async ({ page }) => {
  await page.route('**/api/inbox/feedback', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await openForm(page);
  const words = 'zebras dancing on saturn';
  await page.keyboard.type(words, { delay: 5 });
  await page.mouse.click(5, 5);
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  await page.locator('[data-feedback-nav]').click();
  const box = page.locator('[data-feedback-message]');
  await expect(box).toHaveValue(words);
  await expect(box).toBeFocused();
  await page.keyboard.type('!');
  await expect(box).toHaveValue(`${words}!`);

  await page.locator('[data-feedback-send]').click();
  await page.locator('[data-feedback-done]').click();
  await page.locator('[data-feedback-nav]').click();
  await expect(box).toHaveValue('');
});
