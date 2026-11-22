/**
 * Combine across linked computers (approval "inbox-combine-across-computers"; "Combine…" in
 * docs/agent-guides/inbox-messages.md), in a real browser against two compiled Inboxes on loopback, linked through the
 * real CLI pairing. Studio is the window's; Mini is the other computer. An agent on each (SimAgent over its own
 * `inbox mcp`) wrote one thread there.
 *
 *  1. Picked on both computers, Combine… lists the agents of both, each line ending with its computer, and nothing
 *     says the threads are on two machines.
 *  2. The agent on Mini chosen: "Asked … to combine 2 threads", both rows say "Combining…", the Combine is Mini's.
 *  3. Its new thread arrives on Mini: "Combined 2 threads", both rows leave the list, each archived on its own
 *     computer.
 *  4. Undo: both come back, on both computers.
 *  5. The agent on Studio chosen, the other way round: the dialog lists every running agent of both computers, the
 *     ones that wrote in no pick after the writers, each with its computer; the toasts name the agent as the dialog
 *     did; Mini's thread archived on Mini by Studio. Mini stopped (the window greys its rows), Undo says it waits for
 *     Mini and says "Combine undone." only once Mini is back and its thread is back there too.
 *  6. Mini stopped while the dialog is open: the dialog says Mini can't be asked now, in the person's words, and
 *     offers nobody.
 *  7. Any running agent, always (the owner, 2026-11-22): with both picks on Studio the dialog still lists Mini's agents,
 *     each line with its computer (07-…); picks on both (08-…), Studio's agent writes it after Mini's thread got a new
 *     message: that thread stays open on Mini, and the combined thread carries Studio's pick's file and one quiet line,
 *     "Still open on Mini: …" (09-…).
 *
 * Pictures (1440×900, light; the dialog in dark too) land in PLANNOTATOR_COMBINE_MACHINES_SHOTS, else
 * .local/proof/combine-across-computers/ (CI keeps .local/proof/ as the shard's "inbox-window-proof" artifact).
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
const shots = resolve(process.env.PLANNOTATOR_COMBINE_MACHINES_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'combine-across-computers'));
const CLOSED = 'http://127.0.0.1:9';
const ask = (line: string) => [line, '', ':::question', line, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

interface Machine {
  name: string;
  dataDir: string;
  root: string;
  env: Record<string, string>;
  id: string;
  url: string;
}

let studio: Machine;
let mini: Machine;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const agents: SimAgent[] = [];

function machine(name: string): Machine {
  const root = inboxScratch(`plannotator-combine-machines-${name.toLowerCase()}-`);
  const path = join(root, 'bin');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(path, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  return {
    name,
    root,
    dataDir,
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
  const run = spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;
const read = async <T>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;
const stateOf = async (viewer: Machine, other: Machine) => (await read<{ machines: { id: string; state: string }[] }>(viewer, '/api/inbox/machines')).machines.find((x) => x.id === other.id)?.state;

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

/** An agent on `m` and the thread it started there, drawn in Studio's list. */
async function agentWith(m: Machine, name: string, host: string, subject: string): Promise<{ agent: SimAgent; thread: string; project: string }> {
  const agent = await SimAgent.connect({ binary, env: m.env, name, host, cwd: m.root });
  agents.push(agent);
  const project = scratchProject(join(m.root, 'code'), m === studio ? 'billing-svc' : 'ledger');
  const sent = await agent.send({ project_path: project, subject, body: ask(`${subject}: ship it?`) });
  const thread = sent.thread_id as string;
  await expect.poll(async () => JSON.stringify(await read(studio, '/api/inbox/threads?machines=1')).includes(thread), { timeout: 20_000 }).toBe(true);
  return { agent, thread, project };
}

