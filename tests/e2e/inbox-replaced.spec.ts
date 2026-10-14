/**
 * Replaced questions (design record, not in this repo; direction A "Quiet"),
 * proved in a real browser against the compiled binary. Claude Code asks two
 * questions through `plannotator inbox mcp` (scripts/inbox-sim.ts); the
 * person picks on question 1 and starts a reply; the agent then replaces
 * question 1 (`supersedes`). The window shows the notice and the struck
 * chip, the old card goes Quiet (Replaced, the row, "Your pick … Not sent",
 * no controls), the links jump between the cards, Send stops once on the
 * stale guard (nothing sent, Esc keeps editing), and the next Send carries
 * the words only: the agent's reply never names the replaced pick. A second
 * thread is withdrawn whole: the held list says "1 new" and, shown, the row
 * leaves Stopped on you; its cards read "No longer applies".
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs light and dark at 1440 by 900 land in .local/proof/replaced/ (or
 * PLANNOTATOR_E2E_PROOF_DIR/replaced).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'replaced');

const WORKER = [
  'I checked the 409 row against the Stripe docs. Two things before I go on.',
  '',
  ':::question',
  'Which way should the worker go on a Stripe 409?',
  '',
  'Stopped: the retry worker cannot ship without this.',
  '',
  'Decision: when answered',
  '',
  '- [ ] Retry with the same idempotency key',
  '- [ ] Fail the job and send it to the dead-letter queue',
  '',
  'Recommended: Retry with the same idempotency key',
  ':::',
  '',
  ':::question',
  'Ship the retry behind a flag?',
  '',
  'The flag would be `billing.retry_409`, off by default.',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

const QUEUE = [
  'You moved the 409 handling into the jobs queue in our session, so my worker question no longer fits. This is the one the queue needs.',
  '',
  ':::question',
  'How many times should the jobs queue retry a Stripe 409 before it dead-letters the job?',
  '',
  'Stopped: the queue change cannot merge without this.',
  '',
  '- [ ] 3 times over 10 minutes',
  '- [ ] Once, then dead-letter',
  '- [ ] Never retry; dead-letter at once',
  '',
  'Recommended: 3 times over 10 minutes',
  ':::',
].join('\n');

const PICK = 'Fail the job and send it to the dead-letter queue';
const WORDS = 'Dead-letter it for now. We can look at retries again after the launch.';

interface World {
  root: string;
  dataDir: string;
  url: string;
  billing: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  first: { message_id: string; thread_id: string; questions: { key: string }[] };
}

let world: World;

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const card = (page: Page, messageId: string, key: string) => page.locator(`[data-message-id="${messageId}"] [data-question-key="${key}"]`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-replaced-e2e-');
  const dataDir = join(root, 'data');
  // Nothing here may reach the real tailscale CLI: a trap fails loudly first on PATH.
  const trap = join(root, 'bin');
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), "#!/bin/sh\necho 'inbox-replaced.spec: tailscale must not run' >&2\nexit 97\n");
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
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
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const first = (await claude.send({ project_path: billing, body: WORKER })) as World['first'];
  world = { root, dataDir, url, billing, claude, context, page, errors, first };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

test('the person picks on question 1 and starts a reply', async () => {
  const { page, first } = world;
  await page.goto(world.url);
  const row = page.locator(`.ib-lbody [data-thread-id="${first.thread_id}"]`);
  await expect(row).toHaveAttribute('data-section', 'stopped');
  await row.click();
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Which way should the worker go on a Stripe 409?' })).toBeVisible();
  await pane.getByText(PICK, { exact: true }).click();
  await expect(pane.getByText(/^Picked \d{1,2}:\d{2} [AP]M, not sent$/)).toBeVisible();
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Edit the reply' }).click();
  await page.getByRole('textbox', { name: 'Reply to Claude Code' }).fill(WORDS);
  await expect(page.locator('[data-picks-chip]')).toHaveText('1 pick');
  await shot('1-picked-and-typing');
});

test('the agent replaces question 1 while the person types: the notice, the struck chip, the Quiet card, the subject', async () => {
  const { page, first, claude } = world;
  const [q1] = first.questions;
  const sent = await claude.send({ project_path: world.billing, body: QUEUE, reply_to: first.message_id, supersedes: [`${first.message_id}/${q1!.key}`] });
  expect(sent.superseded).toEqual([`${first.message_id}/${q1!.key}`]);
  const notice = page.locator('[data-replaced-notice]');
  await expect(notice).toContainText(/^Claude Code replaced question 1 at \d{1,2}:\d{2} [AP]M\. Your pick on it won't be sent\. See the new question$/);
  await expect(page.locator('[data-dropped-picks-chip]')).toHaveText('1 pick on a replaced question');
  await expect(page.locator('[data-picks-chip]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Reply to Claude Code' })).toHaveValue(WORDS);
  const old = card(page, first.message_id, q1!.key);
  await expect(old).toHaveAttribute('data-question-state', 'superseded');
  await expect(old.locator('[data-replaced-tag]')).toHaveText('Replaced');
  await expect(old.locator('[data-unsent-pick]')).toHaveText(`Your pick: ${PICK}Not sent`);
  await expect(old.locator('input:not([disabled])')).toHaveCount(0);
  await expect(old.getByRole('button', { name: 'Skip' })).toHaveCount(0);
  const fresh = card(page, String(sent.message_id), String(sent.questions[0].key));
  await expect(fresh.locator('[data-replaces-line]')).toHaveText('Replaces Which way should the worker go on a Stripe 409?↑. Your pick there was not sent.');
  // The derived subject follows the replacement.
  await expect(page.locator('h2.ib-subject')).toHaveText('How many times should the jobs queue retry a Stripe 409 before it dead-letters the job?');
  await old.scrollIntoViewIfNeeded();
  await shot('2-replaced-while-typing');
});

test('the links between the old and new cards land on the card, focused and ringed', async () => {
  const { page, first } = world;
  const [q1] = first.questions;
  const old = card(page, first.message_id, q1!.key);
  await old.locator('.ib-q-link').click();
  const focused = page.locator(':focus');
  await expect(focused).toHaveAttribute('data-question-key', /^q-/);
  await expect(focused).not.toHaveAttribute('data-question-key', q1!.key);
  await expect(focused).toHaveClass(/ib-q-target/);
  await focused.locator('.ib-q-link').click();
  await expect(page.locator(':focus')).toHaveAttribute('data-question-key', q1!.key);
  await old.getByRole('button', { name: 'Show the old options' }).click();
  await expect(old.locator('[data-old-options]')).toBeVisible();
  await expect(old.getByText('Not sent').first()).toBeVisible();
  await shot('3-quiet-card-old-options');
});

test('Send stops on the stale guard: nothing goes; Esc keeps editing and focus returns to Send', async () => {
  const { page, first, claude } = world;
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  const guard = page.getByRole('alertdialog', { name: 'Question 1 changed before you sent' });
  await expect(guard).toBeVisible();
  await expect(guard).toBeFocused();
  await expect(guard).toContainText(`Your pick, ${PICK}, will not be sent.`);
  await expect(guard).toContainText('Your words still go if you send. They were written for the old question, so check they still fit.');
  await expect(guard.getByRole('button', { name: 'Answer the new question' })).toBeVisible();
  await expect(guard.getByRole('button', { name: 'Send your words only' })).toBeVisible();
  await shot('4-stale-guard');
  const thread = await claude.readThread(first.thread_id);
  expect(thread.messages.length).toBe(2);
  await page.keyboard.press('Escape');
  await expect(guard).toHaveCount(0);
  await expect(page.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Reply to Claude Code' })).toHaveValue(WORDS);
});

test('the guard shows once per replacement: the next Send carries the words only, never the replaced pick', async () => {
  const { page, first, claude } = world;
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('.ib-delivered')).toContainText('Saved for Claude Code');
  const reply = await claude.waitForReply(first.thread_id, 10);
  expect(reply.status).toBe('replied');
  // The Send also skips the questions it left open, each on the reply to its
  // own message; the words ride the last reply. No reply carries the replaced pick.
  const thread = await claude.readThread(first.thread_id);
  const replies = (thread.messages as { author: { kind: string }; body: string }[]).filter((m) => m.author.kind === 'person');
  expect(replies.at(-1)!.body).toContain(WORDS);
  for (const r of replies) expect(r.body).not.toContain(PICK);
  // The replaced card still shows the pick, never sent.
  await expect(card(page, first.message_id, first.questions[0]!.key).locator('[data-unsent-pick]')).toContainText('Not sent');
});

test('a whole message withdrawn: the held list says "1 new"; shown, the row leaves Stopped on you; its cards read "No longer applies"', async () => {
  const { page, claude } = world;
  await page.keyboard.press('Escape');
  const second = await claude.send({ project_path: world.billing, body: WORKER, thread: 'refund-webhooks' });
  const row = page.locator(`.ib-lbody [data-thread-id="${second.thread_id}"]`);
  await page.locator('[data-inbox-notice]').click().catch(() => {});
  await expect(row).toHaveAttribute('data-section', 'stopped');
  // Looked at once, so the withdrawal is the only news.
  await row.click();
  await expect(page.locator('section.ib-pane h2.ib-subject')).toHaveText('Which way should the worker go on a Stripe 409?');
  await page.keyboard.press('Escape');
  await claude.send({
    project_path: world.billing,
    reply_to: String(second.message_id),
    body: 'You settled this in our session: the jobs queue already retries a 409 with the same idempotency key, so neither question above applies any more.',
    supersedes: [String(second.message_id)],
  });
  await expect(page.locator('[data-inbox-notice]')).toContainText('1 new in billing-svc');
  await expect(row).toHaveAttribute('data-section', 'stopped');
  await shot('5-withdrawn-held');
  await page.locator('[data-inbox-notice]').click();
  await expect(row).toHaveAttribute('data-section', 'new');
  await shot('6-withdrawn-shown');
  await row.click();
  const pane = page.locator('section.ib-pane');
  // The person looked at the asking message before the withdrawal, so it opens folded to a line; open it.
  const asking = pane.locator(`[data-message-article="${second.message_id}"]`);
  await expect(asking).toHaveAttribute('data-folded', '');
  await asking.locator('[data-fold-head]').click();
  const tags = pane.locator('[data-replaced-tag]');
  await expect(tags).toHaveText(['No longer applies', 'No longer applies']);
  await expect(pane.locator('[data-replaced-row]').first()).toContainText(/Claude Code said at \d{1,2}:\d{2} [AP]M that this no longer applies\. Read why/);
  // The subject never followed a withdrawal.
  await expect(pane.locator('h2.ib-subject')).toHaveText('Which way should the worker go on a Stripe 409?');
  await pane.locator('[data-replaced-row]').first().scrollIntoViewIfNeeded();
  await shot('7-no-longer-applies');
  expect(world.errors).toEqual([]);
});
