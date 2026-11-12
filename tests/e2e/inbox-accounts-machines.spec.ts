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
 * from before the door had `accounts`, Older runs it and its door really does
 * refuse. Without one (CI), Older runs this build, the window gets the answer
 * such a door leads to, and a stand-in door covers that answer's first half in
 * packages/server/inbox-accounts.test.ts.
 *
 * What only a browser can show: one block per machine on a real page, the
 * "on <machine>" note and the "Most room" hover from real far answers, nothing above a
 * slow machine moving when it answers, an open peek keeping its place and focus
 * through a far answer, the sheet inside a phone's window, and where focus
 * lands when Tab leaves the peek. The rules are
 * packages/inbox/accountsSection.test.tsx; the refusals, a tailnet guest's
 * included, are packages/server/inbox-accounts.test.ts.
 *
 * PNGs, light and dark, land in .local/proof/inbox-accounts-step3/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_ACCOUNT_SWITCHING } from '../../packages/core/inbox-types';
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
/** Another login that reads like Studio's `work`: its answer gives that row an organization. */
const NAMESAKE = { alias: 'work', email: 'mira@acme.example', organizationName: 'Acme', isOrganization: true };
const SIDE = { alias: 'side', email: 'mira@side.example' };

const STUDIO = list(
  { ...WORK, active: true, usageAgeSeconds: 40, usage: { fiveHour: limit(41), sevenDay: limit(67, 'Nov 5 12:00'), scoped: [{ ...limit(33), name: 'Fable' }] } },
  { ...PERSONAL, usageAgeSeconds: 40, usage: { fiveHour: limit(12), sevenDay: limit(58, 'Nov 5 12:00') } },
);
const MINI = list(
  { ...PERSONAL, active: true, usageAgeSeconds: 20, usage: { fiveHour: limit(92), sevenDay: limit(58, 'Nov 5 12:00') } },
  { ...NAMESAKE, usageAgeSeconds: 20, usage: { fiveHour: limit(18), sevenDay: limit(31, 'Nov 5 12:00') } },
  { ...TEAM, usageAgeSeconds: 20, usage: { fiveHour: limit(12), sevenDay: limit(22, 'Nov 5 12:00') } },
);
const LAPTOP = list(
  { ...WORK, alias: null, active: true, usageAgeSeconds: 90, usage: { fiveHour: limit(30), sevenDay: limit(50, 'Nov 5 12:00') } },
  { ...SIDE, usageAgeSeconds: 90, usage: { fiveHour: limit(5), sevenDay: limit(9, 'Nov 5 12:00') } },
);
/** Calm, so that when Older runs this build its figures say nothing in the peek. */
const OLDER = list({ ...PERSONAL, active: true, usageAgeSeconds: 200, usage: { fiveHour: limit(10), sevenDay: limit(20, 'Nov 5 12:00') } });

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
let oldOne: Machine;

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
  oldOne = machine('Older', OLDER, older ?? binary);
  for (const other of [mini, buildVm, laptop, oldOne]) await link(studio, other);
});

test.afterAll(async () => {
  await removeInboxScratch();
});

const rowOf = (page: Page, name: string) => page.locator(`[data-accounts-machine="${name}"]`);
/** The name of the account a machine's list shows in use. */
const inUseOf = (page: Page, name: string) => rowOf(page, name).locator('[data-in-use] .ib-acct-name');
/** What a machine's block says when it has no list. */
const quietOf = (page: Page, name: string) => rowOf(page, name).locator('[data-machine-state]');
const namesOf = (page: Page, name: string) => rowOf(page, name).locator('.ib-acct-name');
const notesOf = (page: Page, machine: string, account: string) => rowOf(page, machine).locator('.ib-acct-r').filter({ has: page.locator('.ib-acct-name', { hasText: new RegExp(`^${account}$`) }) }).locator('[data-account-notes]');
const peek = (page: Page) => page.locator('[data-usage-peek]');
const usageRow = (page: Page) => page.locator('[data-usage-nav]');
const nearBlocks = (page: Page) => page.locator('[data-usage-machine]');
/** Every machine's own list, in its own order: in use first, then the most room. */
async function expectEveryRow(page: Page) {
  await expect(namesOf(page, 'Studio')).toHaveText(['work', 'personal']);
  await expect(namesOf(page, 'Mini')).toHaveText(['personal', 'team', 'work']);
  await expect(namesOf(page, 'Laptop')).toHaveCount(2);
}
/** Where each of a machine's rows sits now. */
const rowTops = (page: Page, name: string) => rowOf(page, name).locator('.ib-acct-r').evaluateAll((rows) => rows.map((row) => ({ name: row.querySelector('.ib-acct-name')?.textContent, top: row.getBoundingClientRect().top })));

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

