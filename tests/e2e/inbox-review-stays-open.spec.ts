/**
 * What is open stays open (the owner, 2026-11-23: "If I'm ever in a thread, if I ever create a thread for any PR …
 * it should never disappear on me no matter what … that my diff while I'm viewing diffs or refresh it just goes
 * away"), proved in a real browser against the compiled binary under a temp data dir, with a fake `gh` first on PATH
 * (every name invented, nothing reaches a forge).
 *
 * The person opens their own pull request's diff and starts a comment on a changed line. The fake forge merges the
 * PR (the person's searches now list it as merged, out of every open stack) and the window reads the list again:
 * the diff, the file rail and the half-written comment are all still there, and the header's state mark says merged
 * (the mark the PR gets everywhere in the Inbox) with the word "Merged" beside it, its Reviews row's word, a phone's
 * title row too. Before, the page turned into "This pull request is no longer in the
 * list." and the comment was gone. Then the person reloads: the page reopens on the merged PR (no stack holds it), its
 * diff and its kept comment there, the header still saying merged.
 *
 * A teammate's PR, which leaves every list of the person's once merged: a PR merged while the search still lists it
 * open says merged from the diff's own read of it; the open page of one merged elsewhere stays, asks the server for it
 * (`GET /api/inbox/pulls/pull`, read from the forge by number) and says merged; a reload with only a kept draft
 * comment reopens it with the draft and the reader still taking comments. Then GitHub stops answering: a reload, and
 * a restart of the Inbox while still offline, reopen the page with one line saying GitHub didn't answer; back online,
 * the next focus asks again (the restarted Inbox reads its list first) and the line goes. The line is its own, above
 * the diff, whole at 1440 and on a phone (in the header bar it was cut), and the diff stays as last read, after the
 * restart too. GitHub then answers 404 for it (repository deleted, access lost), every read of it, its patch too: a
 * reload keeps the page and its diff as last read, with one line saying so. A teammate's PR closed on GitHub says
 * Closed with no Post, through a reload, and once reopened says open with Post back. A PR on a linked computer (its
 * routes answered as that computer's Inbox would): merged there and gone from the board, its page stays, asks that
 * computer and says merged, also after a reload.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/review-stays-open (CI keeps .local/proof/ as "inbox-window-proof-N"):
 * before-merge and merged at 1440 light and dark, merged on a phone at 390, and the page after the reload, light and
 * dark; then teammate-merged, draft-only-reloaded, forge-unreachable (1440 and 390), forge-unreachable-restarted,
 * forge-missing (1440 and 390), reopen-closed, reopened, linked-merged and linked-reloaded, 1440 light, and
 * linked-reloaded at 390.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-review-stays-open.spec.ts`.
 */
import { expect, test, type BrowserContext, type Page, type Response } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
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

type Who = { number: number; title: string; author: string; head: string };
/** The person's own PR. */
const MINE: Who = { number: 412, title: 'Retry failed charges on a new schedule', author: 'ada', head: 'ada/retry-schedule' };
/** Teammates' PRs the person was asked to review: once merged, no search of theirs lists them any more. */
const THEIRS: Who = { number: 880, title: 'Show invoice totals in the customer’s currency', author: 'tomas', head: 'tomas/invoice-currency' };
/** Merged on the forge while GitHub's search still lists it open (the search lags a merge). */
const LAGGING: Who = { number: 881, title: 'Round refunds to the cent', author: 'jun', head: 'jun/refund-rounding' };
/** Closed on the forge, then reopened. */
const REOPENED: Who = { number: 882, title: 'Send the dunning email in the customer’s language', author: 'ines', head: 'ines/dunning-locale' };
const keyOf = (who: Who) => `github.com/${REPO}#${who.number}`;

const pr = (state: 'OPEN' | 'MERGED', who: Who = MINE) => ({
  number: who.number,
  title: who.title,
  url: `https://github.com/${REPO}/pull/${who.number}`,
  state,
  isDraft: false,
  updatedAt: new Date(Date.now() - 600_000).toISOString(),
  mergedAt: state === 'MERGED' ? new Date().toISOString() : null,
  baseRefName: 'main',
  headRefName: who.head,
  headRefOid: HEAD,
  additions: 2,
  deletions: 1,
  changedFiles: 1,
  reviewDecision: 'REVIEW_REQUIRED',
  repository: { nameWithOwner: REPO },
  headRepository: { nameWithOwner: REPO },
  author: { login: who.author, avatarUrl: `http://127.0.0.1:9/${who.author}.png` },
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
});

