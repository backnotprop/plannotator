/**
 * Swarm, piece 1 (docs/agent-guides/inbox-swarm.md; approval "inbox-swarm-thread-ui"), in a real browser against the
 * compiled binary. Nothing is mocked: `plannotator inbox --background` under a temp data dir and a scratch HOME, Swarm
 * on by `PLANNOTATOR_EXPERIMENTAL=swarm`, and two live agent sessions in one project (the bridge's long-poll, as the
 * mod, Pi and OpenCode run it): Claude Code working, Codex idle.
 *
 *  1. New message: Claude Code in To, Add an agent and Codex beside it, the Swarm badge pressed (`/swarm` in the
 *     words). Send: one thread, its root to Claude Code and tagging Codex, and a swarm.
 *  2. The agents join, say what they are doing and talk in the ghost thread through `POST /api/inbox/swarm` (what
 *     `plannotator inbox swarm` sends). The thread: the summary row in place of "N sessions" and the Ghost button
 *     first in the bar with the count of their words; the status view with each state and each doing line.
 *  3. The Ghost button: the pane beside the thread (the thread still in view), each message "X to Y", the count gone;
 *     the person writes to everyone from its box, and the ghost thread holds the words. Closed again, an agent's new
 *     words reach the open thread by the stream (a `swarm` event) and the count comes back.
 *  4. A second swarm thread nobody has talked in yet: the empty ghost pane.
 *  5. A phone (390 × 844): the thread, and the ghost pane as its own page whose "‹ <thread title>" goes back.
 *
 * Proof, light and dark, in PLANNOTATOR_E2E_PROOF_DIR/swarm-piece-1/ (else .local/proof/swarm-piece-1/; CI keeps
 * .local/proof/ as the shard's artifact). Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'swarm-piece-1');

const CLAUDE = { host: 'claude-code', session: 'ses-claude' };
const CODEX = { host: 'codex', session: 'ses-codex' };

interface World {
  root: string;
  dataDir: string;
  url: string;
  project: string;
  agent: SimAgent;
  polls: Poll[];
}
let world: World;
/** The swarm thread test 1 starts, and the second one test 4 starts. */
let threadId = '';
let quietId = '';

const door = () => JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
const read = async <T,>(path: string): Promise<T> => (await (await fetch(new URL(path, world.url))).json()) as T;

/** What `plannotator inbox swarm` sends: the agent's ask, as that session. */
async function swarmAsk(by: { host: string; session: string }, ask: Record<string, unknown>): Promise<{ text?: string; code?: string }> {
  const response = await fetch(new URL('/api/inbox/swarm', world.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...ask, by }) });
  const json = (await response.json()) as { text?: string; code?: string };
  expect(response.status, JSON.stringify(json)).toBe(200);
  return json;
}

/** One live session: the bridge's long-poll. `busy`: a turn runs. */
class Poll {
  private stopped = false;
  private readonly loop: Promise<void>;
  constructor(
    readonly session: string,
    readonly host: string,
    private readonly busy: boolean,
    private readonly startedAt: number,
  ) {
    this.loop = this.run();
  }
  private async run(): Promise<void> {
    while (!this.stopped) {
      const { port, token } = door();
      const response = await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session: this.session, host: this.host, waitMs: 1_000, project_path: world.project, started_at: this.startedAt, busy: this.busy, idle_since: this.busy ? null : this.startedAt }),
      }).catch(() => null);
      await response?.text().catch(() => '');
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-swarm-piece-1-e2e-');
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, '.claude'),
    CODEX_HOME: join(root, '.codex'),
    XDG_CONFIG_HOME: join(root, '.config'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_EXPERIMENTAL: 'swarm',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const project = scratchProject(join(root, 'code'), 'ledger');
  // The project the sessions work in, known to the Inbox.
  await agent.send({ project_path: project, subject: 'Nightly export is slow', body: 'The export spends most of its time in one query.' });
  world = { root, dataDir, url: started.stdout.trim(), project, agent, polls: [] };
  const now = Date.now();
  world.polls.push(new Poll(CLAUDE.session, CLAUDE.host, true, now - 30 * 60_000), new Poll(CODEX.session, CODEX.host, false, now - 20 * 60_000));
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.polls.map((poll) => poll.stop()));
    await world.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

async function openWindow(page: Page, width: number, height: number, hash = ''): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(`${world.url}${hash}`);
}

