/**
 * Settings → Reviews in the Inbox: code review's own Settings → Reviews page, hosted in the Inbox's Settings. Listed
 * after Rows while Code review is on; a change made there saves the value code review keeps in config.json
 * (`diffOptions`), so code review shows it; a value code review saved shows there. A phone lists it among the
 * sections and offers no Split or Unified. Real browser, compiled binary, temp PLANNOTATOR_DATA_DIR and HOME.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-reviews-settings.spec.ts`.
 * PNGs land in .local/proof/reviews-settings/.
 */

import { devices, expect, test } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'reviews-settings');

test.afterAll(async () => {
  await removeInboxScratch();
});

test('Settings → Reviews: listed after Rows with Code review on; a change there is the one code review reads, and code review’s is shown there', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-reviews-settings-e2e-');
  const dataDir = join(root, 'data');
  const configFile = join(dataDir, 'config.json');
  // What code review saved before: a code font size of 15 px.
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), inboxCodeReview: true, diffOptions: { fontSize: '15px' } }));
  const diffOptions = () => (JSON.parse(readFileSync(configFile, 'utf8')) as { diffOptions?: Record<string, unknown> }).diffOptions ?? {};

  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const wide = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  try {
    const page = await wide.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${url}#settings/general`);
    const links = page.locator('.ib-snav [data-settings-link]');
    await expect(links.nth(1)).toHaveAttribute('data-settings-link', 'rows');
    await expect(links.nth(2)).toHaveAttribute('data-settings-link', 'reviews');
    await links.nth(2).click();
    await expect(page.locator('.ib-spg > h1')).toHaveText('Reviews');
    const reviews = page.locator('[data-settings-reviews]');
    await expect(reviews.locator('[data-review-settings-section="display"]')).toBeVisible();

    // Code review's saved size shows here.
    const size = reviews.locator('input[type="range"][aria-label="Code Font Size"]');
    await expect(size).toHaveValue('15');

    // A change here is code review's value in config.json.
    const wrap = reviews.getByRole('switch', { name: 'Wrap long lines' });
    const was = await wrap.getAttribute('aria-checked');
    await wrap.click();
    await expect.poll(() => diffOptions().overflow).toBe(was === 'true' ? 'scroll' : 'wrap');
    await size.fill('17');
    await expect.poll(() => diffOptions().fontSize).toBe('17px');
    await reviews.getByRole('radiogroup', { name: 'Motion' }).getByText('Stream', { exact: true }).click();
    await expect.poll(() => diffOptions().powerUpMotion).toBe('stream');
    // It holds on a reload: config.json, not only this page.
    await page.reload();
    await expect(page.locator('[data-settings-reviews] input[type="range"][aria-label="Code Font Size"]')).toHaveValue('17');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: join(proofDir, `wide-${scheme}.png`) });
    }
    expect(errors).toEqual([]);
  } finally {
    await wide.close();
  }

  const phone = await browser.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
  try {
    const page = await phone.newPage();
    await page.goto(`${url}#settings`);
    await page.locator('[data-settings-list] [data-settings-link="reviews"]').click();
    const reviews = page.locator('[data-settings-reviews]');
    await expect(reviews.locator('[data-review-settings-section="display"]')).toBeVisible();
    // Every phone diff is Unified, so there is no Split or Unified to choose.
    await expect(reviews.getByRole('radiogroup', { name: 'Split or Unified' })).toHaveCount(0);
    await page.screenshot({ path: join(proofDir, 'phone-light.png') });
  } finally {
    await phone.close();
  }
});