test('Settings: one block per machine, this one first, each with its own list, and the notes that tie them', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page, errors } = await desktop(browser);
  await page.goto(`${studio.url}#settings/accounts`);
  await expect(inUseOf(page, 'Studio')).toHaveText('work');
  await expect(inUseOf(page, 'Mini')).toHaveText('personal');
  await expectEveryRow(page);
  const blocks = await page.locator('[data-accounts-machine]').evaluateAll((els) => els.map((el) => el.getAttribute('data-accounts-machine')));
  expect(blocks[0]).toBe('Studio');
  expect([...blocks].sort()).toEqual(['Build VM', 'Laptop', 'Mini', 'Older', 'Studio']);
  // Build VM has no claude-swap: its own block says so, with the command.
  await expect(rowOf(page, 'Build VM').locator('[data-accounts-missing]')).toContainText("claude-swap isn't installed on Build VM.");
  // A login another machine is using says which; Mini at 92% points at the most room on Mini.
  await expect(notesOf(page, 'Studio', 'personal')).toContainText('on Mini');
  await expect(notesOf(page, 'Studio', 'work')).toHaveText('on Laptop');
  // "Most room" is in the hover only: the row's face (name and notes, which a row without notes leaves out) never says it.
  await expect(rowOf(page, 'Mini').locator('.ib-acct-r').filter({ has: page.locator('.ib-acct-name', { hasText: /^team$/ }) }).locator('.ib-acct-n')).not.toContainText(/most room/i);
  await expect(rowOf(page, 'Mini').locator('.ib-acct-r').filter({ has: page.locator('.ib-acct-name', { hasText: /^team$/ }) })).toHaveAttribute('title', /Most room/);
  await expect(rowOf(page, 'Mini').locator('[data-in-use] [data-l="hot"]')).toHaveCount(1);
  // This machine's other rows are the switch while switching is on; a linked machine's rows are not, in this build.
  await expect(rowOf(page, 'Studio').locator('button[data-account]')).toHaveCount(INBOX_ACCOUNT_SWITCHING ? 1 : 0);
  await expect(rowOf(page, 'Mini').locator('button[data-account]')).toHaveCount(0);

  // The usage lines up down the page, every machine's rows in one column.
  const left = await page.locator('[data-account-use="bars"]').evaluateAll((els) => [...new Set(els.map((el) => Math.round(el.getBoundingClientRect().left)))]);
  expect(left).toHaveLength(1);
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

test('a slow machine holds up nothing, and moves nothing above it when it answers', async ({ browser }) => {
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
  await expect(inUseOf(page, 'Studio')).toHaveText('work');
  await expect(namesOf(page, 'Laptop')).toHaveCount(2);
  await expect(page.locator('[data-accounts-refresh]')).toBeEnabled();
  await expect(rowOf(page, 'Mini').locator('[data-accounts-wait]')).toHaveText('Reading accounts…');
  const rows = await rowTops(page, 'Studio');
  await shot(page, 'desktop-slow-machine');
  letGo();
  await expect(inUseOf(page, 'Mini')).toHaveText('personal');
  // The blocks above it stay put; its own block grows where it is.
  expect(await rowTops(page, 'Studio')).toEqual(rows);
  await context.close();
});

