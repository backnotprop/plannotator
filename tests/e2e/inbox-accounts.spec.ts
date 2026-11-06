/**
 * Settings → Accounts (approval "accounts-page", step 1) in a real browser
 * against the compiled binary, under a temp PLANNOTATOR_DATA_DIR and HOME. The
 * Inbox's whole PATH is a fake `cswap`'s folder (tests/helpers/fake-cswap.ts),
 * so no real claude-swap can be reached: that one goes to the Keychain.
 *
 * What only a browser can show: the usage cluster holds one column down the
 * list, a row's confirm opens under it and fits, long names shorten instead of
 * pushing the bars, phone rows are tap targets, and nothing scrolls sideways,
 * at 1440, 780, a phone and 320, with 12 accounts of long addresses, aliases
 * and organizations.
 * The states themselves are packages/inbox/accountsSection.test.tsx.
 *
 * PNGs, light, dark and phone, land in .local/proof/inbox-accounts-step1/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_ACCOUNT_SWITCHING } from '../../packages/core/inbox-types';
import { fakeCswapCalls, removeFakeCswap, writeFakeCswap } from '../helpers/fake-cswap';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'inbox-accounts-step1');

const usageWindow = (pct: number) => ({ pct, resetsAt: '2099-11-05T12:00:00+00:00', countdown: '3d 23h', clock: 'Nov 5 12:00' });
const list = (accounts: Record<string, unknown>[]) => JSON.stringify({ schemaVersion: 1, activeAccountNumber: 2, accounts });

const NORMAL = list([
  { number: 1, alias: 'personal', email: 'mira@hollowfield.dev', organizationName: 'Personal', isOrganization: false, active: false, usageStatus: 'ok', usage: { sevenDay: usageWindow(58), scoped: [{ ...usageWindow(33), name: 'Fable' }] } },
  { number: 2, alias: 'work', email: 'mira@northwind.io', organizationName: 'Northwind', isOrganization: true, active: true, usageStatus: 'ok', usage: { fiveHour: usageWindow(92), sevenDay: usageWindow(67) } },
  { number: 3, alias: 'build key', email: 'api-key-3@token.local', organizationName: '', isOrganization: false, active: false, usageStatus: 'api_key', usage: null },
  { number: 4, email: 'mira.okafor.dev@gmail.com', organizationName: 'Personal', isOrganization: false, active: false, usageStatus: 'ok', usage: { fiveHour: usageWindow(8), sevenDay: usageWindow(40) } },
]);

const THREE_WINDOWS = list([
  { number: 1, alias: 'max', email: 'mira@hollowfield.dev', active: false, usageStatus: 'ok', usage: { fiveHour: usageWindow(41), sevenDay: usageWindow(58), scoped: [{ ...usageWindow(33), name: 'Fable' }] } },
  { number: 2, alias: 'work', email: 'mira@northwind.io', active: true, usageStatus: 'ok', usage: { fiveHour: usageWindow(92), sevenDay: usageWindow(67) } },
  { number: 3, alias: 'hollow', email: 'mira@sidequest.dev', active: false, usageStatus: 'ok', usage: { fiveHour: { pct: 0 }, sevenDay: usageWindow(30), scoped: [{ ...usageWindow(96), name: 'Fable' }] } },
]);

const NO_READING = list([
  { number: 1, alias: 'personal', email: 'a@fake.test', active: false, usageStatus: 'unavailable', usage: null, usageError: 'network' },
  { number: 2, email: 'b@fake.test', active: true, usageStatus: 'relogin_required', usage: null },
  { number: 3, alias: 'side', email: 'c@fake.test', active: false, usageStatus: 'unavailable', usage: null, usageError: 'http-429', usageRetryAt: '2099-11-01T12:48:33Z' },
  { number: 4, email: 'api-key-4@token.local', active: false, usageStatus: 'api_key', usage: null },
]);

/** Personal Claude organizations are named after the address, so nothing here may show one until a row opens. */
const SAME_NAME = list([
  { number: 1, email: 'mira@hollowfield.dev', organizationName: "mira@hollowfield.dev's Organization", isOrganization: true, active: false, usageStatus: 'ok', usage: { fiveHour: usageWindow(41), sevenDay: usageWindow(58) } },
  { number: 2, email: 'mira@northwind.io', organizationName: 'Fake mira@northwind.io', isOrganization: true, active: true, usageStatus: 'ok', usage: { fiveHour: usageWindow(12), sevenDay: usageWindow(22) } },
]);

