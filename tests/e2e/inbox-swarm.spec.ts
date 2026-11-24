/**
 * Swarm mode, slice 1 (docs/agent-guides/inbox-compose.md, "Swarm"), in a real browser against the compiled binary.
 * Three live sessions in one project (the bridge's real long-poll, as the mod, Pi and OpenCode run it): Claude Code
 * working, Codex and Pi idle. Nothing is mocked.
 *
 * Swarm is the built-in `/swarm` skill; the badge only puts it in the words, and its state is "the words carry it".
 *
 *  1. New message: Claude Code in To, and the Swarm badge is there at the row's end, quiet and off
 *     (01-new-message-badge-off.png). `+` (Add an agent) and Codex: the badge's highlight plays (reduced motion here:
 *     none), it rests off, and the first time its card says what turning it on gives (06-first-time.png). A press
 *     puts `/swarm` in the message and turns the badge on (02-badge-on-skill-in-message.png); another takes it out;
 *     typing `/swarm` turns it on again.
 *  2. Send: ONE thread, its root to Claude Code and tagging Codex, carrying the skill's text, and a swarm. The thread's line says "Swarm", "2 agents · 1 working".
 *  3. Each agent says what it is doing (the `swarm` action through `plannotator inbox mcp`): the opened status view
 *     shows each state from the connection and each line. (03-swarm-thread-status.png) No file and no "also" yet:
 *     the agent activity source that fills them is a separate change.
 *  4. A reply: in a plain thread the reply box's badge puts `/swarm` in the reply; Send makes that thread a swarm.
 *     (04-reply-starts-swarm.png)
 *  5. A phone (390 × 844): New message's line under the words keeps Add an agent and the quiet badge side by side
 *     inside the screen (05-phone.png); the swarm thread's line opens below itself, one agent per row
 *     (05-phone-thread.png).
 *  6. Turn off: the quiet badge stays on the line; a press turns it back on.
 *
 * Pictures land in PLANNOTATOR_E2E_PROOF_DIR/swarm/ (else .local/proof/swarm/; CI keeps .local/proof/ as the shard's
 * "inbox-window-proof" artifact). Build the binary first (see inbox.spec.ts).
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
const shots = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'swarm');

interface World {
  root: string;
  dataDir: string;
  url: string;
  project: string;
  agent: SimAgent;
  polls: Poll[];
  /** A plain thread the sim agent started: a reply there turns Swarm on. */
  plain: string;
}
let world: World;

const door = () => JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
const read = async <T,>(path: string): Promise<T> => (await (await fetch(new URL(path, world.url))).json()) as T;

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

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-swarm-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const project = scratchProject(join(root, 'code'), 'ledger');
  // The project the sessions work in, known to the Inbox.
  const plain = await agent.send({ project_path: project, subject: 'Nightly export is slow', body: 'The export spends most of its time in one query.' });
  world = { root, dataDir, url: started.stdout.trim(), project, agent, polls: [], plain: String(plain.thread_id) };
  const now = Date.now();
  world.polls.push(new Poll('ses-claude', 'claude-code', true, now - 30 * 60_000), new Poll('ses-codex', 'codex', false, now - 20 * 60_000), new Poll('ses-pi', 'pi', false, now - 10 * 60_000));
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

let threadId = '';

