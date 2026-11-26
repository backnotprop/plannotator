/**
 * Tag an agent on another computer ("Tag an agent on another computer" in docs/agent-guides/inbox-machines.md), in a
 * real browser against two compiled Inboxes on loopback, linked through the real CLI pairing. The thread is Studio's
 * (an agent there started it); Laptop runs the agent the person tags. Each computer's live agent is a connection that
 * polls its own Inbox's bridge, as the Claude Code mod and Pi do; Laptop's agent reads and answers with
 * `plannotator inbox call` in its own shell (its session named by `PLANNOTATOR_SESSION_TAG`, as the mod sets it).
 *
 *  1. In Studio's thread, `@` lists the agents of both computers: Laptop's as "Claude Code (Laptop)", "web · Laptop".
 *  2. Send: Laptop's agent is woken by its own Inbox with the tagged wake (whose thread, read it first, reply_to).
 *  3. It reads the thread by the reply's id and answers with reply_to: the answer is in Studio's thread, the head
 *     naming its folder and computer, on Studio.
 *  4. Laptop stopped: the person's next reply to it waits; Laptop back, its agent is woken with it.
 *  5. Studio stopped: the agent's answer waits ("Waiting for Studio"); Studio back, it is in the thread.
 *  6. The phone's width: the picker with both computers' agents, and the thread with the far answer.
 *
 * Pictures (1440×900, light; 390×844 for the phone) land in PLANNOTATOR_TAG_ACROSS_SHOTS, else
 * .local/proof/tag-across-computers/ (CI keeps .local/proof/ as the shard's "inbox-window-proof" artifact).
 * Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxWakeText, type InboxReplyCommand } from '../../packages/shared/inbox/connection';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_TAG_ACROSS_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'tag-across-computers'));
const CLOSED = 'http://127.0.0.1:9';
/** Laptop's Claude Code session, and Studio's Pi. */
const LAPTOP_AGENT = '7d1f3c2a-4b5e-4f60-8a71-92b3c4d5e6f7';
const STUDIO_PI = '3a9e5c1b-2d4f-4a60-9b71-0c2d3e4f5a6b';

interface Machine {
  name: string;
  dataDir: string;
  root: string;
  env: Record<string, string>;
  id: string;
  url: string;
}

let studio: Machine;
let laptop: Machine;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const agents: SimAgent[] = [];
const pollers: Poller[] = [];

