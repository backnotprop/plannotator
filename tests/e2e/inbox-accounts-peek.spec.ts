/**
 * The sidebar's Usage row, its peek and the phone's bottom sheet (approval
 * "accounts-page") in a real browser against the compiled binary, under a temp
 * PLANNOTATOR_DATA_DIR and HOME. The Inbox's whole PATH is a fake `cswap`'s
 * folder (tests/helpers/fake-cswap.ts), so no real claude-swap can be reached:
 * that one goes to the Keychain.
 *
 * What only a browser can show: where the row sits, the amber at 90% and nowhere
 * else, the peek beside the row and the sheet along a phone's bottom edge,
 * inside the window. The rules behind them are packages/inbox/accountsSection.test.tsx.
 *
 * PNGs, light and dark, land in .local/proof/inbox-accounts-step2/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { removeFakeCswap, writeFakeCswap } from '../helpers/fake-cswap';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'inbox-accounts-step2');

const usageWindow = (pct: number, clock = '3:40 PM') => ({ pct, resetsAt: '2099-11-05T12:00:00+00:00', countdown: '1h 02m', clock });
const list = (account: Record<string, unknown>) =>
  JSON.stringify({
    schemaVersion: 1,
    activeAccountNumber: 1,
    accounts: [
      { number: 1, alias: 'work', email: 'mira@northwind.io', organizationName: 'Northwind', isOrganization: true, active: true, usageStatus: 'ok', usage: null, ...account },
      { number: 2, alias: 'personal', email: 'mira@hollowfield.dev', active: false, usageStatus: 'ok', usage: { sevenDay: usageWindow(99) } },
    ],
  });

const NORMAL = list({ usage: { fiveHour: usageWindow(41), sevenDay: usageWindow(67, 'Nov 5 12:00'), scoped: [{ ...usageWindow(33), name: 'Fable' }] } });
const HIGH = list({ usage: { fiveHour: usageWindow(92), sevenDay: usageWindow(67, 'Nov 5 12:00'), scoped: [{ ...usageWindow(41), name: 'Fable' }] } });
const EXPIRED = list({ usageStatus: 'relogin_required' });

let bin = '';
let url = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-usage-e2e-');
  bin = writeFakeCswap(join(root, 'bin'), { stdout: NORMAL });
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  markTourDecided(dataDir);
  const env = {
    PATH: bin,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
});

test.afterAll(async () => {
  await removeInboxScratch();
});

const row = (page: Page) => page.locator('[data-usage-nav]');
const peek = (page: Page) => page.locator('[data-usage-peek]');
const scheme = (page: Page, name: 'light' | 'dark') => page.emulateMedia({ colorScheme: name, reducedMotion: 'reduce' });
const color = (target: ReturnType<Page['locator']>, property: 'color' | 'fill' = 'color') => target.evaluate((el, name) => getComputedStyle(el)[name as 'color'], property);

async function shot(page: Page, name: string) {
  // Off the left edge's 20 px strip, which slides the sidebar in over the page.
  await page.mouse.move(40, 0);
  for (const colors of ['light', 'dark'] as const) {
    await scheme(page, colors);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${colors}.png`) });
  }
}

/** A fresh window over this answer, past its first read. */
async function open(page: Page, stdout: string | null) {
  if (stdout === null) removeFakeCswap(bin);
  else writeFakeCswap(bin, { stdout });
  // By way of a blank page, so this load is the only one that can answer the wait.
  await page.goto('about:blank');
  const read = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/inbox/accounts');
  await page.goto(url);
  await read;
}

