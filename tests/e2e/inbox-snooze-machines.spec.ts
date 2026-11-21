/**
 * Snooze across linked machines (approval "inbox-snooze": a snooze lives on the
 * thread's home machine), proved in a real browser against compiled Inboxes on
 * loopback, linked through the real CLI pairing. Studio is the window's; MacBook
 * owns the thread.
 *
 *  1. The row menu on MacBook's thread: Tomorrow takes it out of its section into
 *     the Snoozed band, the snooze is on MacBook's disk and not on Studio's, and
 *     MacBook's own list says it is snoozed.
 *  2. Unsnooze from the band: back in its section, gone from MacBook's disk.
 *  3. The return at its time, with no reload.
 *  4. MacBook goes away during a snooze: the band keeps the row, a return comes
 *     by the window's own clock, and it stays returned when MacBook is back.
 *  5. MacBook away: a Snooze and an Unsnooze wait, say so, and apply when it is back.
 *  6. An older peer, when PLANNOTATOR_E2E_OLDER_BINARY names a real release from
 *     before Snooze: Snooze on its rows and threads says why, writes nothing and
 *     opens the Update dialog, the rest of the menu and the viewer unharmed;
 *     updated in place, the real Snooze is there with no reload.
 *
 * Pictures land in PLANNOTATOR_SNOOZE_MACHINES_SHOTS, else .local/proof/snooze-machines.
 * Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const older = process.env.PLANNOTATOR_E2E_OLDER_BINARY ? resolve(process.env.PLANNOTATOR_E2E_OLDER_BINARY) : null;
const shots = resolve(process.env.PLANNOTATOR_SNOOZE_MACHINES_SHOTS ?? join(repo, '.local/proof/snooze-machines'));
const CLOSED = 'http://127.0.0.1:9';
const ask = (line: string) => [line, '', ':::question', line, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

interface Machine {
  name: string;
  dataDir: string;
  root: string;
  env: Record<string, string>;
  binary: string;
  id: string;
  url: string;
}

let studio: Machine;
let macbook: Machine;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const agents: SimAgent[] = [];
/** The release from before Snooze while it runs: the teardown cannot prove it, so it goes by its own `stop`. */
let stillOlder: Machine | null = null;

