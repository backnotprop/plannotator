/**
 * Remove an agent from a thread (approval "inbox-remove-agent-from-thread", proposal B with D and E), proved in a
 * real browser against the compiled binary, with the proof pictures.
 *
 * Nothing is mocked: the binary runs `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR and HOME. Two
 * live sessions poll the bridge as the mods do, each with its own name: "billing-api" (Claude Code) and "webhooks"
 * (Codex), both in billing-svc. The thread "Stripe 409s": billing-api started it, the person tagged webhooks, webhooks
 * answered, the person wrote to billing-api, and billing-api wrote last.
 *
 * The person opens the reply's "to" list, sees Remove on the hovered row (the circle never moves) and on keyboard
 * focus, presses it (toast, thread line, no chip any more), tags webhooks again (it is listed and comes back), and on
 * a phone swipes its sheet row left over Remove.
 *
 * PNGs land in .local/proof/remove-agent/ (CI keeps .local/proof/ as the shard's "inbox-window-proof" artifact), or in
 * PLANNOTATOR_REMOVE_AGENT_SHOTS when it names a folder.
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TagConnection } from '../helpers/inbox-tag-world';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_REMOVE_AGENT_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'remove-agent'));
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: 'reduce' as const };

const API = 'cc-billing-api-5e1f';
const HOOKS = 'codex-webhooks-9a07';

interface World {
  url: string;
  threadId: string;
  rootId: string;
  connections: TagConnection[];
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

type Message = { id: string; body: string; author: { kind: string; session?: string }; tags?: { session: string }[]; removed?: { session: string }[] | null };

async function messages(threadId: string): Promise<Message[]> {
  return ((await (await fetch(`${world.url}/api/inbox/threads/${threadId}`)).json()) as { thread: { messages: Message[] } }).thread.messages;
}
const removedNow = async () => ((await messages(world.threadId))[0]!.removed ?? []).map((r) => r.session);

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Open the thread and its reply box, empty. */
async function openReply(page: Page): Promise<Locator> {
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('h2.ib-subject')).toBeVisible();
  const box = pane.getByRole('textbox', { name: /^Reply to/ });
  const reply = pane.locator('.ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ });
  for (let attempt = 0; attempt < 10 && !(await box.isVisible()); attempt += 1) {
    await reply.click({ timeout: 1_000 }).catch(() => {});
  }
  await expect(box).toBeVisible();
  await box.fill('');
  return box;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-remove-agent-e2e-');
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
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
  const project = join(root, 'projects', 'billing-svc');
  mkdirSync(project, { recursive: true });

  const now = Date.now();
  const connections = [
    new TagConnection(url, token, API, 'claude-code', project, { busy: false, tags: true, sendNow: true, startedAt: now - 3 * 3600_000, label: 'billing-api' }),
    new TagConnection(url, token, HOOKS, 'codex', project, { busy: false, tags: true, sendNow: true, startedAt: now - 2 * 3600_000, label: 'webhooks' }),
  ];
  let rpc = 1;
  const send = async (args: Record<string, unknown>): Promise<{ message_id: string; thread_id: string }> => {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name: 'send_message', arguments: { project_path: project, ...args }, _meta: { 'ai.plannotator/inbox-wakes': true } } }),
    });
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    const json = JSON.parse(line ? line.slice(5) : text) as { error?: unknown; result?: { isError?: boolean; structuredContent: { message_id: string; thread_id: string } } };
    if (json.error || json.result?.isError) throw new Error(text);
    return json.result!.structuredContent;
  };
  const reply = async (messageId: string, body: Record<string, unknown>) => {
    const res = await fetch(`${url}/api/inbox/messages/${messageId}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  const api = { agent_host: 'claude-code', agent_name: 'Claude Code', agent_session: API };
  const hooks = { agent_host: 'codex', agent_name: 'Codex', agent_session: HOOKS };

  const asked = await send({
    ...api,
    subject: 'Stripe 409s',
    body: 'Stripe answers 409 on refunds when an idempotency key comes back with a different amount. Ada Novak saw three this morning.',
  });
  // Both sessions polled once with their names, so the tag resolves and the window names them.
  for (let i = 0; i < 100; i++) {
    const res = (await (await fetch(`${url}/api/inbox/threads/${asked.thread_id}/taggable`)).json()) as { sessions: { session: string }[] };
    if ([API, HOOKS].every((s) => res.sessions.some((x) => x.session === s))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await reply(asked.message_id, { idempotency_key: 'tag-hooks', words: '@webhooks can you check the webhook side?', tags: [{ host: 'codex', session: HOOKS, label: 'webhooks' }] });
  await send({ ...hooks, reply_to: asked.message_id, body: 'The webhook retries reuse the old key with the new amount, so Stripe answers 409. Bob Tully\'s dashboard shows 14 of them.' });
  await reply(asked.message_id, { idempotency_key: 'to-api', words: 'Keep the key and round before hashing. billing-api, check the retry queue.' });
  await send({ ...api, reply_to: asked.message_id, body: 'The retry queue holds 14 refunds with the old key. I can replay them once the fix lands. Charlie Dunn asked to hold replays until 4 PM.' });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { url, threadId: asked.thread_id, rootId: asked.message_id, connections, context, page, errors };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.connections.map((c) => c.stop()));
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the "to" list: Remove on the hovered row and on keyboard focus, and the circle never moves', async () => {
  const { page } = world;
  await openReply(page);
  const chip = page.locator('[data-recipient-chip]');
  await expect(chip).toBeVisible();
  await chip.click();
  const list = page.locator('[data-recipient-list]');
  await expect(list).toBeVisible();
  const row = list.locator(`[data-recipient-row="${HOOKS}"]`);
  const remove = row.locator(`[data-recipient-remove="${HOOKS}"]`);
  const tick = row.locator(`[data-recipient-tick="${HOOKS}"]`);
  await expect(row).toContainText('webhooks');
  await expect(remove).toHaveAccessibleName('Remove webhooks from this thread');
  // billing-api wrote last: its circle is on, webhooks' is off.
  await expect(list.locator(`[data-recipient-tick="${API}"]`)).toHaveAttribute('aria-checked', 'true');
  await expect(tick).toHaveAttribute('aria-checked', 'false');

  await page.mouse.move(2, 2);
  const before = (await tick.boundingBox())!;
  await row.hover();
  await expect(remove).toHaveText('Remove');
  await expect.poll(async () => (await remove.boundingBox())?.width ?? 0).toBeGreaterThan(30);
  const after = (await tick.boundingBox())!;
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.y).toBeCloseTo(before.y, 0);
  // Remove sits between the name and the circle.
  const name = (await row.locator('.ib-rpick-name').boundingBox())!;
  const shown = (await remove.boundingBox())!;
  expect(shown.x).toBeGreaterThanOrEqual(name.x + name.width - 1);
  expect(shown.x + shown.width).toBeLessThanOrEqual(after.x + 1);
  await shot(page, '1-remove-on-hover-desktop');

  // Keyboard: Tab from the row's name reaches Remove, which shows without a hover.
  await page.mouse.move(2, 2);
  await row.locator('.ib-rpick-name').focus();
  await page.keyboard.press('Tab');
  await expect(remove).toBeFocused();
  await expect.poll(async () => (await remove.boundingBox())?.width ?? 0).toBeGreaterThan(30);
  expect((await tick.boundingBox())!.x).toBeCloseTo(before.x, 0);
  await shot(page, '2-remove-on-focus-desktop', ['light']);
  expect(world.errors).toEqual([]);
});

test('one press: the toast and the line, no chip, the reply goes to billing-api, and webhooks is told nothing', async () => {
  const { page } = world;
  const handedBefore = world.connections[1]!.commands.length;
  await page.locator(`[data-recipient-remove="${HOOKS}"]`).click();
  await expect(page.locator('[data-inbox-toast]')).toContainText('Removed webhooks');
  const line = page.locator('[data-thread-move="removed"]');
  await expect(line).toHaveText(/^You removed webhooks from this thread · \S/);
  await expect(page.locator('[data-recipient-chip]')).toHaveCount(0);
  await expect(page.locator('section.ib-pane').getByRole('textbox', { name: /^Reply to/ })).toBeFocused();
  expect(await removedNow()).toEqual([HOOKS]);
  const taggable = (await (await fetch(`${world.url}/api/inbox/threads/${world.threadId}/taggable`)).json()) as { owner: { session: string } | null };
  expect(taggable.owner?.session).toBe(API);
  await shot(page, '3-after-remove-desktop');
  // Nothing went to it at the press.
  await page.waitForTimeout(1_500);
  expect(world.connections[1]!.commands.length).toBe(handedBefore);
  expect(world.errors).toEqual([]);
});

test('typing @web lists webhooks again, and a reply that tags it brings it back', async () => {
  const { page } = world;
  const box = await openReply(page);
  await box.pressSequentially('Hold the replays until 4 PM. @web');
  const option = page.locator(`[data-tag-option="${HOOKS}"]`);
  await expect(option).toBeVisible();
  await expect(option).toContainText('webhooks');
  await shot(page, '4-tag-again-desktop', ['light']);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('ArrowDown');
    if ((await page.locator('[data-tag-option][aria-selected="true"]').getAttribute('data-tag-option')) === HOOKS) break;
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-tag-picker]')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await messages(world.threadId)).filter((m) => m.author.kind === 'person').at(-1)!.body).toContain('Hold the replays until 4 PM.');
  const sent = (await messages(world.threadId)).filter((m) => m.author.kind === 'person').at(-1)!;
  expect(sent.tags?.map((t) => t.session)).toEqual([HOOKS]);
  // It gets the reply, and it is in the thread again: the chip is back with both rows.
  await expect.poll(() => world.connections[1]!.commands.some((c) => c.id === sent.id), { timeout: 15_000 }).toBe(true);
  await openReply(page);
  await expect(page.locator('[data-recipient-chip]')).toBeVisible();
  expect(world.errors).toEqual([]);
});

test('on a phone: the sheet row swipes left over Remove', async ({ browser }) => {
  const context = await browser.newContext({ ...PHONE, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await openReply(page);
    await page.locator('section.ib-pane [data-recipient]').first().click();
    const sheet = page.locator('[data-recipient-list]');
    await expect(sheet).toBeVisible();
    const row = sheet.locator(`[data-swipe-remove="${HOOKS}"]`);
    await expect(row).toBeVisible();
    await expect(sheet.locator(`[data-swipe-remove="${API}"]`)).toBeVisible();
    await page.waitForTimeout(400);
    const box = (await row.boundingBox())!;
    const y = box.y + box.height / 2;
    const x = box.x + box.width - 30;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 40, y, { steps: 4 });
    await page.mouse.move(x - Math.max(150, box.width / 3 + 30), y, { steps: 8 });
    await expect(row).toHaveAttribute('data-armed', '');
    await expect(row.locator('.ib-arcswipe-under')).toContainText('Remove');
    await page.screenshot({ path: join(proofDir, '5-swipe-phone-light.png') });
    await page.mouse.up();
    await expect(page.locator('[data-inbox-toast]')).toContainText('Removed');
    // A second removal: the first stays on the root as history (the tag ended it), the new one stands.
    await expect.poll(removedNow).toEqual([HOOKS, HOOKS]);
    await expect(sheet).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
