/**
 * What is open stays open (the owner, 2026-11-23: "If I'm ever in a thread, if I ever create a thread for any PR …
 * it should never disappear on me no matter what … that my diff while I'm viewing diffs or refresh it just goes
 * away"), proved in a real browser against the compiled binary under a temp data dir, with a fake `gh` first on PATH
 * (every name invented, nothing reaches a forge).
 *
 * The person opens their own pull request's diff and starts a comment on a changed line. The fake forge merges the
 * PR (the person's searches now list it as merged, out of every open stack) and the window reads the list again:
 * the diff, the file rail and the half-written comment are all still there, and the header's state mark says merged
 * (the mark the PR gets everywhere in the Inbox). Before, the page turned into "This pull request is no longer in the
 * list." and the comment was gone. Then the person reloads: the page reopens on the merged PR (no stack holds it), its
 * diff and its kept comment there, the header still saying merged.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/review-stays-open (CI keeps .local/proof/ as "inbox-window-proof-N"):
 * 1440 light and dark, a phone at 390, and the page after the reload, light and dark.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-review-stays-open.spec.ts`.
 */
import { expect, test, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { clearSidebarPeek } from './sidebar-peek';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'review-stays-open');

const REPO = 'northwind/billing-svc';
const KEY = `github.com/${REPO}#412`;
const HEAD = 'c'.repeat(40);
const FILE = 'src/retry.ts';
const PATCH = `diff --git a/${FILE} b/${FILE}\n--- a/${FILE}\n+++ b/${FILE}\n@@ -1,3 +1,4 @@\n export function retry() {\n-  return schedule(3);\n+  const tries = 5;\n+  return schedule(tries);\n }\n`;
/** The window reads the list again on focus once 20 s have passed since its last read (usePulls `PULLS_FOCUS_MS`). */
const FOCUS_READ_MS = 21_000;

const pr = (state: 'OPEN' | 'MERGED') => ({
  number: 412,
  title: 'Retry failed charges on a new schedule',
  url: `https://github.com/${REPO}/pull/412`,
  state,
  isDraft: false,
  updatedAt: new Date(Date.now() - 600_000).toISOString(),
  mergedAt: state === 'MERGED' ? new Date().toISOString() : null,
  baseRefName: 'main',
  headRefName: 'ada/retry-schedule',
  headRefOid: HEAD,
  additions: 2,
  deletions: 1,
  changedFiles: 1,
  reviewDecision: 'REVIEW_REQUIRED',
  repository: { nameWithOwner: REPO },
  headRepository: { nameWithOwner: REPO },
  author: { login: 'ada', avatarUrl: 'http://127.0.0.1:9/ada.png' },
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
});

let forge = '';
/** What the person's searches answer: their PR open (authored), or merged (the merged search's). */
function listAs(state: 'OPEN' | 'MERGED'): void {
  const authored = state === 'OPEN' ? [pr('OPEN')] : [];
  const merged = state === 'MERGED' ? [pr('MERGED')] : [];
  writeFileSync(join(forge, 'pulls.json'), JSON.stringify({ data: { viewer: { login: 'ada' }, requested: { nodes: [] }, authored: { nodes: authored }, merged: { nodes: merged } } }));
}

function writeForge(): void {
  mkdirSync(forge, { recursive: true });
  listAs('OPEN');
  writeFileSync(join(forge, 'pull.patch'), PATCH);
  const gh = [
    '#!/bin/sh',
    `dir='${forge}'`,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"ada","active":true,"state":"success","tokenSource":"keyring"}]}}\'',
    '  exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then',
    '  case "$*" in *"query InboxPullsOthers"*) echo \'{"data":{"viewer":{"login":"ada"},"others0":{"issueCount":0,"nodes":[]}}}\'; exit 0;; esac',
    '  case "$*" in *"requested: search"*) cat "$dir/pulls.json"; exit 0;; esac',
    '  echo \'{"data":null}\'; exit 1',
    'fi',
    'case "$*" in *"/contents/"*) echo "gh: Not Found (HTTP 404)" >&2; exit 1;; esac',
    `if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then case "$6" in *tojson*) echo '{"sha":"${HEAD}","body":null}';; *) echo ${HEAD};; esac; exit 0; fi`,
    'if [ "$1" = api ] && [ "$2" = --hostname ]; then cat "$dir/pull.patch"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n');
  writeFileSync(join(forge, 'gh'), gh);
  writeFileSync(join(forge, 'glab'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(forge, 'gh'), 0o755);
  chmodSync(join(forge, 'glab'), 0o755);
}