async function expectInsideWindow(page: Page) {
  const box = (await peek(page).boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
}

test('desktop: the row sits above Settings, plain until 90%, and its peek opens Settings', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await open(page, NORMAL);
  await expect(row(page)).toHaveText('Usage');
  await expect(page.locator('[data-usage-figure]')).toHaveCount(0);
  // At the bottom, between Feedback and Settings, not in the top area.
  const labels = await page.locator('.ib-side-foot > button, .ib-side-foot > .ib-setrow > button.ib-nav').allTextContents();
  expect(labels.slice(-3)).toEqual(['Feedback', 'Usage', 'Settings']);
  await expect(page.locator('.ib-side-foot [data-usage-nav]')).toHaveCount(1);
  await shot(page, 'desktop-normal');
  await row(page).click();
  await expect(peek(page)).toBeVisible();
  await expect(peek(page).locator('.ib-usage-nm')).toHaveText('work');
  await expect(peek(page).locator('.ib-usage-k')).toHaveText(['5h', 'Fable', 'week']);
  await expect(peek(page)).not.toContainText('@');
  await expect(peek(page).locator('[data-high]')).toHaveCount(0);
  await expectInsideWindow(page);
  const rowBox = (await row(page).boundingBox())!;
  expect((await peek(page).boundingBox())!.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width);
  await shot(page, 'desktop-normal-peek');
  // The row closes what it opened.
  await row(page).click();
  await expect(peek(page)).toHaveCount(0);

  await open(page, HIGH);
  const figure = page.locator('[data-usage-figure]');
  await expect(figure).toHaveText('92%');
  await scheme(page, 'dark');
  // The logo and the figure take the same amber, and it is not the row's own color.
  const amber = await color(figure);
  expect(await color(figure.locator('path'), 'fill')).toBe(amber);
  expect(amber).not.toBe(await color(row(page)));
  await shot(page, 'desktop-90');
  await row(page).click();
  await expect(peek(page).locator('.ib-usage-v[data-high]')).toHaveText(['92%']);
  await expect(peek(page).locator('.ib-usage-t')).toHaveText(['3:40 PM', '', '']);
  await expectInsideWindow(page);
  await shot(page, 'desktop-90-peek');

  await peek(page).locator('[data-usage-block]').click();
  await expect(page.locator('[data-settings-accounts]')).toHaveAttribute('data-settings-accounts', 'accounts');
  await expect(peek(page)).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('#settings/accounts');

  await open(page, EXPIRED);
  await expect(row(page)).toHaveText('Usage');
  await row(page).click();
  await expect(peek(page).locator('.ib-usage-note')).toHaveText('Login expired');
  await shot(page, 'desktop-login-expired-peek');

  await page.keyboard.press('Escape');
  await expect(peek(page)).toHaveCount(0);
  await open(page, null);
  await expect(page.locator('.ib-side-foot')).toBeVisible();
  await expect(row(page)).toHaveCount(0);
  await shot(page, 'desktop-no-cswap');

  expect(errors).toEqual([]);
  await context.close();
});

test('phone: the row in the sidebar opens the same content in the bottom sheet', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const sidebar = () => page.locator('.ib-lhead .ib-sb-trigger').click();

  await open(page, NORMAL);
  await sidebar();
  await expect(row(page)).toHaveText('Usage');
  await shot(page, 'phone-normal');
  await row(page).click();
  await expect(peek(page)).toBeVisible();
  await expect(row(page)).toHaveCount(0);
  await expect(peek(page).locator('.ib-usage-k')).toHaveText(['5h', 'Fable', 'week']);
  await expectInsideWindow(page);
  // Along the bottom edge, nearly the window's width, as Tidy's sheet is.
  const sheet = (await peek(page).boundingBox())!;
  expect(sheet.width).toBeGreaterThanOrEqual(370);
  expect(844 - (sheet.y + sheet.height)).toBeLessThanOrEqual(16);
  await shot(page, 'phone-normal-sheet');
  await page.locator('.ib-pm-scrim').click({ position: { x: 195, y: 100 } });
  await expect(peek(page)).toHaveCount(0);

  await open(page, HIGH);
  await sidebar();
  await expect(page.locator('[data-usage-figure]')).toHaveText('92%');
  await shot(page, 'phone-90');
  await row(page).click();
  await expect(peek(page).locator('.ib-usage-v[data-high]')).toHaveText(['92%']);
  await expectInsideWindow(page);
  await shot(page, 'phone-90-sheet');
  await peek(page).locator('[data-usage-block]').click();
  await expect(page.locator('[data-settings-accounts]')).toHaveAttribute('data-settings-accounts', 'accounts');
  await expect(peek(page)).toHaveCount(0);

  await open(page, EXPIRED);
  await sidebar();
  await row(page).click();
  await expect(peek(page).locator('.ib-usage-note')).toHaveText('Login expired');
  await shot(page, 'phone-login-expired-sheet');
  await page.locator('.ib-pm-scrim').click({ position: { x: 195, y: 100 } });

  await open(page, null);
  await sidebar();
  await expect(page.locator('.ib-side-foot')).toBeVisible();
  await expect(row(page)).toHaveCount(0);
  await shot(page, 'phone-no-cswap');

  expect(errors).toEqual([]);
  await context.close();
});