test('New message: the quiet badge with one agent; a second brings its first-time card; the press puts /swarm in the message; Send makes one swarm thread', async ({ page }) => {
  await openWindow(page, 1440, 900);
  await page.locator('.ib-side [data-open-compose]').first().click();
  const dialog = page.locator('dialog[data-compose]');
  const to = dialog.locator('.ib-cp-tobtn').first();
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 20_000 });
  await to.click();
  await dialog.locator('[data-compose-session="ses-claude"]').click();
  await expect(to).toHaveAttribute('data-compose-to', 'ses-claude');
  // One agent: the badge is there, quiet and off, and no card yet.
  const badge = dialog.locator('[data-swarm-badge]');
  await expect(badge).toHaveAttribute('aria-pressed', 'false');
  const tip = dialog.locator('[data-swarm-tip]');
  await expect(tip).toHaveCount(0);
  const field = dialog.getByRole('textbox', { name: 'Message' });
  const words = "Refunds are off by a cent after Ada Novak's rounding change. Claude Code, fix the rounding. Codex, find every refund that went out wrong.";
  await field.fill(words);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '01-new-message-badge-off.png') });

  await dialog.locator('[data-compose-add-agent]').click();
  await dialog.locator('[data-compose-session="ses-codex"]').click();
  await expect(dialog.locator('[data-compose-also="ses-codex"]')).toBeVisible();
  // The second agent: its highlight, then the badge rests off.
  await expect(badge).toHaveAttribute('aria-pressed', 'false');
  // At the end of the To row.
  const ends = await dialog.evaluate((el) => {
    const row = el.querySelector('.ib-cp-to')!.getBoundingClientRect();
    const b = el.querySelector('[data-swarm-badge]')!.getBoundingClientRect();
    return { gap: row.right - b.right, inRow: b.top >= row.top && b.bottom <= row.bottom };
  });
  expect(ends.inRow).toBe(true);
  expect(ends.gap).toBeLessThan(40);
  // The first time: the card at the badge (claimed once the highlight has settled).
  await expect(tip).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '06-first-time.png') });

  // The press puts the skill in the message: the badge's state is the words'.
  await badge.click();
  await expect(badge).toHaveAttribute('aria-pressed', 'true');
  await expect(tip).toHaveCount(0);
  await expect(field).toHaveValue(`${words} /swarm `);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '02-badge-on-skill-in-message.png') });
  await badge.click();
  await expect(badge).toHaveAttribute('aria-pressed', 'false');
  await expect(field).not.toHaveValue(/\/swarm/);
  // Typed by the person, it turns the badge on the same way.
  await field.fill(`${words}\n\n/swarm this: split the work between you.`);
  await expect(badge).toHaveAttribute('aria-pressed', 'true');

  await dialog.locator('[data-compose-send]').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect
    .poll(
      async () => {
        const list = await read<{ sections: { threads: { thread_id: string; subject: string | null }[] }[] }>('/api/inbox/threads');
        threadId = list.sections.flatMap((s) => s.threads).find((t) => (t.subject ?? '').startsWith('Refunds are off'))?.thread_id ?? '';
        return threadId;
      },
      { timeout: 20_000 },
    )
    .not.toBe('');
  const thread = await read<{ thread: { swarm?: { on: boolean }; messages: { body: string; to?: { session: string }; tags?: { session: string }[] }[] } }>(`/api/inbox/threads/${threadId}`);
  expect(thread.thread.swarm?.on).toBe(true);
  const sent = thread.thread.messages[0]!;
  expect(sent.to?.session).toBe('ses-claude');
  expect(sent.tags?.map((t) => t.session)).toEqual(['ses-codex']);
  // The skill's text rides the message once.
  expect(sent.body.split('--- BEGIN SKILL INSTRUCTIONS: swarm ---')).toHaveLength(2);
});

test('the swarm thread: the line, then the status view with each state and each line', async ({ page }) => {
  await world.agent.swarm({ thread_id: threadId, doing: 'Rewriting the rounding', agent_session: 'ses-claude' });
  await world.agent.swarm({ thread_id: threadId, doing: 'Finding the refunds that went out short', agent_session: 'ses-codex' });

  await openWindow(page, 1440, 900, `#thread=${threadId}`);
  const line = page.locator('[data-swarm-line="on"]');
  await expect(line).toBeVisible({ timeout: 20_000 });
  await expect(line.locator('.ib-swarm-sum')).toHaveText('2 agents · 1 working');
  await line.locator('.ib-swarm-tog').click();
  const claude = page.locator('.ib-swarm-row[data-session="ses-claude"]');
  const codex = page.locator('.ib-swarm-row[data-session="ses-codex"]');
  await expect(claude.locator('[data-swarm-state]')).toHaveText('working');
  await expect(claude.locator('[data-swarm-doing]')).toHaveText('Rewriting the rounding');
  await expect(codex.locator('[data-swarm-state]')).toHaveText('idle');
  await expect(codex.locator('[data-swarm-doing]')).toHaveText('Finding the refunds that went out short');
  await expect(page.locator('[data-swarm-file]')).toHaveCount(0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '03-swarm-thread-status.png') });
});

