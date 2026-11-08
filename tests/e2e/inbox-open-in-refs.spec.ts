/**
 * "Open in" on what the Inbox references (approval "code-review-launch-build",
 * item 7), in a real browser against the compiled binary. `open`, `xdg-open`,
 * `code`, `gh` and `glab` are sh fakes first on PATH, so nothing launches and
 * nothing reaches a forge; each launch is one line in a log. The world: a git
 * repository with an origin, a shape on it (file and diff references, a Code
 * view), an agent's review, a message linking files, and a PR on that origin.
 *
 * What is proved:
 *  - Each place offers the window's split button for a file on disk, and picking
 *    from it launches with that file's real path (and its line, on an editor that
 *    takes one). A referenced file that is not on disk has no control at all.
 *  - A code span naming a file opens the list on a click; one that is not a file stays a plain span.
 *  - An agent in a linked worktree: its message, review and board open the worktree's file, never the main checkout's.
 *  - At 390 px (a phone) no place offers one.
 *  - Code review off: no place offers one, and the window asks nothing about them.
 *  - "Tell your agents" never appears.
 *
 * Build the binary first (see inbox.spec.ts). Shots land in
 * PLANNOTATOR_E2E_PROOF_DIR/open-in-refs (default .local/proof).
 */
import { writeInboxAsk } from '../../packages/shared/inbox/ask';
import { startScriptedAskAgent, type ScriptedAskAgent } from '../helpers/inbox-ask-agent';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'open-in-refs');

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

const RETRY_BASE = ['export async function retryPayout(payout) {', '  for (let attempt = 0; attempt < 5; attempt++) {', '    const result = await charge(payout);', '    if (result.ok) return result;', '  }', '}', ''].join('\n');
/** What only the PR has: no branch on this computer holds it. */
const PR_ONLY_FILE = Array.from({ length: 60 }, (_, i) => `export const schedule${i + 1} = { attempt: ${i + 1}, waitMs: ${(i + 1) * 500} };`).join('\n') + '\n';
/** A long file: 1,400 lines of it. */
const LONG_FILE =
  Array.from({ length: 200 }, (_, i) =>
    [`/** Rows of batch ${i}. */`, `export function batch${i}(rows: Row[]): Row[] {`, `  const kept = rows.filter((row) => row.batch === ${i});`, `  const total = kept.reduce((sum, row) => sum + row.cents, 0);`, `  audit('batch', ${i}, total);`, `  return kept;`, `}`].join('\n'),
  ).join('\n') + '\n';
const RETRY_HEAD = ['const BACKOFF_MS = [500, 2_000, 8_000];', '', 'export async function retryPayout(payout) {', '  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {', '    const result = await charge(payout);', '    if (result.ok) return result;', '    await sleep(BACKOFF_MS[attempt]);', '  }', '}', ''].join('\n');

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  project: string;
  launches: string;
  shape: string;
  shapeThread: string;
  reviewThread: string;
  messageThread: string;
  platform: string;
  subReviewThread: string;
  subGuideThread: string;
  worktree: string;
  treeLinksThread: string;
  treeReviewThread: string;
  treeShape: string;
  hoverThread: string;
  pullThread: string;
  forgeLog: string;
  marksThread: string;
  missingMarkThread: string;
  prReviewThread: string;
  prReviewMessage: string;
  askAgent: ScriptedAskAgent;
  handPull: (threadId: string) => Promise<void>;
  claude: SimAgent;
}

let world: World;