let forge = '';
let mineState: 'OPEN' | 'MERGED' = 'OPEN';
/** The teammates' PRs the person's "review requested" search answers (open ones). */
let requested: Who[] = [];
function writeLists(): void {
  const authored = mineState === 'OPEN' ? [pr('OPEN')] : [];
  const merged = mineState === 'MERGED' ? [pr('MERGED')] : [];
  writeFileSync(join(forge, 'pulls.json'), JSON.stringify({ data: { viewer: { login: 'ada' }, requested: { nodes: requested.map((who) => pr('OPEN', who)) }, authored: { nodes: authored }, merged: { nodes: merged } } }));
}
/**
 * One PR as the forge's REST API has it now: what a read of the PR itself takes (readForgePull's jq) and what the
 * diff's head read takes (its sha, body and state). The fake prints it whatever jq it is asked.
 */
function forgeHas(who: Who, state: 'open' | 'merged' | 'closed'): void {
  const at = new Date().toISOString();
  const rest = {
    sha: HEAD,
    body: null,
    state: state === 'open' ? 'open' : 'closed',
    merged: state === 'merged',
    merged_at: state === 'merged' ? at : null,
    draft: false,
    number: who.number,
    html_url: `https://github.com/${REPO}/pull/${who.number}`,
    title: who.title,
    user: { login: who.author },
    base: { ref: 'main' },
    head: { ref: who.head, sha: HEAD, repo: { full_name: REPO } },
    additions: 2,
    deletions: 1,
    changed_files: 1,
    updated_at: at,
    requested_reviewers: who === MINE ? [] : ['ada'],
  };
  writeFileSync(join(forge, `pr-${who.number}.json`), JSON.stringify(rest));
}
/** What the person's searches answer: their PR open (authored), or merged (the merged search's); the forge agrees. */
function listAs(state: 'OPEN' | 'MERGED'): void {
  mineState = state;
  writeLists();
  forgeHas(MINE, state === 'OPEN' ? 'open' : 'merged');
}
/** The forge stops answering (offline, down): every gh call fails as gh does with no network, its sign-in check too. */
function forgeDown(down: boolean): void {
  writeFileSync(join(forge, 'down'), down ? '1' : '0');
}

