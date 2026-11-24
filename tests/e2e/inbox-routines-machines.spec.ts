/**
 * Routines and capability switches across linked computers (the owner: "If I'm connected somehow to all my machines,
 * I need to see routines from each... I need to be able to run routines from each if I'm connected."), proved in a real
 * browser against compiled Inboxes on loopback, linked through the real CLI pairing. Laptop is the window's; Studio is
 * the linked computer. A routine lives and runs on the computer that made it. The only fakes are the programs a run
 * starts (tests/helpers/fake-claude/) on each computer's own PATH.
 *
 *  1. Settings → Capabilities on Laptop: Studio's switches under Laptop's; Routines turned on for Studio from here.
 *  2. A new routine's computer picked in the editor ("Runs on Studio"): it is made on Studio's disk, not Laptop's.
 *  3. The Routines page lists Laptop's routine and Studio's, Studio's named "· Studio".
 *  4. Run on Studio's routine from Laptop: Studio starts it, and its row says Running.
 *  5. The same page at phone width.
 *  6. Settings → Capabilities at phone width: Studio's switches with their lines.
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

test("1. Settings → Capabilities: Studio's switches under Laptop's, and Routines turned on for Studio from here", async () => {
  await page.goto(`${laptop.url}#settings/capabilities`);
  const group = page.locator(`[data-settings-linked-capabilities="${studio.id}"]`);
  await expect(group.locator('h2')).toHaveText('Studio', { timeout: 20_000 });
  const routines = group.locator('[data-settings-linked-switch="scheduled_threads"] [role="switch"]');
  await expect(routines).toHaveAttribute('aria-checked', 'false');
  // Each of Studio's switches has the line Laptop's own row has under its name, said of Studio.
  await expect(group.locator('[data-settings-linked-switch="board"] .ib-desc')).toHaveText((await page.locator('[data-settings-board] .ib-desc').textContent())!);
  await expect(group.locator('[data-settings-linked-switch="scheduled_threads"] .ib-desc')).toHaveText('Runs saved prompts on a schedule, on Studio, while its Inbox is running.');
  await expect(group).not.toContainText('this computer');
  await routines.click();
  await expect(routines).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await read<{ scheduled_threads?: { on: boolean } }>(studio, '/api/inbox/settings')).scheduled_threads?.on).toBe(true);
  // Laptop's own switch is its own.
  expect((await read<{ scheduled_threads?: { on: boolean } }>(laptop, '/api/inbox/settings')).scheduled_threads?.on).toBe(true);
  await group.scrollIntoViewIfNeeded();
  await shot('01-settings-linked-capabilities.png');
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

test("6. Settings → Capabilities at phone width: Studio's switches with their lines, wrapped as Laptop's", async () => {
  await page.goto(`${laptop.url}#settings/capabilities`);
  const group = page.locator(`[data-settings-linked-capabilities="${studio.id}"]`);
  await expect(group.locator('h2')).toHaveText('Studio', { timeout: 20_000 });
  await expect(group.locator('[data-settings-linked-switch="board"] .ib-desc')).toBeVisible();
  // Nothing in the group runs past the phone's width.
  expect(await group.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await group.scrollIntoViewIfNeeded();
  await shot('06-settings-linked-capabilities-phone.png');
  expect(errors).toEqual([]);
});
