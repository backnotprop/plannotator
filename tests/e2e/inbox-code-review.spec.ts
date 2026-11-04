/**
 * Code review in the Inbox (approval "inbox-code-review-direction", phase 1),
 * proved in a real browser against the compiled binary. Nothing is mocked:
 * the binary runs `plannotator inbox --background` under a temp
 * PLANNOTATOR_DATA_DIR, a simulated agent writes through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts), and Chromium drives the
 * window. HOME is never changed: the sandbox env (PLANNOTATOR_TEST_SANDBOX
 * and the rest below) keeps the binary off the person's agents, and the skill
 * roots point at scratch folders.
 *
 * What is proved, in order:
 *  1. Off (the default): Settings → Capabilities shows Code review off; a
 *     review the agent sends is refused, a guided review shows today's tile,
 *     and the "/" list has no Plannotator skill.
 *  2. On: the "/" list offers /review-curate labelled Plannotator, and not
 *     /review-recheck; a reply that uses it carries its instructions.
 *  3. The agent's review (submit_guide `review: true`) shows a review card
 *     with Start review; Start review opens the full-window review (chapters
 *     rail, Walkthrough | All files, the real diff), a line comment and a
 *     Viewed tick land, and Send feedback sends the verdict as the person's
 *     reply, which the agent reads with the comment in the review app's
 *     export. The card then shows the outcome; /review-recheck is offered.
 *  4. The same at 390 px (a phone).
 *  5. "Tell your agents" never appears.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/code-review (desktop light and dark
 * at 1440, phone light at 390), and a walkthrough video (webm) when
 * PLANNOTATOR_E2E_VIDEO=1.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'code-review');
const video = process.env.PLANNOTATOR_E2E_VIDEO === '1';

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  project: string;
  patch: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

let world: World;
/** The person's reply that asked for the review (test 2), which the agent's review answers (test 3). */
let askedFor = '';

/** The change the review is about: a real git diff of a scratch project. */
function payoutsProject(parent: string): { project: string; patch: string } {
  const project = scratchProject(parent, 'payouts');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout;
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(project, path, '..'), { recursive: true });
    writeFileSync(join(project, path), text);
  };
  write('src/payouts/retry.ts', [
    "import { charge } from './stripe';",
    '',
    'export async function retryPayout(payout: Payout): Promise<Result> {',
    '  for (let attempt = 0; attempt < 5; attempt++) {',
    '    const result = await charge(payout);',
    '    if (result.ok) return result;',
    '  }',
    "  return { ok: false, reason: 'gave_up' };",
    '}',
    '',
  ].join('\n'));
  write('src/payouts/ledger.ts', [
    "import { db } from '../db';",
    '',
    'export async function recordAttempt(payoutId: string, attempt: number, ok: boolean) {',
    "  await db.insert('payout_attempts', { payout_id: payoutId, attempt, ok });",
    '}',
    '',
  ].join('\n'));
  write('config/payouts.json', '{\n  "retry_limit": 5,\n  "timeout_ms": 8000\n}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  write('src/payouts/retry.ts', [
    "import { charge, isRetryable } from './stripe';",
    "import { recordAttempt } from './ledger';",
    '',
    'const BACKOFF_MS = [500, 2_000, 8_000];',
    '',
    'export async function retryPayout(payout: Payout): Promise<Result> {',
    '  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {',
    '    const result = await charge(payout, { idempotencyKey: `${payout.id}:${attempt}` });',
    '    await recordAttempt(payout.id, attempt, result.ok);',
    '    if (result.ok) return result;',
    '    // A card decline or a closed account never succeeds on retry.',
    "    if (!isRetryable(result.code)) return { ok: false, reason: 'not_retryable', code: result.code };",
    '    if (attempt < BACKOFF_MS.length) await sleep(BACKOFF_MS[attempt]!);',
    '  }',
    "  return { ok: false, reason: 'gave_up' };",
    '}',
    '',
    'const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));',
    '',
  ].join('\n'));
  write('src/payouts/ledger.ts', [
    "import { db } from '../db';",
    '',
    'export async function recordAttempt(payoutId: string, attempt: number, ok: boolean) {',
    '  // One row per attempt: a retried request (same key) updates it instead of adding one.',
    "  await db.upsert('payout_attempts', { payout_id: payoutId, attempt, ok }, ['payout_id', 'attempt']);",
    '}',
    '',
  ].join('\n'));
  write('src/payouts/retry.test.ts', [
    "import { expect, test } from 'bun:test';",
    "import { retryPayout } from './retry';",
    '',
    "test('a decline is not retried', async () => {",
    "  const result = await retryPayout(fakePayout({ decline: 'card_declined' }));",
    "  expect(result).toEqual({ ok: false, reason: 'not_retryable', code: 'card_declined' });",
    '});',
    '',
    "test('a timeout is retried with backoff', async () => {",
    '  const result = await retryPayout(fakePayout({ timeoutsBeforeOk: 2 }));',
    '  expect(result.ok).toBe(true);',
    '});',
    '',
  ].join('\n'));
  write('config/payouts.json', '{\n  "retry_limit": 3,\n  "timeout_ms": 8000\n}\n');
  git('add', '-A');
  return { project, patch: git('diff', '--cached') };
}

