/**
 * Swarm, piece 1 (docs/agent-guides/inbox-swarm.md; approval "inbox-swarm-thread-ui"), in a real browser against the
 * compiled binary. Nothing is mocked: `plannotator inbox --background` under a temp data dir and a scratch HOME, and
 * two live agent sessions in one project (the bridge's long-poll, as the mod, Pi and OpenCode run it): Claude Code
 * working, Codex idle.
 *
 *  0. Swarm is off: the route refuses. Settings → Capabilities → Experimental: the Swarm row's switch turns it on,
 *     saved in config.json as `experimental.swarm`.
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
 *  6. The plan (`swarm propose`, what `plannotator inbox swarm propose` sends): in the quiet thread, Claude Code's
 *     proposal is its first reply, drawn as the plan card, Codex "joining"; Codex joins and adds its lines, and the
 *     same card changes in place, by the stream. A team of 20 in the first thread folds to six rows. The phone card.
 *  7. A phone's New message with a second agent, the badge and the saved check in its one row: Send stays on screen.
 *
 * Proof, light and dark, in PLANNOTATOR_E2E_PROOF_DIR/swarm-piece-1/ (else .local/proof/swarm-piece-1/; CI keeps
 * .local/proof/ as the shard's artifact). Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH, INBOX_TAGS_POLL_FIELD } from '../../packages/shared/inbox/connection';
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

/**
 * One live session: the bridge's long-poll, as a current connection sends it (the mod, agent-link): it says it
 * understands tags, so it can be tagged. `busy`: a turn runs.
 */
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
        body: JSON.stringify({ session: this.session, host: this.host, waitMs: 1_000, [INBOX_TAGS_POLL_FIELD]: true, project_path: world.project, started_at: this.startedAt, busy: this.busy, idle_since: this.busy ? null : this.startedAt }),
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

/** Every ghost on screen, as drawn: its box (square, as its 24 × 24 drawing is) and how its mask fits the box. */
async function ghostBoxes(page: Page): Promise<{ w: number; h: number; size: string; position: string }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.ib-ghost-g')].map((el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10, size: style.getPropertyValue('mask-size') || style.getPropertyValue('-webkit-mask-size'), position: style.getPropertyValue('mask-position') || style.getPropertyValue('-webkit-mask-position') };
    }),
  );
}

