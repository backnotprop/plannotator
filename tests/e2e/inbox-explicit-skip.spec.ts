/**
 * A Send skips a question only when the person presses a Skip, and one Send
 * to one session is ONE reply (owner approval "inbox-explicit-skip",
 * 2026-10-21). The owner's thread that led to it: one Claude Code session
 * posted 8 messages holding 11 questions; the person answered the newest one
 * and pressed Send; the old rule skipped the other 10 in 8 replies.
 *
 * Proved in a real browser against the compiled binary, with the agent writing
 * through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *  - the foot says "10 questions stay open · Skip them" by default; a Send
 *    with the one pick is ONE reply, the other 10 stay open, and the agent's
 *    read_thread gets "You have 10 other questions open in this thread…";
 *  - "Skip them" turns it into "10 questions will be skipped · Keep open";
 *    that Send is still ONE reply, skipping exactly those 10;
 *  - the same on a phone (390 by 844, touch).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs of the foot (desktop 1440 and a phone, light and dark, before Send by
 * default and after Skip them) land in .local/proof/explicit-skip/, or
 * PLANNOTATOR_EXPLICIT_SKIP_SHOTS.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_EXPLICIT_SKIP_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'explicit-skip'));

const question = (prompt: string) => [':::question', prompt, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
const FIRST = [
  'Here is the before/after for #1057: the proposal.',
  '',
  question('Build #1057 as shown?'),
  '',
  question('Keep the old toolbar?'),
  '',
  question('Ship behind a flag?'),
  '',
  question('Add a setting for it?'),
].join('\n');
const MERGES = ['Merge New chat (#2046)?', 'Merge Code Font (#855)?', 'Merge Enter saves (#2048)?', 'Merge the five outside PRs?', 'Merge Live versions (#2049)?', 'Merge N / Shift+N (#1550)?'];
const LAST = ['#1995 (installer fallback) has merged.', '', question('Upload the new install scripts to plannotator.ai now?')].join('\n');

interface World {
  url: string;
  project: string;
  env: Record<string, string>;
  claude: SimAgent;
}
let world: World;

type Model = { thread: { messages: { id: string; author: { kind: string }; reply_to: string | null; body: string; questions?: { state: string; answer: { skipped?: boolean } | null }[] }[] } };
const readThread = async (threadId: string) => (await (await fetch(new URL(`/api/inbox/threads/${threadId}`, world.url))).json()) as Model;

/** The owner's thread: one session, 8 messages, 11 questions. */
async function ownersThread(subject: string): Promise<{ threadId: string; last: string }> {
  const { claude, project } = world;
  const first = await claude.send({ project_path: project, subject, thread: subject.toLowerCase().replace(/[^a-z]+/g, '-').slice(0, 40), body: FIRST });
  for (const prompt of MERGES) await claude.send({ project_path: project, reply_to: first.message_id as string, body: `${prompt.replace('?', '')} is ready.\n\n${question(prompt)}` });
  const last = await claude.send({ project_path: project, reply_to: first.message_id as string, body: LAST });
  return { threadId: first.thread_id as string, last: last.message_id as string };
}

async function footShots(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Pick Yes on the newest message's question, then wait for the foot to offer Send. */
async function pickLast(page: Page, last: string): Promise<void> {
  const card = page.locator(`[data-message-id="${last}"] [data-question-key]`).first();
  await card.scrollIntoViewIfNeeded();
  await card.getByText('Yes', { exact: true }).click();
  await expect(page.locator('.ib-pfoot').getByRole('button', { name: 'Send' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-explicit-skip-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const project = scratchProject(join(root, 'src'), 'plannotator');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { url: started.stdout.trim(), project, env, claude };
});

test.afterAll(async () => {
  try {
    await world?.claude.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test("desktop: answer 1 of 11 and Send: one reply, the other 10 stay open, and the agent is told so; Skip them shows what it would skip", async ({ browser }: { browser: Browser }) => {
  const { threadId, last } = await ownersThread('Triage: the backlog is sorted');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${world.url}#thread=${threadId}`);
    await expect(page.locator('section.ib-pane').getByRole('heading', { name: 'Triage: the backlog is sorted' })).toBeVisible();
    await pickLast(page, last);
    const chip = page.locator('.ib-pfoot [data-skip-chip]');
    await expect(chip).toHaveAttribute('data-skip-chip', 'keep');
    await expect(chip).toContainText('10 questions stay open');
    await expect(chip.getByRole('button', { name: 'Skip them' })).toBeVisible();
    await footShots(page, 'desktop-1-default');
    await chip.getByRole('button', { name: 'Skip them' }).click();
    await expect(chip).toHaveAttribute('data-skip-chip', 'skip');
    await expect(chip).toContainText('10 questions will be skipped');
    await footShots(page, 'desktop-2-skip-them');
    // Back to the default, and Send: nothing is skipped.
    await chip.getByRole('button', { name: 'Keep open' }).click();
    await expect(chip).toHaveAttribute('data-skip-chip', 'keep');
    await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (await readThread(threadId)).thread.messages.filter((m) => m.author.kind === 'person').length).toBe(1);
    await page.waitForTimeout(500);
    const model = await readThread(threadId);
    const mine = model.thread.messages.filter((m) => m.author.kind === 'person');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.reply_to).toBe(last);
    const states = model.thread.messages.flatMap((m) => (m.questions ?? []).map((q) => q.state));
    expect(states.filter((s) => s === 'open')).toHaveLength(10);
    expect(states.filter((s) => s === 'sent')).toHaveLength(1);
    const body = (await world.claude.nextReply(threadId, 5)).body as string;
    expect(body.split('\n\n').slice(0, 2)).toEqual([
      'Answered 1 question.',
      "You have 10 other questions open in this thread. They stay open; the person will answer them in the Inbox. Don't re-ask them.",
    ]);
    await expect(page.getByText(/^Skipped · \d{1,2}:\d{2} [AP]M$/)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a phone: the foot by default and after Skip them; that Send is one reply skipping exactly the 10', async ({ browser }: { browser: Browser }) => {
  const { threadId, last } = await ownersThread('Triage on a phone');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    await page.goto(`${world.url}#thread=${threadId}`);
    await expect(page.locator('section.ib-pane').getByRole('heading', { name: 'Triage on a phone' })).toBeVisible();
    await pickLast(page, last);
    const chip = page.locator('.ib-pfoot [data-skip-chip]');
    await expect(chip).toContainText('10 questions stay open');
    await chip.scrollIntoViewIfNeeded();
    await footShots(page, 'phone-1-default');
    await chip.getByRole('button', { name: 'Skip them' }).click();
    await expect(chip).toContainText('10 questions will be skipped');
    await footShots(page, 'phone-2-skip-them');
    await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (await readThread(threadId)).thread.messages.filter((m) => m.author.kind === 'person').length).toBe(1);
    await page.waitForTimeout(500);
    const model = await readThread(threadId);
    expect(model.thread.messages.filter((m) => m.author.kind === 'person')).toHaveLength(1);
    const questions = model.thread.messages.flatMap((m) => m.questions ?? []);
    expect(questions.every((q) => q.state === 'sent')).toBe(true);
    expect(questions.filter((q) => q.answer?.skipped)).toHaveLength(10);
    const mine = model.thread.messages.find((m) => m.author.kind === 'person')!;
    expect(mine.body.split('\n')[0]).toBe('Answered 1 question, skipped 10.');
  } finally {
    await context.close();
  }
});
