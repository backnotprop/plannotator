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
  mkdirSync(dataDir);
  const env = { ...process.env, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_TEST_SANDBOX: dataDir, PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, NO_ANON_PING: '1', PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0' };
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
  await expect(lines(page).first()).toHaveText('Archive');
  expect(seen.slice(before).filter((request) => /zebrafish|button/i.test(request.url + request.body) || request.url.includes('/feedback'))).toEqual([]);
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
