/**
 * Ask, Add or Hand off from the reply box's one line (approval
 * "inbox-tag-handoff", option A2), proved in a real browser against the
 * compiled binary.
 *
 * Nothing is mocked: the binary runs `plannotator inbox --background` under a
 * temp PLANNOTATOR_DATA_DIR and HOME, with the tag world of inbox-tags.spec.ts
 * (tests/helpers/inbox-tag-world.ts): live connections poll the bridge's real
 * doors as the Claude Code mod, Pi and OpenCode do. Claude Code in
 * billing-api owns the threads. The person picks a tag in the window's own
 * reply box and switches the line with its links.
 *
 * The Undo window is the binary's own (10 s), so the hand-off tests wait it out.
 *
 * PNGs (1440 and 390, light and dark) land in .local/proof/tag-handoff/, or
 * in PLANNOTATOR_TAG_HANDOFF_SHOTS when it names a folder.
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  INBOX_ADDED_INSTRUCTION,
  INBOX_HANDOFF_INSTRUCTION,
  INBOX_TAGGED_INSTRUCTION,
  inboxHandedAwayLine,
  inboxWakeText,
} from '../../packages/shared/inbox/connection';
import { seedTagWorld, TAG_SESSIONS, type TagWorld } from '../helpers/inbox-tag-world';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_TAG_HANDOFF_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'tag-handoff'));
const S = TAG_SESSIONS;
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: 'reduce' as const };

interface World {
  url: string;
  tags: TagWorld;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

type Tag = { host?: string; session: string; label?: string; wakes: boolean; joined?: boolean; handed_away?: boolean; delivery?: { at: string } | null };
type Message = {
  id: string;
  body: string;
  reply_to?: string;
  to?: { host?: string; session: string };
  tags?: Tag[];
  handoff?: { label?: string; settled_at?: string; undone_at?: string } | null;
  author: { kind: string; session?: string };
};

async function messages(threadId: string): Promise<Message[]> {
  return ((await (await fetch(`${world.url}/api/inbox/threads/${threadId}`)).json()) as { thread: { messages: Message[] } }).thread.messages;
}
const lastPersonMessage = async (threadId: string) => (await messages(threadId)).filter((m) => m.author.kind === 'person').at(-1)!;
const connection = (session: string) => world.tags.connections.find((c) => c.session === session)!;
const handed = (session: string, id: string) => connection(session).commands.find((c) => c.id === id);

/** An agent writing in a thread through the Inbox's own /mcp, as its plugin does. */
async function agentWrites(args: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${world.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: args, _meta: { 'ai.plannotator/inbox-wakes': true } } }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(text).not.toContain('"isError":true');
}

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Open a thread and its reply box, empty. */
async function openReply(page: Page, threadId: string): Promise<Locator> {
  await page.goto(`${world.url}#thread=${threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('h2.ib-subject')).toBeVisible();
  const box = pane.getByRole('textbox', { name: /^Reply to/ });
  const reply = pane.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
  for (let attempt = 0; attempt < 10 && !(await box.isVisible()); attempt += 1) {
    await reply.click({ timeout: 1_000 }).catch(() => {});
  }
  await expect(box).toBeVisible();
  await box.fill('');
  return box;
}

/** Type `@query`, arrow onto the row of `session`, and pick it: the picker's own keys. */
async function tag(page: Page, box: Locator, query: string, session: string): Promise<void> {
  await box.pressSequentially(`@${query}`);
  await expect(page.locator(`[data-tag-option="${session}"]`)).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('ArrowDown');
    if ((await page.locator('[data-tag-option][aria-selected="true"]').getAttribute('data-tag-option')) === session) break;
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-tag-picker]')).toHaveCount(0);
  await page.waitForTimeout(80);
}

const line = (page: Page) => page.locator('[data-tag-mode]');
const words = (page: Page) => page.locator('[data-tag-mode-words]');
const links = (page: Page) => page.locator('[data-tag-mode-to]');

async function send(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Enter');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-handoff-e2e-');
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/$/, '');
  const { token } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { token: string };
  const tags = await seedTagWorld(url, token, join(root, 'projects'));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { url, tags, context, page, errors };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.tags.stop();
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('Ask, unchanged: the line offers the switches, and Send with none clicked is today\'s tag', async () => {
  const { page } = world;
  const box = await openReply(page, world.tags.ids.t1);
  await box.pressSequentially('Queue it, and cap retries at 5. ');
  await tag(page, box, 'Pi', S.pi);
  await box.pressSequentially('raise the visibility timeout in infra/queue.tf to 30 s.');
  await expect(line(page)).toHaveAttribute('data-tag-mode', 'ask');
  await expect(words(page)).toHaveText('Asks Pi');
  await expect(links(page)).toHaveText(['Add instead', 'Hand off instead']);
  await shot(page, '1-picked-ask-desktop');
  await send(page);
  await expect(line(page)).toHaveCount(0);
  const sent = await lastPersonMessage(world.tags.ids.t1);
  expect(sent.body).toContain('raise the visibility timeout');
  // The wire and the store as before: a plain tag, no hand-off, addressed to whom it answers.
  expect(sent.tags?.map((t) => [t.session, t.wakes, t.joined ?? false, t.handed_away ?? false])).toEqual([[S.pi, true, false, false]]);
  expect(sent.handoff ?? null).toBeNull();
  expect(sent.to?.session ?? S.owner).toBe(S.owner);
  await expect.poll(() => !!handed(S.pi, sent.id), { timeout: 15_000 }).toBe(true);
  expect(handed(S.pi, sent.id)!.added).toBeUndefined();
  expect(handed(S.pi, sent.id)!.handoff).toBeUndefined();
  expect(inboxWakeText(handed(S.pi, sent.id)!).split('\n')[1]).toBe(INBOX_TAGGED_INSTRUCTION);
  await expect.poll(() => !!handed(S.owner, sent.id), { timeout: 15_000 }).toBe(true);
  expect(handed(S.owner, sent.id)!.handed_away).toBeUndefined();
  // The thread after an Ask looks as before: no move line, no new owner.
  await expect(page.locator('[data-thread-move]')).toHaveCount(0);
  await expect(page.locator('[data-thread-owner]')).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test('Add: the agent joins with the added wake, the thread says so, and a later plain reply reaches it too', async () => {
  const { page } = world;
  const box = await openReply(page, world.tags.ids.t3);
  await box.pressSequentially('Keep an eye on this. ');
  await tag(page, box, 'OpenCode', S.opencode);
  await box.pressSequentially('watch the search index while the queue changes.');
  await page.locator('[data-tag-mode-to="add"]').click();
  await expect(line(page)).toHaveAttribute('data-tag-mode', 'add');
  await expect(words(page)).toHaveText('Adds OpenCode to this thread');
  await expect(links(page)).toHaveText(['Ask instead']);
  await shot(page, '2-switched-add-desktop');
  await send(page);
  await expect(page.locator('[data-thread-move="added"]')).toContainText('You added OpenCode to this thread');
  await expect(page.locator('[data-thread-owner]')).toHaveCount(0);
  const sent = await lastPersonMessage(world.tags.ids.t3);
  expect(sent.tags).toEqual([expect.objectContaining({ session: S.opencode, joined: true })]);
  await expect.poll(() => !!handed(S.opencode, sent.id), { timeout: 15_000 }).toBe(true);
  expect(handed(S.opencode, sent.id)).toMatchObject({ added: true, tagged: { owner: 'Claude Code' } });
  expect(inboxWakeText(handed(S.opencode, sent.id)!).split('\n')[1]).toBe(INBOX_ADDED_INSTRUCTION);
  // The owner keeps the thread: a plain reply, no tag typed, goes to it and to the added session.
  const again = await openReply(page, world.tags.ids.t3);
  await again.pressSequentially('Also check the retry counts.');
  await expect(line(page)).toHaveCount(0);
  await send(page);
  await expect.poll(async () => (await lastPersonMessage(world.tags.ids.t3)).body).toBe('Also check the retry counts.');
  const later = await lastPersonMessage(world.tags.ids.t3);
  expect(later.tags?.map((t) => t.session)).toEqual([S.opencode]);
  await expect.poll(() => !!handed(S.opencode, later.id), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => !!handed(S.owner, later.id), { timeout: 15_000 }).toBe(true);
  expect(world.errors).toEqual([]);
});

test('Hand off, then Undo inside the window: nobody is handed it while held, and Undo sends it as an Ask', async () => {
  const { page } = world;
  const box = await openReply(page, world.tags.ids.t1);
  await box.pressSequentially('This is the queue side. ');
  await tag(page, box, 'Pi', S.pi);
  await box.pressSequentially('can you take this?');
  await page.locator('[data-tag-mode-to="handoff"]').click();
  await expect(line(page)).toHaveAttribute('data-tag-mode', 'handoff');
  await expect(words(page)).toHaveText('Hands this thread to Pi');
  await expect(links(page)).toHaveText(['Ask instead']);
  await expect(page.locator('section.ib-pane').getByRole('textbox', { name: 'Reply to Pi' })).toBeVisible();
  await shot(page, '3-switched-handoff-desktop');
  await send(page);
  const move = page.locator('[data-thread-move="handoff"]');
  await expect(move).toContainText('You handed this thread to Pi');
  await expect(move.locator('[data-handoff-undo]')).toBeVisible();
  await expect(page.locator('[data-inbox-toast]')).toContainText('Handed to Pi');
  await expect(page.locator('[data-thread-owner]')).toContainText('Now with Pi');
  await shot(page, '4-after-send-undo-desktop');
  const sent = await lastPersonMessage(world.tags.ids.t1);
  expect(sent.to).toEqual({ host: 'pi', session: S.pi });
  // Held: neither side is handed it inside the window.
  await page.waitForTimeout(2_000);
  expect(handed(S.pi, sent.id)).toBeUndefined();
  expect(handed(S.owner, sent.id)).toBeUndefined();
  await move.locator('[data-handoff-undo]').click();
  await expect.poll(async () => !!(await lastPersonMessage(world.tags.ids.t1)).handoff?.undone_at).toBe(true);
  const undone = await lastPersonMessage(world.tags.ids.t1);
  expect(undone.id).toBe(sent.id);
  expect(undone.body).toContain('can you take this?');
  expect(undone.tags?.map((t) => [t.session, t.handed_away ?? false])).toEqual([[S.pi, false]]);
  await expect(page.locator('[data-thread-move]')).toHaveCount(0);
  await expect(page.locator('[data-thread-owner]')).toHaveCount(0);
  // As an Ask, at once: Pi tagged, the owner as before, nobody told to stop.
  await expect.poll(() => !!handed(S.pi, sent.id), { timeout: 15_000 }).toBe(true);
  expect(handed(S.pi, sent.id)!.handoff).toBeUndefined();
  expect(handed(S.pi, sent.id)!.tagged).toEqual({ owner: 'Claude Code' });
  await expect.poll(() => !!handed(S.owner, sent.id), { timeout: 15_000 }).toBe(true);
  expect(handed(S.owner, sent.id)!.handed_away).toBeUndefined();
  expect(world.errors).toEqual([]);
});

test('Hand off settles: the new owner gets the hand-off wake, the former owner only the stop notice, and the next reply goes to the new owner', async () => {
  const { page } = world;
  const box = await openReply(page, world.tags.ids.t1);
  await box.pressSequentially('Over to you. ');
  await tag(page, box, 'Pi', S.pi);
  await box.pressSequentially('the queue work is yours now.');
  await page.locator('[data-tag-mode-to="handoff"]').click();
  await send(page);
  await expect(page.locator('[data-thread-move="handoff"] [data-handoff-undo]')).toBeVisible();
  const sent = await lastPersonMessage(world.tags.ids.t1);
  // The window ends (10 s), then each side is handed its part.
  await expect.poll(async () => !!(await lastPersonMessage(world.tags.ids.t1)).handoff?.settled_at, { timeout: 25_000 }).toBe(true);
  await expect.poll(() => !!handed(S.pi, sent.id), { timeout: 15_000 }).toBe(true);
  const piWake = inboxWakeText(handed(S.pi, sent.id)!).split('\n');
  expect(handed(S.pi, sent.id)!.handoff).toEqual({ from: 'Claude Code' });
  expect(piWake[1]).toBe(INBOX_HANDOFF_INSTRUCTION);
  expect(piWake.join('\n')).toContain('the queue work is yours now.');
  await expect.poll(() => !!handed(S.owner, sent.id), { timeout: 15_000 }).toBe(true);
  const told = handed(S.owner, sent.id)!;
  expect(told.handed_away).toEqual({ to: 'Pi' });
  expect(told.body).toBe(inboxHandedAwayLine('Pi'));
  expect(inboxWakeText(told)).not.toContain('the queue work is yours now.');
  // The thread after the hand-off: who has it, no Undo any more.
  await expect(page.locator('[data-thread-owner]')).toContainText('Now with Pi');
  await expect(page.locator('[data-handoff-undo]')).toHaveCount(0);
  // The former owner's line: told to stop when its turn ends, with no Send now (the notice never interrupts a turn).
  const formerLine = page.locator(`[data-tag-line="${S.owner}"]`);
  await expect(formerLine).toContainText('Claude Code (billing-api) is told to stop when its turn ends.');
  await expect(formerLine.locator('[data-send-now]')).toHaveCount(0);
  // The former owner's stop notice is not shown as a tag the person typed.
  const handOffMessage = page.locator('article.ib-message').filter({ hasText: 'the queue work is yours now.' });
  await expect(handOffMessage).toHaveCount(1);
  await expect(handOffMessage).toContainText('to Pi');
  await expect(handOffMessage.locator('[data-tagged-names]')).toHaveCount(0);
  await shot(page, '5-thread-after-handoff-desktop');

  // The former owner writes again; the person's next reply still goes to Pi.
  await agentWrites({ agent_host: 'claude-code', agent_name: 'Claude Code', project_path: world.tags.projects.billing, agent_session: S.owner, reply_to: world.tags.ids.t1msg, body: 'Noted, stopping here.' });
  const next = await openReply(page, world.tags.ids.t1);
  await expect(page.locator('section.ib-pane').getByRole('textbox', { name: /^Reply to Pi/ })).toBeVisible();
  await next.pressSequentially('Ship it with tonight\'s infra release.');
  await send(page);
  await expect.poll(async () => (await lastPersonMessage(world.tags.ids.t1)).body).toBe('Ship it with tonight\'s infra release.');
  const after = await lastPersonMessage(world.tags.ids.t1);
  expect(after.to).toEqual({ host: 'pi', session: S.pi });
  await expect.poll(() => !!handed(S.pi, after.id), { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(1_500);
  expect(handed(S.owner, after.id)).toBeUndefined();
  expect(world.errors).toEqual([]);
});

test('on a phone: the same line, links at 44 px inside 390 px, and a hand-off with its Undo', async ({ browser }) => {
  const context = await browser.newContext({ ...PHONE, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const box = await openReply(page, world.tags.ids.t2);
    await box.pressSequentially('Take the alert. ');
    await tag(page, box, 'OpenCode', S.opencode);
    await box.pressSequentially('the runbook needs it.');
    await expect(words(page)).toHaveText('Asks OpenCode');
    for (const el of await page.locator('[data-tag-mode], [data-tag-mode] *').all()) {
      const b = (await el.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
    }
    for (const link of await links(page).all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shot(page, '1-picked-ask-phone');
    await page.locator('[data-tag-mode-to="add"]').click();
    await expect(words(page)).toHaveText('Adds OpenCode to this thread');
    await shot(page, '2-switched-add-phone');
    await page.locator('[data-tag-mode-to="ask"]').click();
    await page.locator('[data-tag-mode-to="handoff"]').click();
    await expect(words(page)).toHaveText('Hands this thread to OpenCode');
    await shot(page, '3-switched-handoff-phone');
    await send(page);
    const undo = page.locator('[data-thread-move="handoff"] [data-handoff-undo]');
    await expect(undo).toBeVisible();
    expect((await undo.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shot(page, '4-after-send-undo-phone');
    await expect.poll(async () => !!(await lastPersonMessage(world.tags.ids.t2)).handoff?.settled_at, { timeout: 25_000 }).toBe(true);
    await expect(page.locator('[data-handoff-undo]')).toHaveCount(0);
    await expect(page.locator('[data-thread-owner]')).toContainText('Now with OpenCode');
    await shot(page, '5-thread-after-handoff-phone');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
