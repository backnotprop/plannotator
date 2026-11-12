import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { writeInboxAsk, type InboxAskConversation } from '../../packages/shared/inbox/ask';
import { scratchProject } from '../../scripts/inbox-sim';
import { startScriptedAskAgent, type ScriptedAskAgent } from '../helpers/inbox-ask-agent';
import { aiSession, postAsk, readAsk, runQuery, type AskAnswer } from '../helpers/inbox-ask-window';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/ask-window'));

const QUESTION = 'Why five attempts and not a time limit?';
const ANSWER = [
  "Five attempts with a 1, 2, 4, 8 and 16 second backoff keeps the worst case at about 31 seconds, under the relay's 60 second push timeout.",
  '',
  'A time limit is easier to explain, but a slow first attempt could use the whole budget and leave no retry at all.',
].join('\n');
const ANSWER_SHOWS = 'keeps the worst case at about 31 seconds';

interface World {
  root: string;
  dataDir: string;
  url: string;
  target: { port: number; serverSession: string };
  threads: Record<'push' | 'search' | 'invoice' | 'webhook' | 'migration' | 'keys', string>;
  projects: Record<'relay' | 'web' | 'billing', string>;
  token: string;
  send: (project: string, session: string, host: string, name: string, subject: string, body: string) => Promise<string>;
  agents: ScriptedAskAgent[];
  client: Client;
  context: BrowserContext;
  page: Page;
  errors: string[];
  held: AbortController;
}

let world: World;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const savedChat = (threadId: string, session: string, host: string, minutes: number, question: string, answer: string | null, seen: boolean): InboxAskConversation => {
  const answeredAt = minutesAgo(minutes);
  return {
    v: 1,
    thread_id: threadId,
    seen_at: seen ? answeredAt : null,
    turns: [
      {
        id: `saved-${threadId.slice(-12)}`,
        at: minutesAgo(minutes + 1),
        session,
        host,
        question,
        ...(answer ? { answer, answered_at: answeredAt } : {}),
      },
    ],
  };
};

async function shot(page: Page, name: string, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}

const askIcon = (page = world.page) => page.locator('section.ib-pane [data-ask-open], section.ib-pane .ib-phead [aria-label="Ask AI about this thread"]');
const side = (page = world.page) => page.locator('.annotation-toolbar [data-annotation-side]');

async function selectInThread(page: Page, words: string): Promise<void> {
  const box = await page.evaluate((needle) => {
    const root = document.querySelector('section.ib-pane .ib-body');
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(needle) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const rects = [...range.getClientRects()];
      const first = rects[0]!;
      const last = rects[rects.length - 1]!;
      return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
    }
    return null;
  }, words);
  expect(box, `"${words}" is on screen`).not.toBeNull();
  await page.mouse.move(box!.x1, box!.y1);
  await page.mouse.down();
  await page.mouse.move((box!.x1 + box!.x2) / 2, (box!.y1 + box!.y2) / 2, { steps: 6 });
  await page.mouse.move(box!.x2, box!.y2, { steps: 6 });
  await page.mouse.up();
}

