/**
 * Decision mode on a linked computer's thread (the owner: whatever works on one computer works on a linked computer's
 * thread, with no guardrails or friction), proved in a real browser against two compiled Inboxes on loopback, linked
 * both ways through the real CLI pairing. Studio is the window's computer; Laptop is the linked one, where Claude Code
 * asks in a harbor thread. Agents are SimAgent over each computer's own `inbox mcp`. Nothing else is faked.
 *
 *  1. Laptop's thread, opened in Studio's window, shows "Decide these N"; Laptop's window shows it for Studio's
 *     fern-api thread too (both ways).
 *  2. The dialog on Laptop's thread: a pick lands on Laptop, Undo takes it back there, a Can't do it's reason is kept
 *     as Laptop's draft for that thread.
 *  3. Laptop asleep: a pick says it waits for Laptop, and Send's chip says "Will send when Laptop is back".
 *  4. Laptop back: the held pick and the Send land there once, and what said they wait goes.
 *  5. Settings → Capabilities: Decision mode turned off in Studio's window is off in Laptop's, and back on from Laptop.
 *
 * Proof: whole-window shots at 1440×900, light and dark, in PLANNOTATOR_DECISION_LINKED_SHOTS or
 * <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/decision-mode-linked/ (CI keeps .local/proof/ as the shard's
 * "inbox-window-proof" artifact). Made-up projects and people only. Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_DECISION_LINKED_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'decision-mode-linked'));
const CLOSED = 'http://127.0.0.1:9';

const PLAIN = 'Ship the new search index tonight?';
const CHANGE = 'Keep the result count next to the search box?';
const ACTION = 'Rotate the harbor search API key';
const LAPTOP_BODY = [
  'Three things before the harbor search index ships. Charlie Dunn signed off on the ranking.',
  '',
  ':::question',
  PLAIN,
  '',
  '- [ ] Yes, tonight — the index is warm and traffic is low',
  '- [ ] No, wait for Monday — Bob Tully is on call then',
  ':::',
  '',
  ':::question',
  CHANGE,
  '',
  'Where: The search page on a phone',
  'Before: The result count scrolls away under the filters',
  'After: The result count stays next to the search box',
  '',
  '- [ ] Yes, keep it there',
  '- [ ] No, leave it under the filters',
  ':::',
  '',
  ':::action',
  ACTION,
  'The old key is in the deploy settings; the new one must be live before the switch.',
  ':::',
].join('\n');
const STUDIO_BODY = [
  'Two calls on the fern-api partner limits. Bob Tully asked for 600 requests a minute per key.',
  '',
  ':::question',
  'Raise the default limit to 600 a minute?',
  '',
  '- [ ] Yes',
  '- [ ] No, keep 300',
  ':::',
  '',
  ':::question',
  'Tell partners a day ahead?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

interface Machine {
  name: string;
  root: string;
  dataDir: string;
  env: Record<string, string>;
  id: string;
  url: string;
}

let studio: Machine;
let laptop: Machine;
let context: BrowserContext;
let page: Page;
const agents: SimAgent[] = [];
const errors: string[] = [];
let laptopThread = '';
let laptopMessage = '';
let studioThread = '';

function machine(name: string): Machine {
  const root = inboxScratch(`plannotator-decide-linked-${name.toLowerCase()}-`);
  const bin = join(root, 'bin');
  const dataDir = join(root, 'data');
  for (const dir of [bin, dataDir]) mkdirSync(dir, { recursive: true });
  // Never a real tailscale: one that only fails.
  writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'tailscale'), 0o755);
  markTourDecided(dataDir);
  return {
    name,
    root,
    dataDir,
    id: '',
    url: '',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_TEST_SANDBOX: root,
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
const read = async <T,>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;
const stateOf = async (m: Machine, other: Machine) => (await read<{ machines: { id: string; state: string }[] }>(m, '/api/inbox/machines')).machines.find((x) => x.id === other.id)?.state;
/** Decision mode as that Inbox keeps it: on or off, and whether it holds a flip of it (config.json `inboxCapabilityFlips`). */
async function switchOn(m: Machine): Promise<{ on: boolean | null; flipped: boolean }> {
  const on = (await read<{ decision_mode?: { on: boolean } }>(m, '/api/inbox/settings')).decision_mode?.on ?? null;
  const file = join(m.dataDir, 'config.json');
  const flips = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { inboxCapabilityFlips?: { decision_mode?: { at?: unknown } } }).inboxCapabilityFlips : undefined;
  return { on, flipped: typeof flips?.decision_mode?.at === 'number' };
}