const row = (id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
const dialog = () => page.locator('[data-dialog="combine"]');
const toast = () => page.locator('[data-inbox-toast]');
const archivedOn = async (m: Machine, id: string) => (await read<{ thread: { resolved_at: string | null } }>(m, `/api/inbox/threads/${id}`)).thread.resolved_at !== null;
const settled = () => page.evaluate(() => Promise.all(document.getAnimations().filter((motion) => motion.effect?.getTiming().iterations !== Infinity).map((motion) => motion.finished.catch(() => {}))));

/** Both rows picked, Combine… pressed: the dialog with every computer's agents read. */
async function openCombine(ids: string[]): Promise<void> {
  for (const id of ids) await row(id).click({ modifiers: ['ControlOrMeta'] });
  await page.locator('[data-pick-bar] [data-pick-combine]').click();
  await expect(dialog()).toBeVisible();
  await expect(dialog().getByText('Finding the agents of these threads…')).toHaveCount(0);
  await expect(dialog().locator('[data-combine-agent]').nth(1)).toBeVisible();
}

/** Every agent line of a computer in the dialog (with picks on two computers each running agent there is offered). */
const linesOf = (machine: Machine) => dialog().locator(machine === studio ? '[data-combine-agent]:not([data-combine-machine])' : `[data-combine-machine="${machine.id}"]`);
/** The agent of that computer that wrote in a pick. */
const agentLine = (machine: Machine) => linesOf(machine).filter({ has: page.locator('small', { hasText: /^1 of these/ }) });
/** Both colour schemes of what is on screen now. */
async function shootBoth(name: string): Promise<void> {
  await settled();
  await page.screenshot({ path: join(shots, `${name}-light.png`) });
  await page.emulateMedia({ colorScheme: 'dark' });
  await settled();
  await page.screenshot({ path: join(shots, `${name}-dark.png`) });
  await page.emulateMedia({ colorScheme: 'light' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  studio = machine('Studio');
  mini = machine('Mini');
  await start(studio);
  await start(mini);
  link(studio, mini);
  await expect.poll(async () => (await read<{ machines: { id: string; state: string; marks?: string[] }[] }>(studio, '/api/inbox/machines')).machines.find((m) => m.id === mini.id)?.marks ?? [], { timeout: 30_000 }).toContain('combine-across');
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

let here: { agent: SimAgent; thread: string; project: string };
let there: { agent: SimAgent; thread: string; project: string };

test('1-4. Picks on both computers: both agents offered with their computer; the Mini agent combines; Undo brings both back', async () => {
  here = await agentWith(studio, 'Claude Code', 'claude-code', 'Invoice retries');
  there = await agentWith(mini, 'Codex', 'codex', 'Retry worker backoff');
  await page.goto(studio.url);
  await expect(row(here.thread)).toBeVisible();
  await expect(row(there.thread)).toBeVisible();

  // 1. The dialog: no "two machines" line, an agent from each computer, each saying which.
  await openCombine([here.thread, there.thread]);
  await expect(dialog().locator('.ib-cmb-why')).toHaveCount(0);
  await expect(agentLine(studio).locator('small')).toContainText('Studio');
  await expect(agentLine(mini).locator('small')).toContainText('Mini');
  await settled();
  await page.screenshot({ path: join(shots, '01-dialog-both-computers-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await settled();
  await page.screenshot({ path: join(shots, '01-dialog-both-computers-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // 2. The agent on Mini: the Combine is Mini's, and both rows say "Combining…".
  await agentLine(mini).locator('input').check();
  await expect(dialog().locator('.ib-cmb-what')).toContainText('Codex');
  await page.screenshot({ path: join(shots, '02-mini-agent-chosen.png') });
  await dialog().locator('[data-combine-go]').click();
  await expect(dialog()).toHaveCount(0);
  await expect(toast()).toContainText('to combine 2 threads');
  await expect(row(here.thread)).toContainText('Combining…');
  await expect(row(there.thread)).toContainText('Combining…');
  await settled();
  await page.screenshot({ path: join(shots, '03-combining.png') });
  const combine = (await read<{ combines: { id: string; state: string; session: string }[] }>(mini, '/api/inbox/combine')).combines[0]!;
  expect(combine.state).toBe('asked');
  expect((await read<{ combines: unknown[] }>(studio, '/api/inbox/combine')).combines).toEqual([]);

  // 3. Mini's agent writes the new thread on Mini: both picked threads go, each on its own computer.
  await there.agent.send({ project_path: there.project, subject: 'Retries, combined', body: 'Where the invoice retries and the worker backoff stand.', idempotency_key: combine.id });
  await expect(toast()).toContainText('Combined 2 threads', { timeout: 20_000 });
  await expect.poll(() => archivedOn(mini, there.thread), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => archivedOn(studio, here.thread), { timeout: 20_000 }).toBe(true);
  await expect(row(here.thread)).toHaveCount(0, { timeout: 20_000 });
  await expect(row(there.thread)).toHaveCount(0, { timeout: 20_000 });
  await settled();
  await page.screenshot({ path: join(shots, '04-combined.png') });

  // 4. Undo: both come back, on both computers.
  await toast().getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('[data-inbox-live]')).toContainText('Combine undone.');
  await expect.poll(() => archivedOn(mini, there.thread), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => archivedOn(studio, here.thread), { timeout: 20_000 }).toBe(false);
  await expect(row(here.thread)).toBeVisible({ timeout: 20_000 });
  await expect(row(there.thread)).toBeVisible({ timeout: 20_000 });
  await settled();
  await page.screenshot({ path: join(shots, '05-undone.png') });
  expect(errors).toEqual([]);
});

let a: { agent: SimAgent; thread: string; project: string };
let b: { agent: SimAgent; thread: string; project: string };

test('5. The agent on Studio combines: every running agent offered; Mini’s thread archived on Mini by Studio; Undo with Mini stopped waits for it', async () => {
  a = await agentWith(studio, 'Claude Code', 'claude-code', 'Ledger export');
  b = await agentWith(mini, 'Codex', 'codex', 'Refund totals');
  await page.reload();
  await expect(row(a.thread)).toBeVisible();
  await expect(row(b.thread)).toBeVisible();
  await openCombine([a.thread, b.thread]);
  // Any running agent on either computer: the ones that wrote in a pick first, then the ones from test 1 that wrote in
  // none; every line ends with its computer.
  const subs = await dialog().locator('[data-combine-agent] small').allTextContents();
  expect(subs.length).toBeGreaterThanOrEqual(4);
  expect(subs.slice(0, 2).every((sub) => sub.startsWith('1 of these'))).toBe(true);
  expect(subs.slice(2).every((sub) => sub.startsWith('0 of these'))).toBe(true);
  expect(subs.every((sub) => sub.endsWith(' · Studio') || sub.endsWith(' · Mini'))).toBe(true);
  await expect(linesOf(studio).locator('small', { hasText: /^0 of these/ })).not.toHaveCount(0);
  await expect(linesOf(mini).locator('small', { hasText: /^0 of these/ })).not.toHaveCount(0);
  await expect(dialog().locator('.ib-cmb-why')).toHaveCount(0);
  await shootBoth('combine-dialog-two-computers');

  await agentLine(studio).locator('input').check();
  const label = (await agentLine(studio).locator('b').textContent())!;
  await dialog().locator('[data-combine-go]').click();
  // The toast names the agent as the dialog did.
  await expect(toast()).toContainText(`Asked ${label} to combine 2 threads`);
  await settled();
  await page.screenshot({ path: join(shots, 'combine-toast-asked.png') });
  const combine = (await read<{ combines: { id: string; state: string }[] }>(studio, '/api/inbox/combine')).combines.find((c) => c.state === 'asked')!;

  // The window's reads of its Combines wait until Mini is stopped, so the "Combined" toast's Undo is pressed with Mini away.
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = (url: URL) => url.pathname === '/api/inbox/combine';
  await page.route(held, async (route) => {
    await gate;
    await route.continue();
  });
  await a.agent.send({ project_path: a.project, subject: 'Exports and refunds', body: 'One thread for both.', idempotency_key: combine.id });
  await expect.poll(() => archivedOn(mini, b.thread), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => archivedOn(studio, a.thread), { timeout: 20_000 }).toBe(true);
  await stopScratchInbox(mini.dataDir);
  // The window knows Mini is away (its earlier thread greyed) before the Undo: the toast says Mini's state as it is then.
  await expect(row(there.thread)).toHaveAttribute('data-away', '', { timeout: 45_000 });
  release();
  await page.unroute(held);
  await expect(toast()).toContainText('Combined 2 threads', { timeout: 20_000 });
  await settled();
  await page.screenshot({ path: join(shots, 'combine-toast-combined.png') });

  // Undo with Mini stopped: it waits for Mini, says so, and does not say it is undone yet.
  await toast().getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.ib-tlead').filter({ hasText: 'Waiting for Mini: this applies when Mini is back.' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-inbox-live]')).not.toContainText('Combine undone.');
  await expect.poll(() => archivedOn(studio, a.thread), { timeout: 20_000 }).toBe(false);
  await settled();
  await page.screenshot({ path: join(shots, 'combine-undo-waiting.png') });

  // Mini back: its thread comes back there, and only then is it undone.
  await start(mini);
  await expect.poll(() => stateOf(studio, mini), { timeout: 45_000 }).toBe('online');
  await expect.poll(() => archivedOn(mini, b.thread), { timeout: 60_000 }).toBe(false);
  await expect(page.locator('[data-inbox-live]')).toContainText('Combine undone.', { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('6. Mini stopped while the dialog is open: the person’s words that it is away, and nobody offered', async () => {
  await page.reload();
  await expect(row(a.thread)).toBeVisible({ timeout: 20_000 });
  await expect(row(b.thread)).toBeVisible({ timeout: 20_000 });
  await openCombine([a.thread, b.thread]);
  await stopScratchInbox(mini.dataDir);
  await expect(dialog()).toContainText('Mini can’t be asked now: it is away.', { timeout: 60_000 });
  await expect(dialog().locator('[data-combine-agent]')).toHaveCount(0);
  await expect(dialog().locator('[data-combine-go]')).toBeDisabled();
  // Never the words written for an agent.
  await expect(dialog()).not.toContainText('Ask the person');
  await shootBoth('combine-dialog-away');
  await dialog().locator('[data-combine-cancel]').click();
  expect(errors).toEqual([]);
});

test('7. Any running agent, also with every pick on one computer; every pick’s files and one quiet line for what stayed open on Mini', async () => {
  // Mini restarted, three agents and two Combine dialogs: longer than the file's default.
  test.setTimeout(360_000);
  await start(mini);
  await expect.poll(() => stateOf(studio, mini), { timeout: 45_000 }).toBe('online');
  await expect.poll(async () => (await read<{ machines: { id: string; marks?: string[] }[] }>(studio, '/api/inbox/machines')).machines.find((m) => m.id === mini.id)?.marks ?? [], { timeout: 30_000 }).toContain('combine-across');
  const c1 = await agentWith(studio, 'Claude Code', 'claude-code', 'Invoice for Charlie Dunn');
  writeFileSync(join(c1.project, 'invoice-charlie-dunn.md'), '# Invoice for Charlie Dunn\n\nTwo lines, paid in full.\n');
  await c1.agent.send({ project_path: c1.project, reply_to: c1.thread, body: 'The invoice, as sent.', attachments: ['invoice-charlie-dunn.md'] });
  const c2 = await agentWith(studio, 'Claude Code', 'claude-code', 'Export for Bob Tully');
  const d = await agentWith(mini, 'Codex', 'codex', 'Refund for Ada Novak');
  await page.reload();
  for (const id of [c1.thread, c2.thread, d.thread]) await expect(row(id)).toBeVisible({ timeout: 20_000 });

  // (a) Both picks on Studio: Mini's running agents are offered too, after the ones that wrote, each with its computer.
  await openCombine([c1.thread, c2.thread]);
  const more = dialog().locator('[data-combine-more]');
  if ((await more.count()) > 0) await more.click();
  const subs = await dialog().locator('[data-combine-agent] small').allTextContents();
  expect(subs.slice(0, 2).every((sub) => sub.startsWith('1 of these'))).toBe(true);
  expect(subs.slice(2).every((sub) => sub.startsWith('0 of these'))).toBe(true);
  expect(subs.every((sub) => sub.endsWith(' · Studio') || sub.endsWith(' · Mini'))).toBe(true);
  await expect(linesOf(mini)).not.toHaveCount(0);
  await expect(dialog().locator('.ib-cmb-why')).toHaveCount(0);
  await settled();
  await page.screenshot({ path: join(shots, '07-dialog-picks-on-one-computer.png') });
  await dialog().locator('[data-combine-cancel]').click();
  await expect(dialog()).toHaveCount(0);

  // (b) Picks on both computers.
  await page.reload();
  await expect(row(d.thread)).toBeVisible({ timeout: 20_000 });
  await openCombine([c1.thread, d.thread]);
  await expect(agentLine(studio).locator('small')).toContainText('Studio');
  await expect(agentLine(mini).locator('small')).toContainText('Mini');
  await settled();
  await page.screenshot({ path: join(shots, '08-dialog-picks-on-both-computers.png') });
  await agentLine(studio).locator('input').check();
  await dialog().locator('[data-combine-go]').click();
  await expect(dialog()).toHaveCount(0);
  const combine = (await read<{ combines: { id: string; state: string }[] }>(studio, '/api/inbox/combine')).combines.find((c) => c.state === 'asked')!;

  // (c) Mini's thread moves on after the Combine read it; then the new thread arrives on Studio.
  await d.agent.send({ project_path: d.project, reply_to: d.thread, body: 'One more refund for Ada Novak came in.' });
  const made = (await c1.agent.send({ project_path: c1.project, subject: 'Charlie Dunn and Ada Novak, combined', body: 'Where the invoice and the refund stand.', idempotency_key: combine.id })).thread_id as string;
  await expect(toast()).toContainText('Combined 2 threads', { timeout: 20_000 });
  await expect.poll(() => archivedOn(studio, c1.thread), { timeout: 20_000 }).toBe(true);
  const first = async () => (await read<{ thread: { messages: { combine_left?: unknown; attachments?: { name: string }[] }[] } }>(studio, `/api/inbox/threads/${made}`)).thread.messages[0]!;
  await expect.poll(async () => (await first()).combine_left ?? null, { timeout: 30_000 }).toEqual({ open: [{ machine: 'Mini', subject: 'Refund for Ada Novak' }] });
  await expect.poll(async () => ((await first()).attachments ?? []).map((a) => a.name), { timeout: 30_000 }).toEqual(['invoice-charlie-dunn.md']);
  expect(await archivedOn(mini, d.thread)).toBe(false);
  // Opened as a link to it opens it (an agent's thread with no question may sit in a folded group of the list).
  await page.goto(`${studio.url}#thread=${made}`);
  const quiet = page.locator('[data-combine-left]');
  await expect(quiet).toHaveText('Still open on Mini: Refund for Ada Novak', { timeout: 20_000 });
  await quiet.scrollIntoViewIfNeeded();
  await settled();
  await page.screenshot({ path: join(shots, '09-combined-thread-quiet-line.png') });
  expect(errors).toEqual([]);
});
