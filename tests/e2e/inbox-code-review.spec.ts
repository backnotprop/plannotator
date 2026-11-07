/**
 * Code review in the Inbox (approval "inbox-code-review-direction", phase 1),
 * proved in a real browser against the compiled binary. Nothing is mocked:
 * the binary runs `plannotator inbox --background` under a temp
 * PLANNOTATOR_DATA_DIR, a simulated agent writes through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts), and Chromium drives the
 * window. HOME is the scratch folder, and the sandbox env (PLANNOTATOR_TEST_SANDBOX
 * and the rest below) keeps the binary off the person's agents.
 *
 * What is proved, in order:
 *  1. Off (the default): Settings → Capabilities shows Code review off; a
 *     review the agent sends is refused, a guided review shows today's tile,
 *     and the "/" list has no Plannotator skill.
 *  2. On: the "/" list offers /review-curate labelled Plannotator, and not
 *     /review-recheck; a reply that uses it carries its instructions.
 *  3. The agent's review (submit_guide `review: true`) shows a review card
 *     with Start review; Start review opens the full-window review (the top
 *     bar's Walkthrough | All files and chapter menu, the real diff), a line comment and a
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

import { chromium, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { expectNoBlankFiles } from './on-screen-files';
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
  // Code review's one-time offer (approval "code-review-offer-card") was already answered: with PREVIEW on a release
  // build it would open on the first page, over this spec's flow. Its own test is packages/inbox/codeReviewOffer.test.tsx.
  const configFile = join(dataDir, 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(configFile, JSON.stringify({ ...config, inboxReveals: { code_review: { shownAt: '2026-10-24T00:00:00.000Z' } } }));
  // The skill roots (review-skill-loader.ts) in scratch folders, like HOME.
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    // Held until the next big release (packages/server/inbox.ts heldSwitch): the Code review switch shows while off only with this.
    // That release removes this line.
    PLANNOTATOR_INBOX_PREVIEW: '1',
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
  // None of Plannotator's skills matches.
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
  await expect(card.locator('.ib-rvc-meta')).toHaveText('4 files +27 -5 · 3 chapters');
  await card.scrollIntoViewIfNeeded();
  await shot(page, '3-review-card');

  await card.getByRole('button', { name: 'Start review' }).click();
  const pane = page.locator('[data-review-message]');
  await expect(pane).toBeVisible();
  await pane.locator('[data-review-jump]').click();
  await expect(page.locator('[data-review-chapters] [data-review-jump-row]')).toHaveCount(4);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-review-jump-menu]')).toHaveCount(0);
  await expect(pane).toBeVisible();
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

  // All files: the menu lists every changed file; a Viewed tick is kept on the message.
  await pane.locator('[data-review-mode-choice="files"]').click();
  await expect(pane).toHaveAttribute('data-review-mode', 'files');
  await pane.locator('[data-review-jump]').click();
  await expect(page.locator('[data-review-files] [data-review-jump-row]')).toHaveCount(4);
  await page.keyboard.press('Escape');
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

test('a review of 21 small files on a tall window: every file on screen draws, all the way down', async ({ browser }) => {
  const paths = Array.from({ length: 21 }, (_, i) => `src/small/f${String(i).padStart(2, '0')}.ts`);
  const review = await world.claude.submitGuide({
    project_path: world.project,
    guide: {
      title: 'Twenty-one small files',
      intent: 'A rename across small files.',
      sections: [{ title: 'The rename', overview: 'Each file changes one line.', diffs: paths.map((file) => ({ file, summary: 'One line.' })) }],
      review: { gitRef: 'main...HEAD', base: 'main' },
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
    patch: paths.map((path, i) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n export const a = 1;\n-export const b = ${i};\n+export const b = ${i + 1};\n`).join(''),
    body: 'A rename across 21 small files.',
    review: true,
  } as never);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1200 }, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    await page.goto(`${world.url}#thread=${review.thread_id}`);
    await page.locator('[data-review-card]').getByRole('button', { name: 'Start review' }).click();
    const pane = page.locator('[data-review-message]');
    await expect(pane.locator('[data-guide-file-shell]').first()).toBeVisible({ timeout: 30_000 });
    await expect(pane.locator('[data-guide-file-shell]')).toHaveCount(21);
    await expectNoBlankFiles(pane.locator('.ib-gbody'));
  } finally {
    await context.close();
  }
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
    // click() scrolls and retries if the diff redraws the line; a separate scroll can catch it detached.
    await added.click();
    const composer = page.getByPlaceholder('Leave feedback...');
    await expect(composer).toBeVisible();
    await composer.fill('Log the Stripe code here.');
    await page.getByRole('button', { name: 'Add Comment' }).click();
    await expect(pane.locator('[data-guide-comments]')).toHaveAttribute('data-guide-comments', '1');
    await expect(pane.locator('[data-review-jump]')).toBeVisible();
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

/** A jump's smooth scroll has landed: the review's scroll holds still. */
async function settled(body: Locator): Promise<void> {
  let last = -1;
  await expect(async () => {
    const now = await body.evaluate((el) => el.scrollTop);
    const still = now === last;
    last = now;
    expect(still).toBe(true);
  }).toPass({ intervals: [300] });
}