async function start(m: Machine): Promise<void> {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

type WireQuestion = { key: string; prompt?: string; kind?: string; state: string; answer: { selected: string[] } | null };
/** A question as Laptop's own Inbox holds it (never the page). */
async function onLaptop(prompt: string): Promise<WireQuestion | null> {
  const model = await read<{ thread: { messages: { questions?: WireQuestion[] }[] } }>(laptop, `/api/inbox/threads/${laptopThread}`);
  return model.thread.messages.flatMap((m) => m.questions ?? []).find((q) => q.prompt === prompt) ?? null;
}
const laptopState = async (prompt: string) => (await onLaptop(prompt))?.state ?? null;

const settled = (on: Page) => on.evaluate(() => Promise.all(document.getAnimations().filter((motion) => motion.effect?.getTiming().iterations !== Infinity).map((motion) => motion.finished.catch(() => {}))));
/** A whole-window shot, light and dark. */
async function shot(name: string, on: Page = page): Promise<void> {
  await on.mouse.move(1, 1);
  for (const scheme of ['light', 'dark'] as const) {
    await on.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await on.waitForTimeout(300);
    await settled(on);
    await on.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await on.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** The same window at phone width, light and dark, then back to the desktop. */
async function phoneShot(name: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(`${name}-phone`);
  await page.setViewportSize({ width: 1440, height: 900 });
}

const dialog = () => page.locator('[data-decision-mode]');
const card = () => dialog().locator('[data-decision-card]');
const promptOf = () => card().locator('[data-decision-question] [data-question-part="prompt"]');
const option = (label: string) => card().locator('[data-question-option]', { hasText: label });
async function goToCard(prompt: string): Promise<void> {
  await dialog().locator('[data-decision-overview]').click();
  await dialog().locator('.ib-dm-allrow', { hasText: prompt }).click();
}

/** The thread's one way in: its open-questions list, then "Decide these N". */
async function decideEntry(on: Page, url: string, thread: string) {
  await on.goto(`${url}#thread=${thread}`);
  const button = on.locator('section.ib-pane [data-open-questions]');
  await expect(button).toBeVisible({ timeout: 20_000 });
  if (!(await on.locator('[data-open-questions-list]').isVisible())) await button.click();
  const decide = on.locator('[data-thread-decide]');
  await expect(decide).toBeVisible({ timeout: 20_000 });
  return decide;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  studio = machine('Studio');
  laptop = machine('Laptop');
  await start(studio);
  await start(laptop);
  const offered = cli(laptop, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(studio, 'link', offered.out.trim(), '--address', base(laptop), '--back', base(studio));
  expect(linked.status, linked.err).toBe(0);
  expect(linked.out).toContain('both ways');
  for (const m of [studio, laptop]) await fetch(`${base(m)}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  const onLaptopAgent = await SimAgent.connect({ binary, env: laptop.env, name: 'Claude Code', host: 'claude-code', cwd: laptop.root });
  const onStudioAgent = await SimAgent.connect({ binary, env: studio.env, name: 'Claude Code', host: 'claude-code', cwd: studio.root });
  agents.push(onLaptopAgent, onStudioAgent);
  const asked = await onLaptopAgent.send({ project_path: scratchProject(join(laptop.root, 'src'), 'harbor'), subject: 'Harbor search index rollout', body: LAPTOP_BODY }, { wakes: true });
  laptopThread = asked.thread_id as string;
  laptopMessage = asked.message_id as string;
  const own = await onStudioAgent.send({ project_path: scratchProject(join(studio.root, 'src'), 'fern-api'), subject: 'Partner API rate limits', body: STUDIO_BODY }, { wakes: true });
  studioThread = own.thread_id as string;
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  // Each computer's merged read lists the other's decisions (both ways), named by computer.
  await expect
    .poll(async () => {
      const [s, l] = await Promise.all([read<{ decisions: { machine?: string }[] }>(studio, '/api/inbox/decisions?machines=1'), read<{ decisions: { machine?: string }[] }>(laptop, '/api/inbox/decisions?machines=1')]);
      return [s.decisions.filter((d) => d.machine === laptop.id).length, l.decisions.filter((d) => d.machine === studio.id).length];
    }, { timeout: 30_000 })
    .toEqual([3, 2]);
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test("1. Laptop's thread in Studio's window shows Decide these N, and Studio's thread in Laptop's window does too", async () => {
  await page.goto(studio.url);
  await expect(page.locator(`.ib-lbody [data-thread-id="${laptopThread}"]`)).toBeVisible({ timeout: 20_000 });
  const decide = await decideEntry(page, studio.url, laptopThread);
  await expect(decide).toContainText('3');
  await expect(page.locator('section.ib-pane [data-thread-machine]')).toContainText('Laptop');
  await shot('01-far-thread-decide-these-n');
  // Both ways: Laptop's window offers it on Studio's thread.
  const there = await context.newPage();
  there.on('pageerror', (error) => errors.push(error.message));
  await there.goto(laptop.url);
  await expect(there.locator(`.ib-lbody [data-thread-id="${studioThread}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(await decideEntry(there, laptop.url, studioThread)).toContainText('2');
  await there.close();
});

test("2. The dialog on Laptop's thread: a pick lands on Laptop, Undo takes it back there, a reason is Laptop's draft", async () => {
  await (await decideEntry(page, studio.url, laptopThread)).click();
  await expect(dialog()).toBeVisible();
  await goToCard(PLAIN);
  await expect(promptOf()).toHaveText(PLAIN);
  await option('Yes, tonight').click();
  await expect.poll(() => laptopState(PLAIN), { timeout: 15_000 }).toBe('picked');
  expect((await onLaptop(PLAIN))?.answer?.selected).toEqual(['Yes, tonight']);
  // Undo: taken back on Laptop.
  await dialog().locator('[data-decision-undo]').click();
  await expect.poll(() => laptopState(PLAIN), { timeout: 15_000 }).toBe('open');
  await goToCard(PLAIN);
  await option('Yes, tonight').click();
  await expect.poll(() => laptopState(PLAIN), { timeout: 15_000 }).toBe('picked');
  // A Can't do it's reason, typed and left: Studio's own draft for Laptop's thread (only a mark carries it there).
  await goToCard(ACTION);
  await card().locator('[data-decision-cant]').click();
  await card().locator('textarea').fill('Bob Tully holds the deploy settings until Friday');
  const action = (await read<{ thread: { messages: { id: string; questions?: WireQuestion[] }[] } }>(laptop, `/api/inbox/threads/${laptopThread}`)).thread.messages.find((m) => m.id === laptopMessage)!.questions!.find((q) => q.kind === 'action')!;
  const key = encodeURIComponent(`decision-reason:${laptopMessage}/${action.key}`);
  await expect
    .poll(async () => (await read<{ draft: { text: string } | null }>(studio, `/api/inbox/threads/${laptopThread}/comment-draft?key=${key}&machine=${laptop.id}`)).draft?.text ?? null, { timeout: 15_000 })
    .toBe('Bob Tully holds the deploy settings until Friday');
  // A reload of the dialog reads it back: the field opens by itself with the words (a click on "Can't do it…" would
  // close it again, as on this computer's threads).
  await page.reload();
  await (await decideEntry(page, studio.url, laptopThread)).click();
  await goToCard(ACTION);
  await expect(card().locator('[data-decision-cant]')).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
  await expect(card().locator('textarea')).toHaveValue('Bob Tully holds the deploy settings until Friday', { timeout: 15_000 });
  await goToCard(PLAIN);
  await expect(card().locator('[data-question-tag]', { hasText: 'Draft' })).toBeVisible();
  await shot('02-dialog-on-a-far-thread');
});

test('3. Laptop asleep: a pick says it waits for Laptop, and Send says it will send when Laptop is back', async () => {
  await stopScratchInbox(laptop.dataDir);
  await expect.poll(() => stateOf(studio, laptop), { timeout: 30_000 }).toBe('offline');
  await goToCard(CHANGE);
  await option('Yes, keep it there').click();
  // A status, not an error.
  await expect(dialog().locator('[data-decision-held]')).toHaveText('Waiting for Laptop: this applies when Laptop is back.', { timeout: 15_000 });
  await expect(dialog().locator('[role="alert"]')).toHaveCount(0);
  await shot('03-pick-held-while-laptop-is-away');
  await dialog().locator('[data-decision-send]').click();
  await expect(dialog().locator('[data-decision-chip-state]')).toHaveText('Will send when Laptop is back', { timeout: 15_000 });
  await shot('04-send-held-while-laptop-is-away');
  await phoneShot('04-send-held-while-laptop-is-away');
  // Laptop asleep never delays Studio's own: its fern-api thread offers "Decide these 2" at once.
  const own = await context.newPage();
  const started = Date.now();
  await expect(await decideEntry(own, studio.url, studioThread)).toContainText('2');
  expect(Date.now() - started).toBeLessThan(8_000);
  await own.close();
});

test('4. Laptop back: the held pick and the Send land there once, and what said they wait goes', async () => {
  await start(laptop);
  await expect.poll(() => stateOf(studio, laptop), { timeout: 45_000 }).toBe('online');
  await expect.poll(() => laptopState(CHANGE), { timeout: 45_000 }).toBe('sent');
  expect(await laptopState(PLAIN)).toBe('sent');
  expect((await onLaptop(CHANGE))?.answer?.selected).toEqual(['Yes, keep it there']);
  const there = await read<{ thread: { messages: { author: { kind: string } }[] } }>(laptop, `/api/inbox/threads/${laptopThread}`);
  expect(there.thread.messages.filter((m) => m.author.kind === 'person')).toHaveLength(1);
  await expect(dialog().locator('[data-decision-chip-state="will send when laptop is back"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(dialog().locator('[data-decision-held]')).toHaveCount(0);
  await shot('05-after-laptop-is-back');
  await phoneShot('05-after-laptop-is-back');
});

test("5. Decision mode is one switch for both: off in Studio's Settings is off in Laptop's, and back on from Laptop", async () => {
  await dialog().locator('[data-decision-close]').click();
  const there = await context.newPage();
  there.on('pageerror', (error) => errors.push(error.message));
  const windows = [
    { on: page, m: studio },
    { on: there, m: laptop },
  ] as const;
  for (const w of windows) await w.on.goto(`${w.m.url}#settings/capabilities`);
  const row = (on: Page) => on.locator('[data-settings-decision-mode]');
  for (const w of windows) await expect(row(w.on).getByRole('switch')).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
  // Laptop came back in step 4: its own line to Studio, which a flip there travels on, is up again first.
  await expect.poll(() => stateOf(laptop, studio), { timeout: 30_000, message: "Laptop's line to Studio after its restart" }).toBe('online');
  // Each hop on its own, so a failure names the side that broke: the window that was pressed, that computer's save and
  // the flip it stamps, the other computer's take of it, and the other computer's open window.
  await row(page).getByRole('switch').click();
  await expect(row(page).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => switchOn(studio), { message: "Studio saved Decision mode off, and stamped the flip" }).toEqual({ on: false, flipped: true });
  await expect.poll(() => switchOn(laptop), { timeout: 20_000, message: "Laptop took Studio's flip" }).toEqual({ on: false, flipped: true });
  await expect(row(there).getByRole('switch')).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 });
  await row(there).scrollIntoViewIfNeeded();
  await shot('06-laptop-settings-decision-mode-off-from-studio', there);
  await row(there).getByRole('switch').click();
  await expect(row(there).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => switchOn(laptop), { message: 'Laptop saved Decision mode on' }).toEqual({ on: true, flipped: true });
  await expect.poll(() => switchOn(studio), { timeout: 20_000, message: "Studio took Laptop's flip" }).toEqual({ on: true, flipped: true });
  await expect(row(page).getByRole('switch')).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
  await row(page).scrollIntoViewIfNeeded();
  await shot('07-studio-settings-decision-mode-on-from-laptop');
  await there.close();
  expect(errors).toEqual([]);
});