/** Never stretched: each ghost's box is square and its drawing fits it whole, centred. */
async function expectGhostsUnstretched(page: Page, count: number): Promise<void> {
  const boxes = await ghostBoxes(page);
  expect(boxes).toHaveLength(count);
  for (const box of boxes) {
    expect({ square: box.w === box.h, size: box.size, centred: /^(50% 50%|center( center)?)$/.test(box.position) }, JSON.stringify(box)).toEqual({ square: true, size: 'contain', centred: true });
  }
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
    PLANNOTATOR_UPDATE_CHECK: '0',
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_PHONES: '0',
    // The computer's name the status view shows beside each member's project (else the runner's host name).
    PLANNOTATOR_MACHINE_NAME: 'Studio',
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

/** config.json's `experimental`, once it is written (a read between the switch and the save sees none yet). */
const savedExperimental = () => {
  try {
    return (JSON.parse(readFileSync(join(world.dataDir, 'config.json'), 'utf8')) as { experimental?: unknown }).experimental;
  } catch {
    return undefined;
  }
};

test('off by default; Settings → Capabilities → Experimental has the Swarm row, and its switch turns Swarm on', async ({ page }) => {
  // Off: the route an agent's `plannotator inbox swarm` asks refuses.
  const off = await fetch(new URL('/api/inbox/swarm', world.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status', by: CLAUDE }) });
  expect([off.status, ((await off.json()) as { code?: string }).code]).toEqual([409, 'swarm_off']);

  await openWindow(page, 1440, 900, '#settings/capabilities');
  const row = page.locator('[data-settings-experimental] [data-settings-swarm]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator('.ib-l')).toHaveText('Swarm');
  await expect(row.locator('.ib-desc')).toHaveText('Several agents work one thread as a team, and talk to each other in its ghost thread.');
  const sw = row.getByRole('switch', { name: 'Swarm' });
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect.poll(savedExperimental).toEqual({ swarm: true });
  // On at once, for agents too.
  await expect.poll(async () => (await read<{ experimental?: { swarm?: { on: boolean } } }>('/api/inbox/settings')).experimental?.swarm?.on).toBe(true);
  await row.scrollIntoViewIfNeeded();
  await shot(page, '11-settings-swarm-on');
});

test('New message to two agents with Swarm on makes one swarm thread, its root to the first and tagging the other', async ({ page }) => {
  await openWindow(page, 1440, 900);
  threadId = await startSwarm(page, "Refunds are off by a cent after Bob Tully's rounding change. Split it between you: the rounding, and the refunds that went out wrong.", '01-new-message-two-agents');
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
  // The view is drawn over the message under it, not under its words: what is at each row's name and doing line is the view's.
  const covered = await page.evaluate(() =>
    [...document.querySelectorAll('[data-swarm-member] .ib-swarm-nm, [data-swarm-member] [data-swarm-doing]')].map((el) => {
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + Math.min(box.width / 2, 40), box.top + box.height / 2);
      return !!top?.closest('[data-swarm-status]');
    }),
  );
  expect(covered).toEqual([true, true, true, true]);
  await expect(claude.locator('.ib-swarm-wh')).toHaveText('ledger · Studio');
  // The Ghost button's and the status view's foot's.
  await expectGhostsUnstretched(page, 2);
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
  // The Ghost button's, the pane's header's and the empty state's.
  await expectGhostsUnstretched(page, 3);
  // The shot once New message's "Sent to" toast has gone by itself (it sits over the pane's Send while it is up).
  await expect(page.locator('.ib-toast')).toHaveCount(0, { timeout: 20_000 });
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
  // The way back names the thread as its bar does: its name (compose's suggestion, kept as the thread's name), else its subject.
  const named = (await read<{ thread: { thread_name?: string | null; subject: string | null } }>(`/api/inbox/threads/${threadId}`)).thread;
  const back = pane.locator('[data-ghost-back]');
  await expect(back).toContainText((named.thread_name || named.subject)!);
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

type ThreadRead = { thread: { messages: { id: string; swarm_plan?: true; reply_to: string | null; author: { kind: string; session?: string | null }; body: string }[]; swarm?: { plan?: { message_id: string; parts: { who: string }[] } } } };
const partOf = (page: Page, who: string) => page.locator(`[data-swarm-plan] [data-swarm-plan-part="${who}"]`);

/** The card's whole window, scrolled to it. */
async function cardShot(page: Page, name: string): Promise<void> {
  await page.locator('[data-swarm-plan]').scrollIntoViewIfNeeded();
  await shot(page, name);
}

test("the plan: Claude Code's proposal is its first reply in the thread, drawn as the plan card while Codex is still joining", async ({ page }) => {
  await swarmAsk(CLAUDE, { action: 'join', thread: quietId });
  const proposed = await swarmAsk(CLAUDE, {
    action: 'propose',
    thread: quietId,
    text: [
      'Two parts: Claude Code reads the query plan, Codex times the export end to end. Work has started.',
      '- Claude Code: Read the export query plan and find the step that takes the time',
      '  - Explorer: List the indexes the export query can use',
      "- Codex: Time each step of the nightly export on a copy of last night's data",
    ].join('\n'),
  });
  expect(proposed.text).toContain('as your reply, 3 lines');
  const read1 = await read<ThreadRead>(`/api/inbox/threads/${quietId}`);
  const card = read1.thread.messages.filter((m) => m.swarm_plan);
  // One message, Claude Code's reply to the person, its words the plan for any reader that does not draw the card.
  expect(card).toHaveLength(1);
  expect([card[0]!.author.session, card[0]!.reply_to, read1.thread.messages.indexOf(card[0]!)]).toEqual([CLAUDE.session, quietId, 1]);
  expect(card[0]!.body).toContain('- Codex: Time each step');
  expect(read1.thread.swarm?.plan?.message_id).toBe(card[0]!.id);

  await openWindow(page, 1440, 900, `#thread=${quietId}`);
  const drawn = page.locator(`[data-message-article="${card[0]!.id}"] [data-swarm-plan]`);
  await expect(drawn).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-swarm-plan]')).toHaveCount(1);
  await expect(drawn.locator('.ib-sp-title')).toHaveText('Swarm plan');
  await expect(drawn.locator('[data-swarm-plan-status]')).toHaveText(/^Started .+ · Codex is joining$/);
  await expect(drawn.locator('[data-swarm-plan-count]')).toHaveText('3 parts');
  await expect(drawn.locator('[data-swarm-plan-summary]')).toContainText('Work has started.');
  await expect(partOf(page, 'Claude Code').locator('[data-swarm-plan-does]')).toHaveText('Read the export query plan and find the step that takes the time');
  await expect(partOf(page, 'Claude Code').locator('.ib-sp-wh')).toHaveText('ledger · Studio');
  await expect(partOf(page, 'Explorer')).toHaveAttribute('data-depth', '1');
  await expect(partOf(page, 'Explorer').locator('[data-swarm-plan-joining]')).toHaveText('sub-agent');
  await expect(partOf(page, 'Codex').locator('[data-swarm-plan-joining]')).toHaveText('joining');
  // No change controls in this piece: the card's only buttons are its fold (none at 3 parts) and the ghost thread.
  await expect(drawn.locator('button')).toHaveCount(1);
  await expect(drawn.locator('[data-swarm-plan-ghost]')).toBeVisible();
  // The band follows the theme: its dark gradient is not the light one.
  const bandIn = async (scheme: 'light' | 'dark') => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('light'))).toBe(scheme === 'light');
    return drawn.locator('.ib-sp-band').evaluate((el) => getComputedStyle(el).backgroundImage);
  };
  const [light, dark] = [await bandIn('light'), await bandIn('dark')];
  expect(dark).not.toBe(light);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await expect(page.locator('.ib-toast')).toHaveCount(0, { timeout: 20_000 });
  await cardShot(page, '08-plan-card-first-reply');
});

test('Codex joins and adds its lines: the same card changes in place, by the stream, and no second card is written', async ({ page }) => {
  await openWindow(page, 1440, 900, `#thread=${quietId}`);
  const card = page.locator('[data-swarm-plan]');
  await expect(card).toBeVisible({ timeout: 20_000 });
  const before = (await read<ThreadRead>(`/api/inbox/threads/${quietId}`)).thread.messages.length;
  await swarmAsk(CODEX, { action: 'join', thread: quietId });
  const added = await swarmAsk(CODEX, {
    action: 'propose',
    thread: quietId,
    text: ['- Codex: Time each step of the export, and the query alone, on last night\'s data', '  - Index check: Try the export with an index on refunds.created_at'].join('\n'),
  });
  expect(added.text).toContain('Added to the plan');
  // The open window: no reload.
  await expect(partOf(page, 'Codex').locator('[data-swarm-plan-does]')).toHaveText("Time each step of the export, and the query alone, on last night's data", { timeout: 20_000 });
  await expect(partOf(page, 'Codex').locator('[data-swarm-plan-joining]')).toHaveCount(0);
  await expect(partOf(page, 'Codex').locator('[data-swarm-plan-by]')).toHaveText('Added by Codex');
  await expect(partOf(page, 'Index check')).toHaveAttribute('data-depth', '1');
  await expect(card.locator('[data-swarm-plan-status]')).toHaveText(/ · everyone joined$/);
  await expect(card.locator('[data-swarm-plan-count]')).toHaveText('4 parts');
  await expect(page.locator('[data-swarm-plan]')).toHaveCount(1);
  const after = await read<ThreadRead>(`/api/inbox/threads/${quietId}`);
  expect([after.thread.messages.length, after.thread.messages.filter((m) => m.swarm_plan).length]).toEqual([before, 1]);
  await cardShot(page, '09-plan-card-second-agent-added');
});

test('a team of 20: the band has no marks, six rows show, and "Show 14 more" opens the rest', async ({ page }) => {
  const team = [
    'Twenty parts across the refunds fix: the rounding, the short refunds, the re-sends and the checks.',
    '- Claude Code: Rewrite the rounding in refunds.ts to whole cents',
    '  - Rounding tests: Tests for every rounding rule in refunds.ts',
    '  - Currency check: The three currencies that have no cents',
    '- Codex: Find the refunds that went out short since Tuesday',
    '  - Short list: Write them to refunds-short.csv',
    '  - Amount check: The amount each one is short by',
    '- Pi: Re-send the short refunds from refunds-short.csv',
    '- OpenCode: The refunds page shows amounts in whole cents',
    '- Cursor: The admin export of refunds',
    '- Qwen Code: The nightly export of refunds',
    '- Cline: The berth_rates migration that rounds the old rates',
    '- Hermes Agent: The email a customer gets for a re-sent refund',
    '- OpenClaw: The support macro for a short refund',
    '- Antigravity: The refunds dashboard',
    '- Claude Code 2: The invoices that use the same rounding',
    '- Codex 2: The credit notes that use the same rounding',
    '- Pi 2: The ledger entries for each re-send',
    '- DeepSeek Harness: A load test of the re-send job',
    '- Muse Code: The changelog line for the fix',
    '- T3 Code: The release note for support',
  ].join('\n');
  expect((await swarmAsk(CLAUDE, { action: 'propose', thread: threadId, text: team })).text).toContain('20 lines');
  await openWindow(page, 1440, 900, `#thread=${threadId}`);
  const card = page.locator('[data-swarm-plan]');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator('[data-swarm-plan-count]')).toHaveText('20 parts');
  await expect(card.locator('[data-swarm-plan-status]')).toHaveText(/ · 14 agents are joining$/);
  await expect(card.locator('.ib-sp-band .ib-mk')).toHaveCount(0);
  await expect(card.locator('[data-swarm-plan-part]')).toHaveCount(6);
  const more = card.locator('[data-swarm-plan-more]');
  await expect(more).toHaveText('Show 14 more');
  await cardShot(page, '10-plan-card-long-team');
  await more.click();
  await expect(card.locator('[data-swarm-plan-part]')).toHaveCount(20);
  await expect(more).toHaveText('Show fewer');
  await cardShot(page, '10-plan-card-long-team-open');
});