async function sideOn(page: Page, words: string): Promise<void> {
  await expect(async () => {
    await selectInThread(page, words);
    await expect(side(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await side(page).click();
}

const frame = (page = world.page) => page.locator('[data-chat-window]');
const agentRow = (page = world.page) => frame(page).locator('[data-message-role="assistant"]:not([data-text-part])');
const chip = (page = world.page) => frame(page).locator('[data-ask-chip]');
const box = (page = world.page) => frame(page).locator('textarea');
const menu = (page = world.page) => page.locator('[data-ask-menu]');
const row = (id: string, page = world.page) => menu(page).locator(`[data-ask-chat="${id}"]`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-ask-window-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-ask-window: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  markTourDecided(dataDir);
  const env = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
  };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string; serverSession: string };

  const projects = { relay: scratchProject(join(root, 'src'), 'relay'), web: scratchProject(join(root, 'src'), 'web'), billing: scratchProject(join(root, 'src'), 'billing') };
  const client = new Client({ name: 'inbox-ask-window', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${registry.port}/mcp`)));
  const send = async (project: string, session: string, host: string, name: string, subject: string, body: string) => {
    const result = await client.callTool({ name: 'send_message', arguments: { subject, body, project_path: project, agent_session: session, agent_host: host, agent_name: name } });
    return (result.structuredContent as { thread_id: string }).thread_id;
  };
  const threads = {
    migration: await send(projects.relay, 'ses-migration', 'pi', 'Pi', 'Migration order', 'The migrations can go in either order.'),
    webhook: await send(projects.billing, 'ses-webhook', 'claude-code', 'Claude Code', 'Webhook signature check', 'Signatures are checked before the body is parsed.'),
    invoice: await send(projects.billing, 'ses-invoice', 'codex', 'Codex', 'Invoice rounding rule', 'Rounding now happens per line, not on the total.'),
    keys: await send(projects.web, 'ses-keys', 'claude-code', 'Claude Code', 'Keyboard check', 'Tell me what you think.'),
    search: await send(projects.web, 'ses-search', 'pi', 'Pi', 'Search filter debounce', 'The filter fires on every key. I put a debounce on it.'),
    push: await send(
      projects.relay,
      'ses-push',
      'claude-code',
      'Claude Code',
      'Push retry budget',
      [
        'The push worker was sending the same notification twice when the relay answered slowly. I put a retry budget in front of it and re-ran the slow-relay test: 40 runs, no duplicates.',
        '',
        'The budget is five attempts with a 1, 2, 4, 8 and 16 second backoff. The fix is on `fix/push-retry-budget`, not merged.',
      ].join('\n'),
    ),
  };

  const inboxDir = join(dataDir, 'inbox');
  writeInboxAsk(inboxDir, savedChat(threads.invoice, 'ses-invoice', 'codex', 60, 'Does this change last month’s totals?', 'No. Only invoices issued from now on round per line.', false));
  writeInboxAsk(inboxDir, savedChat(threads.webhook, 'ses-webhook', 'claude-code', 2 * 24 * 60, 'Which header carries it?', 'The signature is in `X-Signature`.', true));
  writeInboxAsk(inboxDir, savedChat(threads.migration, 'ses-migration', 'pi', 8 * 24 * 60, 'Any lock on the table?', 'Only a brief one on the index build.', true));

  const start = (session: string, project: string, host: 'claude-code' | 'pi', reply: (text: string) => string | Promise<string>) =>
    startScriptedAskAgent({ port: registry.port, token: registry.token, session, project, host, reply });
  const held = new AbortController();
  const agents = [
    start('ses-push', projects.relay, 'claude-code', () => ANSWER),
    start('ses-keys', projects.web, 'claude-code', () => 'Scripted answer.'),
    start('ses-search', projects.web, 'pi', () => new Promise((done) => held.signal.addEventListener('abort', () => done('Done.'), { once: true }))),
  ];

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { root, dataDir, url, target: { port: registry.port, serverSession: registry.serverSession }, threads, projects, token: registry.token, send, agents, client, context, page, errors, held };

  await expect(async () => {
    const posted = await postAsk(world.target, threads.search, 'held-question-1', 'Is 200 ms enough?');
    expect(posted.status).toBe(200);
    const answer = (await posted.json()) as AskAnswer;
    expect(answer.provider_id).not.toBeNull();
    void runQuery(world.target, await aiSession(world.target, answer.provider_id!, threads.search), 'Is 200 ms enough?');
  }).toPass({ timeout: 20_000 });
});

test.afterAll(async () => {
  try {
    world?.held.abort();
    for (const agent of world?.agents ?? []) agent.stop();
    await world?.client.close().catch(() => {});
    await world?.context.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('Side opens the thread’s chat (no Ask icon in the top bar), and a question gets its answer from the real agent', async () => {
  const { page, threads, url } = world;
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(`${url}#thread=${threads.push}`);
  await expect(page.locator('section.ib-pane .ib-phead')).toBeVisible();
  await expect(frame()).toHaveCount(0);
  await sideOn(page, 'retry budget');
  await expect(box()).toBeFocused();
  await expect(box()).toHaveValue('> retry budget\n\n');
  await expect(askIcon()).toHaveCount(0);
  await expect(frame().locator('xpath=ancestor::section')).toHaveCount(0);

  const rect = (await frame().boundingBox())!;
  expect({ width: rect.width, height: rect.height, right: 1440 - rect.x - rect.width, bottom: 900 - rect.y - rect.height }).toEqual({ width: 420, height: 560, right: 16, bottom: 16 });

  await expect(chip()).toContainText('Push retry budget');
  await expect(chip().locator('[data-ask-sparkle]')).toHaveCount(1);
  await expect(chip()).toContainText('Ask AI · ');

  await box().fill(QUESTION);
  await box().press('Enter');
  await expect(frame()).toContainText(ANSWER_SHOWS);
  await expect(box()).toHaveValue('');
  const answer = agentRow();
  await expect(answer).toContainText('Claude Code');
  await expect(answer.locator('.ib-mk svg')).toHaveCount(1);
  await shot(page, '1-open-light', 'light');
});

test('the dropdown lists the chats by the approved rows, states and groups', async () => {
  const { page, threads } = world;
  await chip().click();
  await expect(row(threads.invoice)).toBeVisible();
  const top = menu().locator(':scope > [data-ask-chat]');
  await expect(top).toHaveCount(3);
  await expect(top.nth(0)).toHaveAttribute('data-ask-chat', threads.push);
  await expect(top.nth(0)).toHaveAttribute('data-state', 'current');
  await expect(top.nth(1)).toHaveAttribute('data-ask-chat', threads.search);
  await expect(top.nth(1)).toHaveAttribute('data-state', 'answering');
  await expect(top.nth(1)).toContainText('web ·');
  await expect(top.nth(2)).toHaveAttribute('data-ask-chat', threads.invoice);
  await expect(top.nth(2)).toHaveAttribute('data-state', 'unread');
  await expect(top.nth(2)).toContainText('billing · 1 h ago');
  await expect(menu().getByText('Recent', { exact: true })).toBeVisible();
  await expect(row(threads.webhook)).toContainText('billing · 2 days ago');
  await expect(row(threads.migration)).toContainText('relay · last week');
  await expect(menu().locator('button')).toHaveCount(0);
  await shot(page, '2-menu-open-light', 'light');
});

test('picking a chat moves to its thread and shows that chat', async () => {
  const { page, threads } = world;
  await row(threads.invoice).click();
  await expect(page).toHaveURL(new RegExp(`#.*thread=${threads.invoice}`));
  await expect(chip()).toContainText('Invoice rounding rule');
  await expect(frame()).toContainText('Only invoices issued from now on round per line.');
  await expect(agentRow()).toContainText('Codex');
  await expect(box()).toBeFocused();
  await expect(page.locator('section.ib-pane')).toContainText('Rounding now happens per line');
  await shot(page, '3-after-switching-light', 'light');

  await expect(async () => {
    const read = await readAsk(world.target, threads.invoice);
    expect(read.conversation?.seen_at ?? null).not.toBeNull();
  }).toPass({ timeout: 5_000 });

  await chip().click();
  await row(threads.push).click();
  await expect(chip()).toContainText('Push retry budget');
  await expect(frame()).toContainText(ANSWER_SHOWS);
  await shot(page, '4-open-dark', 'dark');
  await chip().click();
  await expect(row(threads.invoice)).toBeVisible();
  await expect(row(threads.invoice)).not.toHaveAttribute('data-state', 'unread');
  await shot(page, '5-menu-open-dark', 'dark');
  await page.keyboard.press('Escape');
  await expect(menu()).toHaveCount(0);
  await expect(chip()).toBeFocused();
  await expect(frame()).toBeVisible();
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
});

test('Mod+Enter and Escape in the window leave the reply draft and the thread alone', async () => {
  const { page, threads, url } = world;
  await page.goto(`${url}#thread=${threads.keys}`);
  await expect(page.locator('section.ib-pane .ib-phead')).toBeVisible();
  await page.locator('section.ib-pane .ib-pfoot button', { hasText: 'Reply' }).click();
  const reply = page.locator('section.ib-pane textarea');
  await reply.fill('A reply that must stay a draft');
  await expect(page.locator('section.ib-pane .ib-pfoot button', { hasText: 'Send' })).toBeEnabled();
  await sideOn(page, 'what you think');
  await expect(box()).toBeFocused();
  await box().fill('Half a thought');

  const pressed = async () => {
    await page.keyboard.press('ControlOrMeta+Enter');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Slash');
    await page.waitForTimeout(200);
    await expect(page.locator('.ib-map')).toHaveCount(0);
    await expect(reply).toHaveValue('A reply that must stay a draft');
    expect(page.url()).toContain(threads.keys);
    await expect(frame()).toBeVisible();
  };

  await frame().locator('[tabindex="0"]').first().click();
  await pressed();
  await chip().focus();
  await pressed();
  const header = (await frame().locator('[data-chat-drag-handle]').boundingBox())!;
  await page.mouse.click(header.x + header.width - 110, header.y + header.height / 2);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-chat-window]') !== null)).toBe(true);
  await pressed();

  const thread = (await (await fetch(new URL(`/api/inbox/threads/${threads.keys}`, url))).json()) as { thread: { messages: unknown[] } };
  expect(thread.thread.messages.length).toBe(1);
  await expect(box()).toHaveValue('Half a thought');
});

test('no Ask on a phone for now; on the desktop, Side reopens a chat and Reply in the thread joins the draft', async ({ browser }: { browser: Browser }) => {
  const { threads, url } = world;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  try {
    await phone.goto(`${url}#thread=${threads.push}`);
    await expect(phone.locator('section.ib-pane .ib-body').first()).toBeVisible();
    await phone.waitForTimeout(1_500);
    await expect(askIcon(phone)).toHaveCount(0);
    await expect(phone.locator('button[data-rf-corner], [data-rf-card="ask"]')).toHaveCount(0);
    await phone.screenshot({ path: join(shotsDir, '6-phone-light.png') });
  } finally {
    await context.close();
  }

  world.agents.push(startScriptedAskAgent({ port: world.target.port, token: world.token, session: 'ses-phone', project: world.projects.web, reply: () => 'Scripted answer.' }));
  const noted = await world.send(world.projects.web, 'ses-phone', 'claude-code', 'Claude Code', 'Unanswered on a phone', 'Ask me.');
  expect(Object.values(threads)).not.toContain(noted);
  writeInboxAsk(join(world.dataDir, 'inbox'), savedChat(noted, 'ses-phone', 'claude-code', 5, 'What was the plan?', null, false));
  const { page } = world;
  await page.goto(`${url}#thread=${noted}`);
  await page.locator('section.ib-pane .ib-pfoot button', { hasText: 'Reply' }).click();
  const reply = page.locator('section.ib-pane textarea');
  await reply.fill('A draft first');
  await expect(page.locator('button[data-rf-corner], [data-rf-card="ask"]')).toHaveCount(0);
  await sideOn(page, 'Ask me');
  await expect(frame()).toContainText('What was the plan?');
  await frame().getByRole('button', { name: 'Reply in the thread' }).click();
  await expect(reply).toHaveValue('A draft first\n\nWhat was the plan?');
});

test('no page error, and the agent got the surface from the thread', async () => {
  expect(world.errors).toEqual([]);
  const asked = world.agents[0]!.asked.join('\n');
  expect(asked).toContain('Inbox thread "Push retry budget"');
  expect(asked).toContain(QUESTION);
});