const REVIEW_GUIDE = {
  title: 'Retry failed payouts',
  intent: 'Retry only the payouts Stripe calls retryable, with backoff, and record each attempt once.',
  sections: [
    {
      title: 'Retry only what Stripe calls retryable',
      overview: 'A decline or a closed account now stops at once instead of being charged five times. Timeouts and rate limits back off: 0.5 s, 2 s, 8 s.',
      diffs: [{ file: 'src/payouts/retry.ts', summary: 'The retry loop, the retryable check and the backoff.' }],
    },
    {
      title: 'Write each attempt to the ledger once',
      overview: 'The ledger upserts on (payout_id, attempt), so a retried request does not add a second row.',
      diffs: [{ file: 'src/payouts/ledger.ts', summary: 'insert becomes upsert.' }],
    },
    {
      title: 'Tests for the retry window',
      overview: 'A decline is not retried; a timeout is retried until it succeeds.',
      diffs: [{ file: 'src/payouts/retry.test.ts', summary: 'Two new tests.' }],
    },
  ],
  unplacedFiles: ['config/payouts.json'],
  review: { gitRef: 'main...HEAD', base: 'main' },
  generator: { engine: 'claude-code', model: 'claude-opus-5' },
};

const expectStart = (text: string, start: string) => expect(text.slice(0, start.length)).toBe(start);

/** The "/" list's options from Plannotator (its right column reads "Plannotator"). */
const plannotatorOptions = (page: Page) => page.locator('[data-skill-menu] [role="option"]').filter({ hasText: 'Plannotator' });

/** The thread's reply box, opened from the foot's Reply when it is folded. */
async function replyBox(page: Page) {
  const box = page.getByRole('textbox', { name: /^Reply to / });
  if (!(await box.isVisible())) await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(box).toBeVisible();
  return box;
}

async function noAgentsDialog(page: Page): Promise<void> {
  await expect(page.getByText('Tell your agents', { exact: false })).toHaveCount(0);
}

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  await noAgentsDialog(page);
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function setCodeReview(on: boolean): Promise<void> {
  const response = await world.page.request.post(`${world.url}api/inbox/settings`, { data: { code_review: { on } } });
  expect(response.status()).toBe(200);
}

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-code-review-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  // The skill roots (review-skill-loader.ts) in scratch folders; HOME stays the runner's.
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { project, patch } = payoutsProject(join(root, 'src'));
  world = { root, dataDir, env, url, project, patch, claude: await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' }), context, page, errors };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('off by default: no review sent, today\'s guided-review tile, no Plannotator skill in the "/" list', async () => {
  const { page, claude } = world;
  await page.goto(`${world.url}#settings/capabilities`);
  const row = page.locator('[data-settings-code-review]');
  await expect(row).toBeVisible();
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await shot(page, '1-switch-off');

  await expect(claude.submitGuide({ project_path: world.project, guide: REVIEW_GUIDE, patch: world.patch, review: true } as never)).rejects.toThrow();
  const plain = await claude.submitGuide({ project_path: world.project, guide: REVIEW_GUIDE, patch: world.patch, thread: 'plain-guide', subject: 'Payout retries (guided review)' });
  await page.goto(`${world.url}#thread=${plain.thread_id}`);
  await expect(page.locator('[data-guide-card]')).toBeVisible();
  await expect(page.locator('[data-review-card]')).toHaveCount(0);
  const box = await replyBox(page);
  await box.click();
  await box.pressSequentially('/review-', { delay: 30 });
  await page.waitForTimeout(500);
  // The person's own skills may match (the runner's ~/.agents/skills); none of Plannotator's does.
  await expect(plannotatorOptions(page)).toHaveCount(0);
  await box.fill('');
});