test('a reply: the reply box\'s badge puts /swarm in the reply, and its Send makes the thread a swarm', async ({ page }) => {
  await openWindow(page, 1440, 900, `#thread=${world.plain}`);
  const pane = page.locator('section.ib-pane');
  await pane.getByRole('button', { name: 'Reply', exact: true }).last().click();
  const field = pane.locator('.ib-rbox').getByRole('textbox');
  await expect(field).toBeFocused();
  await field.fill('Bring in help: one of you on the query, one on the export.');
  const badge = pane.locator('.ib-rbox [data-reply-swarm] [data-swarm-badge]');
  await expect(badge).toHaveAttribute('aria-pressed', 'false');
  await badge.click();
  await expect(badge).toHaveAttribute('aria-pressed', 'true');
  await expect(field).toHaveValue('Bring in help: one of you on the query, one on the export. /swarm ');
  await pane.locator('.ib-rbox [data-reply-send]').click();
  const reply = (await world.agent.nextReply(world.plain)) as { body: string };
  expect(reply.body.split('--- BEGIN SKILL INSTRUCTIONS: swarm ---')).toHaveLength(2);
  await expect.poll(async () => (await read<{ swarm: { on: boolean } | null }>(`/api/inbox/threads/${world.plain}/swarm`)).swarm?.on ?? false, { timeout: 20_000 }).toBe(true);
  await expect(page.locator('[data-swarm-line="on"]')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '04-reply-starts-swarm.png') });
});

test('a phone: New message keeps Add an agent and the quiet badge side by side; the thread\'s line opens below itself, one agent per row', async ({ page }) => {
  await openWindow(page, 390, 844);
  await page.locator('[data-open-compose]:visible').first().click();
  const sheet = page.locator('dialog[data-compose]');
  const to = sheet.locator('.ib-cp-foot [data-compose-to]');
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 20_000 });
  await to.click();
  await sheet.locator('[data-compose-to-sheet] [data-compose-session="ses-claude"]').click();
  const swarmLine = sheet.locator('[data-compose-swarm-line]');
  await expect(swarmLine.locator('[data-swarm-badge]')).toHaveAttribute('aria-pressed', 'false');
  // It fits: Add an agent and the badge inside the screen, on one row, neither over the other.
  const fit = await swarmLine.evaluate((el) => {
    const [add, badge] = ['[data-compose-add-agent]', '[data-swarm-badge]'].map((s) => el.querySelector(s)!.getBoundingClientRect());
    return { inside: add!.left >= 0 && badge!.right <= window.innerWidth, oneRow: Math.abs(add!.top + add!.height / 2 - (badge!.top + badge!.height / 2)) < 4, apart: add!.right <= badge!.left };
  });
  expect(fit).toEqual({ inside: true, oneRow: true, apart: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '05-phone.png') });

  await page.goto('about:blank');
  await page.goto(`${world.url}#thread=${threadId}`);
  const line = page.locator('[data-swarm-line="on"]');
  await expect(line).toBeVisible({ timeout: 20_000 });
  await expect(line).toHaveAttribute('data-phone', '');
  await line.locator('.ib-swarm-tog').click();
  const rows = page.locator('.ib-swarm-row');
  await expect(rows).toHaveCount(2);
  // One agent per row: the second below the first, every row inside the view.
  const tops = await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  expect(tops[1]!).toBeGreaterThan(tops[0]!);
  const inside = await page.evaluate(() => [...document.querySelectorAll('.ib-swarm-row')].every((el) => el.getBoundingClientRect().right <= window.innerWidth));
  expect(inside).toBe(true);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '05-phone-thread.png') });
});

test('Turn off leaves the quiet badge, which turns it back on', async ({ page }) => {
  await openWindow(page, 1440, 900, `#thread=${threadId}`);
  await page.locator('[data-swarm-line="on"] .ib-swarm-tog').click();
  await page.locator('[data-swarm-turn-off]').click();
  const quiet = page.locator('[data-swarm-line="off"] [data-swarm-badge]');
  await expect(quiet).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await read<{ swarm: { on: boolean } }>(`/api/inbox/threads/${threadId}/swarm`)).swarm.on).toBe(false);
  await quiet.click();
  await expect(page.locator('[data-swarm-line="on"]')).toBeVisible();
  await expect.poll(async () => (await read<{ swarm: { on: boolean } }>(`/api/inbox/threads/${threadId}/swarm`)).swarm.on).toBe(true);
});