/** New message to Claude Code and Codex with Swarm pressed; `proof`: the shot before Send. Answers the new thread's id. */
async function startSwarm(page: Page, words: string, proof?: string): Promise<string> {
  await page.locator('.ib-side [data-open-compose]').first().click();
  const dialog = page.locator('dialog[data-compose]');
  const to = dialog.locator('.ib-cp-tobtn').first();
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 20_000 });
  await to.click();
  await dialog.locator(`[data-compose-session="${CLAUDE.session}"]`).click();
  await expect(to).toHaveAttribute('data-compose-to', CLAUDE.session);
  await dialog.locator('[data-compose-add-agent]').click();
  await dialog.locator(`[data-compose-session="${CODEX.session}"]`).click();
  await expect(dialog.locator(`[data-compose-also="${CODEX.session}"]`)).toBeVisible();
  const field = dialog.getByRole('textbox', { name: 'Message' });
  await field.fill(words);
  const badge = dialog.locator('[data-swarm-badge]');
  await badge.click();
  await expect(badge).toHaveAttribute('aria-pressed', 'true');
  await expect(field).toHaveValue(/\/swarm/);
  if (proof) await shot(page, proof);
  await dialog.locator('[data-compose-send]').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  let id = '';
  await expect
    .poll(
      async () => {
        const list = await read<{ sections: { threads: { thread_id: string; subject: string | null }[] }[] }>('/api/inbox/threads');
        id = list.sections.flatMap((s) => s.threads).find((t) => (t.subject ?? '').startsWith(words.slice(0, 24)))?.thread_id ?? '';
        return id;
      },
      { timeout: 20_000 },
    )
    .not.toBe('');
  return id;
}

test('New message to two agents with Swarm on makes one swarm thread, its root to the first and tagging the other', async ({ page }) => {
  await openWindow(page, 1440, 900);
  threadId = await startSwarm(page, "Refunds are off by a cent after Ada Novak's rounding change. Split it between you: the rounding, and the refunds that went out wrong.", '01-new-message-two-agents');
  const thread = await read<{ thread: { swarm?: { on: boolean }; messages: { to?: { session: string }; tags?: { session: string }[] }[] } }>(`/api/inbox/threads/${threadId}`);
  expect(thread.thread.swarm?.on).toBe(true);
  const sent = thread.thread.messages[0]!;
  expect(sent.to?.session).toBe(CLAUDE.session);
  expect(sent.tags?.map((t) => t.session)).toEqual([CODEX.session]);
});

