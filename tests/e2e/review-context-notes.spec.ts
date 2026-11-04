/**
 * Context notes on a guided review (issue #2588, DESIGN PROTOTYPE on
 * feat/review-context-notes; not for merge), proved and pictured in a real
 * browser against the compiled binary. The agent sends its review with
 * submit_guide (`review: true`); each file reference may carry `notes`, the
 * agent's "why" for some lines. The Inbox draws them on the diff, and they
 * are part of the agent's review, never the person's comments.
 *
 * Sandbox: `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR
 * (a random port), a simulated agent through `plannotator inbox mcp`, gh and
 * glab as sh fakes first on PATH. HOME is never changed. Invented project,
 * invented PR.
 *
 * What it shows, in order:
 *  1. The review opens with three notes drawn on the diff (dashed, "Context",
 *     no actions) beside the file summaries; one comment of the person's own.
 *     The comments panel and its count hold the comment only.
 *  2. Send feedback: the agent's reply carries the comment and none of the notes.
 *  3. A second review on a thread that owns a PR: Post to GitHub sends one
 *     review comment, and the notes nowhere in the posted review.
 *  4. The same review at 390 px.
 *
 * Shots: CONTEXT_NOTES_SHOTS (default .local/proof/context-notes).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.CONTEXT_NOTES_SHOTS ?? join(repo, '.local/proof/context-notes'));

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const lines = (...parts: string[]) => `${parts.join('\n')}\n`;

interface World {
  url: string;
  dataDir: string;
  forge: string;
  project: string;
  patch: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

/** harbor-api: per-key rate limits. A real `git diff` of a scratch repository with an invented origin. */
function harborProject(parent: string): { project: string; patch: string } {
  const project = scratchProject(parent, 'harbor-api');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout;
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(project, path, '..'), { recursive: true });
    writeFileSync(join(project, path), text);
  };
  git('checkout', '-q', '-b', 'main');
  write('src/limits/bucket.ts', lines(
    'export class TokenBucket {',
    '  private tokens: number;',
    '  private last = Date.now();',
    '',
    '  constructor(private readonly capacity: number, private readonly perSecond: number) {',
    '    this.tokens = capacity;',
    '  }',
    '',
    '  take(): boolean {',
    '    const now = Date.now();',
    '    this.tokens += ((now - this.last) / 1000) * this.perSecond;',
    '    this.last = now;',
    '    if (this.tokens < 1) return false;',
    '    this.tokens -= 1;',
    '    return true;',
    '  }',
    '}',
  ));
  write('src/limits/middleware.ts', lines(
    "import { TokenBucket } from './bucket';",
    '',
    'const bucket = new TokenBucket(100, 10);',
    '',
    'export function rateLimit(req: Request): Response | null {',
    '  if (bucket.take()) return null;',
    "  return new Response('Too many requests', { status: 429 });",
    '}',
  ));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('remote', 'add', 'origin', 'https://github.com/harborline/api.git');
  write('src/limits/bucket.ts', lines(
    'export class TokenBucket {',
    '  private tokens: number;',
    '  private last: number;',
    '',
    '  constructor(',
    '    private readonly capacity: number,',
    '    private readonly perSecond: number,',
    '    private readonly now: () => number = Date.now,',
    '  ) {',
    '    this.tokens = capacity;',
    '    this.last = now();',
    '  }',
    '',
    '  take(cost = 1): boolean {',
    '    const now = this.now();',
    '    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);',
    '    this.last = now;',
    '    if (this.tokens < cost) return false;',
    '    this.tokens -= cost;',
    '    return true;',
    '  }',
    '}',
  ));
  write('src/limits/middleware.ts', lines(
    "import { TokenBucket } from './bucket';",
    "import limits from '../../config/limits.json';",
    '',
    'const buckets = new Map<string, TokenBucket>();',
    '',
    'function bucketFor(key: string): TokenBucket {',
    '  let bucket = buckets.get(key);',
    '  if (!bucket) {',
    '    bucket = new TokenBucket(limits.capacity, limits.perSecond);',
    '    buckets.set(key, bucket);',
    '  }',
    '  return bucket;',
    '}',
    '',
    'export function rateLimit(req: Request): Response | null {',
    "  const key = req.headers.get('x-api-key') ?? 'anonymous';",
    "  const cost = req.method === 'GET' ? 1 : 5;",
    '  if (bucketFor(key).take(cost)) return null;',
    '  const retryAfter = Math.ceil(cost / limits.perSecond);',
    "  return new Response('Too many requests', { status: 429, headers: { 'Retry-After': String(retryAfter) } });",
    '}',
  ));
  write('config/limits.json', lines('{', '  "capacity": 100,', '  "perSecond": 10', '}'));
  write('src/limits/bucket.test.ts', lines(
    "import { expect, test } from 'bun:test';",
    "import { TokenBucket } from './bucket';",
    '',
    "test('an idle bucket refills to capacity, not past it', () => {",
    '  let t = 0;',
    '  const bucket = new TokenBucket(3, 1, () => t);',
    '  t = 3_600_000;',
    '  expect([1, 2, 3, 4].map(() => bucket.take())).toEqual([true, true, true, false]);',
    '});',
  ));
  git('add', '-A');
  return { project, patch: git('diff', '--cached') };
}

