/**
 * Settings → Accounts and the Usage peek with linked machines (approval
 * "accounts-page", read-only), in a real browser against real Inboxes linked
 * through the real CLI pairing on loopback, each its own scratch HOME and
 * PLANNOTATOR_DATA_DIR. PLANNOTATOR_TEST_SANDBOX lets a loopback address stand
 * in for the tailnet and empties the agent PATH, so PLANNOTATOR_TEST_CSWAP_DIR
 * names each Inbox's own fake `cswap`'s folder (tests/helpers/fake-cswap.ts), or
 * an empty one. No real claude-swap can be reached: that one goes to the Keychain.
 *
 * Studio's window shows Mini (at 92%), Build VM (no `cswap`) and Laptop (which
 * this spec puts to sleep). With PLANNOTATOR_E2E_OLDER_BINARY naming a build
 * from before the door had `accounts`, Older runs it, and the test on it runs;
 * without one that test skips, and a stand-in door covers the same answer in
 * packages/server/inbox-accounts.test.ts.
 *
 * What only a browser can show: the rows and the list on a real page, nothing
 * moving when a slow machine answers, the sheet inside a phone's window, and
 * where focus lands when Tab leaves the peek. The rules are
 * packages/inbox/accountsSection.test.tsx; the refusals, a tailnet guest's
 * included, are packages/server/inbox-accounts.test.ts.
 *
 * PNGs, light and dark, land in .local/proof/inbox-accounts-step3/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFakeCswap } from '../helpers/fake-cswap';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const older = process.env.PLANNOTATOR_E2E_OLDER_BINARY;
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'inbox-accounts-step3');
const CLOSED = 'http://127.0.0.1:9';

const limit = (pct: number, clock = '3:40 PM') => ({ pct, resetsAt: '2099-11-05T12:00:00+00:00', countdown: '1h 02m', clock });
const list = (...accounts: Record<string, unknown>[]) => JSON.stringify({ schemaVersion: 1, accounts: accounts.map((account, i) => ({ number: i + 1, usageStatus: 'ok', active: false, ...account })) });

const WORK = { alias: 'work', email: 'mira@northwind.io', organizationName: 'Northwind', isOrganization: true };
const PERSONAL = { alias: 'personal', email: 'mira@hollowfield.dev' };
const TEAM = { alias: 'team', email: 'mira@team.example', organizationName: 'Team', isOrganization: true };

const STUDIO = list(
  { ...WORK, active: true, usageAgeSeconds: 40, usage: { fiveHour: limit(41), sevenDay: limit(67, 'Nov 5 12:00'), scoped: [{ ...limit(33), name: 'Fable' }] } },
  { ...PERSONAL, usageAgeSeconds: 40, usage: { fiveHour: limit(12), sevenDay: limit(58, 'Nov 5 12:00') } },
);
const MINI = list(
  { ...PERSONAL, active: true, usageAgeSeconds: 20, usage: { fiveHour: limit(92), sevenDay: limit(58, 'Nov 5 12:00') } },
  { ...TEAM, usageAgeSeconds: 20, usage: { fiveHour: limit(12), sevenDay: limit(22, 'Nov 5 12:00') } },
);
const LAPTOP = list({ ...WORK, alias: null, active: true, usageAgeSeconds: 90, usage: { fiveHour: limit(30), sevenDay: limit(50, 'Nov 5 12:00') } });

interface Machine {
  name: string;
  root: string;
  dataDir: string;
  bin: string;
  env: Record<string, string>;
  binary: string;
  id: string;
  url: string;
}

let studio: Machine;
let mini: Machine;
let buildVm: Machine;
let laptop: Machine;
let oldOne: Machine | null = null;

function machine(name: string, cswap: string | null, from = binary): Machine {
  const root = inboxScratch(`plannotator-inbox-accounts-machines-${name.toLowerCase().replaceAll(' ', '-')}-`);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  if (cswap) writeFakeCswap(bin, { stdout: cswap });
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  markTourDecided(dataDir);
  const env = {
    PATH: bin,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_TEST_CSWAP_DIR: bin,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_MACHINE_NAME: name,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: CLOSED,
    PLANNOTATOR_FEEDBACK_URL: `${CLOSED}/feedback`,
  };
  const m: Machine = { name, root, dataDir, bin, env, binary: from, id: '', url: '' };
  const started = cli(m, '--background');
  rememberInboxOf(dataDir);
  expect(started.status, started.err).toBe(0);
  m.url = started.out.trim();
  return m;
}

function cli(m: Machine, ...args: string[]) {
  const run = spawnSync(m.binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
}

const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;

const machines = async (m: Machine) => ((await (await fetch(`${base(m)}/api/inbox/machines`)).json()) as { machines: { id: string; name: string; self: boolean; state: string }[] }).machines;

/** Link `from` to `to` as the person does on the command line, and wait for its line. */
async function link(from: Machine, to: Machine) {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
  await expect.poll(async () => (await machines(from)).find((m) => m.name === to.name)?.state).toBe('online');
  to.id = (await machines(from)).find((m) => m.name === to.name)!.id;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  studio = machine('Studio', STUDIO);
  mini = machine('Mini', MINI);
  buildVm = machine('Build VM', null);
  laptop = machine('Laptop', LAPTOP);
  for (const other of [mini, buildVm, laptop]) await link(studio, other);
  if (older) {
    oldOne = machine('Older', MINI, older);
    await link(studio, oldOne);
  }
});

