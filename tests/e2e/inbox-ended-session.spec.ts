/**
 * Replying when the session that asked has ended (design record "replying
 * when the asking agent's session has ended", not in this repo), proved in a
 * real browser against the compiled binary. Nothing is mocked: the binary
 * runs `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR and
 * HOME, a Pi agent asks through `plannotator inbox mcp` (scripts/inbox-sim.ts),
 * and the agent connections are the bridge's real doors driven as a
 * connection drives them (inbox-new-message.spec.ts has the same harness).
 *
 * Two sessions: the one that asked polls once and stops; a second one keeps
 * polling. The person replies, chooses the second session at Send, and the
 * reply reaches it with the line saying the asker ended. Then the second one
 * stops too, and a reply with nothing live is saved for the next agent.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs, light and dark at 1440 by 900, land in .local/proof/ended-session/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_WAKE_INSTRUCTION,
  inboxRedirectedLine,
  inboxWakeText,
  parseInboxBridgeCommands,
  type InboxReplyCommand,
} from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'ended-session');
const QUESTION = [
  "I'm stopped on the retry policy for `ledger-sync`. About 2% of nights it fails on a lock timeout against the export job.",
  '',
  ':::question',
  'How should the nightly sync retry?',
  '',
  'Stopped: the sync cannot ship without this.',
  '',
  '- [ ] Retry 3 times with backoff',
  '- [ ] Retry once, then page on-call',
  "- [ ] Don't retry; alert only",
  ':::',
].join('\n');

interface World {
  root: string;
  dataDir: string;
  url: string;
  ledger: string;
  pi: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  asker: string;
  connections: Connection[];
}

let world: World;

function registry(): { pid: number; port: number; token: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

/** One agent session's connection: long-polls for what the person sent it, and acknowledges a delivery. */
class Connection {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = false;
  private loop: Promise<void>;
  constructor(
    readonly session: string,
    readonly startedAt: number,
  ) {
    this.loop = this.run();
  }

  private bridge(path: string, body: Record<string, unknown>): Promise<Response> {
    const { port, token } = registry();
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session: this.session, host: 'pi', ...body }),
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const response = await this.bridge(INBOX_BRIDGE_POLL_PATH, {
        waitMs: 1_000,
        project_path: world.ledger,
        started_at: this.startedAt,
        busy: false,
        idle_since: this.startedAt,
      }).catch(() => null);
      if (!response) continue;
      for (const command of parseInboxBridgeCommands(await response.text())) {
        if (!this.commands.some((known) => known.id === command.id)) this.commands.push(command);
      }
    }
  }

  async deliver(id: string): Promise<void> {
    expect((await this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'delivered', id })).status).toBe(200);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
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

