/**
 * An agent's card atop the list filtered to it, and its profile in the reading pane (approval
 * "inbox-agent-profile-card"), proved in a real browser against the compiled binary, with the proof pictures.
 *
 * Nothing is mocked: the binary runs `plannotator inbox --background` under a temp HOME and PLANNOTATOR_DATA_DIR.
 * Three live sessions poll the bridge as the plugins do, each with its own name: "harbor-web" (a turn running, two
 * threads, one waiting on the person), "harbor-test" (a turn running, then stuck on a permission prompt in its
 * terminal, said with a `state` event) and "quill-docs" (idle). No real agent runs, no browser opens.
 *
 *  1. The list filtered to harbor-web: the card says "Working" with how long; harbor-test's card says "Asking for
 *     permission" in amber with the pause mark.
 *  2. The card opens the profile beside the list (the card pressed): Activity, Threads with "Waiting on you",
 *     Details. The browser's Back closes it; a thread in it replaces it.
 *  3. The Agents view: an agent's row opens its profile; the arrow at its end folds its threads.
 *  4. A phone: the card on the filtered list, the profile as a page, its Back to the list.
 *
 * PNGs land in .local/proof/agent-profile/ (CI keeps .local/proof/ as the shard's "inbox-window-proof" artifact).
 * Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, inboxBlockedField } from '../../packages/shared/inbox/connection';
import { scratchProject } from '../../scripts/inbox-sim';
import { E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'agent-profile'));
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: 'reduce' as const };

interface World {
  dataDir: string;
  url: string;
  origin: string;
  polls: Poll[];
  threads: Record<string, string>;
  browser: Browser;
}
let world: World;

function bridge(path: string, body: Record<string, unknown>) {
  const { port, token } = JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

/** One live session: the bridge's long-poll with its name, `busy`, and `blocked` as the real connections say them. */
class Poll {
  private stopped = false;
  private readonly loop: Promise<void>;
  private blocked: 'permission' | null = null;
  private blockedAt = Date.now();
  constructor(
    readonly session: string,
    readonly label: string,
    readonly busy: boolean,
    private readonly projectPath: string,
  ) {
    this.loop = this.run();
  }

  private body(): Record<string, unknown> {
    return { session: this.session, host: 'claude-code', project_path: this.projectPath, label: this.label, busy: this.busy, ...inboxBlockedField(this.blocked, this.blockedAt) };
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const response = await bridge(INBOX_BRIDGE_POLL_PATH, { ...this.body(), waitMs: 500 }).catch(() => null);
      await response?.text().catch(() => '');
      if (!response) await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** A permission prompt comes up in its terminal: the plugin's `state` event. */
  async ask(): Promise<void> {
    this.blocked = 'permission';
    this.blockedAt = Math.max(Date.now(), this.blockedAt + 1);
    const response = await bridge(INBOX_BRIDGE_EVENT_PATH, { ...this.body(), type: 'state' });
    expect(response.ok).toBe(true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

/** send_message as the session itself, as its connection's MCP calls do. */
async function send(args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${world.origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: 'send_message', arguments: { agent_host: 'claude-code', agent_name: 'Claude Code', ...args }, _meta: { 'ai.plannotator/inbox-wakes': true } } }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const json = JSON.parse(line ? line.slice(5) : text) as { result?: { isError?: boolean; structuredContent: { thread_id: string } } };
  if (!json.result || json.result.isError) throw new Error(text);
  return json.result.structuredContent.thread_id;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, name) });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-agent-profile-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF }));
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_TEST_SANDBOX: '1', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_INBOX_NOTES: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/$/, '');
  world = { dataDir, url, origin: new URL(url).origin, polls: [], threads: {}, browser };
  const harbor = scratchProject(join(root, 'src'), 'harbor');
  const quill = scratchProject(join(root, 'src'), 'quill');
  world.polls.push(new Poll('ses-web', 'harbor-web', true, harbor), new Poll('ses-test', 'harbor-test', true, harbor), new Poll('ses-docs', 'quill-docs', false, quill));
  world.threads.docs = await send({ agent_session: 'ses-web', project_path: harbor, thread: 'Docs for the Agents section', body: ['Draft is in agents.md. Ada Novak asked for one picture per state.', '', ':::question', 'One picture per state?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n') });
  world.threads.rename = await send({ agent_session: 'ses-web', project_path: harbor, thread: 'Rename Machines to Agents', body: 'Done. The section reads Agents, and each machine is a caption.' });
  world.threads.login = await send({ agent_session: 'ses-test', project_path: harbor, thread: 'Login test on Safari', body: 'The login spec fails on WebKit only. Running it again.' });
  world.threads.guide = await send({ agent_session: 'ses-docs', project_path: quill, thread: 'Screenshots for the guide', body: 'Bob Tully wants the new screenshots in the guide.' });
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.polls.map((poll) => poll.stop()));
  } finally {
    await removeInboxScratch();
  }
});