function writeForge(): void {
  mkdirSync(forge, { recursive: true });
  forgeDown(false);
  listAs('OPEN');
  writeFileSync(join(forge, 'pull.patch'), PATCH);
  const gh = [
    '#!/bin/sh',
    `dir='${forge}'`,
    'if [ "$(cat "$dir/down")" = 1 ]; then echo "error connecting to api.github.com" >&2; echo "check your internet connection or https://githubstatus.com" >&2; exit 1; fi',
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
    // A PR the forge no longer has for this login (its repository deleted, access lost): every read of it is a 404.
    `if [ "$1" = api ] && [ "$2" = --hostname ] && [ -f "$dir/gone-\${4##*/}" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi`,
    // `repos/<owner>/<repo>/pulls/<n>` with a jq: the PR as the forge has it now (its last part names it).
    `if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then case "$6" in *tojson*) cat "$dir/pr-\${4##*/}.json";; *) echo ${HEAD};; esac; exit 0; fi`,
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
let env: Record<string, string> = {};
let dataDir = '';

function startInbox(): string {
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const at = started.stdout.trim();
  expect(new URL(at).port).not.toBe('59812');
  return at;
}

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-review-stays-open-e2e-');
  const home = join(root, 'home');
  dataDir = join(root, 'data');
  mkdirSync(home, { recursive: true });
  markTourDecided(dataDir);
  forge = join(root, 'forge');
  writeForge();
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  spawnSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  env = {
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
  url = startInbox();
  context =await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
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
  await expect(review.locator('[data-pull-review-state]')).toHaveCount(0);
  await shot('before-merge', 1440, 900, 'light');
  await shot('before-merge', 1440, 900, 'dark');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await expect(composer).toHaveValue(words);

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
  // The header says it in words beside the mark, its Reviews row's word.
  const word = review.locator('[data-pull-review-title] [data-pull-review-state]');
  await expect(word).toHaveAttribute('data-pull-review-state', 'merged');
  await expect(word).toContainText('Merged');

  await shot('merged', 1440, 900, 'light');
  await shot('merged', 1440, 900, 'dark');
  await shot('merged', 390, 844, 'light');
  // A phone's header has no title bar: its title row says it, with the mark.
  const phoneTitle = review.locator('[data-pull-details-button]');
  await expect(phoneTitle.locator('[data-pull-review-state]')).toContainText('Merged');
  await expect(phoneTitle.locator('.ib-refmark')).toHaveAttribute('data-ref-state', 'merged');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

  // The person reloads: the merged PR is in no list's stack any more, and its page reopens on it all the same, its
  // diff and its comment there, the header saying merged.
  await page.reload();
  await expect(review.locator(`[data-guide-file-shell="${FILE}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(mark).toHaveAttribute('data-ref-state', 'merged');
  await expect(word).toContainText('Merged');
  await expect(page.getByText('This pull request is no longer in the list.')).toHaveCount(0);
  await expect(review.locator('.ib-vcomments')).toContainText('1');
  await shot('reloaded', 1440, 900, 'light');
  await shot('reloaded', 1440, 900, 'dark');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
});

const review = () => page.locator('[data-pull-review]');
const markOf = () => review().locator('[data-pull-review-title] .ib-refmark');
const fileShell = () => review().locator(`[data-guide-file-shell="${FILE}"]`);
const gone = () => page.getByText('This pull request is no longer in the list.');
const unread = () => review().locator('[data-pull-review-unread]');

/** The page's one line reads whole: the sentence there, on screen, not cut (no ellipsis: nothing wider than its box). */
async function expectWhole(line: ReturnType<typeof unread>, words: string): Promise<void> {
  await expect(line).toBeVisible();
  await expect(line).toHaveText(words);
  const box = await line.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, inBar: !!el.closest('.ib-vhead') }));
  expect(box.inBar).toBe(false);
  expect(box.scroll).toBeLessThanOrEqual(box.client);
}

async function openPull(who: Who): Promise<void> {
  const key = encodeURIComponent(keyOf(who));
  await page.goto(`${url}#pulls&stack=${key}&layer=${key}&scope=layer`);
  await clearSidebarPeek(page);
}

/** The server reads the forge again now (as the Reviews page's own refresh would): the PRs it lists, by key. */
async function serverLists(): Promise<Map<string, string>> {
  const served = (await (await page.request.get(`${url}api/inbox/pulls?refresh=1`)).json()) as { pulls: { key: string; state: string }[] };
  return new Map(served.pulls.map((p) => [p.key, p.state]));
}

/** Focus the window until `check` holds (a focus reads again at most every 20 s, a background read may have just run). */
async function focusUntil<T>(check: () => Promise<T>, want: T): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        return check();
      },
      { timeout: 90_000, intervals: [5_000] },
    )
    .toBe(want);
}

test('a teammate’s PR: merged as the diff reads it, then gone from every list, its page and its draft comment stay through a reload', async () => {
  // Two teammates' PRs asked of the person. #881 is merged already, but GitHub's search still lists it open.
  requested = [THEIRS, LAGGING];
  writeLists();
  forgeHas(THEIRS, 'open');
  forgeHas(LAGGING, 'merged');
  // A forced read is held for 20 s after the last one (the test before forced one): ask until it lands.
  await expect.poll(async () => { const listed = await serverLists(); return `${listed.get(keyOf(LAGGING))} ${listed.get(keyOf(THEIRS))}`; }, { timeout: 60_000, intervals: [5_000] }).toBe('open open');

  // #881's page: the list says open, the diff's own read of the PR says merged, and the header says so.
  await openPull(LAGGING);
  await expect(fileShell()).toBeVisible({ timeout: 30_000 });
  await expect(markOf()).toHaveAttribute('data-ref-state', 'merged');

  // #880's page, open: a comment on a changed line, kept with the review (not posted).
  await openPull(THEIRS);
  await expect(fileShell()).toBeVisible({ timeout: 30_000 });
  await expect(markOf()).toHaveAttribute('data-ref-state', 'open');
  await fileShell().locator('[data-line-type="change-addition"][data-column-number]').first().click({ position: { x: 4, y: 4 } });
  const composer = page.getByPlaceholder('Leave feedback...');
  await expect(composer).toBeFocused();
  await composer.fill('Which rate does this take for a refund issued later?');
  await page.getByRole('button', { name: 'Add Comment' }).click();
  await expect(review().locator('.ib-vcomments')).toContainText('1');
  const rail = await review().locator('.ib-rrail').innerText();

  // Its author merges it: no search of the person's lists it any more. The page asks the server for it
  // (GET /api/inbox/pulls/pull) at the window's next list read, which reads it from the forge by number, merged. (The
  // window's own list may never have named it: this test changed the forge after the window's last read. The page's
  // first ask then took the server's listed copy, open, and it asks again at each list read until it says merged.)
  const answers: Promise<{ pull: { state: string } | null; unreadable?: boolean }>[] = [];
  const onAnswer = (r: Response) => {
    if (r.url().includes('/api/inbox/pulls/pull?') && r.url().includes(`%23${THEIRS.number}`)) answers.push(r.json());
  };
  page.on('response', onAnswer);
  requested = [LAGGING];
  writeLists();
  forgeHas(THEIRS, 'merged');
  await page.waitForTimeout(FOCUS_READ_MS);
  await expect.poll(async () => (await serverLists()).has(keyOf(THEIRS)), { timeout: 60_000, intervals: [5_000] }).toBe(false);
  await focusUntil(() => markOf().getAttribute('data-ref-state'), 'merged');
  page.off('response', onAnswer);
  expect(answers.length).toBeGreaterThan(0);
  const answer = await answers[answers.length - 1]!;
  expect(answer.pull?.state).toBe('merged');
  expect(answer.unreadable).toBeUndefined();
  await expect(gone()).toHaveCount(0);
  await expect(fileShell()).toBeVisible();
  expect(await review().locator('.ib-rrail').innerText()).toBe(rail);
  await expect(review().locator('.ib-vcomments')).toContainText('1');
  await expect(review().locator('[data-pull-review-title] [data-pull-review-state]')).toContainText('Merged');
  await shot('teammate-merged', 1440, 900, 'light');

  // A reload: no list names it, and its only comment is the kept draft. The page reopens on it, merged, the draft
  // there and the reader still taking comments (a line's number opens a composer), only Post gone.
  await page.reload();
  await expect(fileShell()).toBeVisible({ timeout: 30_000 });
  await expect(markOf()).toHaveAttribute('data-ref-state', 'merged');
  await expect(gone()).toHaveCount(0);
  await expect(review().locator('.ib-vcomments')).toContainText('1');
  await shot('draft-only-reloaded', 1440, 900, 'light');
  await fileShell().locator('[data-line-type="change-addition"][data-column-number]').first().click({ position: { x: 4, y: 4 } });
  await expect(page.getByPlaceholder('Leave feedback...')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('GitHub not answering: the page stays as last read with one line, through a reload and a restart while offline', async () => {
  // Offline: every gh call fails. Past the server's 20 s hold of its last read of the PR, a reload asks again.
  forgeDown(true);
  await page.waitForTimeout(FOCUS_READ_MS);
  await page.reload();
  await expect(review().locator('[data-pull-review-title]')).toBeVisible({ timeout: 30_000 });
  await expect(unread()).toHaveCount(1, { timeout: 30_000 });
  await expect(unread()).toContainText('GitHub');
  await expect(gone()).toHaveCount(0);
  await expect(fileShell()).toBeVisible();
  await shot('forge-unreachable', 1440, 900, 'light');
  // The line is its own, above the diff: the whole sentence reads, on a phone too (in the header bar it was cut).
  await expectWhole(unread(), "GitHub didn't answer; showing its last read.");
  await shot('forge-unreachable', 390, 844, 'light');
  await expectWhole(unread(), "GitHub didn't answer; showing its last read.");
  await page.setViewportSize({ width: 1440, height: 900 });

  // The Inbox restarts while still offline (its first sign-in check fails, with no good one on record): the PRs it
  // kept since they left the list are still there, so the page reopens on #880 with the same line, and its diff as
  // last read here (kept on disk past the restart), not "could not read this diff".
  await stopScratchInbox(dataDir);
  url = startInbox();
  await openPull(THEIRS);
  await expect(review().locator('[data-pull-review-title]')).toBeVisible({ timeout: 30_000 });
  await expect(unread()).toHaveCount(1, { timeout: 30_000 });
  await expect(gone()).toHaveCount(0);
  await expect(fileShell()).toBeVisible({ timeout: 30_000 });
  await expect(review().locator('[data-pull-diff-error]')).toHaveCount(0);
  await shot('forge-unreachable-restarted', 1440, 900, 'light');

  // Back online: the next focus asks again (the restarted Inbox had read no list yet: it reads one first, so the PR it
  // kept from before is still found), and the line goes; the page stays, merged.
  forgeDown(false);
  await focusUntil(() => unread().count(), 0);
  await expect(markOf()).toHaveAttribute('data-ref-state', 'merged');
  await expect(gone()).toHaveCount(0);
  await expect(review().locator('[data-pull-review-title] [data-pull-review-state]')).toContainText('Merged');
});

test('GitHub no longer has the PR (its repository deleted, access lost): the page stays as last read and says so', async () => {
  writeFileSync(join(forge, `gone-${THEIRS.number}`), '1');
  // Past the server's 20 s hold of its last read of the PR, a reload asks again.
  await page.waitForTimeout(FOCUS_READ_MS);
  await page.reload();
  await expect(review().locator('[data-pull-review-title]')).toBeVisible({ timeout: 30_000 });
  const missing = review().locator('[data-pull-review-missing]');
  await expect(missing).toHaveCount(1, { timeout: 30_000 });
  await expect(missing).toContainText('GitHub');
  await expect(unread()).toHaveCount(0);
  await expect(gone()).toHaveCount(0);
  await expect(markOf()).toHaveAttribute('data-ref-state', 'merged');
  // Its diff as last read here, as the line says: GitHub's 404 for every read of it (its patch too) loses nothing.
  await expect(fileShell()).toBeVisible({ timeout: 30_000 });
  await expect(review().locator('[data-pull-diff-error]')).toHaveCount(0);
  await expectWhole(missing, "GitHub can't find this pull request any more; showing its last read.");
  await shot('forge-missing', 1440, 900, 'light');
  await shot('forge-missing', 390, 844, 'light');
  await expectWhole(missing, "GitHub can't find this pull request any more; showing its last read.");
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('a PR closed on GitHub, then reopened: its page says Closed with no Post, then open with Post back, through a reload', async () => {
  // A teammate's PR the person was asked to review, open: its page with Post.
  requested = [LAGGING, REOPENED];
  writeLists();
  forgeHas(REOPENED, 'open');
  await expect.poll(async () => (await serverLists()).get(keyOf(REOPENED)), { timeout: 60_000, intervals: [5_000] }).toBe('open');
  await openPull(REOPENED);
  await expect(fileShell()).toBeVisible({ timeout: 30_000 });
  await expect(markOf()).toHaveAttribute('data-ref-state', 'open');
  const post = review().locator('[data-review-posts]');
  await expect(post).toHaveCount(1);

  // Closed on GitHub: the search no longer lists it. The page stays, asks GitHub for it, and says Closed; Post goes.
  requested = [LAGGING];
  writeLists();
  forgeHas(REOPENED, 'closed');
  await page.waitForTimeout(FOCUS_READ_MS);
  await expect.poll(async () => (await serverLists()).has(keyOf(REOPENED)), { timeout: 60_000, intervals: [5_000] }).toBe(false);
  await focusUntil(() => markOf().getAttribute('data-ref-state'), 'closed');
  await expect(review().locator('[data-pull-review-title] [data-pull-review-state]')).toContainText('Closed');
  await expect(post).toHaveCount(0);
  // A reload while closed: its diff read now says closed too (the server's read of it).
  await page.reload();
  await expect(fileShell()).toBeVisible({ timeout: 30_000 });
  await expect(markOf()).toHaveAttribute('data-ref-state', 'closed');
  await shot('reopen-closed', 1440, 900, 'light');

  // Reopened: the search lists it again. Closed is not final: the page says open and Post is back, whatever the
  // diff read before (still in the server's 5-minute cache) said.
  requested = [LAGGING, REOPENED];
  writeLists();
  forgeHas(REOPENED, 'open');
  await page.waitForTimeout(FOCUS_READ_MS);
  await expect.poll(async () => (await serverLists()).get(keyOf(REOPENED)), { timeout: 60_000, intervals: [5_000] }).toBe('open');
  await focusUntil(() => markOf().getAttribute('data-ref-state'), 'open');
  await expect(review().locator('[data-pull-review-title] [data-pull-review-state]')).toHaveCount(0);
  await expect(post).toHaveCount(1);
  await shot('reopened', 1440, 900, 'light');
  // And after a reload.
  await page.reload();
  await expect(fileShell()).toBeVisible({ timeout: 30_000 });
  await expect(markOf()).toHaveAttribute('data-ref-state', 'open');
  await expect(post).toHaveCount(1);
});

/** A linked computer ("Mac mini") whose gh lists a PR this one does not: the window reads it there, through `/api/inbox/m/<id>/`. */
const FAR_MACHINE = 'ibx_01JZ0000000000000000000000';
const FAR: Who = { number: 990, title: 'Bill annual plans on the first of the month', author: 'mira', head: 'mira/annual-billing' };
const FAR_KEY = keyOf(FAR);
let farListed = true;
let farState: 'open' | 'merged' = 'open';
const farAsked: string[] = [];
function farPull(): Record<string, unknown> {
  const at = new Date(Date.now() - 600_000).toISOString();
  return {
    key: FAR_KEY, platform: 'github', host: 'github.com', repo: REPO, number: FAR.number, url: `https://github.com/${REPO}/pull/${FAR.number}`,
    title: FAR.title, author: FAR.author, mine: false, requested: true, state: farState, base: 'main', head: FAR.head, head_repo: REPO,
    head_sha: HEAD, additions: 2, deletions: 1, files: 1, review: null, approved_by: null, reviewers: ['ada'], checks: null,
    updated_at: at, merged_at: farState === 'merged' ? at : null, machine: FAR_MACHINE,
  };
}

test('a PR on a linked computer: merged there and gone from the board, its page stays, says Merged, and reopens after a reload', async () => {
  // This computer's board (the Pull requests page) with the linked computer's PR under it while that computer lists it.
  await page.route(
    (u) => u.pathname === '/api/inbox/pulls' && u.searchParams.get('everywhere') === '1',
    async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { pulls: Record<string, unknown>[]; machines?: Record<string, unknown> };
      const pulls = farListed ? [...json.pulls, farPull()] : json.pulls;
      return route.fulfill({ response, json: { ...json, pulls, machines: { ...(json.machines ?? {}), [FAR_MACHINE]: { read_at: new Date().toISOString(), pending: false, name: 'Mac mini' } } } });
    },
  );
  // That computer's per-PR routes, as its Inbox answers them (its own kept copy and its forge: inbox-pull-departed.ts).
  await page.route(
    (u) => u.pathname.startsWith(`/api/inbox/m/${FAR_MACHINE}/`),
    async (route) => {
      const u = new URL(route.request().url());
      const path = u.pathname.slice(`/api/inbox/m/${FAR_MACHINE}`.length);
      farAsked.push(path);
      if (path === '/pulls/pull') return route.fulfill({ json: { serverSession: 'far', pull: farPull() } });
      if (path === '/pulls/diff') {
        return route.fulfill({ json: { serverSession: 'far', key: FAR_KEY, scope: 'layer', base: 'main', head: FAR.head, patch: PATCH, description: null, head_sha: HEAD, state: farState, merged_at: null } });
      }
      if (path === '/pulls/details') return route.fulfill({ json: { serverSession: 'far', key: FAR_KEY, description: null, labels: [], reviewers: [], checks: [], comments: [] } });
      return route.fulfill({ status: 404, json: { error: 'Not here.', code: 'not_found' } });
    },
  );
  await page.goto(`${url}#prs&stack=${encodeURIComponent(FAR_KEY)}&layer=${encodeURIComponent(FAR_KEY)}&scope=layer`);
  // A fresh page: the board this window already read (before the routes above) never named that computer's PR.
  await page.reload();
  await clearSidebarPeek(page);
  await expect(fileShell()).toBeVisible({ timeout: 30_000 });
  await expect(markOf()).toHaveAttribute('data-ref-state', 'open');
  expect(farAsked).toContain('/pulls/diff');

  // Merged on that computer: its board no longer names it. The page stays, asks that computer for it, and says merged.
  farListed = false;
  farState = 'merged';
  await page.waitForTimeout(FOCUS_READ_MS);
  await focusUntil(() => markOf().getAttribute('data-ref-state'), 'merged');
  expect(farAsked).toContain('/pulls/pull');
  await expect(gone()).toHaveCount(0);
  await expect(fileShell()).toBeVisible();
  await expect(review().locator('[data-pull-review-title] [data-pull-review-state]')).toContainText('Merged');
  await shot('linked-merged', 1440, 900, 'light');

  // A reload: no board names it; the window still knows whose it is, and the page reopens on it, merged, read there.
  farAsked.length = 0;
  await page.reload();
  await expect(fileShell()).toBeVisible({ timeout: 30_000 });
  await expect(markOf()).toHaveAttribute('data-ref-state', 'merged');
  await expect(gone()).toHaveCount(0);
  expect(farAsked).toContain('/pulls/pull');
  await shot('linked-reloaded', 1440, 900, 'light');
  await shot('linked-reloaded', 390, 844, 'light');
});