/** The four notes the agent writes, by file. Each says why, and where that reason comes from. */
const NOTES = {
  bucket: [
    { lineStart: 8, lineEnd: 11, text: '`now` is injectable so the test can move the clock; production passes nothing. From my reading of `bucket.test.ts`.' },
    { lineStart: 16, lineEnd: 16, text: 'Caps the refill at `capacity`. An API key idle overnight used to bank about 86,000 tokens and burst past the upstream quota. From the PR description (incident INC-214).' },
  ],
  middleware: [
    { lineStart: 4, lineEnd: 13, text: 'One bucket per API key instead of one for the whole server: a single noisy client throttled everyone. From decision record ADR-019, "Per-key rate limits".' },
    { lineStart: 17, lineEnd: 17, text: 'Writes cost 5 tokens and reads 1, matching what the upstream bills. From the message of commit `4e1a9c2`.' },
  ],
};
const NOTE_TEXTS = [...NOTES.bucket, ...NOTES.middleware].map((n) => n.text);

const GUIDE = {
  title: 'Per-key rate limits',
  intent: 'Give each API key its own token bucket, cap the refill, and charge writes more than reads.',
  sections: [
    {
      title: 'One bucket per API key',
      overview: 'The middleware keeps a bucket per `x-api-key` instead of one for the server, and a 429 now says when to retry.',
      diffs: [{ file: 'src/limits/middleware.ts', summary: 'A map of buckets by key, a cost per request, and `Retry-After` on a 429.', notes: NOTES.middleware }],
    },
    {
      title: 'A refill that stops at capacity',
      overview: 'The bucket no longer banks tokens while idle, and takes a cost.',
      diffs: [
        { file: 'src/limits/bucket.ts', summary: 'Caps the refill and takes a clock for tests.', notes: NOTES.bucket },
        { file: 'src/limits/bucket.test.ts', summary: 'The idle-refill case.' },
      ],
    },
  ],
  unplacedFiles: ['config/limits.json'],
  review: { gitRef: 'main...HEAD', base: 'main' },
  generator: { engine: 'claude-code', model: 'claude-opus-5' },
};

const COMMENT = '`x-api-key` is client-controlled: anyone can mint a fresh bucket per request. Key on the authenticated account instead.';