const STALE = readFileSync(join(repo, 'tests/fixtures/cswap/stale.json'), 'utf8');

const LONG_EMAIL = 'mira.okafor.engineering.platform.oncall.rotation+claude-code-max@hollowfield-and-northwind-consulting-partners.example.com';
const LONG_ALIAS = 'the personal account I use for the long weekend research projects and everything else';
const LONG_ORG = 'Hollowfield & Northwind Consulting Partners International Holdings (Europe, Middle East and Africa) GmbH';
const WORST = list(
  Array.from({ length: 12 }, (_, i) => ({
    number: i + 1,
    alias: i % 3 === 1 ? LONG_ALIAS : undefined,
    email: `${i}.${LONG_EMAIL}`,
    organizationName: i === 4 || i === 7 ? LONG_ORG : `${LONG_ORG} ${i}`,
    isOrganization: true,
    active: i === 2,
    usageStatus: i % 5 === 3 ? 'unavailable' : 'ok',
    usageError: i % 5 === 3 ? 'network' : undefined,
    usage:
      i % 5 === 3
        ? null
        : {
            fiveHour: i % 4 === 2 ? undefined : usageWindow(i * 9),
            sevenDay: usageWindow(100 - i),
            scoped: i % 2 === 0 ? [{ ...usageWindow(12), name: 'A model family with a very long name indeed' }] : [],
          },
  })).map((row, i, rows) => (i === 7 ? { ...row, alias: undefined, email: rows[4]!.email } : i === 4 ? { ...row, alias: undefined } : row)),
);

/** Each state: how the fake answers, then the state the section says it is in. */
const STATES: { name: string; state: string; apply: (bin: string) => void; tall?: boolean }[] = [
  { name: 'normal', state: 'accounts', apply: (bin) => writeFakeCswap(bin, { stdout: NORMAL }) },
  { name: 'three-windows', state: 'accounts', apply: (bin) => writeFakeCswap(bin, { stdout: THREE_WINDOWS }) },
  { name: 'no-reading', state: 'accounts', apply: (bin) => writeFakeCswap(bin, { stdout: NO_READING }) },
  { name: 'same-name', state: 'accounts', apply: (bin) => writeFakeCswap(bin, { stdout: SAME_NAME }) },
  { name: 'stale', state: 'accounts', apply: (bin) => writeFakeCswap(bin, { stdout: STALE }) },
  { name: 'not-installed', state: 'not_installed', apply: (bin) => removeFakeCswap(bin) },
  { name: 'failed', state: 'failed', apply: (bin) => writeFakeCswap(bin, { stdout: JSON.stringify({ schemaVersion: 1, error: { type: 'CswapError', message: 'words-of-cswap' } }), stderr: 'words-of-cswap', exit: 1 }) },
  { name: 'worst-case', state: 'accounts', apply: (bin) => writeFakeCswap(bin, { stdout: WORST }), tall: true },
];

interface World {
  bin: string;
  url: string;
}

let world: World;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-accounts-e2e-');
  const bin = writeFakeCswap(join(root, 'bin'), { stdout: NORMAL });
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  markTourDecided(dataDir);
  const env = {
    PATH: bin,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    // Each state is read by Refresh, seconds apart: the 30 s between two runs would stand in the way.
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_TEST_CSWAP_DIR: bin,
    PLANNOTATOR_TEST_ACCOUNTS_CACHE_MS: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  world = { bin, url: started.stdout.trim() };
});

test.afterAll(async () => {
  await removeInboxScratch();
});

const section = (page: Page) => page.locator('[data-settings-accounts]');

async function shot(page: Page, name: string) {
  // Off the left edge's 20 px strip, which slides the sidebar in over the page.
  await page.mouse.move(40, 0);
  await expect(page.locator('.ib-peek[data-visible]')).toHaveCount(0);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
}

/** Puts the state in place and reads it with Refresh. */
async function show(page: Page, state: (typeof STATES)[number]) {
  state.apply(world.bin);
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/inbox/accounts');
  await page.locator('[data-accounts-refresh]').click();
  await answered;
  await expect(page.locator('[data-accounts-refresh]')).toBeEnabled();
  await expect(section(page)).toHaveAttribute('data-settings-accounts', state.state);
  // A failed Refresh keeps `accounts`, so only the line can tell a good answer from a bad one.
  if (state.state !== 'failed') await expect(page.locator('[data-accounts-failed]')).toHaveCount(0);
}