test('on: the "/" list offers /review-curate as Plannotator\'s, and a reply that uses it carries its instructions', async () => {
  const { page, claude } = world;
  await page.goto(`${world.url}#settings/capabilities`);
  const toggle = page.locator('[data-settings-code-review]').getByRole('switch');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await shot(page, '1-switch-on');

  const ask = await claude.send({ project_path: world.project, thread: 'payouts', subject: 'Payout retries', body: 'I changed the payout retry: only retryable failures, with backoff, and one ledger row per attempt. Tests pass.' });
  await page.goto(`${world.url}#thread=${ask.thread_id}`);
  const box = await replyBox(page);
  await box.click();
  await box.pressSequentially('/review-', { delay: 30 });
  const menu = page.locator('[data-skill-menu]');
  await expect(menu).toBeVisible();
  await expect(plannotatorOptions(page)).toHaveCount(1);
  await expect(menu.getByRole('option').first()).toContainText('review-curate');
  await expect(menu).not.toContainText('review-recheck');
  await shot(page, '2-slash-list');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await box.pressSequentially(' focus on the money paths', { delay: 10 });
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const reply = await claude.nextReply(ask.thread_id as string);
  const body = String(reply.body);
  expect(body).toMatch(/^\/review-curate +focus on the money paths/);
  expect(body).toContain('**Skills referenced**');
  expect(body).toContain('--- BEGIN SKILL INSTRUCTIONS: review-curate ---');
  expect(body).toContain('submit_guide with `review: true`');
  askedFor = String(reply.id);
});

