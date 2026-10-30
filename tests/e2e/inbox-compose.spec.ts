/**
 * Compose: a new message to a connected agent (approval record
 * "inbox-compose-to-agent"), proved in a real browser against the compiled
 * binary. Nothing is mocked: the binary runs `plannotator inbox --background`
 * under a temp PLANNOTATOR_DATA_DIR and HOME, an agent writes through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts), and the agent connections
 * are the bridge's real doors driven as a connection drives them (the bearer
 * token from inbox.json, a long-poll saying where the session works, and
 * `delivered` once the turn is in). Chromium drives the window.
 *
 *  1. No agent: compose says so, Send does nothing but say why, a file
 *     attaches, Escape asks "Keep draft / Discard", the draft waits under
 *     Drafts (the row appears only then).
 *  2. An agent connects: the draft reopens with To prefilled; Send starts a
 *     thread the person wrote, handed to that session alone as a new-thread
 *     wake with the file named; Delivered; the agent's reply_to answer lands
 *     in the same thread.
 *  3. The ⌘K Actions group, the To picker over two projects, and a phone.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in .local/proof/compose/ (and COMPOSE_SHOTS_DIR when set).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_NEW_THREAD_INSTRUCTION,
  inboxWakeText,
  parseInboxBridgeCommands,
  type InboxReplyCommand,
} from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'compose');
const extraShots = process.env.COMPOSE_SHOTS_DIR ? resolve(process.env.COMPOSE_SHOTS_DIR) : null;

interface World {
  root: string;
  dataDir: string;
  url: string;
  ledger: string;
  billing: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  connections: Connection[];
}

let world: World;

function registry(): { port: number; token: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

/** One agent session's connection, as the mod, Pi and OpenCode run it. */
class Connection {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = false;
  private readonly loop: Promise<void>;
  constructor(
    readonly session: string,
    readonly host: string,
    private readonly projectPath: string,
    readonly startedAt: number,
  ) {
    this.loop = this.run();
  }

  bridge(path: string, body: Record<string, unknown>): Promise<Response> {
    const { port, token } = registry();
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session: this.session, host: this.host, ...body }),
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const response = await this.bridge(INBOX_BRIDGE_POLL_PATH, { waitMs: 1_000, project_path: this.projectPath, started_at: this.startedAt, busy: false, idle_since: this.startedAt }).catch(() => null);
      if (!response) continue;
      for (const command of parseInboxBridgeCommands(await response.text())) {
        if (!this.commands.some((known) => known.id === command.id)) this.commands.push(command);
      }
    }
  }

  async deliver(id: string): Promise<void> {
    expect((await this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'delivered', id })).status).toBe(200);
  }

  /** The agent answers in the thread through the Inbox's MCP, as this session. */
  async answer(replyTo: string, body: string): Promise<void> {
    const { port } = registry();
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send_message', arguments: { body, reply_to: replyTo, project_path: this.projectPath, agent_session: this.session, agent_host: this.host } },
      }),
    });
    expect(response.status).toBe(200);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

