/**
 * Routines and capability switches across linked computers (the owner: "If I'm connected somehow to all my machines,
 * I need to see routines from each... I need to be able to run routines from each if I'm connected."; and on the
 * switches, "One set for all: flip a switch once and it applies on every linked computer"), proved in a real browser
 * against compiled Inboxes on loopback, linked through the real CLI pairing. Laptop is the window's; Studio is the
 * linked computer. A routine lives and runs on the computer that made it. The only fakes are the programs a run
 * starts (tests/helpers/fake-claude/) on each computer's own PATH.
 *
 *  1. Settings → Capabilities is one set: Routines on on Laptop is on on Studio at first contact; no group per
 *     computer; the Checklist flipped in one computer's window shows in the other's, light and dark, desktop and phone
 *     (pictures in PLANNOTATOR_CAPABILITIES_ONE_SET_SHOTS, else .local/proof/capabilities-one-set).
 *  2. A new routine's computer picked in the editor ("Runs on Studio"): it is made on Studio's disk, not Laptop's.
 *  3. The Routines page lists Laptop's routine and Studio's, Studio's named "· Studio".
 *  4. Run on Studio's routine from Laptop: Studio starts it, and its row says Running.
 *  5. The same page at phone width.
 *
 * Pictures land in PLANNOTATOR_ROUTINES_MACHINES_SHOTS, else .local/proof/routines-across-computers (CI keeps
 * .local/proof/ as the shard's "inbox-window-proof" artifact). Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { E2E_GROUP_TIP_SEEN, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { installFakeClaude } from '../helpers/fake-claude';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_ROUTINES_MACHINES_SHOTS ?? join(repo, '.local/proof/routines-across-computers'));
/** Settings → Capabilities on both computers, one set (test 1). */
const oneSetShots = resolve(process.env.PLANNOTATOR_CAPABILITIES_ONE_SET_SHOTS ?? join(repo, '.local/proof/capabilities-one-set'));
const CLOSED = 'http://127.0.0.1:9';

interface Machine {
  name: string;
  root: string;
  dataDir: string;
  home: string;
  env: Record<string, string>;
  id: string;
  url: string;
}

let laptop: Machine;
let studio: Machine;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];

/**
 * One computer: its own HOME, and the fake `claude` on its launch PATH (PLANNOTATOR_TEST_LAUNCH_PATH) with Plannotator's
 * Claude Code plugin on in the sandbox's agent home, as in inbox-routine-row-run-ends.spec.ts: a sandboxed Inbox finds
 * no other agent CLI, so without them a Run there does not start. The fake's turn holds, so a run stays Running.
 */