const card = (page: Page, id: string) => page.locator(`[data-agent-card="${id}"]`);
const profile = (page: Page, id: string) => page.locator(`section.ib-pane[data-agent-profile="${id}"]`);

async function chooseView(page: Page, view: 'grouped' | 'agents') {
  await page.locator('.ib-listcol [data-tidy-menu]').first().click();
  await page.locator(`[data-tidy-menu-popup] [data-list-view="${view}"]`).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tidy-menu-popup]')).toHaveCount(0);
}

test('the card on a list filtered to an agent, its profile beside the list, and the Agents view', async () => {
  test.setTimeout(120_000);
  const context = await world.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`${world.url}#agent=ses-web`);
  const web = card(page, 'ses-web');
  await expect(web.locator('.ib-apc-n')).toHaveText('harbor-web');
  await expect(web.locator('.ib-apc-m')).toHaveText('Claude Code · harbor');
  await expect(web.locator('[data-agent-line="working"] .ib-apl-w')).toHaveText('Working');
  await expect(web.locator('[data-agent-line-time]')).toHaveText(/^\d+s$|^\d+m$/);
  await shot(page, '01-card-working.png');

  // Stuck on a permission prompt in its terminal: amber, with the pause mark.
  await world.polls[1]!.ask();
  await page.goto(`${world.url}#agent=ses-test`);
  const asking = card(page, 'ses-test').locator('[data-agent-line]');
  await expect(asking).toHaveAttribute('data-tone', 'asking');
  await expect(asking).toHaveText('Asking for permission');
  await expect(asking.locator('.ib-apl-pause')).toBeVisible();
  await shot(page, '02-card-permission.png');

  // The card opens the profile beside the list, pressed.
  await page.goto(`${world.url}#agent=ses-web`);
  await web.locator('.ib-apc-b').click();
  const pane = profile(page, 'ses-web');
  await expect(pane.locator('h2')).toHaveText('harbor-web');
  await expect(web.locator('.ib-apc-b')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await expect(pane.locator('[data-agent-profile-activity] .ib-apl-w')).toHaveText('Working');
  await expect(pane.locator(`[data-agent-profile-thread="${world.threads.docs}"] .ib-apf-th-w`)).toHaveText('Waiting on you');
  await expect(pane.locator('[data-agent-profile-thread]')).toHaveCount(2);
  await expect(pane.locator('[data-agent-profile-details] dt').first()).toHaveText('Started');
  await expect(pane.locator('[data-agent-profile-message]')).toBeVisible();
  expect(page.url()).toContain('profile=ses-web');
  await shot(page, '03-profile-open.png');

  // The browser's Back closes it; a reload keeps it; a thread in it replaces it.
  await page.goBack();
  await expect(pane).toHaveCount(0);
  await page.goForward();
  await expect(pane).toBeVisible();
  await page.reload();
  await expect(pane.locator('h2')).toHaveText('harbor-web');
  await pane.locator(`[data-agent-profile-thread="${world.threads.rename}"]`).click();
  await expect(page.locator('section.ib-pane h2.ib-subject')).toBeVisible();
  await expect(pane).toHaveCount(0);
  await expect(web.locator('.ib-apc-b')).toHaveAttribute('aria-pressed', 'false');

  // The Agents view: the row opens the profile, the arrow folds its threads.
  await page.goto(world.url);
  await chooseView(page, 'agents');
  const group = page.locator('.ib-lbody > [data-agent="ses-web"]');
  await group.locator('[data-agent-head]').click();
  await expect(profile(page, 'ses-web')).toBeVisible();
  await expect(group.locator('[data-agent-head]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.ib-lbody > [data-agent="ses-test"] [data-agent-line]')).toHaveAttribute('data-tone', 'asking');
  await shot(page, '04-agents-view.png');
  const fold = group.locator('[data-agent-fold]');
  const was = await fold.getAttribute('aria-expanded');
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', was === 'true' ? 'false' : 'true');
  await expect(profile(page, 'ses-web')).toBeVisible();
  await chooseView(page, 'grouped');
  expect(errors).toEqual([]);
  await context.close();
});

test('a phone: the card on the filtered list, the profile as a page, Back to the list', async () => {
  test.setTimeout(90_000);
  const context = await world.browser.newContext(PHONE);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${world.url}#agent=ses-web`);
  const web = card(page, 'ses-web');
  await expect(web.locator('[data-agent-line="working"]')).toBeVisible();
  await shot(page, '05-phone-card.png');
  await web.locator('.ib-apc-b').tap();
  const pane = profile(page, 'ses-web');
  await expect(pane.locator('h2')).toHaveText('harbor-web');
  await expect(page.locator('.ib-listcol')).toBeHidden();
  await expect(pane.locator('[data-agent-profile-back]')).toHaveText('harbor-web');
  await shot(page, '06-phone-profile.png');
  await pane.locator('[data-agent-profile-back]').tap();
  await expect(pane).toHaveCount(0);
  await expect(web).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});