test('the review card, the full-window review with a comment and a Viewed tick, and the verdict sent as the reply', async () => {
  const { page, claude } = world;
  const review = await claude.submitGuide({
    project_path: world.project,
    guide: REVIEW_GUIDE,
    patch: world.patch,
    reply_to: askedFor,
    body: '3 of the 4 changed files need you. Safe to skim: config/payouts.json (retry_limit 5 → 3, matching the backoff).',
    review: true,
  } as never);
  await page.goto(`${world.url}#thread=${review.thread_id}`);
  const card = page.locator('[data-review-card]');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-review-outcome', 'waiting');
  await expect(card).toContainText('Waiting on you');
  await expect(card).toContainText('Retry only what Stripe calls retryable');
  await card.scrollIntoViewIfNeeded();
  await shot(page, '3-review-card');

  await card.getByRole('button', { name: 'Start review' }).click();
  const pane = page.locator('[data-review-message]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('[data-review-chapters] li')).toHaveCount(4);
  const retry = pane.locator('[data-guide-file-shell="src/payouts/retry.ts"]');
  const added = (line: number) => retry.locator(`[data-line-type="change-addition"][data-column-number="${line}"]`);
  await expect(added(12)).toBeVisible({ timeout: 30_000 });
  await shot(page, '4-review-mode');

  await retry.hover();
  await added(12).click();
  const composer = page.getByPlaceholder('Leave feedback...');
  await expect(composer).toBeVisible();
  await composer.fill('Log the Stripe code here: support will ask why a payout stopped.');
  await page.getByRole('button', { name: 'Add Comment' }).click();
  await expect(pane.locator('[data-guide-comments]')).toHaveAttribute('data-guide-comments', '1');

  // All files: the rail lists every changed file; a Viewed tick is kept on the message.
  await pane.locator('[data-review-mode-choice="files"]').click();
  await expect(pane).toHaveAttribute('data-review-mode', 'files');
  await expect(pane.locator('[data-review-files] li')).toHaveCount(4);
  const ledger = pane.locator('[data-guide-file-shell="src/payouts/ledger.ts"]');
  await ledger.scrollIntoViewIfNeeded();
  // The review app's V key does not work here: the tooltip does not name it.
  expect(await ledger.getByRole('button', { name: /Viewed/ }).first().getAttribute('title')).not.toContain('(V)');
  await ledger.getByRole('button', { name: /Viewed/ }).first().click();
  await expect.poll(async () => ((await (await page.request.get(`${world.url}api/inbox/threads/${review.thread_id}`)).json()) as { thread: { messages: { id: string; guide_viewed?: string[] }[] } }).thread.messages.find((m) => m.id === review.message_id)?.guide_viewed).toEqual(['src/payouts/ledger.ts']);
  await pane.locator('[data-review-mode-choice="walkthrough"]').click();
  await retry.scrollIntoViewIfNeeded();
  await shot(page, '4-review-comment');

  // A note half written on a decision is kept across a close and a reopen, until its verdict goes.
  await pane.locator('[data-review-decision] [data-decision-caret]').click();
  await page.getByRole('menuitem', { name: /Send with a note/ }).click();
  await page.locator('[data-decision-note-input]').fill('Also check the retry cap.');
  await pane.getByRole('button', { name: 'Thread' }).click();
  await expect(pane).toHaveCount(0);
  await page.locator('[data-review-card]').getByRole('button', { name: /review/ }).click();
  await expect(pane).toBeVisible();
  await pane.locator('[data-review-decision] [data-decision-caret]').click();
  await page.getByRole('menuitem', { name: /Send with a note/ }).click();
  await expect(page.locator('[data-decision-note-input]')).toHaveValue('Also check the retry cap.');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  const decide = pane.locator('[data-review-decision] [data-decision-primary]');
  await expect(decide).toContainText(/Send/);
  await decide.click();
  await expect(pane).toHaveCount(0);
  const verdict = await claude.nextReply(review.thread_id as string, 50, String(review.message_id));
  const words = String(verdict.body);
  expectStart(words, 'I reviewed "Retry failed payouts" and I am asking for changes: my comment is below.');
  expect(words).toContain('# Feedback on the guided review');
  expect(words).toContain('Log the Stripe code here');
  expect(words).toContain('src/payouts/retry.ts');

  await expect(card).toHaveAttribute('data-review-outcome', 'changes_requested');
  await expect(card).toContainText('Changes requested · 1 comment');
  await expect(card.getByRole('button', { name: 'Open review' })).toBeVisible();
  await page.locator('.ib-msg').last().scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, '5-verdict-sent');
  await card.scrollIntoViewIfNeeded();
  await shot(page, '6-card-outcome');

  // A review happened in this thread: /review-recheck is offered now.
  const box = await replyBox(page);
  await box.click();
  await box.pressSequentially('/review-', { delay: 20 });
  const menu = page.locator('[data-skill-menu]');
  await expect(plannotatorOptions(page)).toHaveCount(2);
  await expect(menu).toContainText('review-recheck');
  await shot(page, '7-slash-list-recheck');
  await page.keyboard.press('Escape');
  await box.fill('');
  expect(world.errors).toEqual([]);
});

