/**
 * New thread from this message (approved by the owner, 2026-11-23), in a real Chromium against the compiled binary,
 * with two agents writing in one thread through `plannotator inbox mcp` (scripts/inbox-sim.ts), each its own session:
 *
 *  - agent B's message's ⋯ leads with New thread from this message (screenshots light and dark);
 *  - pressing it writes one reply from the person, to B's message, so the thread names B as its recipient;
 *  - the person's own message's ⋯ has no such item.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`. Screenshots land in
 * .local/proof/inbox-new-thread-from-message/ (under PLANNOTATOR_E2E_PROOF_DIR).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { NEW_THREAD_FROM_MESSAGE_WORDS } from '../../packages/core/inbox-new-thread-ask';
import { inboxReplyQuoteExcerpt } from '../../packages/core/inbox-reply-quote';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
// Its own folder: inbox.spec.ts clears the proof root's pictures and lists them in its contact sheet.
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'inbox-new-thread-from-message');

const LABEL = 'New thread from this message';
const A_BODY = 'The retry worker is done. It retries a 409 with the same key, at most 3 times.';
const B_BODY = [
  'I looked at the webhook side. Stripe resends an event for up to three days, so the handler must be idempotent too.',
  '',
  ':::question',
  'Store processed event ids for how long?',
  '',
  '- [ ] 3 days',
  '- [ ] 30 days',
  ':::',
].join('\n');

interface World {
  url: string;
  claude: SimAgent;
  codex: SimAgent;
  context: BrowserContext;
  page: Page;
  thread: string;
  ids: { a: string; reply: string; b: string };
}

let world: World;

test.describe.configure({ mode: 'serial' });

const article = (page: Page, id: string) => page.locator(`[data-message-article="${id}"]`);
const more = (page: Page, id: string) => page.locator(`[data-message-more="${id}"]`);
const menuOf = (page: Page, id: string) => page.locator(`[data-message-menu="${id}"]`);
type Stored = { id: string; reply_to: string | null; body: string; author: { kind: string } };
const stored = async (): Promise<Stored[]> => ((await world.claude.readThread(world.thread)).messages ?? []) as Stored[];

async function openThread(page: Page) {
  await page.goto(`${world.url}#thread=${world.thread}`);
  await expect(article(page, world.ids.b)).toBeVisible();
  const hide = page.getByRole('button', { name: 'Hide', exact: true });
  if (await hide.isVisible().catch(() => false)) await hide.click();
  await page.mouse.move(5, 895);
}

/** Opens a message's ⋯, unfolding the message first when the thread shows it folded. */
async function openMenu(page: Page, id: string) {
  const head = article(page, id).locator('[data-open-head]');
  if (!(await head.isVisible())) await article(page, id).locator('button').first().click();
  await expect(head).toBeVisible();
  await head.hover();
  await more(page, id).click();
  await expect(menuOf(page, id)).toBeVisible();
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-new-thread-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const a = await claude.send({ project_path: billing, subject: 'Stripe 409s', thread: 'stripe', body: A_BODY });
  const thread = a.thread_id as string;
  // The person replies through the window, then the second agent writes in the same thread.
  await page.goto(`${url}#thread=${thread}`);
  const box = page.locator('.ib-rbox textarea').first();
  if (!(await box.isVisible().catch(() => false))) await page.getByRole('button', { name: /^Reply/ }).last().click();
  await page.locator('.ib-rbox textarea').first().fill('Good. Codex, check the webhook side too.');
  await page.getByRole('button', { name: /^Send/ }).last().click();
  await expect(page.locator('[data-author="person"]')).toHaveCount(1);
  const person = async () => (((await claude.readThread(thread)).messages ?? []) as Stored[]).find((m) => m.author.kind === 'person')?.id;
  await expect.poll(person).toBeTruthy();
  const reply = (await person())!;
  const b = await codex.send({ project_path: billing, reply_to: reply, body: B_BODY });
  world = { url, claude, codex, context, page, thread, ids: { a: a.message_id as string, reply, b: b.message_id as string } };
});

test.afterAll(async () => {
  try {
    await world?.claude.close().catch(() => {});
    await world?.codex.close().catch(() => {});
    await world?.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test("the person's own message has no item; agent B's message leads with it (light and dark)", async () => {
  const { page, ids } = world;
  await page.emulateMedia({ colorScheme: 'light' });
  await openThread(page);
  await openMenu(page, ids.reply);
  await expect(menuOf(page, ids.reply).getByRole('menuitem', { name: LABEL })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menuOf(page, ids.reply)).toHaveCount(0);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await openThread(page);
    await openMenu(page, ids.b);
    await expect(menuOf(page, ids.b).locator('[role="menuitem"].ib-pmi')).toHaveText(['Reply', LABEL, 'Copy message', 'Copy link to message', 'Copy thread']);
    // Once the menu's entrance has played.
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(proofDir, `new-thread-from-message-menu-${scheme}.png`) });
    await page.keyboard.press('Escape');
    await expect(menuOf(page, ids.b)).toHaveCount(0);
  }
});

test("pressing it on agent B's message writes one reply to that message, which goes to B", async () => {
  const { page, ids } = world;
  await page.emulateMedia({ colorScheme: 'light' });
  await openThread(page);
  const before = await stored();
  await openMenu(page, ids.b);
  await menuOf(page, ids.b).getByRole('menuitem', { name: LABEL }).click();
  await expect.poll(async () => (await stored()).length).toBe(before.length + 1);
  const added = (await stored()).filter((m) => !before.some((o) => o.id === m.id));
  expect(added).toHaveLength(1);
  expect(added[0]!.author.kind).toBe('person');
  expect(added[0]!.reply_to).toBe(ids.b);
  // What B reads, word for word: the approved sentence with B's first words and id.
  expect(added[0]!.body).toBe(NEW_THREAD_FROM_MESSAGE_WORDS(inboxReplyQuoteExcerpt({ author: { kind: 'agent' }, body: B_BODY }), ids.b));
  // Who it is handed to, as Codex's own full read of the thread records it: a reply to B's message, tagging nobody else.
  const got = (await world.codex.nextReply(world.thread, 20, ids.b)) as { id: string; reply_to: string | null; tags?: unknown[]; to?: unknown };
  expect(got.id).toBe(added[0]!.id);
  expect(got.reply_to).toBe(ids.b);
  expect(got.tags ?? []).toEqual([]);
  expect(got.to).toBeUndefined();
  // The thread names who gets it: Codex, the agent that wrote the message, not Claude Code.
  const sent = article(page, added[0]!.id);
  await expect(sent).toBeVisible();
  await expect(sent.locator('.ib-to').first()).toContainText('Codex');
  await expect(sent.locator('.ib-to').first()).not.toContainText('Claude Code');
});