function machine(name: string): Machine {
  const root = inboxScratch(`plannotator-tag-across-${name.toLowerCase()}-`);
  const path = join(root, 'bin');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(path, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  mkdirSync(join(root, 'tmp'), { recursive: true });
  return {
    name,
    root,
    dataDir,
    id: '',
    url: '',
    env: {
      PATH: `${path}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: join(root, 'tmp'),
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

const cli = (m: Machine, env: Record<string, string>, ...args: string[]) => {
  const run = spawnSync(binary, ['inbox', ...args], { env: { ...m.env, ...env }, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const registry = (m: Machine) => JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
const base = (m: Machine) => `http://127.0.0.1:${registry(m).port}`;
const read = async <T>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;
const stateOf = async (viewer: Machine, other: Machine) => (await read<{ machines: { id: string; state: string }[] }>(viewer, '/api/inbox/machines')).machines.find((x) => x.id === other.id)?.state;
const marksOf = async (viewer: Machine, other: Machine) => (await read<{ machines: { id: string; marks?: string[] }[] }>(viewer, '/api/inbox/machines')).machines.find((x) => x.id === other.id)?.marks ?? [];
/** One agent action from Laptop's agent's own shell: its result, or its refusal's words. */
const laptopCall = (action: string, args: Record<string, unknown>) => {
  const run = cli(laptop, { PLANNOTATOR_SESSION_TAG: `claude-code:${LAPTOP_AGENT}` }, 'call', action, JSON.stringify(args));
  return { ...run, json: run.status === 0 ? (JSON.parse(run.out) as Record<string, any>) : null };
};
const messagesOn = async (m: Machine, thread: string) => (await read<{ thread: { messages: { id: string; body: string; author: { kind: string; session?: string; machine?: string; machine_name?: string } }[] } }>(m, `/api/inbox/threads/${thread}`)).thread.messages;

async function start(m: Machine): Promise<void> {
  const run = cli(m, {}, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
  // A start right after a stop may find the old listener going away.
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

function link(from: Machine, to: Machine): void {
  const offered = cli(to, {}, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, {}, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

/**
 * A live agent's connection on `m`: it polls its own Inbox's bridge (held 2 s at a time) with tags on, keeps every
 * command it is handed, and says each was delivered, as the mod does once the wake is in the session.
 */
class Poller {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = true;
  private loop: Promise<void> = Promise.resolve();
  constructor(
    readonly m: Machine,
    readonly session: string,
    readonly host: string,
    readonly project: string,
  ) {
    pollers.push(this);
  }
  private async bridge(path: string, body: Record<string, unknown>): Promise<Response> {
    const { port, token } = registry(this.m);
    return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  }
  start(): void {
    this.stopped = false;
    this.loop = (async () => {
      while (!this.stopped) {
        try {
          const answer = await this.bridge('/api/inbox/bridge/poll', { session: this.session, host: this.host, waitMs: 2_000, tags: true, project_path: this.project });
          const { commands = [] } = answer.ok ? ((await answer.json()) as { commands?: InboxReplyCommand[] }) : {};
          for (const command of commands) {
            if (this.commands.some((c) => c.id === command.id)) continue;
            this.commands.push(command);
            await this.bridge('/api/inbox/bridge/event', { session: this.session, host: this.host, type: 'delivered', id: command.id });
          }
          if (!answer.ok) await new Promise((done) => setTimeout(done, 300));
        } catch {
          await new Promise((done) => setTimeout(done, 300));
        }
      }
    })();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
  /** The command it was handed for that thread's reply (`id`), once it is. */
  async handed(id: string): Promise<InboxReplyCommand> {
    await expect.poll(() => this.commands.some((c) => c.id === id), { timeout: 60_000 }).toBe(true);
    return this.commands.find((c) => c.id === id)!;
  }
}

const settled = () => page.evaluate(() => Promise.all(document.getAnimations().filter((motion) => motion.effect?.getTiming().iterations !== Infinity).map((motion) => motion.finished.catch(() => {}))));

/** Open a thread and its reply box, empty. */
async function openReply(on: Page, threadId: string) {
  await on.goto(`${studio.url}#thread=${threadId}`);
  const pane = on.locator('section.ib-pane');
  await expect(pane.locator('h2.ib-subject')).toBeVisible({ timeout: 20_000 });
  const box = pane.getByRole('textbox', { name: /^Reply to/ });
  const reply = pane.locator('.ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ });
  for (let attempt = 0; attempt < 10 && !(await box.isVisible()); attempt += 1) await reply.click({ timeout: 1_000 }).catch(() => {});
  await expect(box).toBeVisible();
  await box.fill('');
  return box;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  studio = machine('Studio');
  laptop = machine('Laptop');
  await start(studio);
  await start(laptop);
  link(studio, laptop);
  await expect.poll(() => marksOf(studio, laptop), { timeout: 30_000 }).toContain('tag-across');
  await expect.poll(() => marksOf(laptop, studio), { timeout: 30_000 }).toContain('tag-across');
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterAll(async () => {
  try {
    for (const poller of pollers) await poller.stop().catch(() => {});
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

let thread = '';
let farAgent: Poller;
let firstReply = '';
let answer = '';

test('1-3. Studio’s thread: @ offers Laptop’s agent; Send wakes it there; its answer lands in Studio’s thread', async () => {
  test.setTimeout(240_000);
  // Studio: the agent that owns the thread, and a Pi that polls; Laptop: a Claude Code that polls, in "web".
  const owner = await SimAgent.connect({ binary, env: studio.env, name: 'Claude Code', host: 'claude-code', cwd: studio.root });
  agents.push(owner);
  const billing = scratchProject(join(studio.root, 'code'), 'billing-svc');
  thread = (await owner.send({ project_path: billing, subject: 'Refund webhook for Ada Novak', body: 'The refund webhook retries five times. Should it give up sooner?' })).thread_id as string;
  new Poller(studio, STUDIO_PI, 'pi', billing).start();
  farAgent = new Poller(laptop, LAPTOP_AGENT, 'claude-code', scratchProject(join(laptop.root, 'code'), 'web'));
  farAgent.start();

  // 1. The picker lists both computers' agents, Laptop's with its computer.
  const box = await openReply(page, thread);
  await expect(async () => {
    await box.fill('');
    await box.pressSequentially('@');
    await expect(page.locator(`[data-tag-option="${LAPTOP_AGENT}"]`)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const far = page.locator(`[data-tag-option="${LAPTOP_AGENT}"]`);
  await expect(far).toContainText('Claude Code (Laptop)');
  await expect(far).toContainText('web · Laptop');
  await expect(page.locator(`[data-tag-option="${STUDIO_PI}"]`)).toContainText('Studio');
  await settled();
  await page.screenshot({ path: join(shots, '01-picker-two-computers.png') });

  // 2. Pick it and Send: Laptop's Inbox hands its agent the tagged wake for Studio's thread.
  await box.fill('');
  await box.pressSequentially('Give up after three. @');
  await expect(far).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('ArrowDown');
    if ((await page.locator('[data-tag-option][aria-selected="true"]').getAttribute('data-tag-option')) === LAPTOP_AGENT) break;
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-tag-picker]')).toHaveCount(0);
  await box.pressSequentially(' can you check the web side?');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await messagesOn(studio, thread)).filter((m) => m.author.kind === 'person').length, { timeout: 20_000 }).toBe(1);
  firstReply = (await messagesOn(studio, thread)).find((m) => m.author.kind === 'person')!.id;
  const wake = await farAgent.handed(firstReply);
  expect(wake.thread_id).toBe(thread);
  expect(wake.tagged).toBeTruthy();
  const words = inboxWakeText(wake);
  expect(words).toContain('The person tagged you in a Plannotator Inbox thread that another session owns.');
  expect(words).toContain(`Read it first with read_thread (message_id ${firstReply})`);
  expect(words).toContain(`send_message with reply_to ${firstReply}`);
  expect(wake.url).toContain(base(laptop).replace('http://127.0.0.1', ''));

  // 3. It reads the thread by the reply's id, and answers with reply_to: the answer is in Studio's thread.
  const got = laptopCall('read_thread', { message_id: firstReply });
  expect(got.status, got.err).toBe(0);
  expect(JSON.stringify(got.json)).toContain('Give up after three.');
  answer = 'The web side retries on its own; three is safe there.';
  const sent = laptopCall('send_message', { reply_to: firstReply, body: answer });
  expect(sent.status, sent.err).toBe(0);
  expect(sent.json!.machine).toMatchObject({ id: studio.id, name: 'Studio' });
  await expect.poll(async () => (await messagesOn(studio, thread)).find((m) => m.body === answer)?.author, { timeout: 20_000 }).toMatchObject({ kind: 'agent', session: LAPTOP_AGENT, machine: laptop.id, machine_name: 'Laptop' });
  // Nothing of it is a thread on Laptop.
  expect(JSON.stringify(await read<unknown>(laptop, '/api/inbox/threads'))).not.toContain(answer);
  await page.reload();
  const pane = page.locator('section.ib-pane');
  await expect(pane).toContainText(answer, { timeout: 20_000 });
  await expect(pane).toContainText('web · Laptop');
  await settled();
  await page.screenshot({ path: join(shots, '02-far-thread-answered.png') });
  expect(errors).toEqual([]);
});

test('4. Laptop stopped: the person’s reply to its agent waits, and wakes it when Laptop is back', async () => {
  test.setTimeout(240_000);
  await farAgent.stop();
  await stopScratchInbox(laptop.dataDir);
  await expect.poll(() => stateOf(studio, laptop), { timeout: 45_000 }).not.toBe('online');
  const answerId = (await messagesOn(studio, thread)).find((m) => m.body === answer)!.id;
  const { serverSession } = await read<{ serverSession: string }>(studio, '/api/inbox/health');
  const words = 'Thanks. Ship the three-retry change on the web side too.';
  const sent = await fetch(`${base(studio)}/api/inbox/messages/${answerId}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ words, idempotency_key: `r-${answerId}`, serverSession }) });
  expect(sent.status, await sent.clone().text()).toBe(200);
  const later = (await messagesOn(studio, thread)).find((m) => m.body === words)!.id;
  await start(laptop);
  await expect.poll(() => stateOf(studio, laptop), { timeout: 45_000 }).toBe('online');
  farAgent.start();
  const wake = await farAgent.handed(later);
  expect(wake.thread_id).toBe(thread);
  expect(inboxWakeText(wake)).toContain(words);
});

test('5. Studio stopped: the agent’s answer waits for it, and is in the thread when Studio is back', async () => {
  test.setTimeout(240_000);
  await stopScratchInbox(studio.dataDir);
  await expect.poll(() => stateOf(laptop, studio), { timeout: 45_000 }).not.toBe('online');
  const late = 'Shipped on the web side.';
  const sent = laptopCall('send_message', { reply_to: firstReply, body: late });
  expect(sent.status, sent.err).toBe(0);
  expect(sent.json!.held).toBe(true);
  expect(sent.out).not.toContain('"message_id"');
  await start(studio);
  await expect.poll(() => stateOf(laptop, studio), { timeout: 45_000 }).toBe('online');
  await expect.poll(async () => (await messagesOn(studio, thread)).find((m) => m.body === late)?.author.machine, { timeout: 60_000 }).toBe(laptop.id);
});

test('6. The phone’s width: the picker with both computers’ agents, and the far thread with its answer', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const small = await phone.newPage();
    small.on('pageerror', (error) => errors.push(error.message));
    const box = await openReply(small, thread);
    await expect(async () => {
      await box.fill('');
      await box.pressSequentially('@');
      await expect(small.locator(`[data-tag-option="${LAPTOP_AGENT}"]`)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(small.locator(`[data-tag-option="${LAPTOP_AGENT}"]`)).toContainText('Laptop');
    await small.screenshot({ path: join(shots, '03-phone-picker.png') });
    await small.keyboard.press('Escape');
    await box.fill('');
    await expect(small.locator('section.ib-pane')).toContainText(answer);
    await small.screenshot({ path: join(shots, '04-phone-thread.png') });
  } finally {
    await phone.close();
  }
  expect(errors).toEqual([]);
});
