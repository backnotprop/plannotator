/**
 * Tidy (owner-approved design, 2026-10-28), proved in a real browser against
 * the compiled binary. The store is seeded before the Inbox starts (under a
 * temp PLANNOTATOR_DATA_DIR and HOME) so its threads read hours old; the
 * agents' connections are the bridge's real doors driven as a connection
 * drives them (the harness of inbox-reask.spec.ts), and an agent writes
 * through `plannotator inbox mcp` (scripts/inbox-sim.ts) naming its session.
 *
 * Claude Code owes the person a reply (they wrote last 45 min ago) in a
 * thread whose Board card has not moved in 3 days, and has a question the
 * person picked but did not send (theirs to send: never listed); Pi has a
 * question open 4 h and, in a second project, a Board card not moved in 3
 * days; an ended session has a question open 5 h (never offered). The list's
 * ⋮ reads "Tidy 3"; the popover is the agents, their counts and one Tidy
 * button. The Board's ⋮ asks only the cards' owners, and follows the Board's
 * project filter. Tidy wakes each
 * agent once, shows no banner, the rows do not move, the pick is not sent;
 * progress is in the popover: Claude Code answers ("1 thread updated") and
 * Pi, idle after delivery, reads "Nothing to change". The thread note is one
 * line.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs (1440 and 390, light and dark) land in .local/proof/tidy/ (or
 * PLANNOTATOR_E2E_PROOF_DIR/tidy).
 */

import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, inboxWakeText, parseInboxBridgeCommands, type InboxReplyCommand } from '../../packages/shared/inbox/connection';
import { InboxStore } from '../../packages/shared/inbox/store';
import { INBOX_TIDY_INSTRUCTION } from '../../packages/core/inbox-tidy';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'tidy');

const CLAUDE = { kind: 'agent' as const, host: 'claude-code', session: 'ses_e2e_tidy_claude', name: 'Claude Code' };
const PI = { kind: 'agent' as const, host: 'pi', session: 'ses_e2e_tidy_pi', name: 'Pi' };
const ENDED = { kind: 'agent' as const, host: 'claude-code', session: 'ses_e2e_tidy_ended', name: 'Claude Code' };

const q = (prompt: string, choices: string[]) => [':::question', prompt, '', ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  project: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
  /** hover: the person wrote last; release: Claude Code's question with an unsent pick; deploy: Pi's question; ended: the ended session's. */
  t: Record<'hover' | 'release' | 'deploy' | 'ended', { thread: string; message: string }>;
  hoverReply: string;
  /** The projects' ids (the Board's `#board&project=` filter). */
  ids: { billing: string; docs: string };
  connections: Connection[];
  sim: SimAgent | null;
}

let world: World;

