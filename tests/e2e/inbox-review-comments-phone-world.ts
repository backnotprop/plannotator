/**
 * The world of inbox-review-comments-phone.spec.ts: a scratch Inbox from the
 * compiled binary (its own HOME, data folder and fake `gh` and `glab` first on
 * PATH, every name invented), a teammate's pull request of one layer, and an
 * agent's guided review of a real `git diff`.
 *
 * A pull request's comments live in the window's storage, so `seedPull` writes
 * them there before the page loads; a guided review's go in through the route
 * the window saves them by.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

export const SHORT_FILE = 'long.ts';
export const LONG_FILE = 'packages/billing/src/charges/retry/backoff/strategies/exponential-with-full-jitter-and-a-dead-letter-queue.ts';
export const PULL_KEY = 'github.com/northwind/web-app#803';
const PULL_HEAD = '803'.padStart(40, '0');

export interface PhoneWorld {
  url: string;
  thread: string;
  message: string;
  agent: SimAgent;
}

export interface Comment {
  file?: string;
  line: number;
  text: string;
  /** Shown as "Written on older code" in a pull request's list. */
  older?: boolean;
}

const code = (lines: number) => Array.from({ length: lines }, (_, i) => `export const attempt${i + 1} = ${i + 1};`).join('\n') + '\n';

/** A scratch repository holding the change, and its real diff. */
function change(parent: string): { project: string; patch: string } {
  const project = scratchProject(parent, 'web-app');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
    });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout;
  };
  writeFileSync(join(project, 'README.md'), 'A scratch project.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  writeFileSync(join(project, SHORT_FILE), code(120));
  mkdirSync(join(project, LONG_FILE, '..'), { recursive: true });
  writeFileSync(join(project, LONG_FILE), code(40));
  git('add', '-A');
  git('commit', '-q', '-m', 'the change');
  git('remote', 'add', 'origin', 'https://github.com/northwind/web-app.git');
  return { project, patch: git('diff', 'HEAD~1', 'HEAD') };
}

/** The fake forge: signed in, one pull request asked of the person, its diff and head. */
function writeForge(dir: string, patch: string): void {
  mkdirSync(dir, { recursive: true });
  const added = patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const pull = {
    number: 803,
    title: 'Retry a failed charge with backoff',
    url: 'https://github.com/northwind/web-app/pull/803',
    state: 'OPEN',
    isDraft: false,
    updatedAt: new Date(Date.now() - 600_000).toISOString(),
    mergedAt: null,
    baseRefName: 'main',
    headRefName: 'kim/retry',
    headRefOid: PULL_HEAD,
    additions: added,
    deletions: 0,
    changedFiles: 2,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: 'northwind/web-app' },
    headRepository: { nameWithOwner: 'northwind/web-app' },
    author: { login: 'kim', avatarUrl: 'http://127.0.0.1:9/kim.png' },
    reviewRequests: { nodes: [{ requestedReviewer: { login: 'dana' } }] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  };
  writeFileSync(join(dir, 'pulls.json'), JSON.stringify({ data: { viewer: { login: 'dana' }, requested: { nodes: [pull] }, authored: { nodes: [] }, merged: { nodes: [] } } }));
  writeFileSync(join(dir, 'pull.patch'), patch);
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"dana","active":true,"state":"success","tokenSource":"keyring"}]}}\'',
    '  exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then',
    '  case "$*" in *"query InboxPullsOthers"*) echo \'{"data":{"viewer":{"login":"dana"},"others0":{"issueCount":0,"nodes":[]}}}\'; exit 0;; esac',
    '  case "$*" in *"requested: search"*) cat "$dir/pulls.json"; exit 0;; esac',
    '  echo \'{"data":null}\'; exit 1',
    'fi',
    `if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then echo ${PULL_HEAD}; exit 0; fi`,
    'if [ "$1" = api ] && [ "$2" = --hostname ]; then cat "$dir/pull.patch"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'gh'), gh);
  writeFileSync(join(dir, 'glab'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'gh'), 0o755);
  chmodSync(join(dir, 'glab'), 0o755);
}