test('a phone: the plan card fits the screen, each part in one column', async ({ page }) => {
  await openWindow(page, 390, 844, `#thread=${quietId}`);
  const card = page.locator('[data-swarm-plan]');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(partOf(page, 'Index check')).toBeVisible();
  const fit = await page.evaluate(() => {
    const box = document.querySelector('[data-swarm-plan]')!.getBoundingClientRect();
    const row = document.querySelector('[data-swarm-plan-part="Claude Code"]')!;
    const does = row.querySelector('[data-swarm-plan-does]')!.getBoundingClientRect();
    const who = row.querySelector('.ib-sp-who')!.getBoundingClientRect();
    return { inside: box.left >= 0 && box.right <= window.innerWidth + 0.5, stacked: who.top >= does.bottom - 0.5 };
  });
  expect(fit).toEqual({ inside: true, stacked: true });
  await cardShot(page, '12-phone-plan-card');
});

/** New message to Claude Code, then Codex added, with words; the first-time note answered "show" for this page. */
async function newMessageTwoAgents(page: Page, width: number, height: number) {
  await page.route('**/api/inbox/reveal', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { id?: string };
    if (body.id === 'swarm_tip') return route.fulfill({ json: { show: true, reveal: { next: null }, board: { on: false }, steps: { on: false } } });
    return route.continue();
  });
  await openWindow(page, width, height);
  await page.locator('[data-open-compose]:visible').first().click();
  const dialog = page.locator('dialog[data-compose]');
  const to = dialog.locator('[data-compose-to]').first();
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 20_000 });
  await to.click();
  await page.locator(`[data-compose-session="${CLAUDE.session}"]`).first().click();
  await dialog.getByRole('textbox', { name: 'Message' }).fill("Refunds are off by a cent after Bob Tully's rounding change. Claude, find the cause in the ledger. Codex, find every refund that went out wrong and get a replay ready. Don't replay anything until I say so.");
  await dialog.locator('[data-compose-add-agent]').click();
  await page.locator(`[data-compose-session="${CODEX.session}"]`).first().click();
  return dialog;
}