/** The fake gh: the pulls search answers one PR of the person's own; a posted review is kept in gh-posted.json. */
function writeForge(dir: string, patch: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'calls'), '');
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'calls="$dir/calls"',
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"dana","active":true,"state":"success","tokenSource":"keyring"}]}}\'',
    '  exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then',
    '  case "$*" in *"requested: search"*) echo "gh pulls" >> "$calls"; cat "$dir/gh-pulls.json"; exit 0;; esac',
    '  echo "gh graphql-other" >> "$calls"; echo \'{"data":null}\'; exit 1',
    'fi',
    'if [ "$1" = api ] && [ "$3" = --method ]; then',
    '  echo "gh post $2" >> "$calls"',
    '  cat > "$dir/gh-posted.json"',
    '  echo \'{"id":1}\'; exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then',
    '  echo "gh head $4" >> "$calls"; printf "%040d\\n" "${4##*/}"; exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ]; then',
    '  echo "gh diff $4" >> "$calls"; cat "$dir/pr.patch"; exit 0',
    'fi',
    'echo "gh other $1" >> "$calls"; exit 1',
    '',
  ].join('\n');
  const glab = ['#!/bin/sh', 'exit 1', ''].join('\n');
  for (const [file, body] of [['gh', gh], ['glab', glab]] as const) {
    writeFileSync(join(dir, file), body);
    chmodSync(join(dir, file), 0o755);
  }
  writeFileSync(join(dir, 'pr.patch'), patch);
  const pull = {
    number: 57,
    title: 'Per-key rate limits',
    url: 'https://github.com/harborline/api/pull/57',
    state: 'OPEN',
    isDraft: false,
    updatedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    mergedAt: null,
    baseRefName: 'main',
    headRefName: 'per-key-limits',
    headRefOid: '57'.padStart(40, '0'),
    additions: 40,
    deletions: 14,
    changedFiles: 4,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: 'harborline/api' },
    headRepository: { nameWithOwner: 'harborline/api' },
    author: { login: 'dana' },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  };
  writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { viewer: { login: 'dana' }, requested: { nodes: [] }, authored: { nodes: [pull] }, merged: { nodes: [] } } }));
}

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  await expect(page.getByText('Tell your agents', { exact: false })).toHaveCount(0);
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function comment(page: Page, pane: ReturnType<Page['locator']>, file: string, line: number, words: string): Promise<void> {
  const shell = pane.locator(`[data-guide-file-shell="${file}"]`);
  const added = shell.locator(`[data-line-type="change-addition"][data-column-number="${line}"]`);
  await expect(added).toBeVisible({ timeout: 30_000 });
  await shell.hover();
  await added.click();
  const composer = page.getByPlaceholder('Leave feedback...');
  await expect(composer).toBeVisible();
  await composer.fill(words);
  await page.getByRole('button', { name: 'Add Comment' }).click();
}

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-context-notes-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  // Code review on (held for 0.28.50 behind its switch), the Board off.
  const configFile = join(dataDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), inboxBoard: false, inboxCodeReview: true }));
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const { project, patch } = harborProject(join(root, 'src'));
  const forge = join(root, 'forge');
  writeForge(forge, patch);
  const env: Record<string, string> = {
    PATH: `${forge}:${process.env.PATH ?? ''}`,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    PLANNOTATOR_INBOX_PREVIEW: '1',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  expect(new URL(url).port).not.toBe('59812');
  // 1600 wide: the comments panel stays beside the review (it folds into a button below 1,500 px).
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { url, dataDir, forge, project, patch, claude, context, page, errors };
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

test('notes on the diff, the comment alone in the panel and in the feedback the agent gets', async () => {
  const { page, claude } = world;
  // A note outside the diff is refused by name.
  await expect(
    claude.submitGuide({
      project_path: world.project,
      guide: { ...GUIDE, sections: [{ ...GUIDE.sections[0]!, diffs: [{ ...GUIDE.sections[0]!.diffs[0]!, notes: [{ lineStart: 90, lineEnd: 91, text: 'Nowhere.' }] }] }, GUIDE.sections[1]!] },
      patch: world.patch,
      thread: 'limits-bad',
      subject: 'x',
      review: true,
    } as never),
  ).rejects.toThrow(/notes\[0\] lines 90-91/);

  const review = await claude.submitGuide({
    project_path: world.project,
    guide: GUIDE,
    patch: world.patch,
    thread: 'limits',
    subject: 'Per-key rate limits',
    body: 'My review of the rate-limit change. I left notes on the hunks whose reason is not in the code.',
    review: true,
  } as never);
  await page.goto(`${world.url}#thread=${review.thread_id}`);
  await page.locator('[data-review-card]').getByRole('button', { name: 'Start review' }).click();
  const pane = page.locator('[data-review-message]');
  await expect(pane).toBeVisible();
  const middleware = pane.locator('[data-guide-file-shell="src/limits/middleware.ts"]');
  await expect(middleware.locator('[data-context-note]').first()).toBeVisible({ timeout: 30_000 });
  // Unified: the cards get the diff's full width (Split is the default; both draw notes).
  await pane.getByRole('radio', { name: 'Unified' }).check();
  await expect(middleware.locator('[data-context-note]')).toHaveCount(2, { timeout: 30_000 });
  await expect(middleware.locator('[data-context-note]').first()).toContainText('Context');
  // A note has nothing to act on: no edit, delete, copy or explain.
  await expect(middleware.locator('[data-context-note] button')).toHaveCount(0);
  await expect(pane.locator('[data-guide-comments]')).toHaveAttribute('data-guide-comments', '0');
  await shot(page, '01-review-notes');

  await comment(page, pane, 'src/limits/middleware.ts', 16, COMMENT);
  await expect(pane.locator('[data-guide-comments]')).toHaveAttribute('data-guide-comments', '1');
  // The comment and the note under it in view, inside the file's own scroller.
  await middleware.locator('.review-comment:not(.review-context-note)').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await shot(page, '02-note-and-comment');

  // The second chapter: the file summary (the file-level note) above the diff, two notes on it.
  await pane.locator('[data-review-chapters] li').nth(2).click();
  const bucket = pane.locator('[data-guide-file-shell="src/limits/bucket.ts"]');
  await expect(bucket.locator('[data-context-note]')).toHaveCount(2, { timeout: 30_000 });
  await bucket.scrollIntoViewIfNeeded();
  await shot(page, '03-file-summary-and-notes');

  // All files: the notes stay on the diff.
  await pane.locator('[data-review-mode-choice="files"]').click();
  await expect(pane.locator('[data-context-note]').first()).toBeVisible({ timeout: 30_000 });
  await pane.locator('[data-review-mode-choice="walkthrough"]').click();

  await pane.locator('[data-review-decision] [data-decision-primary]').click();
  await expect(pane).toHaveCount(0);
  const verdict = await claude.nextReply(review.thread_id as string, 50, String(review.message_id));
  const words = String(verdict.body);
  writeFileSync(join(shotsDir, '04-feedback-the-agent-gets.md'), words);
  expect(words).toContain('x-api-key` is client-controlled');
  for (const text of NOTE_TEXTS) expect(words).not.toContain(text.slice(0, 40));
  expect(words).not.toContain('Context');
  // Chrome's notification banner is the sandbox's, not the feature's.
  await page.getByRole('button', { name: 'Hide' }).first().click().catch(() => {});
  await page.locator('.ib-msg').last().scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, '04-feedback-sent');
  expect(world.errors).toEqual([]);
});