test('the agents join, say what they do and talk; the thread shows the summary row, the Ghost button with their count, and the status view', async ({ page }) => {
  await swarmAsk(CLAUDE, { action: 'join', thread: threadId });
  await swarmAsk(CODEX, { action: 'join', thread: threadId });
  await swarmAsk(CLAUDE, { action: 'doing', thread: threadId, text: 'Rewriting the rounding in refunds.ts' });
  await swarmAsk(CODEX, { action: 'doing', thread: threadId, text: 'Finding the refunds that went out short' });
  await swarmAsk(CLAUDE, { action: 'say', thread: threadId, text: 'I take the rounding. Tell me which refunds you find.', to: 'Codex' });
  await swarmAsk(CODEX, { action: 'say', thread: threadId, text: 'Found 14 so far, all after Tuesday.', to: 'Claude Code' });

  await openWindow(page, 1440, 900, `#thread=${threadId}`);
  const summary = page.locator('[data-swarm-summary]');
  await expect(summary).toBeVisible({ timeout: 20_000 });
  await expect(summary.locator('.ib-swarm-sum')).toHaveText('2 agents · 1 working');
  const ghost = page.locator('[data-ghost-button]');
  await expect(ghost.locator('[data-ghost-unread]')).toHaveText('2');
  await expect(ghost).toHaveAttribute('aria-label', 'Ghost thread · 2 new');
  // First in the bar: no other button sits between the title and it.
  const first = await page.evaluate(() => {
    const head = document.querySelector('section.ib-pane .ib-phead')!;
    const title = head.querySelector('h2')!;
    const after = [...head.querySelectorAll('.ib-iconbtn')].filter((b) => title.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return after[0]?.hasAttribute('data-ghost-button') ?? false;
  });
  expect(first).toBe(true);
  await shot(page, '02-thread-summary-and-ghost-button');

  await summary.locator('[data-swarm-toggle]').click();
  const claude = page.locator(`[data-swarm-member="${CLAUDE.session}"]`);
  const codex = page.locator(`[data-swarm-member="${CODEX.session}"]`);
  await expect(claude.locator('[data-swarm-state]')).toHaveText('working');
  await expect(claude.locator('[data-swarm-doing]')).toContainText('Rewriting the rounding in refunds.ts');
  await expect(codex.locator('[data-swarm-state]')).toHaveText('idle');
  await expect(codex.locator('[data-swarm-doing]')).toContainText('Finding the refunds that went out short');
  await expect(page.locator('[data-swarm-status] [data-swarm-ghost]')).toContainText('2');
  await shot(page, '03-status-view');
});

test('the ghost pane opens beside the thread with the agents\' words; the person writes to everyone from it', async ({ page }) => {
  await openWindow(page, 1440, 900, `#thread=${threadId}`);
  const ghost = page.locator('[data-ghost-button]');
  await expect(ghost).toBeVisible({ timeout: 20_000 });
  await ghost.click();
  const pane = page.locator('[data-ghost-pane]');
  await expect(pane).toBeVisible();
  await expect(ghost).toHaveAttribute('aria-pressed', 'true');
  await expect(ghost.locator('[data-ghost-unread]')).toHaveCount(0);
  // Beside the thread, not over it.
  await expect(pane).not.toHaveClass(/ib-full/);
  const beside = await page.evaluate(() => {
    const thread = document.querySelector('section.ib-pane')!.getBoundingClientRect();
    const ghostPane = document.querySelector('[data-ghost-pane]')!.getBoundingClientRect();
    return { right: ghostPane.left >= thread.right - 1, threadShown: thread.width > 300 };
  });
  expect(beside).toEqual({ right: true, threadShown: true });
  const lines = pane.locator('[data-ghost-message] .ib-ghost-line');
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText('Claude Code');
  await expect(lines.nth(0)).toContainText('to Codex');
  await expect(lines.nth(1)).toContainText('Codex');
  await expect(lines.nth(1)).toContainText('to Claude Code');
  // Looked at: the count is none on the next read too.
  await expect.poll(async () => (await read<{ swarm: { ghost_unread?: number } }>(`/api/inbox/threads/${threadId}/swarm`)).swarm.ghost_unread ?? 0).toBe(0);

  await expect(pane.locator('[data-ghost-to]')).toContainText('everyone');
  await pane.locator('[data-ghost-input]').fill('Keep every amount in cents, and list the refunds in the thread when you are done.');
  await pane.locator('[data-ghost-send]').click();
  await expect(pane.locator('[data-ghost-message]')).toHaveCount(3);
  await expect(pane.locator('[data-ghost-message]').last().locator('.ib-ghost-line')).toContainText('You');
  await expect(pane.locator('[data-ghost-message]').last().locator('.ib-ghost-line')).toContainText('to everyone');
  const after = await read<{ ghost: { author: { kind: string }; body: string; tags?: { session: string }[] }[] }>(`/api/inbox/threads/${threadId}/swarm`);
  const said = after.ghost.at(-1)!;
  expect(said.author.kind).toBe('person');
  expect(said.body).toContain('Keep every amount in cents');
  expect((said.tags ?? []).map((t) => t.session).sort()).toEqual([CLAUDE.session, CODEX.session].sort());
  await shot(page, '04-ghost-pane-beside-thread');

  // The stream: with the pane closed, an agent's new words reach the open thread as a swarm event, and the count comes back.
  await pane.locator('[data-ghost-close]').click();
  await expect(pane).toHaveCount(0);
  await swarmAsk(CODEX, { action: 'say', thread: threadId, text: 'All 14 are listed in refunds-short.csv.', to: 'Claude Code' });
  await expect(ghost.locator('[data-ghost-unread]')).toHaveText('1', { timeout: 20_000 });
});

test('a swarm nobody has talked in yet: the empty ghost pane', async ({ page }) => {
  await openWindow(page, 1440, 900);
  quietId = await startSwarm(page, 'Read the export query plan and say where the time goes.');
  await page.goto(`${world.url}#thread=${quietId}`);
  const ghost = page.locator('[data-ghost-button]');
  await expect(ghost).toBeVisible({ timeout: 20_000 });
  await expect(ghost.locator('[data-ghost-unread]')).toHaveCount(0);
  await ghost.click();
  const empty = page.locator('[data-ghost-pane] [data-ghost-empty]');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('No ghost messages yet');
  await expect(empty).toContainText('When the agents talk to each other, it shows up here.');
  await shot(page, '05-ghost-pane-empty');
});

test('a phone: the swarm thread, then the ghost pane as its own page whose way back names the thread', async ({ page }) => {
  await openWindow(page, 390, 844, `#thread=${threadId}`);
  const summary = page.locator('[data-swarm-summary]');
  await expect(summary).toBeVisible({ timeout: 20_000 });
  await expect(summary).toHaveAttribute('data-phone', '');
  const ghost = page.locator('[data-ghost-button]');
  await expect(ghost).toBeVisible();
  const inside = await page.evaluate(() => [...document.querySelectorAll('[data-swarm-summary], [data-ghost-button]')].every((el) => el.getBoundingClientRect().right <= window.innerWidth));
  expect(inside).toBe(true);
  await shot(page, '06-phone-thread');

  await ghost.click();
  const pane = page.locator('[data-ghost-pane]');
  await expect(pane).toBeVisible();
  await expect(pane).toHaveClass(/ib-full/);
  const back = pane.locator('[data-ghost-back]');
  await expect(back).toContainText('Refunds are off by a cent');
  const fits = await page.evaluate(() => {
    const box = document.querySelector('[data-ghost-pane]')!.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth + 0.5;
  });
  expect(fits).toBe(true);
  await shot(page, '07-phone-ghost-page');
  await back.click();
  await expect(pane).toHaveCount(0);
  await expect(summary).toBeVisible();
});
