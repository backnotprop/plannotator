/**
 * The status mark for every agent (owner, 2026-11-18), on the compiled binary: `plannotator inbox --background` under
 * a temp HOME and PLANNOTATOR_DATA_DIR; each session is the bridge's real long-poll and `state` event, as a plugin
 * sends them. No real agent runs, no browser opens.
 *
 *  1. Off by default: a live session that reports its turns carries no mark in the Agents list.
 *  2. The ⋮ menu's "Show agent status" turns it on; Settings' row says on too.
 *  3. A session busy: "Working". A session that reports no turns (Codex: no `busy`): no mark.
 *  4. The session says it waits on a permission prompt in its terminal (`blocked: { kind: 'permission' }`): the
 *     waiting mark, named "Waiting for your permission in the agent"; the prompt answered (a `state` event without it):
 *     back to "Working". Off again: no mark.
 *
 * Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, inboxBlockedField } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

interface World {
  dataDir: string;
  url: string;
  agent: SimAgent;
  polls: Poll[];
  context: BrowserContext;
}
let world: World;

function bridge(path: string, body: Record<string, unknown>) {
  const { port, token } = JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

/**
 * One live session: the bridge's long-poll, saying `busy` (or not, for a host that reports no turns) and `blocked`
 * with `blocked_at` as the real connections do, so a poll built before a `state` event and answered after it never
 * undoes it.
 */
class Poll {
  private stopped = false;
  private readonly loop: Promise<void>;
  blocked: 'permission' | 'question' | null = null;
  private blockedAt = Date.now();
  constructor(
    readonly session: string,
    readonly host: string,
    readonly busy: boolean | null,
    private readonly projectPath: string,
  ) {
    this.loop = this.run();
  }

  private body(): Record<string, unknown> {
    return { session: this.session, host: this.host, project_path: this.projectPath, ...(this.busy === null ? {} : { busy: this.busy }), ...inboxBlockedField(this.blocked, this.blockedAt) };
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const response = await bridge(INBOX_BRIDGE_POLL_PATH, { ...this.body(), waitMs: 500 }).catch(() => null);
      await response?.text().catch(() => '');
    }
  }

  /** What a plugin does the moment a prompt comes up or goes: a `state` event. */
  async say(blocked: 'permission' | 'question' | null): Promise<void> {
    this.blocked = blocked;
    this.blockedAt = Math.max(Date.now(), this.blockedAt + 1);
    const response = await bridge(INBOX_BRIDGE_EVENT_PATH, { ...this.body(), type: 'state' });
    expect(response.ok).toBe(true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-agent-status-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF }));
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_TEST_SANDBOX: '1', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  await agent.send({ project_path: project, subject: 'Run finished', body: 'The export streams rows now.' });
  world = { dataDir, url: started.stdout.trim(), agent, polls: [], context: await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }) };
  world.polls.push(new Poll('ses-claude', 'claude-code', true, project), new Poll('ses-codex', 'codex', null, project));
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.polls.map((poll) => poll.stop()));
    await world.agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

const markOf = (page: Page, session: string) => page.locator(`.ib-sbagent[data-sidebar-agent="${session}"] .ib-rxm`);

async function open(page: Page): Promise<void> {
  await page.goto(world.url);
  await expect(page.locator('.ib-main h1').first()).toBeVisible();
  if ((await page.locator('.ib-sbagent').count()) === 0) await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.locator('.ib-sbagent[data-sidebar-agent="ses-claude"]')).toBeVisible();
  await expect(page.locator('.ib-sbagent[data-sidebar-agent="ses-codex"]')).toBeVisible();
}

async function menuSwitch(page: Page): Promise<void> {
  await page.locator('[data-tidy-menu]').click();
  await page.locator('[data-tidy-menu-popup] [data-agent-status-option]').click();
  await page.keyboard.press('Escape');
}

test('off by default; on from the ⋮ menu, a terminal permission prompt shows and clears; a host that reports no turns has none', async () => {
  test.setTimeout(120_000);
  const page = await world.context.newPage();
  await open(page);
  await expect(page.locator('.ib-sbagent .ib-rxm')).toHaveCount(0);

  await menuSwitch(page);
  await expect(markOf(page, 'ses-claude')).toHaveAttribute('aria-label', 'Working');
  await expect(markOf(page, 'ses-codex')).toHaveCount(0);
  // Kept: config.json says it, a reload keeps it.
  // The mark shows from the press itself, before its save lands: wait for the save.
  await expect.poll(() => JSON.parse(readFileSync(join(world.dataDir, 'config.json'), 'utf8')).inboxAgentStatus).toBe(true);
  await page.reload();
  await expect(markOf(page, 'ses-claude')).toHaveAttribute('aria-label', 'Working');

  const claude = world.polls[0]!;
  await claude.say('permission');
  await expect(markOf(page, 'ses-claude')).toHaveAttribute('aria-label', 'Waiting for your permission in the agent');
  await expect(markOf(page, 'ses-claude')).toHaveAttribute('data-rx-where', 'terminal');
  await claude.say(null);
  await expect(markOf(page, 'ses-claude')).toHaveAttribute('aria-label', 'Working');

  await menuSwitch(page);
  await expect(page.locator('.ib-sbagent .ib-rxm')).toHaveCount(0);
  await page.close();
});