test('a phone at 390 px: the switch, the "/" list, the card, the review with a comment, the verdict and the outcome', async ({ browser }) => {
  const { claude } = world;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${world.url}#settings/capabilities`);
    await expect(page.locator('[data-settings-code-review]').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await page.locator('[data-settings-code-review]').scrollIntoViewIfNeeded();
    await shot(page, 'phone-1-switch', ['light']);

    const ask = await claude.send({ project_path: world.project, thread: 'payouts-phone', subject: 'Ledger upsert', body: 'The ledger now upserts each attempt. Want a review?' });
    await page.goto(`${world.url}#thread=${ask.thread_id}`);
    const box = await replyBox(page);
    await box.click();
    await box.pressSequentially('/review-', { delay: 30 });
    await expect(page.locator('[data-skill-menu]')).toContainText('review-curate');
    await shot(page, 'phone-2-slash-list', ['light']);
    await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Send' }).last().click();
    const reply = await claude.nextReply(ask.thread_id as string);

    const review = await claude.submitGuide({ project_path: world.project, guide: REVIEW_GUIDE, patch: world.patch, reply_to: String(reply.id), body: '3 of the 4 changed files need you.', review: true } as never);
    await page.goto(`${world.url}#thread=${review.thread_id}`);
    const card = page.locator('[data-review-card]');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toContainText('Waiting on you');
    await shot(page, 'phone-3-review-card', ['light']);
    await card.getByRole('button', { name: 'Start review' }).click();
    const pane = page.locator('[data-review-message]');
    await expect(pane).toBeVisible();
    const retry = pane.locator('[data-guide-file-shell="src/payouts/retry.ts"]');
    const added = retry.locator('[data-line-type="change-addition"][data-column-number="12"]');
    await expect(added).toBeVisible({ timeout: 30_000 });
    await added.scrollIntoViewIfNeeded();
    await added.click();
    const composer = page.getByPlaceholder('Leave feedback...');
    await expect(composer).toBeVisible();
    await composer.fill('Log the Stripe code here.');
    await page.getByRole('button', { name: 'Add Comment' }).click();
    await expect(pane.locator('[data-guide-comments]')).toHaveAttribute('data-guide-comments', '1');
    await expect(pane.locator('[data-review-phonebar] select')).toBeVisible();
    await retry.getByText('Log the Stripe code here.').scrollIntoViewIfNeeded();
    await shot(page, 'phone-4-review-comment', ['light']);
    // The review fits the phone: nothing wider than the window.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await pane.locator('[data-review-decision] [data-decision-primary]').click();
    await expect(pane).toHaveCount(0);
    await claude.nextReply(review.thread_id as string, 50, String(review.message_id));
    await expect(card).toContainText('Changes requested · 1 comment');
    await page.locator('.ib-msg').last().scrollIntoViewIfNeeded().catch(() => {});
    await shot(page, 'phone-5-verdict-sent', ['light']);
    await card.scrollIntoViewIfNeeded();
    await shot(page, 'phone-6-card-outcome', ['light']);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('the walkthrough video: a review from the card to Approve', async ({ browser }) => {
  test.skip(!video, 'PLANNOTATOR_E2E_VIDEO=1 records it');
  const { claude } = world;
  const ask = await claude.send({ project_path: world.project, thread: 'payouts-video', subject: 'Payout retries v2', body: 'I acted on your comment: the Stripe code is logged now.' });
  const review = await claude.submitGuide({ project_path: world.project, guide: { ...REVIEW_GUIDE, title: 'Retry failed payouts, round 2' }, patch: world.patch, reply_to: String(ask.message_id), body: 'I logged the Stripe code where the retry stops (your comment).', review: true } as never);
  const dir = join(proofDir, 'video');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', recordVideo: { dir, size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  const pause = (ms: number) => page.waitForTimeout(ms);
  try {
    await page.goto(`${world.url}#settings/capabilities`);
    await pause(1800);
    await page.goto(`${world.url}#thread=${review.thread_id}`);
    const card = page.locator('[data-review-card]');
    await card.scrollIntoViewIfNeeded();
    await pause(2500);
    await card.getByRole('button', { name: 'Start review' }).click();
    const pane = page.locator('[data-review-message]');
    const retry = pane.locator('[data-guide-file-shell="src/payouts/retry.ts"]');
    await expect(retry.locator('[data-line-type="change-addition"][data-column-number="12"]')).toBeVisible({ timeout: 30_000 });
    await pause(2500);
    for (const index of [1, 2, 3]) {
      await pane.locator('[data-review-chapters] li').nth(index).click();
      await pause(1800);
    }
    await pane.locator('[data-review-mode-choice="files"]').click();
    await pause(1800);
    await pane.locator('[data-review-files] li').first().click();
    await pause(1500);
    await pane.locator('[data-review-mode-choice="walkthrough"]').click();
    await pane.locator('[data-review-chapters] li').nth(1).click();
    await pause(1200);
    await retry.hover();
    await retry.locator('[data-line-type="change-addition"][data-column-number="9"]').click();
    const composer = page.getByPlaceholder('Leave feedback...');
    await composer.pressSequentially('Nice: one row per attempt.', { delay: 40 });
    await pause(600);
    await page.getByRole('button', { name: 'Add Comment' }).click();
    await pause(1800);
    // Approve with notes: the comment rides along, nothing blocks.
    await pane.locator('[data-review-decision] [data-decision-caret]').click();
    await pause(1500);
    await page.getByRole('menuitem', { name: /Approve with notes/ }).click();
    await expect(pane).toHaveCount(0);
    await expect(card).toContainText('Approved');
    await card.scrollIntoViewIfNeeded();
    await pause(3000);
  } finally {
    await context.close();
  }
  const [recorded] = readdirSync(dir).filter((f) => f.endsWith('.webm'));
  renameSync(join(dir, recorded!), join(proofDir, 'walkthrough.webm'));
  const verdict = await claude.nextReply(review.thread_id as string, 50, String(review.message_id));
  expectStart(String(verdict.body), 'I approved your review "Retry failed payouts, round 2", with a comment below.');
});