async function threadMessages(): Promise<{ id: string; author: { kind: string; session?: string }; to?: { host: string; session: string } | null }[]> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${world.threadId}`);
  return ((await response.json()) as { thread: { messages: never[] } }).thread.messages;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-ended-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const ledger = scratchProject(join(root, 'src'), 'ledger');
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  // Sent as a waking connection sends (the Inbox records `wakes`): only such a session is ever called ended.
  const sent = await pi.send({ project_path: ledger, subject: 'Retry policy for the nightly ledger sync', body: QUESTION }, { wakes: true });
  world = { root, dataDir, url, ledger, pi, context, page, errors, threadId: sent.thread_id as string, asker: '', connections: [] };
  const [first] = await threadMessages();
  world.asker = first!.author.session!;
  expect(world.asker).toMatch(/^ses_/);
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.connections.map((c) => c.stop()));
    await world.pi.close().catch(() => {});
    await world.context.close();
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

test('the asking session stopped and another is live: the thread says so, Send asks where the reply goes, and the picked session is woken with the line saying the asker ended', async () => {
  const { page } = world;
  // The asking session polls once, then stops (it ended); a second Pi session keeps polling.
  const asker = new Connection(world.asker, Date.now() - 60 * 60_000);
  await page.waitForTimeout(1_500);
  await asker.stop();
  const taker = new Connection('pi-session-taker', Date.now() - 20 * 60_000);
  world.connections.push(taker);

  await page.goto(`${world.url}#thread=${world.threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Retry policy for the nightly ledger sync' })).toBeVisible();
  // Ended means 60 s with no poll (the grace), read on the window's 10 s refresh.
  const note = pane.locator('[data-asker-ended="live"]');
  await expect(note).toBeVisible({ timeout: 100_000 });
  await expect(note).toHaveText('The Pi session that asked has ended. When you send, you can pick a live session in ledger to take your reply.');
  await expect(pane.locator('article.ib-message[data-author="agent"] .ib-to').first()).toHaveText('to you · session ended');

  await pane.getByText('Retry 3 times with backoff').click();
  await expect(pane.getByText(/^Picked \d{1,2}:\d{2} [AP]M, not sent$/)).toBeVisible();
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Edit the reply' }).click();
  const box = pane.getByRole('textbox', { name: 'Reply to Pi' });
  const words = 'Go with backoff, but cap the total wait at 10 minutes so it finishes before the 2 AM export.';
  await box.fill(words);
  // The note sits in one always-mounted status region, which describes the box.
  const region = pane.locator('[data-asker-note]');
  await expect(region).toHaveAttribute('role', 'status');
  await expect(box).toHaveAttribute('aria-describedby', (await region.getAttribute('id'))!);
  await shot('1-ended');

  // Send does not send: the choice, the first live session selected and focused.
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  const choice = pane.locator('[data-route-choice]');
  await expect(choice.getByRole('group', { name: 'Where should this reply go?' })).toBeVisible();
  const taking = choice.locator('[data-route-session="pi-session-taker"] input');
  await expect(taking).toBeChecked();
  await expect(taking).toBeFocused();
  const primary = choice.locator('[data-route-send]');
  await expect(primary).toHaveText('Send to Pi');
  await expect(box).toHaveValue(words);
  await shot('2-choose');
  expect((await threadMessages()).filter((m) => m.author.kind === 'person')).toHaveLength(0);

  // Esc with focus on a button of the choice goes back to the reply; the thread stays open.
  await primary.focus();
  await page.keyboard.press('Escape');
  await expect(choice).toHaveCount(0);
  await expect(pane.getByRole('heading', { name: 'Retry policy for the nightly ledger sync' })).toBeVisible();
  await expect(box).toBeFocused();
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(taking).toBeFocused();

  // Arrow keys move the selection and the button follows; Esc goes back with the draft and its choice.
  await page.keyboard.press('ArrowDown');
  await expect(primary).toHaveText('Leave it for the next agent');
  await page.keyboard.press('ArrowUp');
  await expect(primary).toHaveText('Send to Pi');
  await page.keyboard.press('Escape');
  await expect(choice).toHaveCount(0);
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(words);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(pane.locator('[data-route-session="pi-session-taker"] input')).toBeFocused();
  await page.keyboard.press('Enter');

  // The reply, addressed to the picked session, and its wake.
  const command = await waitFor('the redirected reply handed to the second session', () => taker.commands[0]);
  expect(command).toMatchObject({ type: 'reply', thread_id: world.threadId, redirected_from: 'Pi' });
  const lines = inboxWakeText(command).split('\n');
  expect(lines[1]).toBe(INBOX_WAKE_INSTRUCTION);
  expect(lines[2]).toBe(inboxRedirectedLine('Pi', command.id));
  expect((await threadMessages()).at(-1)).toMatchObject({ id: command.id, to: { host: 'pi', session: 'pi-session-taker' } });
  const mine = pane.locator('article.ib-message[data-author="person"]');
  await expect(mine.locator('.ib-to')).toHaveText('to Pi (another session)');
  await expect(pane.locator('[data-delivery="queued"]')).toHaveText('Pi (another session) takes it as its next turn.');

  await taker.deliver(command.id);
  await expect(pane.locator('[data-delivery="delivered"]')).toHaveText(/^Delivered to Pi \(another session\), \d{1,2}:\d{2} [AP]M$/);
  await page.waitForTimeout(2_000);
  expect(taker.commands).toHaveLength(1);
  await shot('4-delivered');
});

test('nothing live: the note says the reply will wait, Send sends at once, and the line says it waits for the next agent', async () => {
  const { page } = world;
  for (const connection of world.connections) await connection.stop();
  world.connections = [];
  // The asking session asks again in the thread (it is still the ended one).
  const messages = await threadMessages();
  await world.pi.send({ project_path: world.ledger, reply_to: messages.at(-1)!.id, body: 'One more: should a failed retry page on-call at night?' }, { wakes: true });
  const pane = page.locator('section.ib-pane');
  const note = pane.locator('[data-asker-ended="none-live"]');
  // The send itself is presence (an MCP call naming the session): ended again 60 s after it.
  await expect(note).toBeVisible({ timeout: 100_000 });
  await expect(note).toHaveText('The Pi session that asked has ended, and no agent is running in ledger now. Your reply will wait here until an agent reads this thread.');
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await pane.getByRole('textbox', { name: 'Reply to Pi' }).fill('Only on the second failure.');
  await shot('3-none-live');
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(pane.locator('[data-route-choice]')).toHaveCount(0);
  await expect(pane.locator('[data-delivery="saved"]')).toHaveText(
    'Saved for Pi. The session that asked has ended, so it waits here until an agent reads this thread.',
  );
  const last = (await threadMessages()).at(-1)!;
  expect(last.author.kind).toBe('person');
  expect(last.to ?? null).toBeNull();
  await shot('3b-none-live-saved');
  expect(world.errors).toEqual([]);
});