function machine(name: string, bin = binary): Machine {
  const root = inboxScratch(`plannotator-snooze-machines-${name.toLowerCase()}-`);
  const path = join(root, 'bin');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(path, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  return {
    name,
    root,
    dataDir,
    binary: bin,
    id: '',
    url: '',
    env: {
      PATH: `${path}:/usr/bin:/bin`,
      HOME: root,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_TEST_SANDBOX: root,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_MACHINE_NAME: name,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_INBOX_NOTES: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      NO_ANON_PING: '1',
      PLANNOTATOR_RELAY_URL: CLOSED,
      PLANNOTATOR_UPDATE_API_URL: `${CLOSED}/releases/latest`,
      PLANNOTATOR_INSTALL_SCRIPT_URL: `${CLOSED}/install.sh`,
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: `${CLOSED}/download`,
      PLANNOTATOR_FEEDBACK_URL: `${CLOSED}/feedback`,
    },
  };
}

const cli = (m: Machine, ...args: string[]) => {
  const run = spawnSync(m.binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;
const read = async <T>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;

async function start(m: Machine): Promise<void> {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
  // A start right after a stop may find the old listener going away.
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

async function asked(m: Machine, subject: string): Promise<string> {
  const agent = await SimAgent.connect({ binary: m.binary, env: m.env, name: 'Claude Code', host: 'claude-code', cwd: m.root });
  agents.push(agent);
  const sent = await agent.send({ project_path: scratchProject(join(m.root, 'code'), 'billing-svc'), subject, body: ask(subject) });
  return sent.thread_id as string;
}

/** A new thread on `m`, drawn in Studio's list: a list on screen keeps an arrival behind "N new", so read it again. */
async function askedOnScreen(m: Machine, subject: string): Promise<string> {
  const id = await asked(m, subject);
  await expect.poll(async () => JSON.stringify(await read(studio, '/api/inbox/threads?machines=1')).includes(id), { timeout: 15_000 }).toBe(true);
  await page.reload();
  await expect(row(id)).toBeVisible();
  return id;
}

const row = (id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
const band = () => page.locator('[data-section-id="snoozed"]');
const bandButton = () => band().locator('.ib-band');
const inBand = (id: string) => band().locator(`[data-thread-id="${id}"]`);
const snoozesOn = (m: Machine): { thread_id: string; until: string }[] => {
  const path = join(m.dataDir, 'inbox', 'snoozes.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { snoozes: { thread_id: string; until: string }[] }).snoozes : [];
};
const stateOf = async (viewer: Machine, other: Machine) => (await read<{ machines: { id: string; state: string }[] }>(viewer, '/api/inbox/machines')).machines.find((x) => x.id === other.id)?.state;

async function menuOn(id: string) {
  await row(id).click({ button: 'right' });
  const menu = page.locator(`[data-row-menu="${id}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

async function snoozeTomorrow(id: string): Promise<void> {
  const menu = await menuOn(id);
  await menu.locator('[data-row-action="snooze"]').click();
  await menu.locator('[data-snooze-choice="tomorrow"]').click();
  await expect(menu).toHaveCount(0);
}

async function openBand(): Promise<void> {
  if ((await bandButton().getAttribute('aria-expanded')) !== 'true') await bandButton().click();
}

/** A thread back from its snooze, on screen with no reload: at once, or behind "1 new" when the list holds still. */
async function returned(id: string): Promise<void> {
  const notice = page.locator('[data-inbox-notice]');
  await expect
    .poll(
      async () => {
        if (await notice.isVisible().catch(() => false)) await notice.click().catch(() => {});
        return row(id).locator('[data-snooze-back-mark]').count();
      },
      { timeout: 40_000 },
    )
    .toBe(1);
  await expect(inBand(id)).toHaveCount(0);
}

/** A return soon, through the window's own path, so the test need not wait for a preset. */
const snoozeThrough = (m: Machine, id: string, until: string | null) =>
  page.evaluate(
    async ([machineId, threadId, value]) => {
      const res = await fetch(`/api/inbox/m/${machineId}/threads/${threadId}/snooze`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Plannotator-Thread': threadId! }, body: JSON.stringify({ idempotency_key: `t-${threadId}-${Date.now()}`, until: value }) });
      return res.status;
    },
    [m.id, id, until] as const,
  );

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  studio = machine('Studio');
  macbook = machine('MacBook');
  await start(studio);
  await start(macbook);
  link(studio, macbook);
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await context.grantPermissions(['notifications'], { origin: new URL(studio.url).origin });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
    if (stillOlder) cli(stillOlder, 'stop');
  } finally {
    await removeInboxScratch();
  }
});

let thread = '';

test('1. Snooze from the viewer: the thread leaves its section, and the snooze is on its home machine', async () => {
  thread = await asked(macbook, 'Refund webhook on the MacBook');
  await page.goto(studio.url);
  await expect(row(thread)).toBeVisible();
  await snoozeTomorrow(thread);
  await expect(bandButton()).toContainText('Snoozed 1');
  await expect(page.locator(`.ib-lbody [data-section-id]:not([data-section-id="snoozed"]) [data-thread-id="${thread}"]`)).toHaveCount(0);
  // The row's fade over, so the picture shows the list as it settled.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((motion) => motion.effect?.getTiming().iterations !== Infinity).map((motion) => motion.finished.catch(() => {}))));
  await page.screenshot({ path: join(shots, 'snoozed-from-viewer.png') });
  expect(snoozesOn(macbook).map((s) => s.thread_id)).toEqual([thread]);
  expect(snoozesOn(studio)).toEqual([]);
  // Quiet everywhere: the home machine's own list has it out of its sections too.
  const home = await read<{ snoozed: { thread_id: string }[] }>(macbook, '/api/inbox/threads?snoozed=exclude');
  expect(home.snoozed.map((r) => r.thread_id)).toEqual([thread]);
});

test('2. Unsnooze from the band: back in its section, gone from the home machine', async () => {
  await openBand();
  await inBand(thread).click({ button: 'right' });
  await page.locator(`[data-row-menu="${thread}"] [data-row-action="unsnooze"]`).click();
  await expect(band()).toHaveCount(0);
  await expect(row(thread)).toBeVisible();
  expect(snoozesOn(macbook)).toEqual([]);
});

test('3. The return at its time, with no reload', async () => {
  expect(await snoozeThrough(macbook, thread, new Date(Date.now() + 8_000).toISOString())).toBe(200);
  await expect(bandButton()).toContainText('Snoozed 1');
  // No reload: the home machine's stream says so.
  await returned(thread);
  await expect(band()).toHaveCount(0);
  // A look ends the return's mark; the next test starts clean.
  await page.locator(`[data-thread-id="${thread}"]`).first().click();
  await page.locator('section.ib-pane').getByRole('button', { name: 'Close the thread' }).click();
});

test('4. The home machine goes away during a snooze: the band keeps the row, and it still comes back on time', async () => {
  const leading = await askedOnScreen(macbook, 'A snooze that returns while the MacBook sleeps');
  const long = await askedOnScreen(macbook, 'A snooze that outlasts the sleep');
  await snoozeTomorrow(long);
  expect(await snoozeThrough(macbook, leading, new Date(Date.now() + 15_000).toISOString())).toBe(200);
  await expect(bandButton()).toContainText('Snoozed 2');

  await stopScratchInbox(macbook.dataDir);
  await expect.poll(() => stateOf(studio, macbook), { timeout: 30_000 }).toBe('offline');
  await openBand();
  await expect(inBand(long)).toBeVisible();
  await page.screenshot({ path: join(shots, 'snoozed-home-machine-asleep.png') });

  // Nothing on the MacBook can say so: the window's own clock brings it back.
  await returned(leading);
  await expect(inBand(long)).toBeVisible();

  await start(macbook);
  await expect.poll(() => stateOf(studio, macbook), { timeout: 45_000 }).toBe('online');
  await page.reload();
  // Back, and nothing changed: one still snoozed on its home machine, the other still returned.
  await openBand();
  await expect(inBand(long)).toBeVisible();
  await expect(inBand(leading)).toHaveCount(0);
  await expect(row(leading)).toBeVisible();
  expect(snoozesOn(macbook).some((s) => s.thread_id === long)).toBe(true);
  // Clean for the next test.
  await inBand(long).click({ button: 'right' });
  await page.locator(`[data-row-menu="${long}"] [data-row-action="unsnooze"]`).click();
  await expect(band()).toHaveCount(0);
});

test('5. The home machine away: a Snooze and an Unsnooze wait, say so, and apply when it is back', async () => {
  const waits = await askedOnScreen(macbook, 'Snoozed while the MacBook sleeps');
  const undone = await askedOnScreen(macbook, 'Unsnoozed while the MacBook sleeps');
  await snoozeTomorrow(undone);
  await expect(bandButton()).toContainText('Snoozed 1');

  await stopScratchInbox(macbook.dataDir);
  await expect.poll(() => stateOf(studio, macbook), { timeout: 30_000 }).toBe('offline');

  await snoozeTomorrow(waits);
  await expect(page.locator('.ib-tlead').filter({ hasText: 'Waiting for MacBook: this applies when MacBook is back.' })).toBeVisible();
  await page.screenshot({ path: join(shots, 'snooze-held-home-machine-asleep.png') });
  // The Snooze's toast goes first, so what follows can only be the Unsnooze's own.
  await page.locator('[data-inbox-toast] [data-toast-dismiss]').click();
  await expect(page.locator('[data-inbox-toast]')).toHaveCount(0);
  await openBand();
  await inBand(undone).click({ button: 'right' });
  await page.locator(`[data-row-menu="${undone}"] [data-row-action="unsnooze"]`).click();
  await expect(page.locator('.ib-tlead').filter({ hasText: 'Waiting for MacBook: this applies when MacBook is back.' })).toBeVisible();

  await start(macbook);
  await expect.poll(() => snoozesOn(macbook).some((s) => s.thread_id === waits), { timeout: 45_000 }).toBe(true);
  await expect.poll(() => snoozesOn(macbook).some((s) => s.thread_id === undone), { timeout: 15_000 }).toBe(false);
  await expect(bandButton()).toContainText('Snoozed 1', { timeout: 15_000 });
  await openBand();
  await expect(inBand(waits)).toBeVisible();
  await expect(inBand(undone)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('6. An older peer: Snooze says why and writes nothing, nothing else harmed; updated in place, the real Snooze is there with no reload', async () => {
  test.skip(older === null, 'needs PLANNOTATOR_E2E_OLDER_BINARY, a real release from before Snooze');
  const mini = machine('Mini', older!);
  stillOlder = mini;
  await start(mini);
  link(studio, mini);
  const old = await askedOnScreen(mini, 'A thread on the older Mini');
  const view = await read<{ machines: { id: string; snoozes: boolean }[] }>(studio, '/api/inbox/machines');
  expect(view.machines.find((m) => m.id === mini.id)?.snoozes).toBe(false);

  let menu = await menuOn(old);
  await expect(menu.locator('[data-row-action="snooze"][data-snooze-blocked]')).toBeVisible();
  await expect(menu.locator('[data-row-action="archive"]')).toBeVisible();
  await page.screenshot({ path: join(shots, 'older-peer-snooze-says-why.png') });
  // No list of times, and no write: the same dialog as the word beside the machine.
  await menu.locator('[data-row-action="snooze"]').click();
  await expect(menu.locator('[data-snooze-choice]')).toHaveCount(0);
  const dialog = page.locator('[data-dialog="machine-update-too-old"]');
  await expect(dialog).toContainText('Snooze needs a newer Plannotator on Mini');
  await dialog.getByRole('button', { name: 'Close' }).click();
  expect((await read<{ waiting: unknown[] }>(studio, '/api/inbox/outbox')).waiting).toEqual([]);

  // Its own `stop`: a release this old cannot prove itself to the scratch teardown.
  expect(cli(mini, 'stop').status).toBe(0);
  mini.binary = binary;
  stillOlder = null;
  await start(mini);
  await expect
    .poll(async () => {
      const menuNow = await menuOn(old);
      const found = await menuNow.locator('[data-row-action="snooze"]:not([data-snooze-blocked])').count();
      await page.keyboard.press('Escape');
      return found;
    }, { timeout: 60_000, intervals: [2_000] })
    .toBe(1);
  await page.screenshot({ path: join(shots, 'updated-peer-offers-snooze.png') });
  menu = await menuOn(old);
  await menu.locator('[data-row-action="snooze"]').click();
  await menu.locator('[data-snooze-choice="tomorrow"]').click();
  await expect.poll(() => snoozesOn(mini).map((s) => s.thread_id)).toEqual([old]);
  expect(errors).toEqual([]);
});