function connect(session: string, host: string, project: string, startedAt = Date.now() - 45 * 60_000): Connection {
  const connection = new Connection(session, host, project, startedAt);
  world.connections.push(connection);
  return connection;
}

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    const file = join(proofDir, `${name}-${scheme}.png`);
    await page.screenshot({ path: file });
    if (extraShots) copyFileSync(file, join(extraShots, `${name}-${scheme}.png`));
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  if (extraShots) mkdirSync(extraShots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-compose-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const ledger = scratchProject(join(root, 'src'), 'ledger');
  const billing = scratchProject(join(root, 'src'), 'billing');
  const agent = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  await agent.send({ project_path: ledger, subject: 'Run finished: the export streams rows', body: 'The export now streams rows to the file. Peak memory went from 1.9 GB to 140 MB.' });
  writeFileSync(join(root, 'notes.md'), '# Notes\n\nThe screenshot and the export show today’s list.\n');
  world = { root, dataDir, url, ledger, billing, agent, context, page, errors, connections: [] };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.connections.map((c) => c.stop()));
    await world.agent.close().catch(() => {});
    await world.context.close();
    const names = [...new Set(readdirSync(proofDir).filter((f) => f.endsWith('.png')).map((f) => f.replace(/-(light|dark)\.png$/, '')))].sort();
    writeFileSync(
      join(proofDir, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>Inbox compose: proof</title><style>body{font:14px system-ui;margin:24px;background:#e9eaee}h2{font-size:15px;margin:24px 0 8px}.pair{display:flex;gap:12px;align-items:flex-start}.pair img{max-width:calc(50% - 6px);box-shadow:0 0 0 1px #0002;border-radius:6px}</style><h1>Inbox compose: every proved state</h1>${names
        .map((n) => `<section><h2>${n}</h2><div class="pair">${['light', 'dark'].filter((s) => existsSync(join(proofDir, `${n}-${s}.png`))).map((s) => `<img src="${n}-${s}.png" alt="${n} ${s}">`).join('')}</div></section>`)
        .join('\n')}`,
    );
  } finally {
    await removeInboxScratch();
  }
});

test('no agent is running: compose says so, Send sends nothing, a file attaches, and closing asks Keep draft / Discard; the draft waits under Drafts', async () => {
  const { page } = world;
  await page.goto(world.url);
  await expect(page.locator('[data-open-compose]').first()).toBeVisible();
  await expect(page.locator('[data-drafts-nav]')).toHaveCount(0);
  await page.locator('.ib-side [data-open-compose]').click();
  const dialog = page.locator('dialog[data-compose]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-compose-to="none"]')).toHaveText('No agent is running');
  await expect(dialog.locator('[data-compose-note="none"]')).toContainText('Nothing can be sent until one is.');
  // An empty compose closes without asking and creates nothing.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await page.locator('.ib-side [data-open-compose]').click();
  const text = dialog.getByRole('textbox', { name: 'Message' });
  await expect(text).toBeFocused();
  await text.fill('Idea: let the Inbox list show which agent session wrote each thread.\n\nA small chip on each row would do.');
  // The thread chip names it from the message, short, and stays a field the person can type in.
  await expect(dialog.getByRole('textbox', { name: 'Thread name' })).toHaveValue('Inbox list');
  await expect(dialog.locator('[data-compose-thread-name]')).toHaveAttribute('data-compose-thread-name', 'auto');
  await dialog.locator('[data-compose-attach]').setInputFiles(join(world.root, 'notes.md'));
  await expect(dialog.locator('[data-compose-file="done"]')).toHaveCount(1);
  await expect(dialog.locator('[data-compose-file="done"]')).toContainText('Markdown');
  // A dotenv file is refused in its own tile.
  await dialog.locator('[data-compose-attach]').setInputFiles({ name: '.env.local', mimeType: 'text/plain', buffer: Buffer.from('SECRET=1') });
  await expect(dialog.locator('[data-compose-file="refused"]')).toContainText('Not attached: .env files often hold secrets.');
  await dialog.locator('[data-compose-file="refused"] button').click();
  const send = dialog.locator('[data-compose-send]');
  await expect(send).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Meta+Enter');
  await expect(dialog.locator('[data-compose-error]')).toHaveText('Nothing sent: no live agent is chosen. Save it as a draft.');
  await expect(dialog.locator('[data-compose-save]')).toBeVisible();
  await shot(page, '03-no-agent-save-draft');

  // Escape asks first; Escape again goes back to writing; then Keep draft.
  await page.keyboard.press('Escape');
  await expect(dialog.locator('[data-compose-question]')).toContainText('Keep this message as a draft?');
  await shot(page, '03b-close-asks-keep-or-discard');
  await page.keyboard.press('Escape');
  await expect(dialog.locator('[data-compose-question]')).toHaveCount(0);
  await expect(text).toBeFocused();
  await page.keyboard.press('Escape');
  await dialog.locator('[data-compose-keep]').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-inbox-toast]')).toContainText('It waits under Drafts and never sends itself.');
  const nav = page.locator('[data-drafts-nav]');
  await expect(nav).toContainText('Drafts1');
  await nav.click();
  const row = page.locator('[data-draft-id]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-draft-chip]')).toHaveText('No agent chosen');
  await expect(row).toContainText('Idea: let the Inbox list show which agent session wrote…');
  await shot(page, '04-drafts-list');

  // A phone with no agent running: empty, the top bar shows the disabled Send; once something is written,
  // it offers Save draft in Send's place.
  const phone = await world.context.browser()!.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const mobile = await phone.newPage();
  try {
    await mobile.goto(world.url);
    await mobile.locator('.ib-lhead [data-open-compose]').click();
    const sheet = mobile.locator('dialog[data-compose]');
    await expect(sheet.locator('[data-compose-to="none"]')).toBeVisible();
    await expect(sheet.locator('.ib-cp-bar [data-compose-save]')).toHaveCount(0);
    await expect(sheet.locator('.ib-cp-bar [data-compose-send]')).toHaveAttribute('aria-disabled', 'true');
    await sheet.getByRole('textbox', { name: 'Message' }).fill('Idea: let the Inbox list show which agent session wrote each thread.');
    await expect(sheet.locator('.ib-cp-bar [data-compose-save]')).toHaveText('Save draft');
    await expect(sheet.locator('.ib-cp-bar [data-compose-send]')).toHaveCount(0);
    await sheet.getByRole('textbox', { name: 'Message' }).blur();
    await shot(mobile, '10b-phone-no-agent', ['dark', 'light']);
    await sheet.locator('[data-compose-cancel]').click();
    await sheet.locator('[data-compose-discard]').click();
    await expect(sheet).toHaveCount(0);
  } finally {
    await phone.close();
  }
  expect(world.errors).toEqual([]);
});

test('an agent connects: the draft (saved with nobody in To) reopens with To empty; picked, Send starts a thread handed to that session alone, as a new-thread wake naming the file; Delivered; the answer lands in the thread', async () => {
  const { page } = world;
  const claude = connect('ses-claude', 'claude-code', world.ledger);
  const other = connect('ses-other', 'pi', world.billing);
  const row = page.locator('[data-draft-id]');
  await expect(row.locator('[data-draft-chip]')).toHaveText('No agent chosen');
  await row.locator('.ib-draft-open').click();
  const dialog = page.locator('dialog[data-compose]');
  await expect(dialog.locator('h2')).toHaveText('Draft');
  // Saved with nobody in To, it reopens with To empty though two sessions are live: never filled by itself.
  const to = dialog.locator('.ib-cp-tobtn');
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 15_000 });
  await expect(to).toHaveAttribute('data-compose-to', 'choose');
  await expect(to).toBeFocused();
  await expect(dialog.locator('[data-compose-status]')).toHaveText('Choose an agent to send it.');
  await expect(dialog.locator('[data-compose-send]')).toHaveAttribute('aria-disabled', 'true');
  await to.click();
  await expect(dialog.locator('[data-compose-picker]')).toBeVisible();
  // One line per live session (ledger and billing, one each): no project headers, so no start times.
  await expect(dialog.locator('[role="listbox"] > [role="option"]')).toHaveCount(2);
  await expect(dialog.locator('[data-compose-started]')).toHaveCount(0);
  await shot(page, '01-compose-to-picker');
  await dialog.locator('[data-compose-session="ses-claude"]').click();
  await expect(to).toHaveAttribute('data-compose-to', 'ses-claude');
  await expect(dialog.locator('[data-compose-status]')).toHaveCount(0);
  await shot(page, '02-compose-ready-with-file');
  await dialog.locator('[data-compose-send]').click();
  await expect(dialog).toHaveCount(0);
  const toast = page.locator('[data-inbox-toast]');
  await expect(toast.locator('.ib-tdetail')).toHaveText('in ledger');
  await expect(page.locator('[data-inbox-live]')).toHaveText('Sent to Claude Code in ledger. It takes it as its next turn.');
  // The draft is gone; with none left, so is the sidebar row.
  await expect(page.locator('[data-drafts-nav]')).toHaveCount(0);
  await toast.locator('[data-toast-action]').click();

  const command = await waitFor('the new-thread command', () => claude.commands[0]);
  expect(command).toMatchObject({ type: 'message', reply_to: null, new_thread: true, subject: 'Idea: let the Inbox list show which agent session wrote…' });
  expect(inboxWakeText(command).split('\n')[1]).toBe(INBOX_NEW_THREAD_INSTRUCTION);
  expect(command.body).toMatch(/\n\nAttached: notes\.md \(\/.+\/inbox\/uploads\/att_[0-9A-Z]+\/notes\.md\)$/);
  expect(readFileSync(command.body.match(/\((\/.+notes\.md)\)$/)![1]!, 'utf8')).toContain('The screenshot and the export');
  expect(other.commands).toEqual([]);

  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('[data-started-by]')).toHaveText(/You started this thread\s*to Claude Code in ledger/);
  await expect(pane.locator('[data-attachment-name="notes.md"]').first()).toBeVisible();
  // The session's connection polls idle: it takes it within seconds.
  await expect(pane.locator('[data-delivery="sending"]')).toHaveText('Sending to Claude Code…');
  const listRow = page.locator(`.ib-listcol [data-thread-id="${command.thread_id}"]`).first();
  await expect(listRow).toContainText('To Claude Code');
  // The thread's name as compose showed it, the row's title (approval "list-rows-mail-icons").
  await expect(listRow.locator('.ib-title, .ib-m2').first()).toContainText('Inbox list');
  await claude.deliver(command.id);
  await expect(pane.locator('[data-delivery="delivered"]')).toHaveText(/^Delivered to Claude Code, (?:[A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d{2} [AP]M$/);
  await shot(page, '07-thread-delivered');

  await claude.answer(command.id, 'I will add the chip after the export fix lands.');
  await expect(pane.locator('article.ib-message[data-author="agent"]')).toContainText('I will add the chip');
  expect(world.errors).toEqual([]);
});

// The failure this guards (the owner, 2026-10-16: "When I create a new thread
// and hit send, why doesn't it show up in the Sent list? I don't see it in
// the inbox list at all."): with a thread open, the held list took no new
// row, so the thread the person just started was missing until they closed
// the one they were reading.
test('Send with a thread open: the new thread is in Sent at once, "To Claude Code", while the thread stays open and the other rows keep their order', async () => {
  const { page } = world;
  const { port } = registry();
  const list = async () => (await (await fetch(`http://127.0.0.1:${port}/api/inbox/threads?archived=exclude`)).json()) as { sections: { id: string; threads: { thread_id: string; subject: string }[] }[] };
  const reading = (await list()).sections.flatMap((s) => s.threads).find((t) => t.subject.startsWith('Run finished'))!;
  await page.goto(`${world.url}#thread=${reading.thread_id}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane).toBeVisible();
  const rows = () => page.locator('.ib-listcol .ib-lbody [data-thread-id]').evaluateAll((all) => all.map((r) => r.getAttribute('data-thread-id')!));
  await expect.poll(async () => (await rows()).length).toBeGreaterThan(0);
  const before = await rows();
  await page.locator('.ib-side [data-open-compose], .ib-lhead [data-open-compose]').first().click();
  const dialog = page.locator('dialog[data-compose]');
  await dialog.locator('.ib-cp-tobtn').click();
  await dialog.locator('[data-compose-session="ses-claude"]').click();
  await dialog.getByRole('textbox', { name: 'Message' }).fill('While I read this: look at the flaky upload test.');
  await dialog.locator('[data-compose-send]').click();
  await expect(dialog).toHaveCount(0);
  let id = '';
  await expect
    .poll(async () => {
      const sent = (await list()).sections.find((s) => s.id === 'sent')!.threads.find((t) => t.subject.startsWith('While I read this'));
      id = sent?.thread_id ?? '';
      return id;
    })
    .not.toBe('');
  const row = page.locator(`.ib-listcol .ib-lbody [data-section-id="sent"] [data-thread-id="${id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('To Claude Code');
  // The thread being read is still open, and every other row is where it was.
  await expect(pane).toBeVisible();
  expect(page.url()).toContain(reading.thread_id);
  expect((await rows()).filter((t) => t !== id)).toEqual(before);
  await shot(page, '07b-sent-row-while-reading');
  expect(world.errors).toEqual([]);
});

test('⌘K: the Actions group opens compose for "Message <agent> in <project>"; a phone gets the full-screen sheet and the Drafts list', async () => {
  const { page } = world;
  await page.goto(world.url);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const palette = page.locator('dialog[data-search-palette]');
  await expect(palette).toBeVisible();
  await expect(palette.locator('[data-compose-action="new"]')).toBeVisible();
  await page.keyboard.type('pi bill');
  const action = palette.locator('[data-compose-action="message"]');
  await expect(action).toHaveText(/Message Pi in billing/);
  await action.click();
  const dialog = page.locator('dialog[data-compose]');
  await expect(dialog.locator('.ib-cp-tobtn')).toHaveAttribute('data-compose-to', 'ses-other');
  await dialog.getByRole('textbox', { name: 'Message' }).fill('Billing: retry the Stripe webhook on a 409 instead of failing the run.');
  await shot(page, '01b-compose-from-palette');
  // Discard: nothing is kept.
  await page.keyboard.press('Escape');
  await dialog.locator('[data-compose-discard]').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-drafts-nav]')).toHaveCount(0);

  // A phone: the list header's compose icon, the sheet, Save draft from its top bar, the Drafts page.
  const phone = await world.context.browser()!.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const mobile = await phone.newPage();
  try {
    await mobile.goto(world.url);
    await mobile.locator('.ib-lhead [data-open-compose]').click();
    const sheet = mobile.locator('dialog[data-compose]');
    await expect(sheet.locator('.ib-cp-bar h2')).toHaveText('New message');
    // Empty: no Save draft in Send's place, the Send there is disabled.
    await expect(sheet.locator('.ib-cp-tobtn')).not.toHaveAttribute('data-loading', /.*/);
    await expect(sheet.locator('.ib-cp-bar [data-compose-save]')).toHaveCount(0);
    await expect(sheet.locator('.ib-cp-bar [data-compose-send]')).toHaveAttribute('aria-disabled', 'true');
    await sheet.getByRole('textbox', { name: 'Message' }).fill('Rename the Quiet section to “Done”? Quiet reads like “muted” to me.');
    // To starts empty: the top bar offers Save draft until a session is picked.
    await expect(sheet.locator('.ib-cp-tobtn')).toHaveAttribute('data-compose-to', 'choose');
    await expect(sheet.locator('.ib-cp-bar [data-compose-save]')).toHaveText('Save draft');
    await sheet.locator('.ib-cp-tobtn').click();
    await sheet.locator('[data-compose-session="ses-claude"]').click();
    await shot(mobile, '10-phone-compose', ['dark', 'light']);
    await sheet.locator('.ib-cp-bar [data-compose-send]').click();
    await expect(sheet).toHaveCount(0);
    await mobile.goto(`${world.url}#drafts`);
    await expect(mobile.locator('[data-drafts-page]')).toBeVisible();
    // The message went (the session was live): no draft was left.
    await expect(mobile.locator('[data-draft-id]')).toHaveCount(0);
    await mobile.locator('.ib-drafts [data-open-compose], .ib-drafts .ib-lhead-compose').first().click();
    await mobile.locator('dialog[data-compose] [data-compose-text] textarea').fill('A draft kept from a phone.');
    // Kept for a live session (the Drafts page's "is live" chip, later): To is picked, never filled by itself.
    await mobile.locator('dialog[data-compose] .ib-cp-tobtn').click();
    await mobile.locator('dialog[data-compose] [data-compose-session="ses-claude"]').click();
    await mobile.locator('dialog[data-compose] [data-compose-cancel]').click();
    await mobile.locator('dialog[data-compose] [data-compose-keep]').click();
    await expect(mobile.locator('[data-draft-id]')).toHaveCount(1);
    await shot(mobile, '11-phone-drafts', ['dark', 'light']);
  } finally {
    await phone.close();
  }
  expect(world.errors).toEqual([]);
});

test('the session stops before it takes a message: Not delivered, and Send to another session moves it; a draft for a session that ended keeps it, struck through', async () => {
  test.setTimeout(240_000);
  const { page } = world;
  const gone = connect('ses-gone', 'claude-code', world.ledger, Date.now() - 20 * 60_000);
  const stays = world.connections.find((c) => c.session === 'ses-claude')!;
  await page.goto(world.url);
  const dialog = page.locator('dialog[data-compose]');
  // A message to the session that will stop, and a draft for it.
  for (const words of ['Check the retry budget on the relay.', 'Billing: retry the Stripe webhook on a 409 instead of failing the run.']) {
    await page.locator('.ib-side [data-open-compose]').click();
    await dialog.locator('.ib-cp-tobtn').click();
    await dialog.locator('[data-compose-session="ses-gone"]').click();
    await dialog.getByRole('textbox', { name: 'Message' }).fill(words);
    if (words.startsWith('Check')) {
      await dialog.locator('[data-compose-send]').click();
    } else {
      await page.keyboard.press('Escape');
      await dialog.locator('[data-compose-keep]').click();
    }
    await expect(dialog).toHaveCount(0);
  }
  const command = await waitFor('the message to ses-gone', () => gone.commands[0]);
  // A draft with no agent chosen, for the Drafts page's three chips.
  const { port } = registry();
  await fetch(`http://127.0.0.1:${port}/api/inbox/drafts/drf_01M4XZ7Q2V8D9C1X5RZ3N0AB4T`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'Rename the Quiet section to “Done”? Quiet reads like “muted” to me.', to: null, project: { id: null, root: world.ledger, name: 'ledger' }, files: [], base: null }),
  });
  await gone.stop();

  // Not live after 30 s; "ended" once its last poll is a minute old (the asker grace).
  await page.goto(`${world.url}#thread=${command.thread_id}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('[data-delivery="undelivered"]')).toHaveText(
    'Not delivered. That Claude Code session stopped before it took this. If it is resumed, it still gets it.',
    { timeout: 120_000 },
  );
  await shot(page, '08-not-delivered');
  await pane.locator('[data-readdress-open]').click();
  await pane.locator('[data-readdress-session="ses-claude"]').click();
  await shot(page, '08b-send-to-another-session');
  await pane.locator('[data-readdress-send]').click();
  const moved = await waitFor('the moved message', () => stays.commands.find((c) => c.id === command.id));
  expect(moved).toMatchObject({ type: 'message', new_thread: true });
  await stays.deliver(command.id);
  await expect(pane.locator('[data-delivery="delivered"]')).toHaveText(/^Delivered to Claude Code, /);

  await page.goto(`${world.url}#drafts`);
  const ended = page.locator('[data-draft-status="ended"]');
  await expect(ended.locator('[data-draft-chip]')).toHaveText('That session ended');
  await expect(page.locator('[data-draft-status="none"] [data-draft-chip]')).toHaveText('No agent chosen');
  await shot(page, '04b-drafts-three-chips');
  await ended.locator('.ib-draft-open').click();
  await expect(dialog.locator('.ib-cp-tobtn')).toHaveAttribute('data-compose-to', 'ended');
  await expect(dialog.locator('[data-compose-note="ended"]')).toContainText('The Claude Code session this draft was for has ended.');
  await expect(dialog.locator('[data-compose-send]')).toHaveAttribute('aria-disabled', 'true');
  await shot(page, '05-reopened-draft-agent-ended');
  // Never re-addressed on its own: closing unchanged asks nothing and keeps the ended session.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const kept = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/drafts`)).json()) as { drafts: { to: { session: string } | null }[] };
  expect(kept.drafts.map((d) => d.to?.session ?? null)).toContain('ses-gone');
  expect(world.errors).toEqual([]);
});