test('a far answer that grows an open peek keeps it on the row, with focus where it was', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page, errors } = await desktop(browser);
  let letMini = () => {};
  const miniHeld = new Promise<void>((go) => {
    letMini = go;
  });
  await page.route(`**/api/inbox/accounts/${mini.id}*`, async (route) => {
    await miniHeld;
    await route.continue();
  });
  let letLaptop = () => {};
  const laptopHeld = new Promise<void>((go) => {
    letLaptop = go;
  });
  const near = { number: 1, alias: 'lap', email: 'lap@fake.test', organizationName: null, isOrganization: false, active: true, usageStatus: 'ok', usageError: null, usageRetryAt: null, usage: { fiveHour: limit(95), sevenDay: null, scoped: [] }, usageAgeSeconds: 10 };
  await page.route(`**/api/inbox/accounts/${laptop.id}*`, async (route) => {
    await laptopHeld;
    await route.fulfill({ json: { state: 'accounts', accounts: [near] } });
  });
  await page.goto(studio.url);
  await usageRow(page).click();
  const block = peek(page).locator('[data-usage-block]');
  await expect(block.locator('.ib-usage-nm')).toHaveText('work');
  await expect(block).toBeFocused();
  const before = (await peek(page).boundingBox())!;
  letMini();
  await expect(nearBlocks(page)).toHaveText(['Mini5h 92%']);
  await expect(block).toBeFocused();
  const after = (await peek(page).boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height);
  expect(Math.abs(after.y + after.height - (before.y + before.height))).toBeLessThanOrEqual(1);
  // Focus past the first block, where a popup put back together would not leave it.
  await page.keyboard.press('Tab');
  const onMini = nearBlocks(page).first();
  await expect(onMini).toBeFocused();
  letLaptop();
  await expect(nearBlocks(page)).toHaveText(['Mini5h 92%', 'Laptop5h 95%']);
  await expect(onMini).toBeFocused();
  expect(errors).toEqual([]);
  await context.close();
});

test('phone 390: the same machines on the page, and the near machine in the bottom sheet, inside the window', async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await phone(browser);
  await page.goto(`${studio.url}#settings/accounts`);
  await expect(inUseOf(page, 'Mini')).toHaveText('personal');
  await expectEveryRow(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // A phone row is a tap target, with no hover word.
  for (const height of await page.locator('.ib-acct-r').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
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
  test.setTimeout(120_000);
  // Without a real older build the window gets what its door's refusal becomes.
  const answerAsOlder = async (page: Page) => {
    if (!older) await page.route(`**/api/inbox/accounts/${oldOne.id}*`, (route) => route.fulfill({ json: { state: 'needs_update' } }));
  };
  if (older) expect(await (await fetch(`${base(studio)}/api/inbox/accounts/${oldOne.id}`)).json()).toEqual({ state: 'needs_update' });
  // A real older build still links, and its threads still show: only usage waits. Without one, this build is linked, so there is nothing to prove.
  if (older) expect((await machines(studio)).find((m) => m.name === 'Older')?.state).toBe('online');
  const { context, page, errors } = await desktop(browser);
  await answerAsOlder(page);
  await page.goto(`${studio.url}#settings/accounts`);
  await expect(quietOf(page, 'Older')).toHaveText('Update Plannotator');
  await expect(inUseOf(page, 'Mini')).toHaveText('personal');
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await shot(page, 'desktop-older-far-side');
  expect(errors).toEqual([]);
  await context.close();

  const small = await phone(browser);
  await answerAsOlder(small.page);
  await small.page.goto(`${studio.url}#settings/accounts`);
  await expect(quietOf(small.page, 'Older')).toHaveText('Update Plannotator');
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
  await expect(quietOf(page, 'Laptop')).toHaveText('Asleep');
  await expect(inUseOf(page, 'Studio')).toHaveText('work');
  await expect(namesOf(page, 'Studio')).toHaveText(['work', 'personal']);
  // Asleep is not a list: nothing on Studio says "on Laptop" any more.
  await expect(notesOf(page, 'Studio', 'work')).toHaveCount(0);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await shot(page, 'desktop-machine-offline');
  expect(errors).toEqual([]);
  await context.close();

  const small = await phone(browser);
  await small.page.goto(`${studio.url}#settings/accounts`);
  await expect(quietOf(small.page, 'Laptop')).toHaveText('Asleep');
  await shot(small.page, 'phone-390-machine-offline');
  await small.context.close();
});