/** Nothing in the window or a row runs past its edge. */
async function expectNoOverflow(page: Page) {
  const report = await page.evaluate(() => {
    const scroller = document.querySelector('.ib-spage') as HTMLElement;
    const card = document.querySelector('.ib-accts')?.getBoundingClientRect();
    const past: string[] = [];
    if (card) {
      for (const el of document.querySelectorAll('.ib-acct-r, .ib-acct-n, .ib-acct-use, .ib-acct-confirm, .ib-acct-fail, .ib-acct-miss')) {
        const box = el.getBoundingClientRect();
        if (box.right > card.right + 0.5 || box.left < card.left - 0.5) past.push(el.className);
      }
    }
    return { sideways: scroller.scrollWidth - scroller.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, past };
  });
  expect(report).toEqual({ sideways: 0, doc: 0, past: [] });
}

/** The usage cluster lines up down the list: every label, bar and figure in one column, whatever the name beside it. */
async function expectColumns(page: Page) {
  const columns = await page.evaluate(() => {
    const left = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().left) : -1);
    const clusters = [...document.querySelectorAll('[data-machine-key="self"] [data-account-use="bars"]')];
    return {
      clusters: [...new Set(clusters.map(left))],
      figures: [...new Set(clusters.map((cluster) => left(cluster.querySelector('b[data-usage]'))))],
    };
  });
  expect(columns.clusters).toHaveLength(1);
  expect(columns.figures).toHaveLength(1);
}

/**
 * Presses a row, proves its confirm opens under it and fits, takes its picture, and cancels.
 * While switching is off (INBOX_ACCOUNT_SWITCHING), proves the row is plain and pressing it opens nothing.
 */
async function shotConfirm(page: Page, account: number, name: string) {
  if (!INBOX_ACCOUNT_SWITCHING) {
    const plain = page.locator(`[data-machine-key="self"] [data-account="${account}"]`);
    await expect(plain).toHaveJSProperty('tagName', 'DIV');
    await plain.click();
    await expect(page.locator('[data-accounts-confirm]')).toHaveCount(0);
    await expect(page.locator('.ib-accts button')).toHaveCount(0);
    return;
  }
  const row = page.locator(`[data-machine-key="self"] button[data-account="${account}"]`);
  await row.click();
  const confirm = page.locator('[data-accounts-confirm]');
  await expect(confirm).toBeVisible();
  expect(await row.evaluate((el) => el.nextElementSibling?.hasAttribute('data-accounts-confirm'))).toBe(true);
  await expectNoOverflow(page);
  await shot(page, name);
  await page.locator('[data-accounts-cancel]').click();
  await expect(confirm).toHaveCount(0);
}