test('Post to GitHub: one review comment goes on the PR, no note', async () => {
  const { page, claude } = world;
  const review = await claude.submitGuide({
    project_path: world.project,
    guide: { ...GUIDE, title: 'Per-key rate limits (PR #57)' },
    patch: world.patch,
    thread: 'limits-pr',
    subject: 'PR #57: per-key rate limits',
    body: 'My review of https://github.com/harborline/api/pull/57, with notes on the hunks.',
    review: true,
  } as never);
  // The thread owns the PR (the Pull requests page's hand-off records this choice).
  const pulls = (await (await page.request.get(`${world.url}api/inbox/pulls`)).json()) as { pulls: { key: string; number: number }[] };
  const key = pulls.pulls.find((p) => p.number === 57)!.key;
  const owned = await page.request.post(`${world.url}api/inbox/pulls/owner`, { data: { keys: [key], thread_id: review.thread_id } });
  expect(owned.status()).toBe(200);

  await page.goto(`${world.url}#thread=${review.thread_id}`);
  await page.locator('[data-review-card]').getByRole('button', { name: 'Start review' }).click();
  const pane = page.locator('[data-review-message]');
  await expect(pane.locator('[data-context-note]').first()).toBeVisible({ timeout: 30_000 });
  await pane.locator('[data-review-destination-choice="forge"]').click();
  await expect(pane.locator('[data-review-posts="github"]')).toBeVisible();
  await comment(page, pane, 'src/limits/middleware.ts', 16, COMMENT);
  await expect(pane.locator('[data-review-posts] [data-decision-primary]')).toContainText('Post Comments');
  await pane.locator('[data-review-posts] [data-decision-primary]').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('1 comment');
  await shot(page, '05-post-dialog');
  await dialog.getByRole('button', { name: /Post/ }).last().click();
  await expect.poll(() => existsSync(join(world.forge, 'gh-posted.json')), { timeout: 30_000 }).toBe(true);
  const posted = readFileSync(join(world.forge, 'gh-posted.json'), 'utf8');
  writeFileSync(join(shotsDir, '05-posted-to-github.json'), posted);
  // A guided review's comments ride the review body (PostEnding's `anchor="guide"`): the one comment, nothing else.
  const sent = JSON.parse(posted) as { comments: unknown[]; body: string };
  expect(sent.body).toContain('client-controlled');
  expect(sent.body.match(/\*\*src\//g)).toHaveLength(1);
  for (const text of NOTE_TEXTS) expect(posted).not.toContain(text.slice(0, 40));
  await page.waitForTimeout(800);
  await shot(page, '06-posted');
});

test('a phone at 390 px: the notes on the diff', async ({ browser }) => {
  const { claude } = world;
  const review = await claude.submitGuide({ project_path: world.project, guide: GUIDE, patch: world.patch, thread: 'limits-phone', subject: 'Per-key rate limits (phone)', review: true } as never);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    await page.goto(`${world.url}#thread=${review.thread_id}`);
    await page.locator('[data-review-card]').getByRole('button', { name: 'Start review' }).click();
    const pane = page.locator('[data-review-message]');
    const note = pane.locator('[data-guide-file-shell="src/limits/middleware.ts"] [data-context-note]').first();
    await expect(note).toBeVisible({ timeout: 30_000 });
    await note.scrollIntoViewIfNeeded();
    await shot(page, 'phone-01-notes');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally {
    await context.close();
  }
});