/** Fails when a part of the review's top bar overlaps another, or leaves the window. */
async function expectBarFits(page: Page): Promise<void> {
  const trouble = await page.evaluate(() => {
    const head = document.querySelector('[data-review-message] .ib-vhead') as HTMLElement;
    const parts = [...head.children, ...head.querySelectorAll('.ib-rv-nav > *')]
      .filter((el) => el.getClientRects().length > 0 && !el.classList.contains('ib-sp') && !el.classList.contains('ib-rv-nav'))
      .map((el) => ({ name: (el as HTMLElement).className || el.tagName, box: el.getBoundingClientRect() }))
      .sort((a, b) => a.box.left - b.box.left);
    const problems: string[] = [];
    parts.forEach((part, i) => {
      if (part.box.right > window.innerWidth + 0.5 || part.box.left < -0.5) problems.push(`${part.name} leaves the window`);
      const next = parts[i + 1];
      if (next && next.box.left < part.box.right - 0.5) problems.push(`${part.name} overlaps ${next.name}`);
    });
    if (head.scrollWidth > head.clientWidth + 1) problems.push('the bar overflows');
    return problems;
  });
  expect(trouble).toEqual([]);
}

/** The tooltip showing now does not sit on the verdict's buttons. */
async function expectTipClearOfDecision(page: Page, words = 'Split view. Click for Unified'): Promise<void> {
  const tip = page.getByText(words);
  await expect(tip).toBeVisible();
  const box = (await tip.boundingBox())!;
  const decide = (await page.locator('[data-review-message] [data-review-decision]').boundingBox())!;
  const apart = box.x + box.width <= decide.x || decide.x + decide.width <= box.x || box.y + box.height <= decide.y || decide.y + decide.height <= box.y;
  expect(apart, `tooltip ${JSON.stringify(box)} on the verdict ${JSON.stringify(decide)}`).toBe(true);
}

/** The place named in the top bar reads whole when it is the short word "Overview". */
async function expectOverviewWhole(page: Page): Promise<void> {
  const name = page.locator('[data-review-message] .ib-rj-name');
  await expect(name).toHaveText('Overview');
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
}

