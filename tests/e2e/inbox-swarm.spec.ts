/**
 * Swarm mode, slice 1 (docs/agent-guides/inbox-compose.md, "Swarm"), in a real browser against the compiled binary.
 * Three live sessions in one project (the bridge's real long-poll, as the mod, Pi and OpenCode run it): Claude Code
 * working, Codex and Pi idle. Nothing is mocked.
 *
 *  1. New message: Claude Code in To, then `+` (Add an agent) and Codex: both in To, and the Swarm badge appears at the
 *     row's end, resting off (the owner: "it appears, then rests off until I turn it on"). The first time, its card
 *     says what turning it on gives. (01-new-message-swarm-tip.png) A press turns Swarm on
 *     (02-new-message-swarm-on.png), another turns it off and it stays, another turns it back on.
 *  2. Send: ONE thread, its root to Claude Code and tagging Codex, swarm on. The thread's line says "Swarm",
 *     "2 agents · 1 working".
 *  3. Each agent says what it is doing (the `swarm` action through `plannotator inbox mcp`): the opened status view
 *     shows each state from the connection and each line. (03-swarm-thread-status.png) No file and no "also" yet:
 *     the agent activity source that fills them is a separate change.
 *  4. A phone (390 × 844): the same thread, the line opened below itself, one agent per row. (04-phone-swarm.png)
 *  5. Turn off: the quiet badge stays on the line; a press turns it back on.
 *
 * Pictures land in PLANNOTATOR_E2E_PROOF_DIR/swarm-mode/ (else .local/proof/swarm-mode/; CI keeps .local/proof/ as the
 * shard's "inbox-window-proof" artifact). Build the binary first (see inbox.spec.ts).
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
const shots = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'swarm-mode');

interface World {
  root: string;
  dataDir: string;
  url: string;
  project: string;
  agent: SimAgent;
  polls: Poll[];
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
  await agent.send({ project_path: project, subject: 'Nightly export is slow', body: 'The export spends most of its time in one query.' });
  world = { root, dataDir, url: started.stdout.trim(), project, agent, polls: [] };
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

test('New message: two agents in To, the badge appears resting off with its first-time card; on, off, on; Send makes one swarm thread', async ({ page }) => {
  await openWindow(page, 1440, 900);
  await page.locator('.ib-side [data-open-compose]').first().click();
  const dialog = page.locator('dialog[data-compose]');
  const to = dialog.locator('.ib-cp-tobtn').first();
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 20_000 });
  await to.click();
  await dialog.locator('[data-compose-session="ses-claude"]').click();
  await expect(to).toHaveAttribute('data-compose-to', 'ses-claude');
  await expect(dialog.locator('[data-swarm-badge]')).toHaveCount(0);

  await dialog.getByRole('textbox', { name: 'Message' }).fill("Refunds are off by a cent after Ada Novak's rounding change. Claude Code, fix the rounding. Codex, find every refund that went out wrong.");
  await dialog.locator('[data-compose-add-agent]').click();
  await dialog.locator('[data-compose-session="ses-codex"]').click();
  await expect(dialog.locator('[data-compose-also="ses-codex"]')).toBeVisible();
  const badge = dialog.locator('[data-swarm-badge]');
  await expect(badge).toHaveAttribute('aria-pressed', 'false');
  // At the end of the To row.
  const ends = await dialog.evaluate((el) => {
    const row = el.querySelector('.ib-cp-to')!.getBoundingClientRect();
    const b = el.querySelector('[data-swarm-badge]')!.getBoundingClientRect();
    return { gap: row.right - b.right, inRow: b.top >= row.top && b.bottom <= row.bottom };
  });
  expect(ends.inRow).toBe(true);
  expect(ends.gap).toBeLessThan(40);
  // The first time: the card at the badge (claimed once the badge has settled).
  const tip = dialog.locator('[data-swarm-tip]');
  await expect(tip).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '01-new-message-swarm-tip.png') });

  await badge.click();
  await expect(badge).toHaveAttribute('aria-pressed', 'true');
  await expect(tip).toHaveCount(0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '02-new-message-swarm-on.png') });
  await badge.click();
  await expect(badge).toHaveAttribute('aria-pressed', 'false');
  await badge.click();
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
  const thread = await read<{ thread: { swarm?: { on: boolean }; messages: { to?: { session: string }; tags?: { session: string }[]; swarm?: true }[] } }>(`/api/inbox/threads/${threadId}`);
  expect(thread.thread.swarm?.on).toBe(true);
  expect(thread.thread.messages[0]!.to?.session).toBe('ses-claude');
  expect(thread.thread.messages[0]!.tags?.map((t) => t.session)).toEqual(['ses-codex']);
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

test('a phone: the line opens below itself, one agent per row', async ({ page }) => {
  await openWindow(page, 390, 844, `#thread=${threadId}`);
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
  await page.screenshot({ path: join(shots, '04-phone-swarm.png') });
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