function registry(): { port: number; token: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

/** One agent session's connection: long-polls for what the person sent it, and acknowledges a delivery. */
class Connection {
  readonly commands: InboxReplyCommand[] = [];
  busy = false;
  idleSince = Date.now() - 30 * 60_000;
  private stopped = false;
  private loop: Promise<void>;
  constructor(
    readonly session: string,
    readonly host: string,
  ) {
    this.loop = this.run();
  }

  private bridge(path: string, body: Record<string, unknown>): Promise<Response> {
    const { port, token } = registry();
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ session: this.session, host: this.host, ...body }),
    });
  }

  private async run(): Promise<void> {
    const started = Date.now() - 60 * 60_000;
    while (!this.stopped) {
      const response = await this.bridge(INBOX_BRIDGE_POLL_PATH, {
        waitMs: 500,
        project_path: world.project,
        started_at: started,
        busy: this.busy,
        idle_since: this.busy ? null : this.idleSince,
      }).catch(() => null);
      if (!response) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
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

async function waitFor<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

type Message = { id: string; author: { kind: string; session?: string }; tidy?: { id: string; wake: boolean }; to?: { session: string } | null; questions?: { state: string; key: string }[] };
async function threadMessages(threadId: string): Promise<Message[]> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${threadId}`);
  return ((await response.json()) as { thread: { messages: Message[] } }).thread.messages;
}

/** Every row's thread id and text, in list order. */
async function rows(page: Page): Promise<{ id: string; text: string }[]> {
  return page.locator('.ib-lbody [data-thread-id]').evaluateAll((els) => els.map((el) => ({ id: el.getAttribute('data-thread-id') ?? '', text: (el.textContent ?? '').replace(/\s+/g, ' ').trim() })));
}

/** Seeds the store (before the Inbox starts) with the threads, read hours old. */
function seed(dataDir: string, project: string, docsProject: string, now: number): World['t'] & { hoverReply: string; ids: World['ids'] } {
  let clock = now;
  const store = InboxStore.open(dataDir, { now: () => new Date(clock) });
  const at = (minutesAgo: number) => {
    clock = now - minutesAgo * 60_000;
  };
  const projectId = store.ensureProject({ root: project, name: 'billing' }).id;
  const docsId = store.ensureProject({ root: docsProject, name: 'docs' }).id;
  const send = (author: typeof CLAUDE, subject: string, body: string, inProject = projectId) => {
    const m = store.sendMessage({ project_id: inProject, author, subject, thread: subject, body } as never).message;
    store.markSeen(m.thread_id);
    return { thread: m.thread_id, message: m.id };
  };
  at(5 * 60);
  const ended = send(ENDED, 'Seat limits copy', q('Say "seats" or "members" on the limits page?', ['Seats', 'Members']));
  at(4 * 60);
  const deploy = send(PI, 'Docs site to production', q('Deploy the docs site to production tonight?', ['Tonight', 'Tomorrow morning']));
  at(3 * 60 + 30);
  const release = send(CLAUDE, 'Release notes for 0.29', q('Put the Board in the 0.29 release notes?', ['Yes, as experimental', 'Leave it out']));
  at(3 * 60);
  const relQ = store.questionsOf(release.message)[0]!;
  store.savePicks(release.message, [{ key: relQ.key, revision: relQ.revision, answer: { v: 1, key: relQ.key, kind: 'single', prompt: relQ.prompt, selected: ['Yes, as experimental'] } } as never]);
  at(3 * 24 * 60);
  const hover = send(CLAUDE, 'Hover cards on review surfaces', 'Hover cards are in on all three review surfaces. I will send pictures of the light, dark and phone passes once the dark pass is done.');
  store.createCard({ project_id: projectId, by: CLAUDE, title: 'Hover cards on review surfaces', column: 'designing', say: 'Sending pictures soon', threads: [hover.thread] });
  // Pi's card in the other project, not moved in 3 days either: the Board's project filter leaves it out.
  const nav = send(PI, 'Docs sidebar order', 'Started on the docs sidebar order.', docsId);
  store.createCard({ project_id: docsId, by: PI, title: 'Docs sidebar order', column: 'building', say: 'Reordering the sidebar', threads: [nav.thread] });
  at(45);
  const reply = store.sendReply(hover.message, { words: 'Still waiting on those pictures. Did the phone pass happen?', idempotency_key: 'e2e-tidy-hover' });
  at(44);
  store.recordDelivery(reply.reply!.id, { host: CLAUDE.host, session: CLAUDE.session });
  return { hover, release, deploy, ended, hoverReply: reply.reply!.id, ids: { billing: projectId, docs: docsId } };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-tidy-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const project = scratchProject(join(root, 'src'), 'billing');
  const now = Date.now();
  const { hoverReply, ids, ...t } = seed(dataDir, project, scratchProject(join(root, 'src'), 'docs'), now);
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      inboxTour: { version: 2, seen_at: new Date(now).toISOString(), skipped_at: new Date(now).toISOString() },
      inboxNotifications: { dismissed: true },
      inboxSound: { dialogShownFor: 'tidy-e2e' },
      inboxBoard: true,
      inboxBoardIntro: { shownAt: new Date(now).toISOString() },
      inboxAgentNotes: { offered: true },
    }),
  );
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { root, dataDir, env, url: started.stdout.trim(), project, context, page, errors, t, hoverReply, ids, connections: [], sim: null };
  // Claude Code and Pi are live (their connections poll); the ended session has none.
  world.connections.push(new Connection(CLAUDE.session, CLAUDE.host), new Connection(PI.session, PI.host));
  // Let both connections register before the window reads who it would ask.
  await new Promise((r) => setTimeout(r, 1_500));
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.connections.map((c) => c.stop()));
    await world.sim?.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the list: ⋮ holds Tidy 3 and Refresh; the popover asks the live agents, never the ended session', async () => {
  const { page } = world;
  await page.goto(world.url);
  const trigger = page.locator('.ib-lhead [data-tidy-menu]');
  await expect(trigger).toBeVisible();
  await expect(page.locator(`.ib-lbody [data-thread-id="${world.t.deploy.thread}"]`).first()).toBeVisible();
  await shot(page, 'list-menu-closed-1440');
  await trigger.click();
  const item = page.locator('[data-tidy-item]');
  await expect(item).toHaveText(/^Tidy\s*3$/);
  await expect(item).not.toHaveAttribute('data-disabled', /.*/);
  await expect(page.locator('[data-tidy-refresh]')).toHaveText('Refresh');
  await shot(page, 'list-menu-open-1440');
  await item.click();
  const pop = page.locator('[data-tidy-popover]');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.ib-tidy-top')).toHaveText(/Tidy\s*3 threads/);
  await expect(pop.locator(`[data-tidy-agent="${CLAUDE.session}"]`)).toContainText('Claude Code1');
  await expect(pop.locator(`[data-tidy-agent="${PI.session}"]`)).toContainText('Pi2');
  await expect(pop.locator(`[data-tidy-agent="${ENDED.session}"]`)).toHaveCount(0);
  // Nothing else in it: the agents, their counts, one Tidy button.
  await expect(pop.getByRole('button')).toHaveCount(1);
  await shot(page, 'list-popover-1440');
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('the Board: its ⋮ asks only the agents whose cards have not moved, and follows the Board\'s project filter', async () => {
  const { page } = world;
  await page.goto(`${world.url}#board`);
  const trigger = page.locator('.ib-bhead [data-tidy-menu]');
  await expect(trigger).toBeVisible();
  await shot(page, 'board-menu-closed-1440');
  await trigger.click();
  // Every project: Claude Code's card in billing and Pi's in docs; not Pi's question (no card).
  await expect(page.locator('[data-tidy-item]')).toHaveText(/^Tidy\s*2$/);
  await shot(page, 'board-menu-open-1440');
  await page.locator('[data-tidy-item]').click();
  const pop = page.locator('[data-tidy-popover]');
  await expect(pop.locator(`[data-tidy-agent="${CLAUDE.session}"]`)).toContainText('Claude Code1');
  await expect(pop.locator(`[data-tidy-agent="${PI.session}"]`)).toContainText('Pi1');
  await shot(page, 'board-popover-1440');
  await page.keyboard.press('Escape');

  // Filtered to billing: only the card in view, so only Claude Code.
  await page.goto(`${world.url}#board&project=${world.ids.billing}`);
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.locator('[data-tidy-item]')).toHaveText(/^Tidy\s*1$/);
  await page.locator('[data-tidy-item]').click();
  await expect(pop.locator(`[data-tidy-agent="${CLAUDE.session}"]`)).toContainText('Claude Code1');
  await expect(pop.locator(`[data-tidy-agent="${PI.session}"]`)).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('a phone: the ⋮ and the popover as a bottom sheet, on the list and the Board', async ({ browser }: { browser: Browser }) => {
  const { defaultBrowserType: _, ...iphone } = devices['iPhone 13'];
  const context = await browser.newContext({ ...iphone, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(world.url);
    const trigger = page.locator('.ib-lhead [data-tidy-menu]');
    await expect(trigger).toBeVisible();
    const box = await trigger.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    await shot(page, 'list-menu-closed-390');
    await trigger.click();
    await expect(page.locator('[data-tidy-item]')).toBeVisible();
    await shot(page, 'list-menu-open-390');
    await page.locator('[data-tidy-item]').click();
    const pop = page.locator('[data-tidy-popover]');
    await expect(pop).toBeVisible();
    const sheet = await pop.boundingBox();
    expect(sheet!.x).toBeLessThanOrEqual(8.5);
    expect(sheet!.width).toBeGreaterThan(360);
    await shot(page, 'list-popover-390');
    await page.keyboard.press('Escape');
    await page.goto(`${world.url}#board`);
    const boardTrigger = page.locator('.ib-bhead [data-tidy-menu]');
    await expect(boardTrigger).toBeVisible();
    await shot(page, 'board-menu-closed-390');
    await boardTrigger.click();
    await expect(page.locator('[data-tidy-item]')).toBeVisible();
    await shot(page, 'board-menu-open-390');
    await page.locator('[data-tidy-item]').click();
    await expect(page.locator('[data-tidy-popover]')).toBeVisible();
    await shot(page, 'board-popover-390');
  } finally {
    await context.close();
  }
});

/** Opens ⋮ → Tidy and answers the popover. */
async function openTidy(page: Page) {
  await page.locator('.ib-lhead [data-tidy-menu]').click();
  await page.locator('[data-tidy-item]').click();
  const pop = page.locator('[data-tidy-popover]');
  await expect(pop).toBeVisible();
  return pop;
}

/** Shows every message of the open thread (a long thread folds its middle). */
async function expandThread(page: Page) {
  const expand = page.locator('section.ib-pane').getByRole('button', { name: 'Expand all messages' });
  if ((await expand.count()) > 0) await expand.click();
}

test('Tidy: one wake per agent, no banner, the rows stay put, the pick is not sent; progress in the popover', async () => {
  const { page } = world;
  const [claude, pi] = world.connections as [Connection, Connection];
  await page.goto(world.url);
  await expect(page.locator(`.ib-lbody [data-thread-id="${world.t.deploy.thread}"]`).first()).toBeVisible();
  // The hover thread (the person wrote last) sits in Quiet: open it so its row is compared too.
  await page.locator('.ib-lbody').getByRole('button', { name: /^Quiet/ }).click();
  await expect(page.locator(`.ib-lbody [data-thread-id="${world.t.hover.thread}"]`).first()).toBeVisible();
  const before = await rows(page);
  const releaseBefore = (await threadMessages(world.t.release.thread))[0]!.questions!;
  expect(releaseBefore[0]!.state).toBe('picked');

  const start = await openTidy(page);
  await start.locator('[data-tidy-go]').click();
  await expect(page.locator('[data-tidy-popover]')).toHaveCount(0);

  // Each live agent is handed one Tidy wake, worded for it.
  const claudeWake = await waitFor('the Tidy wake for Claude Code', () => claude.commands.find((c) => c.tidy === true));
  const piWake = await waitFor('the Tidy wake for Pi', () => pi.commands.find((c) => c.tidy === true));
  const text = inboxWakeText(claudeWake);
  expect(text.split('\n')[0]).toBe(`Plannotator Inbox: Tidy (${claudeWake.id})`);
  expect(text).toContain(INBOX_TIDY_INSTRUCTION);
  expect(text).toContain(`(reply_to ${world.hoverReply})`);
  expect(claude.commands.filter((c) => c.tidy === true)).toHaveLength(1);
  expect(pi.commands.filter((c) => c.tidy === true)).toHaveLength(1);
  expect(inboxWakeText(piWake)).not.toContain('Hover cards');

  // No banner; the rows did not move, nor change, for the notes.
  await page.waitForTimeout(800);
  expect(await rows(page)).toEqual(before);
  await expect(page.locator('.ib-lbody').getByText(/Tidy ·/)).toHaveCount(0);
  // The unsent pick was not sent: still a pick, and no answer from the person.
  const release = await threadMessages(world.t.release.thread);
  expect(release[0]!.questions![0]!.state).toBe('picked');
  expect(release.filter((m) => m.author.kind === 'person' && !m.tidy)).toHaveLength(0);
  expect(release.some((m) => m.tidy)).toBe(false);
  expect(text).not.toContain('Release notes for 0.29');
  // The ended session's thread got nothing.
  expect((await threadMessages(world.t.ended.thread)).some((m) => m.tidy)).toBe(false);

  // While it goes: the menu item reads its progress, the popover each agent's state.
  await page.locator('.ib-lhead [data-tidy-menu]').click();
  await expect(page.locator('[data-tidy-item]')).toHaveText(/^Tidy · [0-1]\/2$/);
  await page.locator('[data-tidy-item]').click();
  const during = page.locator('[data-tidy-popover]');
  await expect(during.locator(`[data-tidy-run-agent="${CLAUDE.session}"]`)).toBeVisible();
  await expect(during.locator('[data-tidy-go]')).toHaveCount(0);
  await shot(page, 'run-popover-1440');
  await page.keyboard.press('Escape');

  // Claude Code answers in the hover thread; Pi, idle after delivery, writes nothing.
  await claude.deliver(claudeWake.id);
  await pi.deliver(piWake.id);
  world.sim = await SimAgent.connect({ binary, env: world.env, name: 'Claude Code', host: 'claude-code' });
  await world.sim.send({ project_path: world.project, reply_to: world.hoverReply, body: 'Here are the pictures I promised: light, dark and the 390 px phone pass.', agent_session: CLAUDE.session } as never);
  pi.busy = true;
  await page.waitForTimeout(1_200);
  pi.idleSince = Date.now();
  pi.busy = false;

  await page.locator('.ib-lhead [data-tidy-menu]').click();
  await expect(page.locator('[data-tidy-item]')).toHaveText('Tidy · 2/2', { timeout: 20_000 });
  await page.locator('[data-tidy-item]').click();
  const after = page.locator('[data-tidy-popover]');
  await expect(after.locator(`[data-tidy-run-agent="${PI.session}"]`)).toContainText('Nothing to change');
  await expect(after.locator(`[data-tidy-run-agent="${CLAUDE.session}"]`)).toContainText('1 thread updated');
  await shot(page, 'run-popover-done-1440');
  await page.keyboard.press('Escape');

  // The note in its thread: one quiet line, nothing to open.
  await page.goto(`${world.url}#thread=${world.t.hover.thread}`);
  await expandThread(page);
  const note = page.locator('section.ib-pane [data-tidy-note]');
  await expect(note).toHaveText(/^Tidy sent to Claude Code · \d{1,2}:\d{2} [AP]M$/);
  await expect(note.locator('summary, pre, button')).toHaveCount(0);
  await note.scrollIntoViewIfNeeded();
  await shot(page, 'thread-note-1440');
  expect(world.errors).toEqual([]);
});

test('a phone after the run: the run in the popover and the thread note', async ({ browser }: { browser: Browser }) => {
  const { defaultBrowserType: _, ...iphone } = devices['iPhone 13'];
  const context = await browser.newContext({ ...iphone, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(world.url);
    await expect(page.locator(`.ib-lbody [data-thread-id="${world.t.deploy.thread}"]`).first()).toBeVisible();
    const pop = await openTidy(page);
    await expect(pop.locator(`[data-tidy-run-agent="${PI.session}"]`)).toContainText('Nothing to change');
    await shot(page, 'run-popover-done-390');
    await page.keyboard.press('Escape');
    await page.goto(`${world.url}#thread=${world.t.hover.thread}`);
    await expandThread(page);
    await expect(page.locator('[data-tidy-note]')).toBeVisible();
    await page.locator('[data-tidy-note]').scrollIntoViewIfNeeded();
    await shot(page, 'thread-note-390');
  } finally {
    await context.close();
  }
});
