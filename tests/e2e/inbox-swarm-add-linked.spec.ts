/**
 * Swarm's Add an agent and Remove for an agent on another computer (docs/agent-guides/inbox-swarm.md), in a real
 * browser against two compiled Inboxes on loopback, linked through the real CLI pairing (as
 * inbox-tag-across-computers.spec.ts). The swarm's thread is Studio's; Laptop runs the agents the person adds. Each
 * live agent is a connection that polls its own Inbox's bridge, as the Claude Code mod and Pi do.
 *
 *  1. Studio's thread, the status view's Add an agent: Laptop's Pi is listed with its computer; a pick shows it "not
 *     joined yet" on Laptop, and Laptop's Inbox wakes it once, with the join line for this thread. It joins from
 *     Laptop (what `plannotator inbox swarm join` sends there) and the status view shows it joined.
 *  2. Remove on its row: gone from the status view and from the ghost box's "to" list; "to everyone" leaves it out.
 *     The toast's Undo brings it back.
 *  3. Laptop stopped: Add an agent still offers Laptop's Codex; the pick shows it not joined yet and nothing is
 *     delivered; Laptop back, Codex is woken once.
 *
 * Pictures (1440×900, light) land in PLANNOTATOR_E2E_PROOF_DIR/swarm-add-linked/ (else .local/proof/swarm-add-linked/;
 * CI keeps .local/proof/ as the shard's artifact). Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { INBOX_BRIDGE_POLL_PATH, INBOX_TAGS_POLL_FIELD, type InboxReplyCommand } from '../../packages/shared/inbox/connection';
import { swarmJoinLine } from '../../packages/core/swarm-skill';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'swarm-add-linked');
const CLOSED = 'http://127.0.0.1:9';
/** Studio's Claude Code (the thread is to it), and Laptop's Pi and Codex. */
const CLAUDE = { host: 'claude-code', session: '5b2e8c1d-3f4a-4b60-9c71-a2b3c4d5e6f7' };
const FAR_PI = { host: 'pi', session: '8c3f9d2e-4a5b-4c60-8d71-b2c3d4e5f6a7' };
const FAR_CODEX = { host: 'codex', session: '9d4a0e3f-5b6c-4d60-9e71-c2d3e4f5a6b7' };

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
  const root = inboxScratch(`plannotator-swarm-add-linked-${name.toLowerCase()}-`);
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
      PLANNOTATOR_EXPERIMENTAL: 'swarm',
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
const registry = (m: Machine) => JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
const base = (m: Machine) => `http://127.0.0.1:${registry(m).port}`;
const read = async <T>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;
const stateOf = async (viewer: Machine, other: Machine) => (await read<{ machines: { id: string; state: string }[] }>(viewer, '/api/inbox/machines')).machines.find((x) => x.id === other.id)?.state;
const marksOf = async (viewer: Machine, other: Machine) => (await read<{ machines: { id: string; marks?: string[] }[] }>(viewer, '/api/inbox/machines')).machines.find((x) => x.id === other.id)?.marks ?? [];
type Member = { session: string; joined: boolean; machine_name?: string | null };
const membersOn = async (m: Machine, thread: string) => (await read<{ swarm: { members: Member[] } | null }>(m, `/api/inbox/threads/${thread}/swarm`)).swarm?.members ?? [];
const lastMessageOn = async (m: Machine, thread: string) => (await read<{ thread: { messages: { id: string; author: { kind: string } }[] } }>(m, `/api/inbox/threads/${thread}`)).thread.messages.at(-1)!;