test('the top bar holds what the rail held: chapters, the count, files, Overview, and the diff controls, by mouse and by keyboard', async () => {
  const { page, claude } = world;
  const review = await claude.submitGuide({ project_path: world.project, guide: REVIEW_GUIDE, patch: world.patch, thread: 'top-bar', subject: 'Retry failed payouts', body: 'Ready.', review: true } as never);
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto(`${world.url}#thread=${review.thread_id}`);
  await page.locator('[data-review-card]').getByRole('button', { name: 'Start review' }).click();
  const pane = page.locator('[data-review-message]');
  const bar = pane.locator('.ib-vhead');
  const jump = pane.locator('[data-review-jump]');
  const menu = page.locator('[data-review-jump-menu]');
  const firstFile = pane.locator('[data-guide-file-shell="src/payouts/retry.ts"]');
  await expect(firstFile.locator('[data-line-type="change-addition"]').first()).toBeVisible({ timeout: 30_000 });

  // No rail, and the bar says the review's name once.
  await expect(pane.locator('.ib-rrail')).toHaveCount(0);
  await expect(pane.locator('[data-review-title]')).toHaveText('Retry failed payouts');
  await expect(jump).toContainText('Overview');
  // The heading says what is being reviewed; the title's tooltip says it too, from anywhere in the review.
  await expect(pane.locator('[data-guide-facts]')).toContainText('main');
  await pane.locator('[data-review-title]').hover();
  await expect(page.locator('[data-review-source]')).toBeVisible();
  await page.mouse.move(700, 500);
  // The diff controls are the bar's, after the title (approval "diff-controls-headers"); no chapter has a tab.
  await expect(pane.locator('[data-guide-section-tab]')).toHaveCount(0);
  const controls = bar.locator('[data-diff-controls]');
  const toggle = controls.locator('[data-diff-layout-toggle]');
  await expect(toggle).toHaveAttribute('data-diff-layout-toggle', 'split');
  expect(await bar.evaluate((head) => !!(head.querySelector('[data-review-title]')!.compareDocumentPosition(head.querySelector('[data-diff-controls]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  // Words cut from the screen stay in a tooltip: the arrow says Thread, the mark says what it is and does.
  await pane.locator('.ib-back').hover();
  await expect(page.getByText('Thread', { exact: true })).toBeVisible();
  await toggle.hover();
  await expectTipClearOfDecision(page);
  await page.mouse.move(700, 500);

  // The menu: Overview, every chapter, the count.
  await jump.click();
  await expect(menu.locator('[data-review-jump-row]')).toHaveCount(4);
  await expect(menu.locator('[data-review-jump-row="overview"]')).toHaveText('Overview');
  await expect(menu.locator('[data-review-progress]')).toHaveText('0 of 3 chapters reviewed');
  await shot(page, 'topbar-menu');

  // A pick goes to the chapter and names it. Scrolling by hand then names what is in view.
  await menu.locator('[data-review-jump-row="1"]').click();
  await expect(jump).toContainText('2 of 3');
  await expect(jump).toContainText('Write each attempt to the ledger once');
  await expect(pane.locator('[data-guide-file-shell="src/payouts/ledger.ts"]')).toBeInViewport();
  const body = pane.locator('.ib-gbody');
  await settled(body);
  await body.hover();
  await page.mouse.wheel(0, -100000);
  await expect(jump).toContainText('Overview');
  await page.mouse.wheel(0, 100000);
  await expect(jump).toContainText('of 3');
  await page.mouse.wheel(0, -100000);
  await expect(jump).toContainText('Overview');
  await settled(body);

  // The one button switches every diff, and switches back; the controls stay where they are, off the page.
  const approve = pane.locator('[data-review-decision] [data-decision-primary]');
  const approveAt = (await approve.boundingBox())!.x;
  // Each file's layout as drawn. A new file has no old side, so Split draws it in one column too (the diff library's way).
  const drawnTypes = () => pane.locator('pre[data-diff]').evaluateAll((pres) => pres.map((p) => p.getAttribute('data-diff-type')));
  const asSplit = await drawnTypes();
  expect(asSplit).toContain('split');
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-diff-layout-toggle', 'unified');
  await expect.poll(async () => [...new Set(await drawnTypes())]).toEqual(['single']);
  await toggle.click();
  await expect.poll(drawnTypes).toEqual(asSplit);
  expect((await approve.boundingBox())!.x).toBe(approveAt);
  const controlsBox = (await controls.boundingBox())!;
  expect(controlsBox.x + controlsBox.width).toBeLessThanOrEqual(approveAt);
  expect(controlsBox.y + controlsBox.height).toBeLessThanOrEqual((await body.boundingBox())!.y);
  // The gear: code review's popover, without Whole file and Hide whitespace.
  await controls.getByRole('button', { name: 'Diff display options' }).click();
  await expect(page.locator('[data-diff-display-popup]').getByRole('switch')).toHaveText(['Wrap long lines', 'Line numbers', 'Backgrounds']);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-diff-display-popup]')).toHaveCount(0);
  await expect(pane).toBeVisible();

  // Reviewed: the tick shows in the menu, the count moves, and the rows are still there.
  await page.mouse.wheel(0, -100000);
  await pane.locator('[data-guide-section="0"]').getByRole('button', { name: 'Reviewed' }).click();
  await jump.click();
  await expect(menu.locator('[data-review-progress]')).toHaveText('1 of 3 chapters reviewed');
  await expect(menu.locator('[data-review-jump-row="0"] [data-done]')).toBeVisible();
  // The tick reads on its disc: the menu recolours any svg, and this one keeps the disc's own colour.
  const tick = await menu.locator('[data-review-jump-row="0"] [data-done]').evaluate((disc) => ({ on: getComputedStyle(disc).color, stroke: getComputedStyle(disc.querySelector('svg')!).stroke }));
  expect(tick.stroke).toBe(tick.on);
  // Keyboard, as the rail's rows were: Enter opens (on the trigger), an arrow and Enter pick, focus comes back to the button.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(pane).toBeVisible();
  await jump.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  const third = menu.locator('[data-review-jump-row="2"]');
  await expect(async () => {
    await page.keyboard.press('ArrowDown');
    await expect(third).toBeFocused({ timeout: 200 });
  }).toPass();
  await page.keyboard.press('Enter');
  await expect(jump).toContainText('3 of 3');
  await expect(jump).toBeFocused();

  // What the rail's Files gave, and the place kept across the switch: the file in view stays in view.
  const ledger = pane.locator('[data-guide-file-shell="src/payouts/ledger.ts"]');
  await jump.click();
  await menu.locator('[data-review-jump-row="1"]').click();
  await expect(ledger).toBeInViewport();
  await page.waitForTimeout(600);
  await pane.locator('[data-review-mode-choice="files"]').click();
  await expect(pane).toHaveAttribute('data-review-mode', 'files');
  await expect(jump).toContainText('ledger.ts');
  await expect(ledger).toBeInViewport();
  await jump.click();
  await expect(menu.locator('[data-review-files] [data-review-jump-row]')).toHaveCount(4);
  await expect(menu.locator('[data-review-progress]')).toHaveText('0 of 4 files viewed');
  // The menu lists the files in the order the review draws them, so "2 of 4" is the second one down the page.
  const drawn = await pane.locator('[data-guide-file-shell]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.guideFileShell));
  const listed = await menu.locator('[data-review-jump-row]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.reviewJumpRow));
  expect(listed).toEqual(drawn);
  await menu.locator('[data-review-jump-row="src/payouts/retry.ts"]').click();
  await expect(pane.locator('[data-guide-section-narrative]').first()).toBeHidden();
  await pane.locator('[data-review-mode-choice="walkthrough"]').click();
  // A file no chapter placed: back from All files, the name is the last chapter's, what a scroll by hand gives, not Overview.
  const placed = new Set(REVIEW_GUIDE.sections.flatMap((section) => section.diffs.map((ref) => ref.file)));
  const unplaced = (drawn as string[]).find((path) => !placed.has(path))!;
  await pane.locator('[data-review-mode-choice="files"]').click();
  await jump.click();
  await menu.locator(`[data-review-jump-row="${unplaced}"]`).click();
  await settled(body);
  await pane.locator('[data-review-mode-choice="walkthrough"]').click();
  await expect(jump).toContainText('3 of 3');

  // Keys the review did not have stay that way: nothing here moves the thread or the chapter.
  const before = page.url();
  const place = await jump.textContent();
  await body.click({ position: { x: 3, y: 3 } });
  for (const key of ['j', 'k', ']', '[']) await page.keyboard.press(key);
  expect(page.url()).toBe(before);
  expect(await jump.textContent()).toBe(place);

  // With the menu closed Escape goes back to the thread, as it always did.
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(world.errors).toEqual([]);
});

test('narrow windows, long titles and many chapters: nothing overlaps or leaves the window, the diff controls in the bar included', async () => {
  const { page, claude } = world;
  const long = 'Retry every failed payout with a jittered backoff, then remove the row and send exactly one email, whatever the worker crashed on halfway through its run';
  const unbroken = 'reconcile_failed_payouts_against_the_ledger_before_the_morning_report_runs_and_never_twice_for_the_same_invoice';
  const guide = {
    ...REVIEW_GUIDE,
    title: long,
    intent: long,
    sections: Array.from({ length: 30 }, (_, i) => ({
      title: i % 3 === 0 ? `${unbroken}_${i}` : `${long} (${i + 1})`,
      overview: 'Notes.',
      diffs: i === 0 ? [{ file: 'src/payouts/retry.ts', summary: 'The loop.' }] : i === 1 ? [{ file: 'src/payouts/ledger.ts', summary: 'The row.' }] : [],
    })),
  };
  const review = await claude.submitGuide({ project_path: world.project, guide, patch: world.patch, thread: 'worst', subject: long, body: 'Ready.', review: true } as never);
  await page.goto(`${world.url}#thread=${review.thread_id}&guide=${review.message_id}`);
  const pane = page.locator('[data-review-message]');
  await expect(pane.locator('[data-guide-file-shell]').first()).toBeVisible({ timeout: 30_000 });
  const jump = pane.locator('[data-review-jump]');
  const menu = page.locator('[data-review-jump-menu]');
  for (const width of [1440, 1280, 1100, 960, 800, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await expectBarFits(page);
    await jump.click();
    await expect(menu).toBeVisible();
    // Thirty chapters: the list scrolls inside the window and the count stays on screen.
    await expect(menu.locator('[data-review-progress]')).toBeInViewport({ ratio: 1 });
    const box = (await menu.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    await menu.locator('[data-review-jump-row="5"]').click();
    await expect(jump).toContainText('6 of 30');
    await expectBarFits(page);
    // The chapter's own name in the bar is cut, never the count, and its tooltip says it whole.
    await expect(pane.locator('.ib-rj-lead')).toHaveText('6 of 30');
    await jump.hover();
    await expect(page.locator('[data-pn-tooltip]')).toContainText(long);
    await page.mouse.move(width / 2, 500);
    await settled(pane.locator('.ib-gbody'));
    await expect(pane.locator('.ib-vhead [data-diff-controls]')).toBeVisible();
    await expectBarFits(page);
    await pane.locator('.ib-gbody').hover();
    await page.mouse.wheel(0, -1000000);
    await expect(jump).toContainText('Overview');
    await expectOverviewWhole(page);
  }
  // A pull request's destination joins the bar (thread and list stubbed in this page; nothing reaches a forge).
  const key = 'github.com/acme/payouts#880';
  const threadRoute = /\/api\/inbox\/threads\/[^/?]+(\?.*)?$/;
  const pullsRoute = /\/api\/inbox\/pulls(\?|$)/;
  await page.route(threadRoute, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    return route.fulfill({ response, json: json.thread ? { ...json, thread: { ...(json.thread as object), pull_keys: [key] } } : { ...json, pull_keys: [key] } });
  });
  await page.route(pullsRoute, (route) =>
    route.fulfill({
      json: { fetched_at: null, hosts: [], links: {}, projects: {}, cards: {}, pulls: [{ key, platform: 'github', host: 'github.com', repo: 'acme/payouts', number: 880, url: 'https://github.com/acme/payouts/pull/880', title: long, author: 'someone', mine: true, requested: false, state: 'open', base: 'main', head: 'retry', head_repo: 'acme/payouts', head_sha: 'a'.repeat(40), additions: 4, deletions: 1, files: 1, review: null, approved_by: null, reviewers: [], checks: 'success', updated_at: '2026-10-11T10:00:00.000Z', merged_at: null }] },
    }),
  );
  await page.reload();
  await expect(pane.locator('[data-review-destination]')).toBeVisible();
  for (const width of [1440, 1280, 1100, 1099, 960, 959, 800, 768, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await expectBarFits(page);
    await expectOverviewWhole(page);
  }
  // With the diff controls in the bar too, a long chapter name gives way, after the title: the close button stays on screen.
  await page.setViewportSize({ width: 1440, height: 800 });
  await jump.click();
  await menu.locator('[data-review-jump-row="5"]').click();
  await settled(pane.locator('.ib-gbody'));
  await expect(pane.locator('.ib-vhead [data-diff-controls]')).toBeVisible();
  const nameWide = (await jump.boundingBox())!.width;
  await page.setViewportSize({ width: 1300, height: 800 });
  await expect.poll(async () => (await jump.boundingBox())!.width).toBe(nameWide);
  for (const width of [1300, 1100, 1000, 996, 995, 990, 975, 960]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(pane.locator('.ib-vhead [data-diff-controls]')).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Close the review' })).toBeInViewport({ ratio: 1 });
    await expectBarFits(page);
  }
  await page.unroute(threadRoute);
  await page.unroute(pullsRoute);
  await page.reload();
  await expect(pane.locator('[data-review-destination]')).toHaveCount(0);
  // A chapter past the window's middle is in view when the menu opens.
  await page.setViewportSize({ width: 1440, height: 800 });
  await jump.click();
  await menu.locator('[data-review-jump-row="28"]').click();
  await expect(jump).toContainText('29 of 30');
  await jump.click();
  await expect(menu.locator('[data-review-jump-row="28"]')).toBeInViewport();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(world.errors).toEqual([]);
});

test('a phone at 390 px: one row of one height, and the same menu as a desktop holds the place, the mode and the title', async ({ browser }) => {
  const { claude } = world;
  const review = await claude.submitGuide({ project_path: world.project, guide: REVIEW_GUIDE, patch: world.patch, thread: 'phone-bar', subject: 'Retry failed payouts', body: 'Ready.', review: true } as never);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    await page.goto(`${world.url}#thread=${review.thread_id}&guide=${review.message_id}`);
    const pane = page.locator('[data-review-message]');
    await expect(pane.locator('[data-guide-file-shell]').first()).toBeVisible({ timeout: 30_000 });
    // A phone reads Unified only: no layout to choose, in the bar or on a card.
    await expect(pane.locator('[data-diff-style-switch]')).toHaveCount(0);
    await expect(pane.locator('[data-diff-controls]')).toHaveCount(0);
    await expect(pane.locator('select')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    // One row, every control one height; Approve says so in a word.
    const bar = pane.locator('.ib-vhead');
    const parts = [bar.locator('.ib-back'), bar.locator('[data-review-jump]'), bar.locator('.ib-vcomments'), bar.locator('[data-decision-primary]'), bar.getByRole('button', { name: 'Close the review' })];
    const boxes = await Promise.all(parts.map(async (part) => (await part.boundingBox())!));
    expect(new Set(boxes.map((box) => box.height))).toEqual(new Set([36]));
    expect(new Set(boxes.map((box) => box.y))).toEqual(new Set([boxes[0]!.y]));
    await expect(bar.getByText('Approve', { exact: true })).toBeVisible();
    await expectBarFits(page);

    // The menu names the review and where it comes from, switches the mode, and goes to a chapter.
    const jump = bar.locator('[data-review-jump]');
    const menu = page.locator('[data-review-jump-menu]');
    await expect(jump).toContainText('Overview');
    await jump.click();
    await expect(menu.locator('[data-review-title]')).toHaveText('Retry failed payouts');
    await expect(menu.locator('[data-review-source]')).toBeVisible();
    await expect(menu.locator('[data-review-progress]')).toHaveText('0 of 3 chapters reviewed');
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await menu.locator('[data-review-jump-row="1"]').click();
    await expect(jump).toContainText('Write each attempt to the ledger once');

    // A jump lands on the file, under the bar, not behind it.
    const clear = async (path: string) => {
      const shell = pane.locator(`[data-guide-file-shell="${path}"]`);
      await expect(shell).toBeInViewport();
      await settled(pane.locator('.ib-gbody'));
      const barBox = (await bar.boundingBox())!;
      const shellBox = (await shell.boundingBox())!;
      expect(shellBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);
    };
    await clear('src/payouts/ledger.ts');

    // All files keeps the place, and the menu stays open to pick in the new list.
    await jump.click();
    await menu.locator('[data-review-mode-choice="files"]').click();
    await expect(pane).toHaveAttribute('data-review-mode', 'files');
    await expect(menu.locator('[data-review-progress]')).toHaveText('0 of 4 files viewed');
    await expect(jump).toContainText('ledger.ts');
    await menu.locator('[data-review-jump-row="src/payouts/retry.ts"]').click();
    await expect(jump).toContainText('retry.ts');
    await clear('src/payouts/retry.ts');

    // Escape closes the menu and stays in the review; the next one leaves it.
    await jump.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(pane).toBeVisible();
  } finally {
    await context.close();
  }
});

test('Viewed takes its click at every scroll: nothing sits on a file header, and no chapter carries a tab', async () => {
  const { page, claude } = world;
  const review = await claude.submitGuide({ project_path: world.project, guide: REVIEW_GUIDE, patch: world.patch, thread: 'viewed-click', subject: 'Retry failed payouts', body: 'Ready.', review: true } as never);
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto(`${world.url}#thread=${review.thread_id}&guide=${review.message_id}`);
  const pane = page.locator('[data-review-message]');
  await expect(pane.locator('[data-guide-file-shell] [data-line-type="change-addition"]').first()).toBeVisible({ timeout: 30_000 });
  const body = pane.locator('.ib-gbody');
  const jump = pane.locator('[data-review-jump]');
  const menu = page.locator('[data-review-jump-menu]');
  const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  /** What shows with the page at this scroll: any tab, and any Viewed whose centre is under something else. */
  const look = (top: number) =>
    body.evaluate((scroll, at) => {
      scroll.scrollTop = at;
      const view = scroll.getBoundingClientRect();
      const showing = (el: Element) => {
        const box = el.getBoundingClientRect();
        return box.bottom > view.top && box.top < view.bottom;
      };
      const viewed = [...scroll.querySelectorAll<HTMLElement>('[data-guide-file-shell] button')].filter((button) => button.textContent?.includes('Viewed'));
      const spots = viewed.map((button) => {
        const box = button.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, button };
      }).filter((spot) => spot.y > view.top + 1 && spot.y < view.bottom - 1);
      return {
        tabs: [...scroll.querySelectorAll('[data-guide-section-tab]')].filter(showing).length,
        covered: spots.filter((spot) => !spot.button.contains(document.elementFromPoint(spot.x, spot.y))).length,
        spots: spots.map((spot) => ({ x: spot.x, y: spot.y })),
        height: scroll.scrollHeight - scroll.clientHeight,
      };
    }, top);
  const sweep = async () => {
    const { height } = await look(0);
    let nearTop: { x: number; y: number; top: number } | null = null;
    for (let top = 0; top <= height; top += 12) {
      await look(top);
      await frames();
      const seen = await look(top);
      expect(`${top}: ${seen.covered}`).toBe(`${top}: 0`);
      // The diff controls are the bar's (approval "diff-controls-headers").
      expect(`${top}: ${seen.tabs}`).toBe(`${top}: 0`);
      const box = (await body.boundingBox())!;
      const spot = seen.spots.find((at) => at.y - box.y < 40);
      if (spot && !nearTop) nearTop = { ...spot, top };
    }
    return nearTop as { x: number; y: number; top: number } | null;
  };
  const viewedCount = async () => {
    await jump.click();
    const words = await menu.locator('[data-review-progress]').textContent();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    return words;
  };

  // The walkthrough: nothing covers a Viewed.
  await sweep();

  // All files, a Viewed just under the bar, a real click: the count moves.
  await pane.locator('[data-review-mode-choice="files"]').click();
  await expect(pane).toHaveAttribute('data-review-mode', 'files');
  await settled(body);
  const spot = await sweep();
  expect(spot).not.toBeNull();
  await look(spot!.top);
  await frames();
  await page.mouse.click(spot!.x, spot!.y);
  await expect.poll(viewedCount).toBe('1 of 4 files viewed');
  await expect(pane.locator('.ib-vhead [data-diff-controls]')).toHaveCount(1);
  await page.mouse.move(0, 400);
  expect(world.errors).toEqual([]);
});

/** The file header's fold button. */
const FILE_FOLD = /Collapse diff/;

/** The review, in a window short enough for a place with no tab, on its own thread (ticks and folds stay on a thread). */
async function shortReview(thread: string, height = 420, guide: object = REVIEW_GUIDE): Promise<{ page: Page; pane: Locator; body: Locator }> {
  const { page, claude } = world;
  const review = await claude.submitGuide({ project_path: world.project, guide, patch: world.patch, thread, subject: 'Retry failed payouts', body: 'Ready.', review: true } as never);
  await page.setViewportSize({ width: 1440, height });
  await page.goto(`${world.url}#thread=${review.thread_id}&guide=${review.message_id}`);
  const pane = page.locator('[data-review-message]');
  await expect(pane.locator('[data-guide-file-shell] [data-line-type="change-addition"]').first()).toBeVisible({ timeout: 30_000 });
  return { page, pane, body: pane.locator('.ib-gbody') };
}

test('Collapse all in the bar folds every file and opens them again; its tooltip stays off Approve', async () => {
  const { page, pane, body } = await shortReview('collapse-all', 700);
  const button = pane.locator('.ib-vhead [data-diff-collapse-all]');
  /** Files whose diff draws lines (a folded file draws only its header). */
  const open = () => pane.locator('[data-guide-file-shell]').evaluateAll((shells) => shells.filter((shell) => shell.querySelector('diffs-container')?.shadowRoot?.querySelector('pre[data-diff] [data-line]')).length);
  await expect.poll(open).toBeGreaterThan(0);
  await button.hover();
  await expectTipClearOfDecision(page, 'Collapse all files');
  await page.mouse.move(700, 400);
  await body.evaluate((scroll) => {
    scroll.scrollTop = scroll.scrollHeight / 3;
  });
  await button.click();
  await expect(button).toHaveAccessibleName('Expand all files');
  await expect.poll(open).toBe(0);
  await button.click();
  await expect(button).toHaveAccessibleName('Collapse all files');
  await expect.poll(open).toBeGreaterThan(0);
  // A file folded by hand afterwards folds alone.
  const before = await open();
  await pane.locator('[data-guide-file-shell]').first().getByRole('button', { name: FILE_FOLD }).first().click();
  await expect.poll(open).toBe(before - 1);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(world.errors).toEqual([]);
});

test('the chapter menu after a key press: a quiet ring on its button, none round the popup, one on the row', async () => {
  const { page, pane } = await shortReview('menu-ring');
  await page.setViewportSize({ width: 1440, height: 700 });
  const jump = pane.locator('[data-review-jump]');
  const menu = page.locator('[data-review-jump-menu]');
  const outline = (at: Locator) => at.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: Number.parseFloat(getComputedStyle(el).outlineWidth) }));
  // A key press (Escape), then the mouse: the popup counts as keyboard focus, and still has no ring.
  await jump.click();
  await expect(menu).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await jump.click();
  await expect(menu).toBeFocused();
  expect(await menu.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
  expect((await outline(menu)).style).toBe('none');
  // By the keyboard the row in hand has a ring.
  await page.keyboard.press('ArrowDown');
  const row = menu.locator('[role="menuitem"]:focus, [role="menuitemradio"]:focus');
  await expect(row).toHaveCount(1);
  expect((await outline(row)).style).toBe('solid');
  // Back on the button after Escape: a ring still shows, thinner than the row's.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(jump).toBeFocused();
  const ring = await outline(jump);
  expect(ring.style).toBe('solid');
  expect(ring.width).toBeGreaterThan(0);
  expect(ring.width).toBeLessThan(2);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(world.errors).toEqual([]);
});

/** A real finger on the page, through the browser's own touch input. */
async function fingerDrag(page: Page, from: { x: number; y: number }, by: { x: number; y: number }, during: () => Promise<void>): Promise<void> {
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let step = 1; step <= 8; step += 1) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (by.x * step) / 8, y: from.y + (by.y * step) / 8 }] });
    await page.waitForTimeout(20);
  }
  await during();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
}