/** The repository: `main` checked out, and the PR's branch with one changed file and one the checkout does not have. */
function payouts(parent: string) {
  const dir = scratchProject(parent, 'payouts');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout;
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git('checkout', '-q', '-b', 'main');
  write('src/retry.ts', RETRY_BASE);
  write('src/ledger.ts', 'export const ledger = [];\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'backoff');
  write('src/retry.ts', RETRY_HEAD);
  write('src/only-on-the-pr.ts', 'export const onlyHere = true;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'backoff');
  const patch = git('diff', 'main...backoff');
  git('checkout', '-q', 'main');
  git('remote', 'add', 'origin', 'https://github.com/acme/payouts.git');
  // An agent's linked worktree on that branch, `main` left checked out beside it: how agents work.
  const worktree = join(parent, 'wt-backoff');
  git('worktree', 'add', '-q', worktree, 'backoff');
  return { dir, patch, worktree: realpathSync(worktree) };
}

/** The fakes first on PATH: the launchers log and exit; `gh` answers the one PR. */
function fakes(dir: string, launches: string, patch: string) {
  mkdirSync(dir, { recursive: true });
  for (const name of ['open', 'xdg-open', 'code', 'cursor', 'zed', 'subl']) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> '${launches}'\nexit 0\n`);
    chmodSync(join(dir, name), 0o755);
  }
  writeFileSync(join(dir, 'pr.patch'), patch);
  const pull = {
    number: 88,
    title: 'Back off between retries',
    url: 'https://github.com/acme/payouts/pull/88',
    state: 'OPEN',
    isDraft: false,
    updatedAt: new Date().toISOString(),
    mergedAt: null,
    baseRefName: 'main',
    headRefName: 'backoff',
    headRefOid: '8'.repeat(40),
    additions: 5,
    deletions: 2,
    changedFiles: 2,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: 'acme/payouts' },
    headRepository: { nameWithOwner: 'acme/payouts' },
    author: { login: 'tomas', avatarUrl: '' },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  };
  // The forge's copy of the PR's head commit.
  mkdirSync(join(dir, 'forge/src'), { recursive: true });
  writeFileSync(join(dir, 'forge/src/retry.ts'), RETRY_HEAD);
  writeFileSync(join(dir, 'forge/src/pr-only-schedule.ts'), PR_ONLY_FILE);
  writeFileSync(join(dir, 'pulls.json'), JSON.stringify({ data: { viewer: { login: 'dana' }, requested: { nodes: [pull] }, authored: { nodes: [] }, merged: { nodes: [] } } }));
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/bin/sh',
      'if [ "$1" = auth ]; then echo \'{"hosts":{"github.com":[{"login":"dana","active":true,"state":"success","tokenSource":"keyring"}]}}\'; exit 0; fi',
      'case "$1 $2" in',
      `  "api repos/acme/payouts/contents/"*"?ref=${'8'.repeat(40)}") echo "$2" >> '${join(dir, 'forge.log')}'; f="\${2#repos/acme/payouts/contents/}"; f="\${f%%\\?*}"; f="$(printf %s "$f" | sed 's/%2F/\\//g')"; [ -f '${join(dir, 'forge')}'/"$f" ] || { echo 'gh: Not Found (HTTP 404)' >&2; exit 1; }; base64 < '${join(dir, 'forge')}'/"$f"; exit 0;;`,
      '  "api repos/"*) exit 1;;',
      'esac',
      `if [ "$1" = api ] && [ "$2" = graphql ]; then cat '${join(dir, 'pulls.json')}'; exit 0; fi`,
      'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then echo "' + '8'.repeat(40) + '"; exit 0; fi',
      `if [ "$1" = api ] && [ "$2" = --hostname ]; then cat '${join(dir, 'pr.patch')}'; exit 0; fi`,
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'glab'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'glab'), 0o755);
}

const REVIEW_GUIDE = {
  title: 'Back off between retries',
  intent: 'Wait before retrying, in `src/retry.ts:3`; `react.js` is not one of ours.',
  sections: [{ title: 'The retry loop', overview: 'Waits between attempts.', diffs: [{ file: 'src/retry.ts', summary: 'The backoff.' }, { file: 'src/only-on-the-pr.ts', summary: 'A new file.' }] }],
};

function board(patch: string) {
  return {
    title: 'Back off between retries',
    claim: 'Built. The loop now waits [^1]. The rows go through `src/ledger.ts:1`, and `react.js` is not one of ours.',
    views: {
      picture: { html: '<svg viewBox="0 0 700 240" width="700" height="240"><g data-step="1" data-mark="loop" data-code="src/ledger.ts#L1" data-ref="1"><rect class="ink" x="40" y="70" width="260" height="90" rx="12"/><text x="170" y="120" text-anchor="middle">The retry loop</text></g><g data-step="2" data-mark="gone" data-ref="3"><rect class="acc-fill" x="400" y="70" width="260" height="90" rx="12"/><text x="530" y="120" text-anchor="middle" class="t-acc">A file that is gone</text></g></svg>', width: 700, height: 240 },
      code: {
        stage: 'after',
        guide: { title: 'Back off between retries', intent: 'Wait before retrying, in `src/retry.ts:3`.', sections: [{ title: 'The retry loop', overview: 'Waits between attempts.', diffs: [{ file: 'src/retry.ts', summary: 'The backoff.' }] }] },
        patch,
        files: [{ path: 'src/retry.ts', line: 3 }],
      },
    },
    refs: [
      { n: 1, kind: 'file', title: 'The retry loop', sub: 'Where it waits.', target: 'src/retry.ts', line: 3 },
      { n: 2, kind: 'diff', title: 'The change', target: 'src/retry.ts' },
      { n: 3, kind: 'file', title: 'A file that is gone', target: 'src/gone.ts' },
    ],
  };
}

test.use({ actionTimeout: 20_000 });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-open-in-refs-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as object), inboxCodeReview: true, inboxShape: true }));
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const { dir: project, patch, worktree } = payouts(join(root, 'src'));
  const launches = join(root, 'launches.log');
  const stubs = join(root, 'stubs');
  fakes(stubs, launches, patch);
  const env: Record<string, string> = {
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    HOME: root,
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
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const shapeSent = await claude.send({ project_path: project, thread: 'shape', subject: 'Retries: the board', body: 'The board is up. It reads `src/ledger.ts:1`.' });
  const messageSent = await claude.send({ project_path: project, thread: 'links', subject: 'Retries: where to look', body: 'The wait is in [the retry loop](src/retry.ts#L3), and the rows in [the ledger](src/ledger.ts). I also meant [a file that is gone](src/gone.ts). The table is `src/ledger.ts:1`, and `react.js` is not one of ours.' });
  const treeLinks = await claude.send({ project_path: worktree, thread: 'tree links', subject: 'Retries: from my worktree', body: 'See [the new file](src/only-on-the-pr.ts), `src/only-on-the-pr.ts:1` and `src/retry.ts`.' });
  const treeReview = await claude.submitGuide({ project_path: worktree, thread: 'tree review', subject: 'Retries: worktree review', guide: REVIEW_GUIDE, patch, review: true } as never);
  // An agent that stood in a subfolder, with a file there that has the same path: a diff's path still starts at the top.
  mkdirSync(join(project, 'src/src'), { recursive: true });
  writeFileSync(join(project, 'src/src/retry.ts'), 'export {};\n');
  const subReview = await claude.submitGuide({ project_path: join(project, 'src'), thread: 'subfolder review', subject: 'Retries: subfolder review', guide: REVIEW_GUIDE, patch, review: true } as never);
  const subGuide = await claude.submitGuide({ project_path: join(project, 'src'), thread: 'subfolder guide', subject: 'Retries: subfolder guide', guide: REVIEW_GUIDE, patch } as never);
  writeFileSync(join(project, 'src/big-ledger.ts'), LONG_FILE);
  const hoverSent = await claude.send({
    project_path: project,
    thread: 'hover',
    subject: 'Ledger: where to look',
    body: 'Batch five is `src/big-ledger.ts:36-42`, the last one is `src/big-ledger.ts:1395`, and the whole file is `src/big-ledger.ts`, with [the entry point](src/retry.ts#L3) beside it.',
  });
  const pullSent = await claude.send({
    project_path: project,
    thread: 'pull',
    subject: 'Backoff: read this first',
    body: 'The wait is `src/retry.ts:1-3`, the schedule is in [the new file](src/pr-only-schedule.ts:30-34), and `src/nowhere.ts` is not in it.',
  });
  const reviewSent = await claude.submitGuide({ project_path: project, thread: 'review', subject: 'Retries: review', guide: REVIEW_GUIDE, patch, review: true } as never);
  mkdirSync(join(root, 'boards'), { recursive: true });
  writeFileSync(join(root, 'boards', 'board.json'), JSON.stringify(board(patch)));
  const updated = spawnSync(binary, ['shape', 'update', '--file', join(root, 'boards', 'board.json'), '--project', project, '--thread', shapeSent.thread_id as string], { env, cwd: project, encoding: 'utf8', timeout: 30_000 });
  expect(updated.status, updated.stderr).toBe(0);
  // `--project` is the agent's working folder: a worktree folds into the project and the board keeps it.
  const treeUpdated = spawnSync(binary, ['shape', 'update', '--file', join(root, 'boards', 'board.json'), '--project', worktree, '--thread', treeLinks.thread_id as string], { env, encoding: 'utf8', timeout: 60_000 });
  expect(treeUpdated.status, treeUpdated.stderr).toBe(0);
  const { platform } = (await (await fetch(new URL('/api/inbox/open-in/apps', url))).json()) as { platform: string };
  // Hand the PR to a thread, as the PR page's Hand to an agent does. A PR has one owner: the latest.
  const listed = (await (await fetch(new URL('/api/inbox/pulls', url))).json()) as { serverSession: string; pulls: { key: string }[] };
  const handPull = async (threadId: string) => {
    const owned = await fetch(new URL('/api/inbox/pulls/owner', url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverSession: listed.serverSession, keys: [listed.pulls[0]!.key], thread_id: threadId }),
    });
    expect(owned.status, await owned.clone().text()).toBe(200);
  };
  await handPull(pullSent.thread_id as string);
  // A review of that PR, the agent's message after it, and Ask AI's window with an answer: a live session it can reach.
  const prReview = await claude.submitGuide({ project_path: project, thread: 'pr review', subject: 'Backoff: the review', guide: REVIEW_GUIDE, patch, review: true, agent_session: 'ses-pr-review' } as never);
  const marksThread = (await claude.send({ project_path: project, thread: 'marks', subject: 'Marks: where to look', body: 'The rows go through `src/ledger.ts:1` and the words after it go on for a while, past [env](.env) and on to the end of this line.' })).thread_id as string;
  const missingMarkThread = (await claude.send({ project_path: project, thread: 'missing mark', subject: 'Marks: a missing file', body: 'Everything on this line is plain words, then [env](.env) sits in the middle, and more plain words follow it to the end.' })).thread_id as string;
  const prReviewThread = prReview.thread_id as string;
  const prReviewMessage = prReview.message_id as string;
  await claude.send({ project_path: project, reply_to: prReviewMessage, body: 'Start at `src/retry.ts:1-3`. The schedule is in [the new file](src/pr-only-schedule.ts:30-34).', agent_session: 'ses-pr-review' } as never);
  const askedAt = new Date(Date.now() - 60_000).toISOString();
  writeInboxAsk(join(dataDir, 'inbox'), {
    v: 1,
    thread_id: prReviewThread,
    seen_at: askedAt,
    turns: [{ id: 'saved-review', at: askedAt, session: 'ses-pr-review', host: 'claude-code', question: 'Where does it wait?', answer: 'In `src/retry.ts:1-3`, from the table in `src/pr-only-schedule.ts:30-34`. Not in `react.js`.', answered_at: askedAt }],
  });
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  const askAgent = startScriptedAskAgent({ port: registry.port, token: registry.token, session: 'ses-pr-review', project, host: 'claude-code', reply: () => 'Scripted answer.' });
  world = {
    platform,
    root,
    dataDir,
    env,
    url,
    project,
    launches,
    shape: (JSON.parse(updated.stdout) as { id: string }).id,
    shapeThread: shapeSent.thread_id as string,
    reviewThread: reviewSent.thread_id as string,
    subReviewThread: subReview.thread_id as string,
    subGuideThread: subGuide.thread_id as string,
    messageThread: messageSent.thread_id as string,
    worktree,
    treeLinksThread: treeLinks.thread_id as string,
    treeReviewThread: treeReview.thread_id as string,
    treeShape: (JSON.parse(treeUpdated.stdout) as { id: string }).id,
    hoverThread: hoverSent.thread_id as string,
    pullThread: pullSent.thread_id as string,
    forgeLog: join(stubs, 'forge.log'),
    marksThread,
    missingMarkThread,
    prReviewThread,
    prReviewMessage,
    askAgent,
    handPull,
    claude,
  };
});

test.afterAll(async () => {
  try {
    world?.askAgent.stop();
    await world?.claude.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

async function windowAt(browser: Browser, width: number, height: number, colorScheme: 'light' | 'dark'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 2, ...(width < 500 ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    throw error;
  });
  return { context, page };
}

const launched = (): string[] => (existsSync(world.launches) ? readFileSync(world.launches, 'utf8').trim().split('\n').filter(Boolean) : []);
const shot = (page: Page, name: string) => page.screenshot({ path: join(proofDir, `${name}.png`) });
const realPath = (file: string) => join(world.project, file);
/** What Open in's file manager launches for a file: macOS selects the file; Linux opens the folder that holds it. */
const revealed = (file: string) => (world.platform === 'mac' ? `open -R ${file}` : `xdg-open ${dirname(file)}`);

/** Rest the pointer on words that name a file: their code window, its code drawn in colour. */
async function codeWindowOf(page: Page, words: Locator): Promise<Locator> {
  const window = page.locator('[data-code-snippet-preview]');
  await page.mouse.move(1, 1);
  await expect(window).toHaveCount(0);
  await words.hover();
  await expect(window).toBeVisible();
  await page.waitForTimeout(250);
  return window;
}

/** Rest on words that name no file: no window, and no list. */
async function noCodeWindow(page: Page, words: Locator) {
  await page.mouse.move(1, 1);
  await expect(page.locator('[data-code-snippet-preview]')).toHaveCount(0);
  await words.hover();
  await page.waitForTimeout(500);
  await expect(page.locator('[data-code-snippet-preview]')).toHaveCount(0);
  await expect(words).toBeVisible();
}

/** The board's References panel, open. */
async function openRefs(page: Page, thread = world.shapeThread, shape = world.shape) {
  await page.goto(`${world.url}#thread=${thread}&shape=${shape}`);
  const panelTab = page.getByRole('button', { name: /References/ }).first();
  await panelTab.waitFor();
  await panelTab.click();
  await expect(page.locator('.shp-ref-list li')).toHaveCount(3);
}

/** The agent's review, on All files. */
async function openReviewFiles(page: Page, thread = world.reviewThread) {
  await page.goto(`${world.url}#thread=${thread}`);
  await page.getByRole('button', { name: 'Start review' }).first().click();
  await page.locator('[data-review-mode-choice="files"]').click();
}

/** The PR's own diff, from its page. */
async function openPullDiff(page: Page) {
  await page.goto(`${world.url}#reviews`);
  // The PR is handed to a thread, so its row opens that thread (Reviews): its page is the stack's address.
  const stack = await page.locator('[data-pulls-row]').first().getAttribute('data-pulls-row');
  await page.goto(`${world.url}#reviews&stack=${encodeURIComponent(stack!)}`);
  await page.locator('[data-pulls-open-diff]').click();
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`on this computer, ${colorScheme}: each place offers Open in for a file on disk, and only then`, async ({ browser }) => {
    const { context, page } = await windowAt(browser, 1440, 900, colorScheme);
    try {
      // Shape: the References list. The two rows on src/retry.ts have it; the file that is gone has none.
      await openRefs(page);
      const rows = page.locator('.shp-ref-list li');
      await expect(rows.nth(0).locator('[data-open-in-caret]')).toBeVisible();
      await expect(rows.nth(1).locator('[data-open-in-caret]')).toBeVisible();
      await expect(rows.nth(2).locator('.shp-ref-row')).toBeVisible();
      await expect(rows.nth(2).locator('[data-open-in-caret]')).toHaveCount(0);
      await rows.nth(0).locator('[data-open-in-caret]').click();
      const menu = page.locator('[data-open-in-menu="src/retry.ts"]');
      await expect(menu.locator('[data-open-in-item="reveal"]')).toBeVisible();
      await expect(menu.locator('[data-open-in-item="browser"]')).toHaveCount(0);
      await shot(page, `01-shape-references-menu-${colorScheme}`);
      const before = launched().length;
      await menu.locator('[data-open-in-item="reveal"]').click();
      await expect.poll(() => launched().length).toBe(before + 1);
      expect(launched().at(-1)).toBe(revealed(realPath('src/retry.ts')));
      // An editor this computer has (a bundle on macOS, a fake on PATH elsewhere): at its line when its launcher takes one.
      await rows.nth(0).locator('[data-open-in-caret]').click();
      await expect(menu.locator('[data-open-in-item="reveal"]')).toBeVisible();
      const code = menu.locator('[data-open-in-item="vscode"]');
      if (await code.count()) {
        const count = launched().length;
        await code.click();
        await expect.poll(() => launched().length).toBe(count + 1);
        expect(launched().at(-1)).toMatch(/(vscode:\/\/file.*src\/retry\.ts:3|--goto .*src\/retry\.ts:3)/);
      } else {
        await page.keyboard.press('Escape');
      }

      // Esc on that menu closes the menu, and leaves the panel.
      await rows.nth(0).locator('[data-open-in-caret]').click();
      await expect(menu.locator('[data-open-in-item="reveal"]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(page.locator('.shp-ref-list')).toBeVisible();

      // A diff reference's popout has it too, and a pick leaves it open.
      await rows.nth(1).locator('.shp-ref-open').click();
      const diffPopout = page.locator('[data-popout]');
      await expect(diffPopout.locator('.shp-diff-pop')).toBeVisible();
      await diffPopout.locator('[data-open-in-caret]').click();
      await expect(menu.locator('[data-open-in-item="reveal"]')).toBeVisible();
      // The dialog's close and the control beside it sit on one line.
      const middle = async (at: string) => {
        const box = (await diffPopout.locator(at).first().boundingBox())!;
        return box.y + box.height / 2;
      };
      expect(Math.abs((await middle('[aria-label="Close"]')) - (await middle('[data-open-in-caret]')))).toBeLessThan(1.5);
      await shot(page, `04c-shape-diff-popout-${colorScheme}`);
      const diffCount = launched().length;
      await menu.locator('[data-open-in-item="reveal"]').click();
      await expect.poll(() => launched().length).toBe(diffCount + 1);
      expect(launched().at(-1)).toBe(revealed(realPath('src/retry.ts')));
      await expect(diffPopout).toBeVisible();

      // A bubble's preview, on the board. Its menu opens without closing the preview.
      await page.reload();
      const bubble = page.locator('[data-ref="1"]').first();
      await bubble.hover();
      const peek = page.locator('.shp-peek');
      await expect(peek.locator('[data-open-in-caret]')).toBeVisible();
      await shot(page, `02-shape-bubble-${colorScheme}`);
      await peek.locator('[data-open-in-caret]').click();
      await expect(page.locator('[data-open-in-menu="src/retry.ts"]')).toBeVisible();
      await expect(peek).toBeVisible();
      await page.keyboard.press('Escape');
      await page.mouse.move(2, 2);

      // A part with a reference opens the file in the popout: its header, and a pick leaves it open.
      await page.reload();
      await page.locator('[data-mark="loop"]').first().click();
      const popout = page.locator('[data-popout]');
      await expect(popout.locator('[data-open-in-caret]')).toBeVisible();
      await popout.locator('[data-open-in-caret]').click();
      await expect(page.locator('[data-open-in-menu="src/retry.ts"]')).toBeVisible();
      await shot(page, `04b-shape-popout-${colorScheme}`);
      const popoutCount = launched().length;
      await page.locator('[data-open-in-menu="src/retry.ts"] [data-open-in-item="reveal"]').click();
      await expect.poll(() => launched().length).toBe(popoutCount + 1);
      expect(launched().at(-1)).toBe(revealed(realPath('src/retry.ts')));
      await expect(popout).toBeVisible();

      // The board's claim: resting on a code span shows its code, with Open. One that is not a file shows nothing.
      await page.reload();
      await expect(page.locator('.shp-view.v-picture.drawn')).toBeVisible(); // its fade in has finished, for the picture
      const claimWindow = await codeWindowOf(page, page.locator('.shp-claim [data-code-hover="src/ledger.ts"]'));
      await expect(claimWindow).toContainText('export const ledger');
      await claimWindow.locator('[data-open-in-caret]').click();
      const claimMenu = page.locator('[data-open-in-menu="src/ledger.ts"]');
      await expect(claimMenu.locator('[data-open-in-item="reveal"]')).toBeVisible();
      await shot(page, `13-board-claim-code-span-${colorScheme}`);
      const claimCount = launched().length;
      await claimMenu.locator('[data-open-in-item="reveal"]').click();
      await expect.poll(() => launched().length).toBe(claimCount + 1);
      expect(launched().at(-1)).toBe(revealed(realPath('src/ledger.ts')));
      await noCodeWindow(page, page.locator('.shp-claim [data-code-hover="react.js"]'));
      // The board's Chat tab is the thread: its messages' words too.
      await page.locator('.shp-tbtn.chat').click();
      await page.locator('.shp-tabs [role="tab"]', { hasText: 'Thread' }).click();
      const chatWindow = await codeWindowOf(page, page.locator('.ib-shape-thread [data-code-hover="src/ledger.ts"]'));
      await expect(chatWindow).toContainText('export const ledger');
      await expect(chatWindow.locator('[data-open-in-caret]')).toBeVisible();
      await page.mouse.move(1, 1);
      await page.getByRole('button', { name: 'Close panel' }).click();
      // The number beside it is still the number.
      await expect(page.locator('.shp-claim [data-ref="1"]').first()).toBeVisible();
      // Commenting (the crosshair, in Annotate's place), the claim's words are only words: nothing shows.
      await page.locator('.shp-tbtn', { hasText: 'Shape' }).first().click();
      await page.locator('.shp-dock').getByRole('button', { name: 'Comment', exact: true }).click();
      await expect(page.locator('.shp-claim [data-code-hover]')).toHaveCount(0);
      await noCodeWindow(page, page.locator('.shp-claim code', { hasText: 'src/ledger.ts:1' }));

      // The review's own words: its intent names a file.
      await page.goto(`${world.url}#thread=${world.reviewThread}`);
      await page.getByRole('button', { name: 'Start review' }).first().click();
      const reader = page.locator('section[data-review-mode]');
      const guideWindow = await codeWindowOf(page, reader.locator('[data-code-hover="src/retry.ts"]'));
      await guideWindow.locator('[data-open-in-caret]').click();
      const guideMenu = page.locator('[data-open-in-menu="src/retry.ts"]');
      await expect(guideMenu.locator('[data-open-in-item="reveal"]')).toBeVisible();
      await shot(page, `14-guide-code-span-${colorScheme}`);
      const guideCount = launched().length;
      await guideMenu.locator('[data-open-in-item="reveal"]').click();
      await expect.poll(() => launched().length).toBe(guideCount + 1);
      expect(launched().at(-1)).toBe(revealed(realPath('src/retry.ts')));
      await noCodeWindow(page, reader.locator('[data-code-hover="react.js"]'));

      // The review's diff header: a file on disk has it, one only the change has does not.
      await openReviewFiles(page);
      const onDisk = page.locator('[data-guide-file-shell="src/retry.ts"]');
      await expect(onDisk.locator('[data-open-in-caret]')).toBeVisible();
      const notOnDisk = page.locator('[data-guide-file-shell="src/only-on-the-pr.ts"]');
      await notOnDisk.scrollIntoViewIfNeeded();
      await expect(notOnDisk.locator('[data-guide-code-view-mounted="true"]')).toBeVisible();
      await expect(notOnDisk.locator('[data-open-in-caret]')).toHaveCount(0);
      await onDisk.scrollIntoViewIfNeeded();
      await onDisk.locator('[data-open-in-caret]').click();
      await expect(page.locator('[data-open-in-menu="src/retry.ts"] [data-open-in-item="reveal"]')).toBeVisible();
      await shot(page, `05-review-all-files-menu-${colorScheme}`);
      const reviewCount = launched().length;
      await page.locator('[data-open-in-menu="src/retry.ts"] [data-open-in-item="reveal"]').click();
      await expect.poll(() => launched().length).toBe(reviewCount + 1);
      expect(launched().at(-1)).toBe(revealed(realPath('src/retry.ts')));

      // The PR page's diff, "Open the diff": what is on disk in the clone; nothing for a file the clone has not got.
      await openPullDiff(page);
      const prFile = page.locator('[data-guide-file-shell="src/retry.ts"]');
      await expect(prFile.locator('[data-open-in-caret]')).toBeVisible();
      const prNew = page.locator('[data-guide-file-shell="src/only-on-the-pr.ts"]');
      await prNew.scrollIntoViewIfNeeded();
      await expect(prNew.locator('[data-guide-code-view-mounted="true"]')).toBeVisible();
      await expect(prNew.locator('[data-open-in-caret]')).toHaveCount(0);
      await prFile.scrollIntoViewIfNeeded();
      await shot(page, `06-pr-diff-${colorScheme}`);

      // A message's links and code spans that name a file: the sentence stays a sentence, and resting on one shows its code.
      await page.goto(`${world.url}#thread=${world.messageThread}`);
      const body = page.locator('.ib-body').first();
      await expect(body.locator('[data-local-link="unavailable"]')).toHaveCount(3);
      await expect(body.locator('[data-open-in-caret]')).toHaveCount(0);
      await expect(body.locator('[data-open-in]')).toHaveCount(0);
      await expect(body.locator('[data-code-hover] svg')).toHaveCount(0);
      await shot(page, `07-message-links-${colorScheme}`);

      const linkWindow = await codeWindowOf(page, body.locator('[data-code-hover="src/retry.ts"]'));
      await expect(linkWindow.locator('[data-target-line]')).toHaveCount(1);
      await expect(linkWindow.locator('[data-target-line]')).toContainText('charge(payout)');
      await shot(page, `20-hover-link-local-${colorScheme}`);
      // The span's Open goes to its line.
      const spanWindow = await codeWindowOf(page, body.locator('[data-code-hover="src/ledger.ts"]').last());
      await spanWindow.locator('[data-open-in-caret]').click();
      const spanMenu = page.locator('[data-open-in-menu="src/ledger.ts"]');
      await expect(spanMenu.locator('[data-open-in-item="reveal"]')).toBeVisible();
      await shot(page, `21-hover-open-menu-${colorScheme}`);
      const spanEditor = spanMenu.locator('[data-open-in-item="vscode"]');
      if (await spanEditor.count()) {
        const count = launched().length;
        await spanEditor.click();
        await expect.poll(() => launched().length).toBe(count + 1);
        expect(launched().at(-1)).toMatch(/(vscode:\/\/file.*src\/ledger\.ts:1|--goto .*src\/ledger\.ts:1)/);
      } else {
        await page.keyboard.press('Escape');
      }
      await expect(spanMenu).toHaveCount(0);
      // A name that is no file here: no window, no error; the link then says why it is not a link.
      await noCodeWindow(page, body.locator('[data-code-hover="react.js"]'));
      await noCodeWindow(page, body.locator('[data-code-hover="src/gone.ts"]'));
      await expect(page.locator('[data-open-in-status].ib-err')).toHaveCount(0);

      // A range; a line deep in a long file, with what is around it; a long file named with no line, from its top.
      await page.goto(`${world.url}#thread=${world.hoverThread}`);
      const words = page.locator('.ib-body').first();
      const range = await codeWindowOf(page, words.locator('[data-code-hover="src/big-ledger.ts"]').nth(0));
      await expect(range.locator('[data-target-line]')).toHaveCount(7);
      await expect(range.locator('[data-target-line]').first()).toContainText('Rows of batch 5');
      await shot(page, `22-hover-line-range-${colorScheme}`);
      const deep = await codeWindowOf(page, words.locator('[data-code-hover="src/big-ledger.ts"]').nth(1));
      await expect(deep.locator('[data-target-line]')).toContainText('batch199');
      await expect(deep).toContainText('line 1395');
      await shot(page, `23-hover-long-file-deep-line-${colorScheme}`);
      const top = await codeWindowOf(page, words.locator('[data-code-hover="src/big-ledger.ts"]').nth(2));
      await expect(top.locator('tbody tr')).toHaveCount(40);
      await expect(top).toContainText('lines 1–40');
      await shot(page, `24-hover-long-file-top-${colorScheme}`);
      // Its own code scrolls without closing it.
      await top.locator('.code-snippet-preview').evaluate((el) => el.scrollTo(0, 200));
      await page.waitForTimeout(100);
      await expect(top).toBeVisible();

      // A thread that owns a PR: the PR's version, from the forge at its head commit, and this computer's Open beside it.
      await page.goto(`${world.url}#thread=${world.pullThread}`);
      const pullBody = page.locator('.ib-body').first();
      const prVersion = await codeWindowOf(page, pullBody.locator('[data-code-hover="src/retry.ts"]'));
      await expect(prVersion).toContainText('src/retry.ts · #88');
      await expect(prVersion).toContainText('BACKOFF_MS');
      await expect(prVersion.locator('[data-open-in-caret]')).toBeVisible();
      await expect(prVersion.locator('[data-code-hover-forge]')).toHaveAttribute('href', `https://github.com/acme/payouts/blob/${'8'.repeat(40)}/src/retry.ts#L1-L3`);
      await shot(page, `25-hover-pr-with-checkout-${colorScheme}`);
      // Only in the PR, on no branch here: its code, the forge's link, and no editor to open it in.
      const prOnly = await codeWindowOf(page, pullBody.locator('[data-code-hover="src/pr-only-schedule.ts"]'));
      await expect(prOnly.locator('[data-target-line]')).toHaveCount(5);
      await expect(prOnly.locator('[data-target-line]').first()).toContainText('schedule30');
      await expect(prOnly.locator('[data-open-in-caret]')).toHaveCount(0);
      await expect(prOnly.locator('[data-code-hover-forge]')).toHaveText('Open on GitHub');
      await shot(page, `26-hover-pr-not-checked-out-${colorScheme}`);
      await noCodeWindow(page, pullBody.locator('[data-code-hover="src/nowhere.ts"]'));
      expect(readFileSync(world.forgeLog, 'utf8')).toContain(`repos/acme/payouts/contents/src%2Fpr-only-schedule.ts?ref=${'8'.repeat(40)}`);

      await expect(page.getByText('Tell your agents')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test(`on a phone, ${colorScheme}: no place offers an app`, async ({ browser }) => {
    const { context, page } = await windowAt(browser, 390, 844, colorScheme);
    try {
      await page.goto(`${world.url}#thread=${world.messageThread}`);
      await expect(page.locator('.ib-body [data-local-link="unavailable"]').first()).toBeVisible();
      await expect(page.locator('[data-open-in-caret]')).toHaveCount(0);
      await shot(page, `08-phone-message-${colorScheme}`);

      // No hover here: a tap shows the code as a sheet, with no app to open it in. Close, or the scrim, dismisses it.
      const sheet = page.locator('[data-code-snippet-sheet]');
      await page.locator('.ib-body [data-code-hover="src/retry.ts"]').tap();
      await expect(sheet).toBeVisible();
      await expect(sheet.locator('[data-target-line]')).toContainText('charge(payout)');
      await expect(sheet.locator('[data-open-in-caret]')).toHaveCount(0);
      await page.waitForTimeout(250);
      await shot(page, `27-phone-sheet-local-${colorScheme}`);
      await sheet.locator('[data-code-hover-close]').tap();
      await expect(sheet).toHaveCount(0);
      await page.goto(`${world.url}#thread=${world.hoverThread}`);
      await page.locator('.ib-body [data-code-hover="src/big-ledger.ts"]').first().tap();
      await expect(sheet.locator('[data-target-line]')).toHaveCount(7);
      await page.waitForTimeout(250);
      await shot(page, `28-phone-sheet-line-range-${colorScheme}`);
      await page.locator('[data-code-snippet-scrim]').click({ position: { x: 10, y: 10 } });
      await expect(sheet).toHaveCount(0);
      await page.goto(`${world.url}#thread=${world.pullThread}`);
      await page.locator('.ib-body [data-code-hover="src/pr-only-schedule.ts"]').tap();
      await expect(sheet.locator('[data-target-line]').first()).toContainText('schedule30');
      await expect(sheet.locator('[data-code-hover-forge]')).toHaveAttribute('href', `https://github.com/acme/payouts/blob/${'8'.repeat(40)}/src/pr-only-schedule.ts#L30-L34`);
      await page.waitForTimeout(250);
      await shot(page, `29-phone-sheet-pr-${colorScheme}`);

      await page.goto(`${world.url}#thread=${world.shapeThread}&shape=${world.shape}`);
      // The phone's dock has the count, not the word.
      await page.locator('.shp-tbtn', { hasText: '3' }).click();
      await expect(page.locator('.shp-ref-list li')).toHaveCount(3);
      await expect(page.locator('[data-open-in-caret]')).toHaveCount(0);
      await page.waitForTimeout(600); // the sheet has finished rising, for the picture
      await shot(page, `09-phone-shape-${colorScheme}`);

      await page.goto(`${world.url}#thread=${world.reviewThread}`);
      await page.getByRole('button', { name: 'Start review' }).first().click();
      await expect(page.locator('[data-guide-file-shell="src/retry.ts"]')).toBeVisible();
      await expect(page.locator('[data-open-in-caret]')).toHaveCount(0);
      await shot(page, `10-phone-review-${colorScheme}`);
    } finally {
      await context.close();
    }
  });
}

// An agent in a linked worktree, `main` checked out in the main repository: every place opens the agent's checkout.
/** The PR's review: its thread, the review over it, and Ask AI's window floating over both. */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`in a review, ${colorScheme}: the thread, the reader and Ask AI show the PR's code and Open, as a message does`, async ({ browser }) => {
    await world.handPull(world.prReviewThread);
    const { context, page } = await windowAt(browser, 1440, 900, colorScheme);
    try {
      // The review's thread: the agent's message after the review card.
      await page.goto(`${world.url}#thread=${world.prReviewThread}`);
      const message = page.locator('.ib-body', { hasText: 'Start at' });
      const inThread = await codeWindowOf(page, message.locator('[data-code-hover="src/retry.ts"]'));
      await expect(inThread).toContainText('src/retry.ts · #88');
      await expect(inThread).toContainText('BACKOFF_MS');
      await expect(inThread.locator('[data-open-in-caret]')).toBeVisible();
      await inThread.locator('[data-open-in-primary]').hover();
      await expect(page.getByRole('tooltip').or(page.locator('[data-pn-tooltip]')).first()).toContainText("this computer's copy");
      await shot(page, `30-review-thread-${colorScheme}`);
      const linkOnlyInPr = await codeWindowOf(page, message.locator('[data-code-hover="src/pr-only-schedule.ts"]'));
      await expect(linkOnlyInPr.locator('[data-target-line]').first()).toContainText('schedule30');
      await expect(linkOnlyInPr.locator('[data-open-in-caret]')).toHaveCount(0);
      await expect(linkOnlyInPr.locator('[data-code-hover-forge]')).toBeVisible();
      // A file that is there: no "not attached" tooltip beside its code.
      await page.waitForTimeout(800);
      await expect(page.locator('[data-pn-tooltip]')).toHaveCount(0);
      await page.mouse.move(1, 1);

      // Ask AI's window stays over the review, and its answer's words behave the same, over the window.
      await page.locator('section.ib-pane [data-ask-open]').click();
      const ask = page.locator('[data-chat-window]');
      await expect(ask).toContainText('from the table in');
      // Read once, the review's message is folded in the thread: the review opens by its address too.
      await page.evaluate((guide) => {
        location.hash += `&guide=${guide}`;
      }, world.prReviewMessage);
      const reader = page.locator('section[data-review-mode]');
      await expect(reader).toBeVisible();
      await expect(ask).toBeVisible();
      const inAsk = await codeWindowOf(page, ask.locator('code', { hasText: 'src/retry.ts:1-3' }));
      await expect(inAsk).toContainText('src/retry.ts · #88');
      await expect(inAsk).toContainText('BACKOFF_MS');
      await shot(page, `31-review-ask-window-${colorScheme}`);
      await inAsk.locator('[data-open-in-caret]').click();
      const menu = page.locator('[data-open-in-menu="src/retry.ts"]');
      const count = launched().length;
      await menu.locator('[data-open-in-item="reveal"]').click();
      await expect.poll(() => launched().length).toBe(count + 1);
      expect(launched().at(-1)).toBe(revealed(realPath('src/retry.ts')));
      // Escape takes the code window, and leaves Ask AI's and the review.
      await codeWindowOf(page, ask.locator('code', { hasText: 'src/retry.ts:1-3' }));
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-code-snippet-preview]')).toHaveCount(0);
      await expect(ask).toBeVisible();
      await expect(reader).toBeVisible();
      const onlyInPr = await codeWindowOf(page, ask.locator('code', { hasText: 'src/pr-only-schedule.ts:30-34' }));
      await expect(onlyInPr.locator('[data-open-in-caret]')).toHaveCount(0);
      await noCodeWindow(page, ask.locator('code', { hasText: 'react.js' }));

      // The review's own words read the same PR.
      const inReader = await codeWindowOf(page, reader.locator('[data-code-hover="src/retry.ts"]'));
      await expect(inReader).toContainText('src/retry.ts · #88');
      await shot(page, `32-review-reader-${colorScheme}`);
    } finally {
      await context.close();
    }
  });

  test(`in a review on a phone, ${colorScheme}: a tap shows the sheet in the thread and in Ask AI`, async ({ browser }) => {
    await world.handPull(world.prReviewThread);
    const { context, page } = await windowAt(browser, 390, 844, colorScheme);
    try {
      await page.goto(`${world.url}#thread=${world.prReviewThread}`);
      const sheet = page.locator('[data-code-snippet-sheet]');
      await page.locator('.ib-body', { hasText: 'Start at' }).locator('[data-code-hover="src/pr-only-schedule.ts"]').tap();
      await expect(sheet.locator('[data-target-line]').first()).toContainText('schedule30');
      await expect(sheet.locator('[data-code-hover-forge]')).toBeVisible();
      await expect(sheet.locator('[data-open-in-caret]')).toHaveCount(0);
      await page.waitForTimeout(250);
      await shot(page, `33-phone-review-thread-${colorScheme}`);
      await sheet.locator('[data-code-hover-close]').tap();
      await expect(sheet).toHaveCount(0);
      await page.locator('[data-ask-open]').first().tap();
      const ask = page.locator('[data-chat-window]');
      // Ask AI's window on a phone is the whole screen, as it is with Code review off.
      await expect(ask).toBeVisible();
      await expect.poll(async () => JSON.stringify(await ask.boundingBox())).toBe(JSON.stringify({ x: 0, y: 0, width: 390, height: 844 }));
      await ask.locator('code', { hasText: 'src/retry.ts:1-3' }).tap();
      await expect(sheet).toContainText('BACKOFF_MS');
      await page.waitForTimeout(250);
      await shot(page, `34-phone-review-ask-${colorScheme}`);
      await sheet.locator('[data-code-hover-close]').tap();
      await expect(sheet).toHaveCount(0);
      await expect(ask).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

/** Press in the text before `words`, and drag past them into the text after. */
async function dragAcross(page: Page, words: Locator) {
  // The page draws the message again once it has read the settings.
  await expect.poll(() => words.boundingBox()).not.toBeNull();
  const box = (await words.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x - 30, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 6 });
  await page.mouse.move(box.x + box.width + 60, y, { steps: 6 });
  await page.mouse.up();
}

test('a selection or a saved comment across the words: resting on them still shows the code, and the page stands', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1440, 900, 'dark');
  const errors: string[] = [];
  page.removeAllListeners('pageerror');
  page.on('pageerror', (error) => errors.push(error.message));
  const window = page.locator('[data-code-snippet-preview]');
  try {
    await page.goto(`${world.url}#thread=${world.marksThread}`);
    const body = page.locator('.ib-body', { hasText: 'The rows go through' });
    const span = body.locator('[data-code-hover="src/ledger.ts"]');
    const missing = body.locator('[data-code-hover=".env"], [data-local-link="unavailable"]').first();
    await expect(span).toBeVisible();

    // A drag over the words opens nothing.
    await dragAcross(page, span);
    await page.waitForTimeout(400);
    await expect(window).toHaveCount(0);
    await expect(page.locator('.annotation-toolbar')).toBeVisible();

    // The selection's marks are round them now.
    await page.mouse.move(1, 1);
    await span.hover();
    await expect(window).toContainText('export const ledger');
    await page.mouse.move(1, 1);
    await expect(window).toHaveCount(0);
    await missing.hover();
    await page.waitForTimeout(500);
    await expect(window).toHaveCount(0);
    await page.mouse.move(1, 1);
    await page.keyboard.press('Escape');

    // Saved, and after a reload: the highlight is drawn before any hover.
    await dragAcross(page, span);
    await page.locator('.annotation-toolbar button[aria-label="Comment"]').click();
    await page.locator('[data-comment-popover] textarea[data-pn-mobile-editable="true"]').last().fill('Check the rows.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.annotation-toolbar')).toHaveCount(0);
    await page.reload();
    await expect(span).toBeVisible();
    await expect(body.locator('mark').first()).toBeVisible();
    for (const attempt of [1, 2]) {
      await page.mouse.move(1, 1);
      await expect(window).toHaveCount(0);
      await span.hover();
      await expect(window, `hover ${attempt}`).toContainText('export const ledger');
    }
    await page.mouse.move(1, 1);
    await missing.hover();
    await page.waitForTimeout(500);
    await page.mouse.move(1, 1);
    await expect(body).toBeVisible();
    await shot(page, '35-marks-after-hover-dark');

    // A guide's words, the same.
    await page.goto(`${world.url}#thread=${world.reviewThread}`);
    await page.getByRole('button', { name: 'Start review' }).or(page.getByRole('button', { name: 'Open review' })).first().click();
    const reader = page.locator('section[data-review-mode]');
    const inReader = reader.locator('[data-code-hover="src/retry.ts"]').first();
    await expect(inReader).toBeVisible();
    await dragAcross(page, inReader);
    await page.mouse.move(1, 1);
    await inReader.hover();
    await expect(window).toContainText('retryPayout');
    await expect(reader).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a saved comment across a link to a missing file: learning it is missing leaves the highlight on the words', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1440, 900, 'dark');
  try {
    await page.goto(`${world.url}#thread=${world.missingMarkThread}`);
    const link = page.locator('.ib-body [data-code-hover=".env"], .ib-body [data-local-link="unavailable"]').first();
    await expect(link).toBeVisible();
    await dragAcross(page, link);
    await page.locator('.annotation-toolbar button[aria-label="Comment"]').click();
    await page.locator('[data-comment-popover] textarea[data-pn-mobile-editable="true"]').last().fill('Is this one here?');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.reload();
    await expect(link.locator('mark').first()).toBeVisible();
    await link.hover();
    // It says why on this first rest, and the highlight stays.
    await expect(page.locator('[data-pn-tooltip]')).toBeVisible();
    await expect(link.locator('mark').first()).toBeVisible();
    await page.screenshot({ path: join(proofDir, '36-missing-link-mark-dark.png') });
    await page.mouse.move(1, 1);
    await expect(page.locator('[data-pn-tooltip]')).toHaveCount(0);
    await link.hover();
    await expect(page.locator('[data-pn-tooltip]')).toBeVisible();
    await expect(link.locator('mark').first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('Ask AI\'s window in a small window keeps its place, and a code span in it shows its code over it', async ({ browser }) => {
  await world.handPull(world.prReviewThread);
  const { context, page } = await windowAt(browser, 700, 500, 'dark');
  try {
    await page.goto(`${world.url}#thread=${world.prReviewThread}`);
    await page.locator('section.ib-pane [data-ask-open]').click();
    const ask = page.locator('[data-chat-window]');
    await expect(ask).toContainText('from the table in');
    const box = (await ask.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(500);
    expect(box.x + box.width).toBeLessThanOrEqual(700);
    await expect(ask.getByRole('button').first()).toBeInViewport();
    const inAsk = await codeWindowOf(page, ask.locator('code', { hasText: 'src/retry.ts:1-3' }));
    // Over Ask AI's window: the window's own header is under it, not over it.
    const head = await inAsk.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + 8);
      return !!top && el.contains(top);
    });
    expect(head).toBe(true);
  } finally {
    await context.close();
  }
});

test('an agent in a linked worktree: its message, review and board open the worktree, not the main checkout', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1440, 900, 'light');
  const inTree = (file: string) => join(world.worktree, file);
  const pick = async (id: string) => {
    const item = page.locator(`[data-open-in-menu="${id}"] [data-open-in-item="reveal"]`);
    await expect(item).toBeVisible();
    const count = launched().length;
    await item.click();
    await expect.poll(() => launched().length).toBe(count + 1);
    return launched().at(-1)!;
  };
  try {
    // A link and a span to a file only the worktree has; a span to one both have.
    await page.goto(`${world.url}#thread=${world.treeLinksThread}`);
    const body = page.locator('.ib-body').first();
    const linkInTree = await codeWindowOf(page, body.locator('[data-code-hover="src/only-on-the-pr.ts"]').first());
    await expect(linkInTree).toContainText('onlyHere');
    await linkInTree.locator('[data-open-in-caret]').click();
    expect(await pick('src/only-on-the-pr.ts')).toBe(revealed(inTree('src/only-on-the-pr.ts')));
    // It shows what it opens: the main checkout's has no BACKOFF_MS.
    const spanInTree = await codeWindowOf(page, body.locator('[data-code-hover="src/retry.ts"]'));
    await expect(spanInTree).toContainText('BACKOFF_MS');
    await spanInTree.locator('[data-open-in-caret]').click();
    expect(await pick('src/retry.ts')).toBe(revealed(inTree('src/retry.ts')));

    // The review: the same two files.
    await openReviewFiles(page, world.treeReviewThread);
    const newFile = page.locator('[data-guide-file-shell="src/only-on-the-pr.ts"]');
    await newFile.scrollIntoViewIfNeeded();
    await expect(newFile.locator('[data-open-in-caret]')).toBeVisible();
    await newFile.locator('[data-open-in-caret]').click();
    expect(await pick('src/only-on-the-pr.ts')).toBe(revealed(inTree('src/only-on-the-pr.ts')));
    const changed = page.locator('[data-guide-file-shell="src/retry.ts"]');
    await changed.scrollIntoViewIfNeeded();
    await changed.locator('[data-open-in-caret]').click();
    expect(await pick('src/retry.ts')).toBe(revealed(inTree('src/retry.ts')));
    await shot(page, '12-worktree-review-light');

    // The board: Open in, and its own file viewer, read the worktree (the main checkout's has no BACKOFF_MS).
    await openRefs(page, world.treeLinksThread, world.treeShape);
    const row = page.locator('.shp-ref-list li').nth(0);
    await row.locator('[data-open-in-caret]').click();
    expect(await pick('src/retry.ts')).toBe(revealed(inTree('src/retry.ts')));
    await row.locator('.shp-ref-open').click();
    await expect(page.locator('[data-popout]')).toContainText('BACKOFF_MS');

    // The board's and the review's own words start in the worktree too. (With the panel open, a click on the board only closes the panel.)
    await page.reload();
    await (await codeWindowOf(page, page.locator('.shp-claim [data-code-hover="src/ledger.ts"]'))).locator('[data-open-in-caret]').click();
    expect(await pick('src/ledger.ts')).toBe(revealed(inTree('src/ledger.ts')));
    await page.goto(`${world.url}#thread=${world.treeReviewThread}`);
    await page.getByRole('button', { name: 'Start review' }).first().click();
    await (await codeWindowOf(page, page.locator('section[data-review-mode] [data-code-hover="src/retry.ts"]'))).locator('[data-open-in-caret]').click();
    expect(await pick('src/retry.ts')).toBe(revealed(inTree('src/retry.ts')));
  } finally {
    await context.close();
  }
});

test('from a subfolder: a review\'s and a guide\'s file header opens the file the diff shows', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1440, 900, 'light');
  const pick = async () => {
    await page.locator('[data-open-in-caret]').first().click();
    const item = page.locator('[data-open-in-menu="src/retry.ts"] [data-open-in-item="reveal"]');
    await expect(item).toBeVisible();
    const count = launched().length;
    await item.click();
    await expect.poll(() => launched().length).toBe(count + 1);
    expect(launched().at(-1)).toBe(revealed(realPath('src/retry.ts')));
  };
  try {
    await openReviewFiles(page, world.subReviewThread);
    await pick();
    await page.goto(`${world.url}#thread=${world.subGuideThread}`);
    await page.locator('[data-guide-card]').first().click();
    await pick();
  } finally {
    await context.close();
  }
});

test('Code review off: no place offers one', async ({ browser }) => {
  const config = join(world.dataDir, 'config.json');
  const was = readFileSync(config, 'utf8');
  writeFileSync(config, JSON.stringify({ ...(JSON.parse(was) as object), inboxCodeReview: false }));
  const { context, page } = await windowAt(browser, 1440, 900, 'light');
  // The window itself stays out of it: not one question goes to these routes (the server's refusal alone would hide the control).
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/open-in/')) asked.push(request.url());
  });
  try {
    await page.goto(`${world.url}#thread=${world.messageThread}`);
    await expect(page.locator('.ib-body [data-local-link="unavailable"]').first()).toBeVisible();
    await expect(page.locator('[data-open-in-caret]')).toHaveCount(0);
    await expect(page.locator('[data-code-hover]')).toHaveCount(0);
    await page.goto(`${world.url}#thread=${world.shapeThread}&shape=${world.shape}`);
    await page.getByRole('button', { name: /References/ }).first().click();
    await expect(page.locator('.shp-ref-list li')).toHaveCount(3);
    await expect(page.locator('[data-open-in-caret]')).toHaveCount(0);
    await page.locator('.shp-sidep .shp-icon-btn').click();
    await expect(page.locator('.shp-claim code', { hasText: 'src/ledger.ts:1' })).toBeVisible();
    await expect(page.locator('[data-code-hover]')).toHaveCount(0);
    // A guide opens as a plain guide with Code review off, and its words stay words.
    await page.goto(`${world.url}#thread=${world.reviewThread}`);
    await page.locator('[data-guide-card]').first().click();
    await expect(page.locator('.ib-gbody code', { hasText: 'src/retry.ts:3' })).toBeVisible();
    await expect(page.locator('[data-code-hover]')).toHaveCount(0);
    expect(asked).toEqual([]);
  } finally {
    await context.close();
    writeFileSync(config, was);
  }
});