let url = '';
let agent: SimAgent;
let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-review-stays-open-e2e-');
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  mkdirSync(home, { recursive: true });
  markTourDecided(dataDir);
  forge = join(root, 'forge');
  writeForge();
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  spawnSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${forge}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
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
  url = started.stdout.trim();
  expect(new URL(url).port).not.toBe('59812');
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  page = await context.newPage();
  const on = await page.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(on.status()).toBe(200);
  // The project exists once an agent writes from it.
  agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: project, subject: 'Retry schedule', body: 'The retry PR is up.' });
});

test.afterAll(async () => {
  try {
    await agent?.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

async function shot(name: string, width: number, height: number, scheme: 'light' | 'dark'): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(proofDir, `${name}-${width}-${scheme}.png`) });
}

test('a merged PR’s diff stays open with the comment being written, and its header says merged', async () => {
  const key = encodeURIComponent(KEY);
  await page.goto(`${url}#pulls&stack=${key}&layer=${key}&scope=layer`);
  await clearSidebarPeek(page);
  const review = page.locator('[data-pull-review]');
  await expect(review.locator(`[data-guide-file-shell="${FILE}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(review.locator('[data-pull-review-title] .ib-refmark')).toHaveAttribute('data-ref-state', 'open');
  const rail = await review.locator('.ib-rrail').innerText();

  // A comment on a changed line, half written and not saved (a click on the line's number opens its composer).
  const line = review.locator(`[data-guide-file-shell="${FILE}"] [data-line-type="change-addition"][data-column-number]`).first();
  await line.click({ position: { x: 4, y: 4 } });
  const composer = page.getByPlaceholder('Leave feedback...');
  await expect(composer).toBeFocused();
  const words = 'Cap the tries at five, and say why in';
  await composer.fill(words);
  await shot('before-merge', 1440, 900, 'light');

  // The forge merges it; the window reads the list again (focus, past its 20 s).
  // The review page keeps the list's count only, so its focus read takes the server's cache: the server reads the
  // forge again first (as the Reviews page's own refresh would), then the window's focus read brings that answer.
  listAs('MERGED');
  await page.waitForTimeout(FOCUS_READ_MS);
  const served = (await (await page.request.get(`${url}api/inbox/pulls?refresh=1`)).json()) as { pulls: { key: string; state: string }[] };
  expect(served.pulls.find((p) => p.key === KEY)?.state).toBe('merged');
  // Focus reads the list at most every 20 s (a background read may have just run): focus again until it lands.
  const mark = review.locator('[data-pull-review-title] .ib-refmark');
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        return mark.getAttribute('data-ref-state');
      },
      { timeout: 90_000, intervals: [5_000] },
    )
    .toBe('merged');
  await expect(page.getByText('This pull request is no longer in the list.')).toHaveCount(0);
  await expect(review.locator(`[data-guide-file-shell="${FILE}"]`)).toBeVisible();
  expect(await review.locator('.ib-rrail').innerText()).toBe(rail);
  await expect(composer).toHaveValue(words);
  // The comment is added (kept with the review, not posted).
  await page.getByRole('button', { name: 'Add Comment' }).click();
  await expect(review.locator('.ib-vcomments')).toContainText('1');

  await shot('merged', 1440, 900, 'light');
  await shot('merged', 1440, 900, 'dark');
  await shot('merged', 390, 844, 'light');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

  // The person reloads: the merged PR is in no list's stack any more, and its page reopens on it all the same, its
  // diff and its comment there, the header saying merged.
  await page.reload();
  await expect(review.locator(`[data-guide-file-shell="${FILE}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(mark).toHaveAttribute('data-ref-state', 'merged');
  await expect(page.getByText('This pull request is no longer in the list.')).toHaveCount(0);
  await expect(review.locator('.ib-vcomments')).toContainText('1');
  await shot('reloaded', 1440, 900, 'light');
  await shot('reloaded', 1440, 900, 'dark');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
});