test('a long line scrolls sideways in the code by wheel or trackpad, and the page stays put', async () => {
  const { page, pane, body } = await shortReview('native-bar', 800);
  await page.setViewportSize({ width: 900, height: 800 });
  const shell = pane.locator('[data-guide-file-shell="src/payouts/retry.ts"]');
  const code = shell.locator('[data-code]').first();
  const scrolled = () => code.evaluate((el) => el.scrollLeft);
  await expect.poll(() => code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await shell.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await settled(body);

  const line = (await shell.locator('[data-line-type]').first().boundingBox())!;
  const shellBox = (await shell.boundingBox())!;
  const top = await body.evaluate((el) => el.scrollTop);
  await page.mouse.move(shellBox.x + shellBox.width * 0.7, line.y + 30);
  await page.mouse.wheel(120, 0);
  await expect.poll(scrolled).toBeGreaterThan(0);
  expect(await body.evaluate((el) => el.scrollTop)).toBe(top);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(world.errors).toEqual([]);
});

test('the library\'s own scrollbar sits whole at the bottom of the file\'s code, and dragging it scrolls the code', async () => {
  // Scrollbars drawn as on Windows or with "always show" (Playwright's headless hides them): Pierre's bar must take
  // its room under the last row, inside the file's box. A 15px classic bar that the layout did not count was cut off.
  const review = await world.claude.submitGuide({ project_path: world.project, guide: REVIEW_GUIDE, patch: world.patch, thread: 'native-bar-drawn', subject: 'Retry failed payouts', body: 'Ready.', review: true } as never);
  const drawn = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-features=OverlayScrollbar'] });
  try {
    const page = await drawn.newPage({ viewport: { width: 900, height: 800 } });
    await page.goto(`${world.url}#thread=${review.thread_id}&guide=${review.message_id}`);
    const shell = page.locator('[data-review-message] [data-guide-file-shell="src/payouts/retry.ts"]');
    const code = shell.locator('[data-code]').first();
    await expect.poll(() => code.evaluate((el) => el.scrollWidth > el.clientWidth), { timeout: 30_000 }).toBe(true);
    await shell.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settled(page.locator('[data-review-message] .ib-gbody'));
    const fit = await shell.evaluate((el) => {
      const code = el.querySelector('diffs-container')!.shadowRoot!.querySelector('[data-code]') as HTMLElement;
      const box = el.querySelector('[data-guide-code-view-mounted]')!.getBoundingClientRect();
      const rect = code.getBoundingClientRect();
      return { bar: code.offsetHeight - code.clientHeight, below: box.bottom - rect.bottom, left: rect.left, bottom: rect.bottom };
    });
    expect(fit.bar).toBeGreaterThan(0);
    expect(fit.below).toBeGreaterThanOrEqual(0);
    // The thumb starts at the bar's left end: a drag along the bar scrolls the code.
    await page.mouse.move(fit.left + 12, fit.bottom - fit.bar / 2);
    await page.mouse.down();
    await page.mouse.move(fit.left + 80, fit.bottom - fit.bar / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => code.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  } finally {
    await drawn.close();
  }
});

test('while a wide file\'s own bar is below the screen, a bar pinned to the pane\'s bottom scrolls it; at the file\'s end it goes', async () => {
  const review = await world.claude.submitGuide({ project_path: world.project, guide: REVIEW_GUIDE, patch: world.patch, thread: 'pinned-bar', subject: 'Retry failed payouts', body: 'Ready.', review: true } as never);
  const drawn = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-features=OverlayScrollbar'] });
  try {
    const page = await drawn.newPage({ viewport: { width: 900, height: 320 } });
    await page.goto(`${world.url}#thread=${review.thread_id}&guide=${review.message_id}`);
    const body = page.locator('[data-review-message] .ib-gbody');
    const shell = page.locator('[data-review-message] [data-guide-file-shell="src/payouts/retry.ts"]');
    const code = shell.locator('[data-code]').first();
    await expect.poll(() => code.evaluate((el) => el.scrollWidth > el.clientWidth), { timeout: 30_000 }).toBe(true);
    const pinned = page.locator('[data-diff-bottom-bar]');
    // The file's top in view, its end below the pane.
    await shell.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await settled(body);
    await expect(pinned.first()).toBeVisible();
    const pane = (await body.boundingBox())!;
    const bar = (await pinned.first().boundingBox())!;
    expect(Math.abs(bar.y + bar.height - Math.min(pane.y + pane.height, 320))).toBeLessThanOrEqual(1);
    await page.mouse.move(bar.x + 10, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + 90, bar.y + bar.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => code.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    // The file's own bar on screen: no pinned one.
    await shell.evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await settled(body);
    await expect(pinned).toHaveCount(0);
  } finally {
    await drawn.close();
  }
});

test('a phone: a sideways drag on the code scrolls it, and the page does not move', async ({ browser }) => {
  const { claude } = world;
  const review = await claude.submitGuide({ project_path: world.project, guide: REVIEW_GUIDE, patch: world.patch, thread: 'native-bar-phone', subject: 'Retry failed payouts', body: 'Ready.', review: true } as never);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${world.url}#thread=${review.thread_id}&guide=${review.message_id}`);
    const pane = page.locator('[data-review-message]');
    const body = pane.locator('.ib-gbody');
    const shell = pane.locator('[data-guide-file-shell="src/payouts/retry.ts"]');
    const code = shell.locator('[data-code]').first();
    const scrolled = () => code.evaluate((el) => el.scrollLeft);
    await expect(shell.locator('[data-line-type]').first()).toBeVisible({ timeout: 30_000 });
    await shell.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await settled(body);

    const shellBox = (await shell.boundingBox())!;
    const line = (await shell.locator('[data-line-type]').nth(4).boundingBox())!;
    const top = await body.evaluate((el) => el.scrollTop);
    await fingerDrag(page, { x: shellBox.x + shellBox.width * 0.8, y: line.y + line.height / 2 }, { x: -170, y: 0 }, async () => {
      await expect.poll(scrolled).toBeGreaterThan(0);
      expect(await body.evaluate((el) => el.scrollTop)).toBe(top);
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

/** The colour of one screen pixel. A 1x1 PNG's only pixel comes out of every row filter unchanged. */
async function pixelAt(page: Page, x: number, y: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 }, scale: 'css' });
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return [...inflateSync(Buffer.concat(data)).subarray(1, 4)];
}

const sameColour = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 2);

test('each file\'s name sits on the page above its code box: no fill at rest, under the pointer or stuck to the top', async () => {
  // Approval "review-file-title", take B: the name's row shows the chapter's surface, the code is a box of its own.
  const { page, pane, body } = await shortReview('file-title', 420);
  const shell = pane.locator('[data-guide-file-shell="src/payouts/retry.ts"]');
  // Scrolled into the file: the row is stuck to the pane's top with the code going under it, painted with the surface
  // beside it (the chapter column's padding, or the page in All files), never see-through.
  const expectStuckRowIsSurface = async (what: string) => {
    const title = (await shell.locator('[data-file-header]').boundingBox())!;
    await body.evaluate((el, by) => { el.scrollTop += by; }, title.y - (await body.boundingBox())!.y + 120);
    await settled(body);
    await page.mouse.move(5, 5);
    const stuck = (await shell.locator('[data-file-header]').boundingBox())!;
    expect(Math.abs(stuck.y - (await body.boundingBox())!.y)).toBeLessThanOrEqual(1);
    const beside = await pixelAt(page, (await shell.boundingBox())!.x - 4, stuck.y + stuck.height / 2);
    expect(sameColour(await pixelAt(page, stuck.x + stuck.width * 0.55, stuck.y + stuck.height / 2), beside), what).toBe(true);
  };
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await shell.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await settled(body);
    const title = (await shell.locator('[data-file-header]').boundingBox())!;
    // A blank spot in the row, and the surface just above it (between the summary line and the name).
    const spot = { x: title.x + title.width * 0.55, y: title.y + title.height / 2 };
    const surface = await pixelAt(page, spot.x, title.y - 3);
    await page.mouse.move(5, 5);
    expect(sameColour(await pixelAt(page, spot.x, spot.y), surface), `${scheme}: the name's row at rest`).toBe(true);
    await page.mouse.move(spot.x, spot.y);
    await page.waitForTimeout(250);
    expect(sameColour(await pixelAt(page, spot.x, spot.y), surface), `${scheme}: the name's row under the pointer`).toBe(true);
    await page.mouse.move(5, 5);
    // The code's box: its top-left corner is round (the surface shows just inside the corner of its square), and a
    // line runs down its left edge, unlike both the surface outside and the gutter inside.
    const code = await shell.evaluate((el) => {
      const pre = el.querySelector('diffs-container')!.shadowRoot!.querySelector('pre')!.getBoundingClientRect();
      return { left: pre.left, top: pre.top, middle: pre.top + pre.height / 2 };
    });
    expect(sameColour(await pixelAt(page, code.left + 1.5, code.top + 1.5), surface), `${scheme}: the box's round corner`).toBe(true);
    const edge = await pixelAt(page, code.left, code.middle);
    expect(sameColour(edge, await pixelAt(page, code.left - 3, code.middle)), `${scheme}: the box's edge against the surface`).toBe(false);
    expect(sameColour(edge, await pixelAt(page, code.left + 12, code.middle)), `${scheme}: the box's edge against the gutter`).toBe(false);
    await expectStuckRowIsSurface(`${scheme}: the stuck row`);

    // All files: no chapter card, the page's own surface.
    await pane.locator('[data-review-mode-choice="files"]').click();
    await expect(pane).toHaveAttribute('data-review-mode', 'files');
    await shell.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await settled(body);
    await expectStuckRowIsSurface(`${scheme}: the stuck row in All files`);
    await pane.locator('[data-review-mode-choice="walkthrough"]').click();
    await expect(pane).toHaveAttribute('data-review-mode', 'walkthrough');
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(world.errors).toEqual([]);
});

test('Code review off: the same review opens in the guide pane, with no top bar of chapters and the diff controls before Close', async () => {
  const { page, claude } = world;
  const review = await claude.submitGuide({ project_path: world.project, guide: REVIEW_GUIDE, patch: world.patch, thread: 'off-after', subject: 'Retry failed payouts', body: 'Ready.', review: true } as never);
  await setCodeReview(false);
  try {
    await page.goto(`${world.url}#thread=${review.thread_id}&guide=${review.message_id}`);
    await expect(page.locator('[data-guide-file-shell]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-review-message]')).toHaveCount(0);
    await expect(page.locator('[data-review-nav]')).toHaveCount(0);
    await expect(page.locator('[data-guide-heading]')).toHaveCount(0);
    await expect(page.locator('[data-guide-section-tab]')).toHaveCount(0);
    await expect(page.locator('[data-guide-message] .ib-vhead [data-diff-controls] [data-diff-layout-toggle]')).toBeVisible();
    await expect(page.locator('h1').filter({ hasText: 'Retry failed payouts' })).toBeVisible();
  } finally {
    await setCodeReview(true);
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
    for (const index of [0, 1, 2]) {
      await pane.locator('[data-review-jump]').click();
      await page.locator(`[data-review-jump-row="${index}"]`).click();
      await pause(1800);
    }
    await pane.locator('[data-review-mode-choice="files"]').click();
    await pause(1800);
    await pane.locator('[data-review-jump]').click();
    await page.locator('[data-review-files] [data-review-jump-row]').first().click();
    await pause(1500);
    await pane.locator('[data-review-mode-choice="walkthrough"]').click();
    await pane.locator('[data-review-jump]').click();
    await page.locator('[data-review-jump-row="0"]').click();
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
