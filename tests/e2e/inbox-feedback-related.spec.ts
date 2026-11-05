/**
 * "Might be related" under the Feedback box, in a real browser on the compiled
 * binary, where layout is real: nothing typed leaves the window, no match
 * leaves the form's layout identical, the box stays put when a line shows, Send
 * does not move under a resting pointer, and a link opens safely.
 *
 * Under a temp PLANNOTATOR_DATA_DIR, with every page request recorded and
 * anything off this computer answered here, so nothing reaches the network.
 * Send is never pressed. The phone and its keyboard are in
 * inbox-feedback-related-phone-webkit.spec.ts.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-feedback-related.spec.ts`.
 */
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

let url = '';

test.beforeAll(() => {
  const root = inboxScratch('inbox-feedback-related-');
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

/** Past the pause (500 ms) and React's update. */
const PAST_THE_PAUSE = 800;

interface Seen {
  url: string;
  body: string;
}

/** Records every request; anything not on this computer gets an empty page here and never leaves. */
async function openForm(page: Page): Promise<Seen[]> {
  const seen: Seen[] = [];
  await page.context().route('**/*', (route) => {
    const request = route.request();
    seen.push({ url: request.url(), body: request.postData() ?? '' });
    const { hostname } = new URL(request.url());
    if (hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' });
  });
  await page.goto(url);
  await page.locator('[data-feedback-nav]').click();
  await expect(page.locator('[data-feedback-message]')).toBeFocused();
  return seen;
}

const box = (page: Page) => page.locator('[data-feedback-message]');
const send = (page: Page) => page.locator('[data-feedback-send]');
const lines = (page: Page) => page.locator('[data-feedback-related] a');

/** Where the dialog and every part of the form sit. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const rect = (el: Element) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height };
    };
    const dialog = document.querySelector('dialog[open]')!;
    return { dialog: rect(dialog), parts: [...dialog.querySelectorAll('form > *:not([data-feedback-related]), form > div:not([data-feedback-related]) > *')].map(rect) };
  });

test('nothing typed leaves the window, while typing or when a line shows', async ({ page }) => {
  const seen = await openForm(page);
  await page.waitForLoadState('networkidle');
  const before = seen.length;
  await page.keyboard.type('need a done button zebrafish', { delay: 15 });
  await page.waitForTimeout(PAST_THE_PAUSE);
  await expect(lines(page)).toHaveCount(1);
  await page.locator('[data-feedback-contact]').click();
  await page.waitForTimeout(PAST_THE_PAUSE);

  const during = seen.slice(before);
  expect(during.filter((r) => /zebrafish|done(%20|\+| )button/i.test(r.url + r.body))).toEqual([]);
  expect(during.filter((r) => r.url.includes('/api/inbox/feedback'))).toEqual([]);
  // The file is in the page: reading it asks nothing, and nothing goes off this computer from the first load on.
  expect(seen.filter((r) => /feedbackRelated/.test(r.url))).toEqual([]);
  expect(seen.filter((r) => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(r.url))).toEqual([]);
});

test('no match leaves the form laid out exactly as it was', async ({ page }) => {
  await openForm(page);
  const today = await layout(page);
  await page.keyboard.type('translate the interface into Spanish', { delay: 15 });
  await page.waitForTimeout(PAST_THE_PAUSE);
  await expect(lines(page)).toHaveCount(0);
  const typed = await layout(page);
  expect(typed).toEqual(today);
  // The empty slot itself takes no room: the same form without it sits the same.
  await page.addStyleTag({ content: '[data-feedback-related] { display: none; }' });
  expect(await layout(page)).toEqual(typed);
});

const LONG = 'A title far too long for any row of this form, '.repeat(6);

/** Every row, its link and its mark: what a long title could push out of shape. */
const rows = (page: Page) =>
  page.locator('[data-feedback-related] li').evaluateAll((items) =>
    items.map((li) => {
      const a = li.querySelector('a')!;
      const mark = li.querySelector('svg')!.getBoundingClientRect();
      const row = li.getBoundingClientRect();
      return { height: row.height, markWidth: mark.width, inside: a.getBoundingClientRect().right <= row.right + 0.5, cut: a.scrollWidth > a.clientWidth };
    }),
  );

test('a release note or issue is one line: a long title changes nothing but where it is cut', async ({ page }) => {
  await openForm(page);
  await page.keyboard.type('quick labels please', { delay: 15 });
  await expect(lines(page).first()).toBeVisible();
  const before = await layout(page);
  const shape = await rows(page);
  await lines(page).evaluateAll((links, long) => links.forEach((a) => (a.textContent = long)), LONG);
  const after = await rows(page);
  expect(await layout(page)).toEqual(before);
  expect(after.map((row) => row.height)).toEqual(shape.map((row) => row.height));
  for (const row of after) expect(row).toMatchObject({ markWidth: 14, inside: true, cut: true });
});

test('a pointer resting on the chips holds the list: the chip stays under it and its click lands', async ({ page, context }) => {
  await openForm(page);
  const bug = page.locator('[data-feedback-category="bug"]');
  const at = (await bug.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.keyboard.type('need a done button', { delay: 15 });
  await page.waitForTimeout(PAST_THE_PAUSE);
  await expect(lines(page)).toHaveCount(0);
  expect(await bug.boundingBox()).toEqual(at);
  const opened: unknown[] = [];
  context.on('page', (other) => opened.push(other));
  await page.mouse.down();
  await page.mouse.up();
  await expect(bug).toHaveAttribute('aria-pressed', 'true');
  expect(opened).toEqual([]);
  await page.mouse.move(at.x, at.y - 200);
  await expect(lines(page)).toHaveCount(1);
});

test('a click in the instant the list appears opens no page', async ({ page, context }) => {
  await openForm(page);
  const opened: unknown[] = [];
  context.on('page', (other) => opened.push(other));
  // In the page, on the change itself: a click from out here would arrive at no fixed moment.
  await page.evaluate(() => {
    const slot = document.querySelector('[data-feedback-related]')!;
    new MutationObserver((_, watch) => {
      const link = slot.querySelector('a');
      if (!link) return;
      watch.disconnect();
      link.click();
    }).observe(slot, { childList: true, subtree: true });
  });
  await page.keyboard.type('need a done button', { delay: 15 });
  await expect(lines(page)).toHaveCount(1);
  await page.waitForTimeout(200);
  expect(opened).toEqual([]);
});

test('a screen reader hears the kind with the link', async ({ page }) => {
  await openForm(page);
  await page.keyboard.type('quick labels please', { delay: 15 });
  await expect(lines(page).first()).toBeVisible();
  const related = page.locator('[data-feedback-related]');
  await expect(related.getByRole('link', { name: /Release note, v\d|Open issue #\d/ })).toHaveCount(await lines(page).count());
});

test("a feature's sentence stays whole: longer words wrap and grow the row", async ({ page }) => {
  await openForm(page);
  await page.keyboard.type('need a done button', { delay: 15 });
  await expect(lines(page).first()).toBeVisible();
  const row = page.locator('[data-feedback-related] li');
  const before = (await row.boundingBox())!.height;
  await row.locator('span').evaluate((said, long) => said.append(long), LONG);
  expect((await row.boundingBox())!.height).toBeGreaterThan(before);
});

test('a line shows under the box: the box stays put and the dialog grows down only', async ({ page }) => {
  await openForm(page);
  const today = await layout(page);
  const boxAt = await box(page).boundingBox();
  await page.keyboard.type('need a done button', { delay: 15 });
  await expect(lines(page).first()).toBeVisible();
  const now = await layout(page);
  expect(now.dialog.y).toBe(today.dialog.y);
  expect(now.dialog.height).toBeGreaterThan(today.dialog.height);
  expect(await box(page).boundingBox()).toEqual(boxAt);
  const list = await page.locator('[data-feedback-related]').boundingBox();
  expect(list!.y).toBeGreaterThanOrEqual(boxAt!.y + boxAt!.height);

  // The words stop matching: the line goes, and the box still has not moved.
  await box(page).fill('works great, thank you');
  await expect(lines(page)).toHaveCount(0);
  expect(await box(page).boundingBox()).toEqual(boxAt);
  expect((await layout(page)).dialog.height).toBe(today.dialog.height);
});

test('Send does not move under a resting pointer; the line comes when the pointer leaves', async ({ page }) => {
  await openForm(page);
  const at = (await send(page).boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await box(page).focus();
  await page.keyboard.type('need a done button', { delay: 15 });
  await page.waitForTimeout(PAST_THE_PAUSE);
  await expect(lines(page)).toHaveCount(0);
  expect(await send(page).boundingBox()).toEqual(at);

  // The press lands where the pointer aimed: the dialog is still in the same place until it leaves.
  await page.mouse.move(40, 40);
  await expect(lines(page)).toHaveCount(1);
  expect((await send(page).boundingBox())!.y).toBeGreaterThan(at.y);
});

test('a link opens a public page in a new tab, with no way back to this window, and the words stay', async ({ page, context }) => {
  await openForm(page);
  await page.keyboard.type('need a done button', { delay: 15 });
  const link = lines(page).first();
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('target', '_blank');
  // Past the moment a click is taken for one aimed at what was there before.
  await page.waitForTimeout(450);
  const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await tab.waitForLoadState();
  expect(tab.url()).toMatch(/^https:\/\/plannotator\.ai\/docs\//);
  expect(await tab.evaluate(() => [window.opener, document.referrer])).toEqual([null, '']);
  await tab.close();
  await expect(box(page)).toHaveValue('need a done button');
});

test('in a short window the whole form stays reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 520 });
  await openForm(page);
  await page.keyboard.type('need a done button', { delay: 15 });
  await expect(lines(page)).toHaveCount(1);
  const dialog = (await layout(page)).dialog;
  expect(dialog.y + dialog.height).toBeLessThanOrEqual(520);
  await send(page).scrollIntoViewIfNeeded();
  const button = (await send(page).boundingBox())!;
  expect(button.y + button.height).toBeLessThanOrEqual(520);
});