type Rect = { left: number; right: number; top: number; bottom: number };
const overlaps = (a: Rect, b: Rect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

// Send is never pushed off a phone's screen, at 390 with the whole row there (Skills and the badge's word). Narrower,
// what gives way is a stop-gap until the row's design is picked, so only Send and the badge's name are held to here.
for (const [width, height] of [[390, 844], [360, 800], [320, 700]] as const) {
  const whole = width >= 390;
  test(`a phone ${width} px wide: New message with a second agent and the Swarm badge in its row keeps Send whole on the screen, in one row`, async ({ page }) => {
    const dialog = await newMessageTwoAgents(page, width, height);
    const badge = dialog.locator('[data-compose-swarm-line] [data-swarm-badge]');
    await expect(badge).toBeVisible();
    // The fullest row: the saved draft's check is in it too.
    await expect(dialog.locator('[data-compose-saved]')).toBeVisible({ timeout: 20_000 });
    await expect(badge).toHaveAccessibleName('Swarm');
    const fit = await page.evaluate(() => {
      const foot = document.querySelector('dialog[data-compose] .ib-cp-foot')!;
      const send = document.querySelector('dialog[data-compose] [data-compose-send]')!.getBoundingClientRect();
      const clip = document.querySelector('dialog[data-compose] .ib-cp-foot > .ib-cp-clip')!.getBoundingClientRect();
      const inner = foot.getBoundingClientRect().right - parseFloat(getComputedStyle(foot).paddingRight);
      const shown = (selector: string) => {
        const el = document.querySelector<HTMLElement>(`dialog[data-compose] ${selector}`);
        return !!el && el.getBoundingClientRect().width > 2;
      };
      return {
        inRow: send.right <= inner + 0.5,
        onScreen: send.left >= 0 && send.right <= window.innerWidth + 0.5,
        tappable: send.width >= 36 && send.height >= 36,
        oneRow: Math.abs(send.top + send.height / 2 - (clip.top + clip.height / 2)) < 1,
        skills: shown('[data-compose-skills]'),
        word: shown('[data-swarm-badge] .ib-sw-lab-on .ib-sw-word'),
      };
    });
    expect(fit).toEqual({ inRow: true, onScreen: true, tappable: true, oneRow: true, ...(whole ? { skills: true, word: true } : { skills: fit.skills, word: fit.word }) });
  });
}

test('a phone: the Swarm badge on, its stars lie on none of the row\'s other controls', async ({ page }) => {
  const dialog = await newMessageTwoAgents(page, 390, 844);
  await expect(dialog.locator('[data-compose-saved]')).toBeVisible({ timeout: 20_000 });
  const badge = dialog.locator('[data-compose-swarm-line] [data-swarm-badge]');
  await badge.click();
  await expect(badge).toHaveAttribute('aria-pressed', 'true');
  const hits = await page.evaluate(() => {
    const d = document.querySelector('dialog[data-compose]')!;
    const layer = d.querySelector('.ib-sw-stars')!;
    const box = layer.getBoundingClientRect();
    // What the layer shows: its box grown or cut by its clip-path's inset (none: everything).
    const inset = /^inset\((.*)\)$/.exec(getComputedStyle(layer).clipPath)?.[1]?.split(/\s+/).map(parseFloat);
    const [t, r = t, b = t, l = r] = inset ?? [-Infinity];
    const seen = { left: box.left + l!, right: box.right - r!, top: box.top + t!, bottom: box.bottom - b! };
    const stars = [...d.querySelectorAll('.ib-sw-st')].map((s) => {
      const a = s.getBoundingClientRect();
      return { left: Math.max(a.left, seen.left), right: Math.min(a.right, seen.right), top: Math.max(a.top, seen.top), bottom: Math.min(a.bottom, seen.bottom) };
    }).filter((a) => a.right > a.left && a.bottom > a.top);
    const others = ['[data-compose-saved]', '[data-compose-add-agent]', '[data-compose-send]', '[data-compose-also]'].map((s) => d.querySelector(s)!.getBoundingClientRect());
    return { stars: stars.length, others: others.map((o) => ({ left: o.left, right: o.right, top: o.top, bottom: o.bottom })), seen: stars };
  });
  expect(hits.stars).toBeGreaterThan(0);
  expect(hits.seen.filter((star) => hits.others.some((o) => overlaps(star, o)))).toEqual([]);
});

// The first-time note opens away from the message box on a computer: it covers none of the words being written.
for (const [width, height] of [[1440, 900], [1280, 800], [1280, 600]] as const) {
  test(`a computer ${width}×${height}: the Swarm first-time note stays by the badge, inside the window, off the message`, async ({ page }) => {
    const dialog = await newMessageTwoAgents(page, width, height);
    const note = page.locator('[data-swarm-tip]');
    await expect(note).toBeVisible({ timeout: 20_000 });
    const place = async () =>
      page.evaluate(() => {
        const r = (el: Element) => {
          const b = el.getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        };
        const d = document.querySelector('dialog[data-compose]')!;
        return { note: r(document.querySelector('[data-swarm-tip]')!), badge: r(d.querySelector('[data-swarm-badge]')!), text: r(d.querySelector('[data-compose-text] textarea')!), w: innerWidth, h: innerHeight };
      });
    const check = (p: Awaited<ReturnType<typeof place>>) => ({
      offMessage: !overlaps(p.note, p.text),
      inWindow: p.note.left >= 0 && p.note.top >= 0 && p.note.right <= p.w && p.note.bottom <= p.h,
      // Attached: within the caret's reach of the badge on one side.
      byBadge: Math.max(p.note.left - p.badge.right, p.badge.left - p.note.right, p.note.top - p.badge.bottom, p.badge.top - p.note.bottom) <= 12,
    });
    expect(check(await place())).toEqual({ offMessage: true, inWindow: true, byBadge: true });
    // The draft saves while it is open: "Draft · saved" comes into the To row and the badge moves; still off the message.
    await expect(dialog.locator('.ib-cp-dsaved')).toBeVisible({ timeout: 20_000 });
    await expect(note).toBeVisible();
    expect(check(await place())).toEqual({ offMessage: true, inWindow: true, byBadge: true });
  });
}