test.afterAll(async () => {
  await removeInboxScratch();
});

const rowOf = (page: Page, name: string) => page.locator(`[data-accounts-machine="${name}"]`);
const useOf = (page: Page, name: string) => rowOf(page, name).locator('.ib-acct-ro');
const peek = (page: Page) => page.locator('[data-usage-peek]');
const usageRow = (page: Page) => page.locator('[data-usage-nav]');
const nearBlocks = (page: Page) => page.locator('[data-usage-machine]');
const account = (page: Page, name: string) => page.locator('.ib-acct').filter({ has: page.getByText(name, { exact: true }) });

async function shot(page: Page, name: string) {
  // Off the left edge's 20 px strip, which slides the sidebar in over the page.
  await page.mouse.move(40, 0);
  for (const colors of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: colors, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${colors}.png`) });
  }
}

const desktop = async (browser: Browser): Promise<{ context: BrowserContext; page: Page; errors: string[] }> => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return { context, page, errors };
};
const phone = async (browser: Browser) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return { context, page };
};

test('Settings: this machine, then each linked one and the account it is using; every machine in one list', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page, errors } = await desktop(browser);
  await page.goto(`${studio.url}#settings/accounts`);
  await expect(useOf(page, 'Studio')).toHaveText('work');
  await expect(useOf(page, 'Mini')).toHaveText('personal');
  await expect(useOf(page, 'Laptop')).toHaveText('mira');
  await expect(useOf(page, 'Build VM')).toHaveText('');
  await expect(page.locator('[data-accounts-machines] button')).toHaveCount(0);

  // `personal` is saved on Studio and Mini, `work` on Studio and Laptop: one row each. Mini's newer reading wins.
  await expect(page.locator('.ib-acct .ib-acct-name')).toHaveText(['work', 'personal', 'team']);
  await expect(account(page, 'personal').locator('[data-usage="5h"]')).toContainText('92%');
  await account(page, 'personal').locator('button.ib-acct-row').click();
  await expect(account(page, 'personal').locator('.ib-acct-more')).toContainText('Studio, Mini');

  // Rows of one height: the Machines column lines up with the first row's.
  const left = await Promise.all(['Studio', 'Mini', 'Build VM', 'Laptop'].map(async (name) => (await useOf(page, name).boundingBox())!.x));
  expect(new Set(left).size).toBe(1);
  // A hairline between rows, as in the list below, and none under the last.
  const line = (name: string) => rowOf(page, name).evaluate((el) => getComputedStyle(el).borderBottomWidth);
  expect(await line('Studio')).toBe('1px');
  expect(await page.locator('[data-accounts-machine]').last().evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe('0px');
  await shot(page, 'desktop-settings');
  expect(errors).toEqual([]);
  await context.close();
});

test('the peek shows Mini at 92% in amber under this machine, the row stays plain, and Tab out closes it back on the row', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page, errors } = await desktop(browser);
  await page.goto(studio.url);
  await expect(usageRow(page)).toHaveText('Usage');
  await usageRow(page).click();
  await expect(nearBlocks(page)).toHaveText(['Mini5h 92%']);
  await expect(usageRow(page)).toHaveText('Usage');
  await expect(peek(page).locator('[data-usage-block]')).toHaveCount(1);
  const amber = await nearBlocks(page).locator('.ib-usage-note').evaluate((el) => getComputedStyle(el).color);
  const plain = await peek(page).locator('.ib-usage-nm').first().evaluate((el) => getComputedStyle(el).color);
  expect(amber).not.toBe(plain);
  const box = (await peek(page).boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(1040);
  await shot(page, 'desktop-near-peek');

  await page.keyboard.press('Tab');
  await expect(nearBlocks(page)).toBeFocused();
  await expect(peek(page)).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(peek(page)).toHaveCount(0);
  await expect(usageRow(page)).toBeFocused();

  await usageRow(page).click();
  await expect(peek(page).locator('[data-usage-block]')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(peek(page)).toHaveCount(0);
  await expect(usageRow(page)).toBeFocused();

  await usageRow(page).click();
  await nearBlocks(page).click();
  await expect(peek(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#settings\/accounts$/);
  expect(errors).toEqual([]);
  await context.close();
});

test('a slow machine holds up nothing and moves nothing when it answers', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await desktop(browser);
  let letGo = () => {};
  const held = new Promise<void>((go) => {
    letGo = go;
  });
  await page.route(`**/api/inbox/accounts/${mini.id}*`, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${studio.url}#settings/accounts`);
  await expect(useOf(page, 'Studio')).toHaveText('work');
  await expect(useOf(page, 'Laptop')).toHaveText('mira');
  await expect(page.locator('[data-accounts-refresh]')).toBeEnabled();
  await expect(useOf(page, 'Mini')).toHaveText('Reading accounts…');
  const before = (await rowOf(page, 'Laptop').boundingBox())!.y;
  await shot(page, 'desktop-slow-machine');
  letGo();
  await expect(useOf(page, 'Mini')).toHaveText('personal');
  expect((await rowOf(page, 'Laptop').boundingBox())!.y).toBe(before);
  await context.close();
});

test('phone 390: the same machines on the page, and the near machine in the bottom sheet, inside the window', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await phone(browser);
  await page.goto(`${studio.url}#settings/accounts`);
  await expect(useOf(page, 'Mini')).toHaveText('personal');
  await expect(page.locator('.ib-acct .ib-acct-name')).toHaveText(['work', 'personal', 'team']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'phone-390-settings');

  await page.goto('about:blank');
  await page.goto(studio.url);
  await page.locator('.ib-lhead .ib-sb-trigger').click();
  await usageRow(page).click();
  await expect(nearBlocks(page)).toHaveText(['Mini5h 92%']);
  const sheet = (await peek(page).boundingBox())!;
  expect(sheet.x).toBeGreaterThanOrEqual(0);
  expect(sheet.x + sheet.width).toBeLessThanOrEqual(390);
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(844);
  await shot(page, 'phone-390-sheet');
  await context.close();
});

test('an older Plannotator on the far side stays quiet: its row asks for an update, and everything else reads', async ({ browser }) => {
  test.skip(!oldOne, 'set PLANNOTATOR_E2E_OLDER_BINARY to a build from before the door had `accounts`');
  test.setTimeout(120_000);
  const far = await (await fetch(`${base(studio)}/api/inbox/accounts/${oldOne!.id}`)).json();
  expect(far).toEqual({ state: 'needs_update' });
  // It still links, and its threads still show: only usage waits.
  expect((await machines(studio)).find((m) => m.name === 'Older')?.state).toBe('online');
  const { context, page, errors } = await desktop(browser);
  await page.goto(`${studio.url}#settings/accounts`);
  await expect(useOf(page, 'Older')).toHaveText('Update Plannotator');
  await expect(useOf(page, 'Mini')).toHaveText('personal');
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await shot(page, 'desktop-older-far-side');
  expect(errors).toEqual([]);
  await context.close();

  const small = await phone(browser);
  await small.page.goto(`${studio.url}#settings/accounts`);
  await expect(useOf(small.page, 'Older')).toHaveText('Update Plannotator');
  await shot(small.page, 'phone-390-older-far-side');
  await small.context.close();
});

test('a machine that goes to sleep reads as asleep, at once, with no error, and this machine\'s figures are all there', async ({ browser }) => {
  test.setTimeout(120_000);
  await stopScratchInbox(laptop.dataDir);
  await expect.poll(async () => (await machines(studio)).find((m) => m.name === 'Laptop')?.state, { timeout: 30_000 }).toBe('offline');
  const started = Date.now();
  const far = await (await fetch(`${base(studio)}/api/inbox/accounts/${laptop.id}`)).json();
  expect(far).toEqual({ state: 'offline' });
  expect(Date.now() - started).toBeLessThan(2_000);

  const { context, page, errors } = await desktop(browser);
  await page.goto(`${studio.url}#settings/accounts`);
  await expect(useOf(page, 'Laptop')).toHaveText('Asleep');
  await expect(useOf(page, 'Studio')).toHaveText('work');
  await expect(page.locator('.ib-acct .ib-acct-name')).toHaveText(['work', 'personal', 'team']);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await shot(page, 'desktop-machine-offline');
  expect(errors).toEqual([]);
  await context.close();

  const small = await phone(browser);
  await small.page.goto(`${studio.url}#settings/accounts`);
  await expect(useOf(small.page, 'Laptop')).toHaveText('Asleep');
  await shot(small.page, 'phone-390-machine-offline');
  await small.context.close();
});