async function walk(page: Page, prefix: string, errors: string[]) {
  for (const state of STATES) {
    await show(page, state);
    await expectNoOverflow(page);
    if (state.name === 'normal' || state.name === 'three-windows' || state.name === 'worst-case') await expectColumns(page);
    if (state.name === 'normal') {
      // The account in use comes first.
      const first = page.locator('[data-machine-key="self"] .ib-acct-r').first();
      await expect(first).toHaveAttribute('data-in-use', '');
      await expect(first.locator('.ib-acct-name')).toHaveText('work');
      // An API key is its name alone: no bar, and "API key" only on hover.
      await expect(page.locator('[data-account="3"] [data-account-use]')).toHaveText('');
      await expect(page.locator('[data-account="3"]')).toHaveAttribute('title', /API key/);
      // No address on the page.
      await expect(page.locator('.ib-spg')).not.toContainText('@');
      // The amber is the mock's: 92% in use differs from a row under 90%.
      const color = (account: number) => page.locator(`[data-account="${account}"] b[data-usage]`).evaluate((b) => getComputedStyle(b).color);
      expect(await color(2)).not.toBe(await color(1));
      await shotConfirm(page, 1, `${prefix}-confirm`);
      // This picture goes before the failed Refresh below, which would leave its line in it.
      await expect(page.locator('[data-accounts-failed]')).toHaveCount(0);
      await shot(page, `${prefix}-normal`);
      // A Refresh that fails keeps the list, with the line above it.
      writeFakeCswap(world.bin, { stdout: 'Traceback' });
      await page.locator('[data-accounts-refresh]').click();
      await expect(page.locator('[data-accounts-failed]')).toBeVisible();
      await expect(page.locator('[data-account]')).toHaveCount(4);
      await shot(page, `${prefix}-refresh-failed`);
      continue;
    }
    if (state.name === 'same-name') {
      await expect(page.locator('.ib-spg')).not.toContainText('@');
      await expect(page.locator('[data-account="1"] .ib-acct-name')).toHaveText('mira #1');
      await expect(page.locator('[data-account="2"] .ib-acct-name')).toHaveText('mira #2');
    }
    if (state.name === 'stale') {
      await expect(page.locator('[data-account="1"] [data-stale]')).toBeVisible();
      await expect(page.locator('[data-account="1"] [data-l="hot"]')).toHaveCount(0);
      await shotConfirm(page, 2, `${prefix}-stale-confirm`);
    }
    if (state.name === 'no-reading') {
      // No reading: no bar, and the reason beside the name.
      await expect(page.locator('[data-account-use="none"]')).toHaveCount(3);
      await expect(page.locator('[data-account-use="none"] i')).toHaveCount(0);
      // The name and its notes stop before the usage.
      const words = (await page.locator('[data-account="1"] .ib-acct-n').boundingBox())!;
      // The empty cluster has no height, so its left edge comes from the page, not a bounding box.
      const useLeft = await page.locator('[data-account="1"] .ib-acct-use').evaluate((el) => el.getBoundingClientRect().left);
      if (prefix === 'desktop') expect(words.x + words.width).toBeLessThanOrEqual(useLeft);
    }
    if (state.name === 'not-installed') await expect(page.locator('[data-accounts-missing] .ib-cbox pre')).toHaveText('uv tool install claude-swap');
    if (state.name === 'failed') {
      await expect(page.locator('[data-accounts-failed]')).toBeVisible();
      await expect(section(page)).not.toContainText('words-of-cswap');
    }
    if (state.name === 'worst-case') {
      await expect(page.locator('[data-account]')).toHaveCount(12);
      // A long name shortens on one line on a desktop, instead of pushing the usage.
      if (prefix === 'desktop') {
        const name = page.locator('[data-account="3"] .ib-acct-name');
        expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      }
      await shotConfirm(page, 1, `${prefix}-worst-case-confirm`);
    }
    await shot(page, `${prefix}-${state.name}`);
  }
  expect(errors).toEqual([]);
  // Nothing on the page switched: a confirm was only ever cancelled.
  expect([...new Set(fakeCswapCalls(world.bin))]).toEqual(['list --json']);
}

test('desktop: every state, light and dark, with the columns, a confirm and the worst case', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(120_000);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${world.url}#settings/accounts`);
  await expect(section(page)).toHaveAttribute('data-settings-accounts', 'accounts');
  await walk(page, 'desktop', errors);
  // The narrowest window that keeps the side nav: the tightest a row gets.
  await page.setViewportSize({ width: 780, height: 1040 });
  await expect(page.locator('.ib-snav')).toBeVisible();
  await expectNoOverflow(page);
  await expectColumns(page);
  await shot(page, 'narrow-worst-case');
  await context.close();
});

test('phone: through the list of sections, every state, light and dark', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(120_000);
  writeFakeCswap(world.bin, { stdout: NORMAL });
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 1120 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${world.url}#settings`);
  await page.locator('[data-settings-list] [data-settings-link="accounts"]').tap();
  await expect(section(page)).toHaveAttribute('data-settings-accounts', 'accounts');
  // A phone row is a tap target of 44 px or more, with no hover word.
  for (const box of await page.locator('[data-machine-key="self"] .ib-acct-r').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
  await expect(page.locator('.ib-acct-sw', { hasText: 'Switch' })).toHaveCount(0);
  await walk(page, 'phone', errors);
  await context.close();
});

test('320 px: a three-limit row stays inside its window and lines up', async ({ browser }: { browser: Browser }) => {
  writeFakeCswap(world.bin, { stdout: THREE_WINDOWS });
  const context: BrowserContext = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${world.url}#settings/accounts`);
  await expect(section(page)).toHaveAttribute('data-settings-accounts', 'accounts');
  await expect(page.locator('[data-account]')).toHaveCount(3);
  await expectNoOverflow(page);
  await expectColumns(page);
  await shot(page, 'phone-320-three-windows');
  await context.close();
});