/** What `plannotator inbox swarm` sends on `m`, as `by`. */
async function swarmAsk(m: Machine, by: { host: string; session: string }, ask: Record<string, unknown>): Promise<{ status: number; json: { text?: string; code?: string } }> {
  const response = await fetch(`${base(m)}/api/inbox/swarm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...ask, by }) });
  return { status: response.status, json: (await response.json()) as { text?: string; code?: string } };
}

async function start(m: Machine): Promise<void> {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

/**
 * A live agent's connection on `m`: it polls its own Inbox's bridge with tags on, counts every command it is handed
 * (one handed again is a second wake), and says each was delivered, as the mod does.
 */
class Poller {
  readonly commands: InboxReplyCommand[] = [];
  readonly handed = new Map<string, number>();
  private stopped = true;
  private loop: Promise<void> = Promise.resolve();
  constructor(
    readonly m: Machine,
    readonly agent: { host: string; session: string },
    readonly project: string,
    private readonly busy = false,
  ) {
    pollers.push(this);
  }
  private async bridge(path: string, body: Record<string, unknown>): Promise<Response> {
    const { port, token } = registry(this.m);
    return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  }
  start(): void {
    this.stopped = false;
    const since = Date.now();
    this.loop = (async () => {
      while (!this.stopped) {
        try {
          const answer = await this.bridge(INBOX_BRIDGE_POLL_PATH, { ...this.agent, waitMs: 2_000, [INBOX_TAGS_POLL_FIELD]: true, project_path: this.project, started_at: since, busy: this.busy, idle_since: this.busy ? null : since });
          const { commands = [] } = answer.ok ? ((await answer.json()) as { commands?: InboxReplyCommand[] }) : {};
          for (const command of commands) {
            this.handed.set(command.id, (this.handed.get(command.id) ?? 0) + 1);
            if (!this.commands.some((c) => c.id === command.id)) this.commands.push(command);
            await this.bridge('/api/inbox/bridge/event', { ...this.agent, type: 'delivered', id: command.id });
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
  /** The command it was handed for the person's message `id`, once it is. */
  async wake(id: string): Promise<InboxReplyCommand> {
    await expect.poll(() => this.commands.some((c) => c.id === id), { timeout: 60_000 }).toBe(true);
    return this.commands.find((c) => c.id === id)!;
  }
}

const settled = () => page.evaluate(() => Promise.all(document.getAnimations().filter((motion) => motion.effect?.getTiming().iterations !== Infinity).map((motion) => motion.finished.catch(() => {}))));

/** Studio's thread, its status view open. */
async function openStatus(threadId: string): Promise<void> {
  await page.goto(`${studio.url}#thread=${threadId}`);
  const summary = page.locator('[data-swarm-summary]');
  await expect(summary).toBeVisible({ timeout: 20_000 });
  // The same address again is a same-page jump: a view left open stays open, and a press on its toggle would close it.
  const status = page.locator('[data-swarm-status]');
  if (!(await status.isVisible())) await summary.locator('[data-swarm-toggle]').click();
  await expect(status).toBeVisible();
}

/** Add an agent, and the pick of `session` from its list. */
async function addAgent(session: string, computer: string): Promise<void> {
  await page.locator('[data-swarm-status] [data-swarm-add]').click();
  const row = page.locator(`[data-swarm-add-list] [data-swarm-add-row="${session}"]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(computer);
  await row.locator('button').first().click();
  await expect(page.locator('[data-swarm-add-list]')).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

let thread = '';
let farPi: Poller;
let farCodex: Poller;

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
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));

  // Studio: the project, known to its Inbox, and its live Claude Code; Laptop: Pi and Codex, live in "ledger".
  const sim = await SimAgent.connect({ binary, env: studio.env, name: 'Claude Code', host: 'claude-code', cwd: studio.root });
  agents.push(sim);
  const harbor = scratchProject(join(studio.root, 'code'), 'harbor');
  await sim.send({ project_path: harbor, subject: 'Berth pricing', body: 'Pricing per berth is still a flat rate.' });
  new Poller(studio, CLAUDE, harbor, true).start();
  const ledger = scratchProject(join(laptop.root, 'code'), 'ledger');
  farPi = new Poller(laptop, FAR_PI, ledger);
  farCodex = new Poller(laptop, FAR_CODEX, ledger);
  farPi.start();
  farCodex.start();

  // The person's New message to Claude Code with Swarm pressed: the swarm's thread, on Studio.
  await page.goto(studio.url);
  await page.locator('.ib-side [data-open-compose]').first().click();
  const dialog = page.locator('dialog[data-compose]');
  const to = dialog.locator('.ib-cp-tobtn').first();
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 20_000 });
  await to.click();
  await dialog.locator(`[data-compose-session="${CLAUDE.session}"]`).click();
  await expect(to).toHaveAttribute('data-compose-to', CLAUDE.session);
  const words = "Price each berth by length for Charlie Dunn's marina.";
  await dialog.getByRole('textbox', { name: 'Message' }).fill(words);
  await dialog.locator('[data-swarm-badge]').click();
  await expect(dialog.locator('[data-swarm-badge]')).toHaveAttribute('aria-pressed', 'true');
  await dialog.locator('[data-compose-send]').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect
    .poll(
      async () => {
        const list = await read<{ sections: { threads: { thread_id: string; subject: string | null }[] }[] }>(studio, '/api/inbox/threads');
        thread = list.sections.flatMap((s) => s.threads).find((t) => (t.subject ?? '').startsWith(words.slice(0, 24)))?.thread_id ?? '';
        return thread;
      },
      { timeout: 20_000 },
    )
    .not.toBe('');
  expect((await swarmAsk(studio, CLAUDE, { action: 'join', thread })).status).toBe(200);
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

test('1. Add an agent on Laptop: listed with its computer, not joined yet, woken there once with the join line; it joins from Laptop', async () => {
  test.setTimeout(240_000);
  await openStatus(thread);
  await addAgent(FAR_PI.session, 'Laptop');
  const row = page.locator(`[data-swarm-member="${FAR_PI.session}"]`);
  await expect(row.locator('[data-swarm-state]')).toHaveText('not joined yet');
  await expect(row.locator('.ib-swarm-wh')).toContainText('Laptop');
  await expect(row.locator('.ib-swarm-wh')).not.toContainText('Studio');
  // The thread says it went to Pi alone.
  const added = await lastMessageOn(studio, thread);
  expect(added.author.kind).toBe('person');
  const article = page.locator(`[data-message-article="${added.id}"]`);
  await expect(article.locator('.ib-to')).toContainText('to Pi');
  await expect(article.locator('[data-tagged-names]')).toHaveCount(0);
  await settled();
  await page.screenshot({ path: join(shots, '01-added-not-joined.png') });

  // Laptop's Inbox wakes it, once, with the join line for this thread.
  const wake = await farPi.wake(added.id);
  expect(wake.thread_id).toBe(thread);
  expect(wake.body).toContain(swarmJoinLine(thread));
  await expect.poll(async () => (await read<{ thread: { messages: { id: string; tags?: { session: string; delivery?: unknown }[] }[] } }>(studio, `/api/inbox/threads/${thread}`)).thread.messages.find((m) => m.id === added.id)?.tags?.find((t) => t.session === FAR_PI.session)?.delivery ?? null, { timeout: 30_000 }).not.toBeNull();
  await page.waitForTimeout(3_000);
  expect(farPi.handed.get(added.id)).toBe(1);

  // It joins from Laptop, as `plannotator inbox swarm join` there sends it.
  const joined = await swarmAsk(laptop, FAR_PI, { action: 'join', thread });
  expect(joined.status, JSON.stringify(joined.json)).toBe(200);
  await expect.poll(async () => (await membersOn(studio, thread)).find((m) => m.session === FAR_PI.session)?.joined, { timeout: 20_000 }).toBe(true);
  await openStatus(thread);
  await expect(page.locator(`[data-swarm-member="${FAR_PI.session}"]`)).not.toHaveAttribute('data-state', 'not_joined');
  await expect(page.locator(`[data-swarm-member="${FAR_PI.session}"] [data-swarm-state]`)).not.toHaveText('not joined yet');
  expect(errors).toEqual([]);
});

test('2. Remove: gone from the status view and the ghost box\'s "to"; "to everyone" leaves it out; Undo brings it back', async () => {
  test.setTimeout(180_000);
  await openStatus(thread);
  const row = page.locator(`[data-swarm-member="${FAR_PI.session}"]`);
  await row.hover();
  await page.locator(`[data-swarm-remove="${FAR_PI.session}"]`).click();
  const toast = page.locator('[data-inbox-toast]');
  await expect(toast).toContainText('Removed');
  await expect(page.locator(`[data-swarm-member="${FAR_PI.session}"]`)).toHaveCount(0);
  await expect.poll(async () => (await membersOn(studio, thread)).map((m) => m.session)).not.toContain(FAR_PI.session);
  await settled();
  await page.screenshot({ path: join(shots, '02-removed-toast-undo.png') });

  // Undo, from the toast: back in the status view, joined.
  await toast.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(async () => (await membersOn(studio, thread)).find((m) => m.session === FAR_PI.session)?.joined, { timeout: 20_000 }).toBe(true);

  // Removed again, the ghost box: no Pi to pick, and "to everyone" goes to Studio's agent alone.
  await openStatus(thread);
  await page.locator(`[data-swarm-member="${FAR_PI.session}"]`).hover();
  await page.locator(`[data-swarm-remove="${FAR_PI.session}"]`).click();
  await expect(page.locator(`[data-swarm-member="${FAR_PI.session}"]`)).toHaveCount(0);
  await page.goto(`${studio.url}#thread=${thread}`);
  const ghost = page.locator('[data-ghost-button]');
  await expect(ghost).toBeVisible({ timeout: 20_000 });
  await ghost.click();
  const pane = page.locator('[data-ghost-pane]');
  await expect(pane).toBeVisible();
  await pane.locator('[data-ghost-to]').click();
  await expect(pane.locator('[data-ghost-to-list]')).toBeVisible();
  await expect(pane.locator('[data-ghost-to-row="Pi"]')).toHaveCount(0);
  await pane.locator('[data-ghost-to-row=""] button').first().click();
  await expect(pane.locator('[data-ghost-to]')).toContainText('everyone');
  await pane.locator('[data-ghost-input]').fill('Keep every price in cents.');
  await pane.locator('[data-ghost-send]').click();
  await expect
    .poll(async () => {
      const said = (await read<{ ghost: { body: string; tags?: { session: string }[] }[] }>(studio, `/api/inbox/threads/${thread}/swarm`)).ghost.find((m) => m.body.includes('Keep every price in cents.'));
      return said ? (said.tags ?? []).map((t) => t.session) : null;
    })
    .toEqual([CLAUDE.session]);

  // Put back for the rest (main's Undo, as the toast sends it).
  const { serverSession } = await read<{ serverSession: string }>(studio, '/api/inbox/health');
  const undo = await fetch(`${base(studio)}/api/inbox/threads/${thread}/remove-agent/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base(studio) }, body: JSON.stringify({ session: FAR_PI.session, serverSession }) });
  expect(undo.status, await undo.clone().text()).toBe(200);
  await expect.poll(async () => (await membersOn(studio, thread)).some((m) => m.session === FAR_PI.session)).toBe(true);
  expect(errors).toEqual([]);
});

test('3. Laptop stopped: Add an agent still offers its Codex, the add waits; Laptop back, Codex is woken once', async () => {
  test.setTimeout(240_000);
  await farPi.stop();
  await farCodex.stop();
  await stopScratchInbox(laptop.dataDir);
  await expect.poll(() => stateOf(studio, laptop), { timeout: 45_000 }).not.toBe('online');

  await openStatus(thread);
  await addAgent(FAR_CODEX.session, 'Laptop');
  await expect(page.locator(`[data-swarm-member="${FAR_CODEX.session}"] [data-swarm-state]`)).toHaveText('not joined yet');
  const added = await lastMessageOn(studio, thread);
  expect(added.author.kind).toBe('person');
  // Nothing delivered while Laptop sleeps.
  await page.waitForTimeout(3_000);
  const tagOf = async () => (await read<{ thread: { messages: { id: string; tags?: { session: string; delivery?: unknown }[] }[] } }>(studio, `/api/inbox/threads/${thread}`)).thread.messages.find((m) => m.id === added.id)?.tags?.find((t) => t.session === FAR_CODEX.session);
  expect((await tagOf())?.delivery ?? null).toBeNull();
  await settled();
  await page.screenshot({ path: join(shots, '03-added-while-laptop-asleep.png') });

  await start(laptop);
  await expect.poll(() => stateOf(studio, laptop), { timeout: 45_000 }).toBe('online');
  farCodex.start();
  const wake = await farCodex.wake(added.id);
  expect(wake.body).toContain(swarmJoinLine(thread));
  await expect.poll(async () => (await tagOf())?.delivery ?? null, { timeout: 45_000 }).not.toBeNull();
  await page.waitForTimeout(3_000);
  expect(farCodex.handed.get(added.id)).toBe(1);
  expect(errors).toEqual([]);
});