function machine(name: string, config: Record<string, unknown>): Machine {
  const root = inboxScratch(`plannotator-routines-machines-${name.toLowerCase()}-`);
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  for (const dir of [bin, home, dataDir, join(dataDir, 'agents-home', '.claude')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'tailscale'), 0o755);
  writeFileSync(join(dataDir, 'agents-home', '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const fake = installFakeClaude({ bin, state: join(root, 'fake-claude'), config: { hold: true } });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxLaunch: { enabled: true }, inboxReveals: E2E_GROUP_TIP_SEEN, ...config }));
  markTourDecided(dataDir);
  mkdirSync(join(dataDir, 'inbox'), { recursive: true });
  writeFileSync(join(dataDir, 'inbox', 'turned-on'), '{"on":true,"by":"command"}\n');
  return {
    name,
    root,
    dataDir,
    home,
    id: '',
    url: '',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      SHELL: fake.shell,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_TEST_SANDBOX: root,
      PLANNOTATOR_TEST_LAUNCH_PATH: `${bin}:/usr/bin:/bin`,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_BROWSER,
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
  const run = spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;
const read = async <T>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;

async function start(m: Machine): Promise<void> {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

/** A computer's own routines, read from its Inbox (never the page). */
const routinesOn = async (m: Machine) => ((await read<{ scheduled?: { id: string; name: string; state: string }[] }>(m, '/api/inbox/scheduled')).scheduled ?? []);
const settled = (on: Page) => on.evaluate(() => Promise.all(document.getAnimations().filter((motion) => motion.effect?.getTiming().iterations !== Infinity).map((motion) => motion.finished.catch(() => {}))));
const shot = async (name: string) => {
  await settled(page);
  await page.screenshot({ path: join(shots, name) });
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  mkdirSync(oneSetShots, { recursive: true });
  laptop = machine('Laptop', { inboxScheduledThreads: true });
  studio = machine('Studio', {});
  await start(laptop);
  await start(studio);
  const offered = cli(studio, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(laptop, 'link', offered.out.trim(), '--address', base(studio), '--back', base(laptop));
  expect(linked.status, linked.err).toBe(0);
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterAll(async () => {
  try {
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('1. Settings → Capabilities is one set: no group per computer, and a flip on either computer shows on the other', async () => {
  type Switches = { scheduled_threads?: { on: boolean }; steps?: { on: boolean } };
  // First contact: Routines on on Laptop and never flipped on either, so on wins and Studio's are on too (2–4 use them).
  await expect.poll(async () => (await read<Switches>(studio, '/api/inbox/settings')).scheduled_threads?.on, { timeout: 20_000 }).toBe(true);
  const there = await context.newPage();
  there.on('pageerror', (error) => errors.push(error.message));
  const windows = [
    { name: 'laptop', on: page, m: laptop },
    { name: 'studio', on: there, m: studio },
  ] as const;
  for (const w of windows) await w.on.goto(`${w.m.url}#settings/capabilities`);
  const checklist = (on: Page) => on.locator('[data-settings-steps] [role="switch"]');
  for (const w of windows) {
    await expect(checklist(w.on)).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 });
    // The groups of each linked computer's switches are gone.
    await expect(w.on.locator('[data-settings-linked-capabilities]')).toHaveCount(0);
  }
  // Each flip on one window shows on the other's without a reload: light and dark, desktop and phone.
  const looks = [
    { look: 'desktop-light', from: 0, on: true, colorScheme: 'light', width: 1440, height: 900 },
    { look: 'desktop-dark', from: 1, on: false, colorScheme: 'dark', width: 1440, height: 900 },
    { look: 'phone-light', from: 1, on: true, colorScheme: 'light', width: 390, height: 844 },
    { look: 'phone-dark', from: 0, on: false, colorScheme: 'dark', width: 390, height: 844 },
  ] as const;
  for (const look of looks) {
    for (const w of windows) {
      await w.on.setViewportSize({ width: look.width, height: look.height });
      await w.on.emulateMedia({ colorScheme: look.colorScheme });
    }
    const from = windows[look.from];
    const to = windows[1 - look.from]!;
    await checklist(from.on).click();
    await expect(checklist(from.on)).toHaveAttribute('aria-checked', String(look.on));
    await expect(checklist(to.on)).toHaveAttribute('aria-checked', String(look.on), { timeout: 20_000 });
    await expect.poll(async () => (await read<Switches>(to.m, '/api/inbox/settings')).steps?.on).toBe(look.on);
    for (const w of windows) {
      await checklist(w.on).scrollIntoViewIfNeeded();
      await settled(w.on);
      await w.on.screenshot({ path: join(oneSetShots, `${look.look}-${w.name}-after-flip-on-${from.name}.png`) });
    }
  }
  await there.close();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
});

test('2. A new routine on Studio, picked in the editor: made on Studio, not Laptop', async () => {
  await page.goto(`${laptop.url}#routine=new`);
  const editor = page.locator('[data-scheduled-editor]');
  const pick = editor.locator('[data-scheduled-runs-on] select');
  await expect(pick).toBeVisible({ timeout: 20_000 });
  await pick.selectOption(studio.id);
  await expect(editor.locator('[data-scheduled-runs-on]')).toContainText('Runs on Studio');
  await editor.locator('input[aria-label="Name"]').fill('Studio nightly build');
  await editor.locator('textarea[aria-label="Prompt"]').fill('Build the app and say what failed.');
  await expect.poll(async () => (await routinesOn(studio)).map((r) => r.name), { timeout: 15_000 }).toEqual(['Studio nightly build']);
  expect((await routinesOn(laptop)).map((r) => r.name)).toEqual([]);
  await shot('02-editor-computer-choice.png');
});

test("3. The Routines page lists Laptop's and Studio's, Studio's named after it", async () => {
  // Laptop's own, made by its window (the page's own fetch: its Origin and page session).
  const made = await page.evaluate(async () => {
    const health = (await (await fetch('/api/inbox/health')).json()) as { serverSession: string };
    const answer = await fetch('/api/inbox/scheduled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverSession: health.serverSession, name: 'Laptop morning digest', prompt: 'Summarize the open threads.', schedule: null, if_missed: 'run_once', folder: { scratch: true }, agent: 'claude-code', attachments: [], idempotency_key: 'laptop-digest' }),
    });
    return answer.status;
  });
  expect(made).toBe(201);
  await page.goto(`${laptop.url}#routines`);
  const far = page.locator('[data-scheduled-computer="Studio"]');
  await expect(far).toContainText('Studio nightly build', { timeout: 20_000 });
  await expect(far).toContainText('· Studio');
  await expect(page.locator('[data-scheduled-row]')).toHaveCount(2);
  await shot('03-routines-two-computers.png');
});

test("4. Run on Studio's routine from Laptop: Studio starts it, and the row says Running", async () => {
  const far = page.locator('[data-scheduled-computer="Studio"]');
  await far.locator('[data-scheduled-run="run"]').click();
  await expect.poll(async () => (await routinesOn(studio))[0]?.state, { timeout: 30_000 }).toBe('running');
  await expect(far).toHaveAttribute('data-state', 'running', { timeout: 20_000 });
  await expect(far.locator('[data-scheduled-run]')).toHaveAttribute('data-scheduled-run', 'stop');
  await shot('04-far-routine-running.png');
});

test('5. The same page at phone width', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${laptop.url}#routines`);
  await expect(page.locator('[data-scheduled-computer="Studio"]')).toContainText('Studio', { timeout: 20_000 });
  await shot('05-routines-phone.png');
  expect(errors).toEqual([]);
});