const GUIDE = {
  title: 'Retry a failed charge',
  intent: 'Back off between attempts, and stop when the charge cannot succeed.',
  sections: [
    { title: 'The attempts', overview: 'Each attempt is a constant the loop reads.', diffs: [{ file: SHORT_FILE, summary: 'The attempts.' }] },
    { title: 'The strategy', overview: 'Backoff with full jitter.', diffs: [{ file: LONG_FILE, summary: 'The strategy.' }] },
  ],
};

export async function startWorld(browser: Browser): Promise<PhoneWorld> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-review-comments-phone-e2e-');
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  mkdirSync(home, { recursive: true });
  markTourDecided(dataDir);
  const { project, patch } = change(join(root, 'src'));
  const forge = join(root, 'forge');
  writeForge(forge, patch);
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${forge}:${process.env.PATH ?? ''}`,
    HOME: home,
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
  const context = await browser.newContext();
  const on = await context.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(on.status()).toBe(200);
  await context.close();
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const review = await agent.submitGuide({ project_path: project, subject: 'Retry a failed charge', guide: GUIDE, patch, body: 'Two files to read.', review: true } as never);
  return { url, thread: String(review.thread_id), message: String(review.message_id), agent };
}

export async function stopWorld(world: PhoneWorld | undefined): Promise<void> {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
}

const annotation = (c: Comment, i: number) => ({
  id: `seeded-${i}`,
  type: 'comment',
  scope: 'line',
  filePath: c.file ?? SHORT_FILE,
  lineStart: c.line,
  lineEnd: c.line,
  side: 'new',
  text: c.text,
  author: 'dana',
  createdAt: Date.now(),
});

/** A window at this size, with a phone's touch when it is one. */
export async function windowAt(browser: Browser, width: number, height: number, phone: boolean, colorScheme: 'light' | 'dark' = 'light'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion: 'reduce', ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  return { context, page: await context.newPage() };
}

/** The comments a window holds for the pull request, in its storage before it loads. */
export async function seedPull(page: Page, comments: readonly Comment[]): Promise<void> {
  const value = { comments: comments.map((c, i) => ({ ...annotation(c, i), ...(c.older ? { outdated: true } : {}) })), viewed: [] };
  await page.addInitScript(
    ([name, kept]) => {
      if (window.localStorage.getItem(name) === null) window.localStorage.setItem(name, kept);
    },
    [`plannotator-inbox-pull-review:${PULL_KEY}:layer:${PULL_HEAD}`, JSON.stringify(value)] as const,
  );
}

export async function openPull(world: PhoneWorld, page: Page): Promise<void> {
  const key = encodeURIComponent(PULL_KEY);
  await page.goto(`${world.url}#pulls&stack=${key}&layer=${key}&scope=layer`);
  await expect(page.locator(`[data-guide-file-shell="${SHORT_FILE}"]`)).toBeVisible({ timeout: 30_000 });
}

/** The guided review's comments, as the window saves them. */
export async function seedReview(world: PhoneWorld, page: Page, comments: readonly Comment[]): Promise<void> {
  for (const [i, c] of comments.entries()) {
    const saved = await page.request.post(`${world.url}api/inbox/messages/${world.message}/guide/annotations`, { data: { annotation: annotation(c, i) } });
    expect(saved.status(), await saved.text()).toBe(200);
  }
}

export async function openReview(world: PhoneWorld, page: Page): Promise<void> {
  await page.goto(`${world.url}#thread=${world.thread}`);
  await page.locator('[data-review-card]').getByRole('button', { name: /review/i }).first().click();
  await expect(page.locator('[data-review-message]')).toBeVisible();
  await expect(page.locator(`[data-guide-file-shell="${SHORT_FILE}"]`)).toBeVisible({ timeout: 30_000 });
}
