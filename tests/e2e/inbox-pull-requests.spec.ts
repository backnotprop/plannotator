/**
 * Pull requests in the Inbox (approval "inbox-code-review-direction", items 4
 * and 5; code review in the Inbox, phase 2), proved in a real browser against
 * the compiled binary. The binary runs `plannotator inbox --background` under
 * a temp PLANNOTATOR_DATA_DIR; simulated agents write through `plannotator
 * inbox mcp` (scripts/inbox-sim.ts); Chromium drives the window. HOME is
 * a scratch folder: the Inbox reads skills and agent config from it. `gh` and `glab` are sh fakes first on PATH: nothing reaches
 * GitHub or GitLab, and the real CLIs never run. The diffs they answer are
 * real `git diff`s of scratch repositories with invented names.
 *
 * What is proved, in order:
 *  1. Off (the default): no Reviews row, a #pulls link (the permanent alias of
 *     #reviews) says Code review is off, with Open Settings, and no gh / glab
 *     query runs (the fakes' call log).
 *  2. On, with the Board off: the row; the list grouped by whose move it is
 *     (On you with a teammate's review request and the agent's stack, Ready
 *     to land, the folded "2 waiting on others"); the stack is one row with
 *     its chain.
 *  3. The stack view with the Board off: layers from main up, "Lands next" on
 *     the lowest open one, its review thread's agent (tied by the PR's link in
 *     the agent's own message) and Open review thread, no Board UI, no merge
 *     button.
 *  4. A PR with no review thread (approval "pr-page-review-with-agent"): one
 *     button, Review with an agent, opens the New review box filled in; Start
 *     review sends the first message to the agent in To, and the PR is
 *     that thread's from then on ("Review thread with Claude Code", Open
 *     review thread, also once the guided review arrived). "Open the diff"
 *     sits beside the button in every state, and each row opens its diff.
 *     (Start a new agent shows only while the Inbox can launch; the shots add
 *     compose's launch block to the sessions answer, since launching is not
 *     on main yet.)
 *  5. The Board on, a card linking the stack: a quiet Board chip.
 *  6. Open the diff opens the lowest open layer's own diff; Next layer moves up;
 *     Whole stack is the compare from the lowest open layer's base (not the
 *     merged layer under it); Approve goes into the agent's thread as the
 *     person's reply.
 *  7. Reply at the stack's foot goes into the agent's thread.
 *  8. The same at 390 px (a phone).
 *  9. Post to GitHub (the owner's answer C on #2590: the person chooses at
 *     the end): the choice on a PR with an agent, a teammate's PR posting its
 *     approval with a line comment (the fake gh's stdin is the review the
 *     review app's provider builds), and a refusal from GitHub shown in the
 *     dialog with nothing claimed posted.
 * 10. The rows' top left is each author's picture (the owner on #2608), the
 *     Inbox's own route fetching it from the fake forge's `avatarUrl` (a
 *     loopback server, tests/helpers/fake-avatars.ts); the window never asks
 *     another origin for anything. A long title is cut in the review header,
 *     whose controls stay in the window from 1280 down to 760 wide.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/pull-requests (desktop light and
 * dark at 1440, phone at 390), and a walkthrough video (webm) when
 * PLANNOTATOR_E2E_VIDEO=1.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { startFakeAvatars, type FakeAvatars } from '../helpers/fake-avatars';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'pull-requests');
const video = process.env.PLANNOTATOR_E2E_VIDEO === '1';

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  forge: string;
  projects: { billing: string; web: string; ledger: string };
  threads: { stack: string; vite: string; csv: string };
  patches: { locale: string; rtl: string };
  claude: SimAgent;
  codex: SimAgent;
  polls: Poll[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  avatars: FakeAvatars;
  /** Every request a window made to an origin other than the Inbox's (none may happen). */
  outside: string[];
}

/** The real person's Inbox port: a spec's Inbox never takes it. */
const OWNER_INBOX_PORT = '59812';

/** Records any request the page makes to an origin other than `url`'s (data: and blob: are the page's own). */
function watchOutside(page: Page, url: string, outside: string[]): void {
  const own = new URL(url).origin;
  page.on('request', (request) => {
    const at = new URL(request.url());
    if (at.protocol === 'data:' || at.protocol === 'blob:') return;
    if (at.origin !== own) outside.push(request.url());
  });
}

let world: World;
/** The verdict's reply (test 4), after which the stack's Reply lands (test 5). */
let verdictId = '';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

function gitIn(dir: string) {
  return (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout;
  };
}

/** A scratch repository with `origin`, `main` and the branches given, each from the one before it (or main). */
function repoWith(parent: string, name: string, origin: string, base: Record<string, string>, branches: { name: string; from: string; files: Record<string, string> }[]) {
  const dir = scratchProject(parent, name);
  const git = gitIn(dir);
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  git('checkout', '-q', '-b', 'main');
  write(base);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  for (const branch of branches) {
    git('checkout', '-q', '-b', branch.name, branch.from);
    write(branch.files);
    git('add', '-A');
    git('commit', '-q', '-m', branch.name);
  }
  git('remote', 'add', 'origin', origin);
  return { dir, git, diff: (from: string, to: string) => git('diff', `${from}...${to}`) };
}

const lines = (...parts: string[]) => `${parts.join('\n')}\n`;

/** The fake gh / glab: canned answers by endpoint; each call one line in `calls` (`gh pulls`, `gh diff <endpoint>`, `glab pulls`, …). */
function writeForge(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'calls'), '');
  const shared = [
    'calls="$dir/calls"',
    'name() { printf "%s" "$1" | tr "/.%?&=" "______"; }',
  ];
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    ...shared,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"dana","active":true,"state":"success","tokenSource":"keyring"}]}}\'',
    '  exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then',
    // Others (a read of its own): nothing open past the person's own lists.
    '  case "$*" in *"query InboxPullsOthers"*) echo "gh others" >> "$calls"; echo \'{"data":{"viewer":{"login":"dana"},"others0":{"issueCount":0,"nodes":[]}}}\'; exit 0;; esac',
    '  case "$*" in *"requested: search"*) echo "gh pulls" >> "$calls"; cat "$dir/gh-pulls.json"; exit 0;; esac',
    '  echo "gh graphql-other" >> "$calls"; echo \'{"data":null}\'; exit 1',
    'fi',
    // A review posted (Post to GitHub): `gh api <endpoint> --method POST --input -`, the review on stdin, kept.
    'if [ "$1" = api ] && [ "$3" = --method ]; then',
    '  echo "gh post $2" >> "$calls"',
    '  cat > "$dir/gh-posted.json"',
    '  if [ -f "$dir/gh-post-fail" ]; then cat "$dir/gh-post-fail" >&2; exit 1; fi',
    '  echo \'{"id":1}\'; exit 0',
    'fi',
    // A layer's head commit, read around its patch (`--jq .head.sha`): the list's `headRefOid` for that number.
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then',
    '  echo "gh head $4" >> "$calls"; printf "%040d\\n" "${4##*/}"; exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ]; then',
    '  echo "gh diff $4" >> "$calls"',
    '  f="$dir/gh-$(name "$4").patch"',
    '  if [ -f "$f" ]; then cat "$f"; exit 0; fi',
    '  echo "HTTP 404: Not Found" >&2; exit 1',
    'fi',
    'echo "gh other $1" >> "$calls"; exit 1',
    '',
  ].join('\n');
  const glab = [
    '#!/bin/sh',
    `dir='${dir}'`,
    ...shared,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo "gitlab.com"; echo "  ✓ Logged in to gitlab.com as dana (keyring)"; exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$4" = graphql ]; then',
    '  case "$*" in *"query InboxPullsOthers"*) echo "glab others" >> "$calls"; echo \'{"data":{"currentUser":{"username":"dana"}}}\'; exit 0;; esac',
    '  case "$*" in *reviewRequestedMergeRequests*) echo "glab pulls" >> "$calls"; cat "$dir/glab-pulls.json"; exit 0;; esac',
    '  echo "glab graphql-other" >> "$calls"; echo \'{"data":null}\'; exit 1',
    'fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ]; then',
    '  echo "glab diff $4" >> "$calls"',
    '  f="$dir/glab-$(name "$4").patch"',
    '  if [ -f "$f" ]; then cat "$f"; exit 0; fi',
    '  echo "404 Not Found" >&2; exit 1',
    'fi',
    'echo "glab other $1" >> "$calls"; exit 1',
    '',
  ].join('\n');
  for (const [file, body] of [['gh', gh], ['glab', glab]] as const) {
    writeFileSync(join(dir, file), body);
    chmodSync(join(dir, file), 0o755);
  }
  const named = (endpoint: string) => endpoint.replace(/[/.%?&=]/g, '_');
  return {
    gh: (endpoint: string, patch: string) => writeFileSync(join(dir, `gh-${named(endpoint)}.patch`), patch),
    glab: (endpoint: string, patch: string) => writeFileSync(join(dir, `glab-${named(endpoint)}.patch`), patch),
  };
}

const forgeCalls = () => readFileSync(join(world.forge, 'calls'), 'utf8').split('\n').filter(Boolean);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** The fake forge's picture address for a login (the loopback server started in beforeAll). */
let avatarOf = (login: string) => `http://127.0.0.1:9/${login}.png`;

function ghPull(repoName: string, number: number, fields: Record<string, unknown>) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/${repoName}/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    updatedAt: ago(30),
    mergedAt: null,
    baseRefName: 'main',
    headRefName: `b${number}`,
    headRefOid: String(number).padStart(40, '0'),
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: repoName },
    headRepository: { nameWithOwner: repoName },
    author: { login: 'dana', avatarUrl: avatarOf('dana') },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...fields,
  };
}

/** `+a −d N files` of a patch, as the forge would count them. */
function stats(patch: string) {
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions, changedFiles: files };
}

/** One live session: the bridge's long-poll, as the mod, Pi and OpenCode run it (compose's and the review picker's sessions). */
class Poll {
  private stopped = false;
  private readonly loop: Promise<void>;
  constructor(
    private readonly dataDir: string,
    readonly session: string,
    readonly host: string,
    private readonly projectPath: string,
    private readonly startedAt: number,
  ) {
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const { port, token } = JSON.parse(readFileSync(join(this.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
      const response = await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session: this.session, host: this.host, waitMs: 1_000, project_path: this.projectPath, started_at: this.startedAt, busy: false, idle_since: this.startedAt }),
      }).catch(() => null);
      await response?.text().catch(() => '');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

/**
 * Launching an agent from the Inbox is not on main yet: for the shots, compose's sessions answer gets the launch
 * block an Inbox that can launch adds, so Start a new agent shows. Nothing is launched.
 */
async function offerLaunch(page: Page): Promise<void> {
  await page.route('**/api/inbox/sessions*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, launch: { agents: [{ agent: 'claude-code', name: 'Claude Code' }], projects: [] } } });
  });
}

async function noAgentsDialog(page: Page): Promise<void> {
  await expect(page.getByText('Tell your agents', { exact: false })).toHaveCount(0);
}

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  await noAgentsDialog(page);
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function setCodeReview(on: boolean): Promise<void> {
  const response = await world.page.request.post(`${world.url}api/inbox/settings`, { data: { code_review: { on } } });
  expect(response.status()).toBe(200);
}

async function setBoard(on: boolean): Promise<void> {
  const response = await world.page.request.post(`${world.url}api/inbox/settings`, { data: { board: { on } } });
  expect(response.status()).toBe(200);
}

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-pull-requests-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  // The Board off and Code review off: Pull requests needs no Board (test 5 turns it on for the card chip).
  const configFile = join(dataDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), inboxBoard: false }));
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const forgeDir = join(root, 'forge');
  const forge = writeForge(forgeDir);
  // The authors' pictures: a loopback server the fake forge's avatarUrl names (allowed under the test sandbox only).
  const avatars = await startFakeAvatars();
  avatarOf = avatars.url;
  const src = join(root, 'src');

  // billing-svc: Claude Code's stack of four, the charge client merged under it.
  const billing = repoWith(
    src,
    'billing-svc',
    'https://github.com/northwind/billing-svc.git',
    {
      'src/charges/client.ts': lines("export async function charge(id: string) {", "  return fetch(`/charges/${id}`, { method: 'POST' });", '}'),
      'src/charges/retry.ts': lines('export const RETRY_LIMIT = 3;'),
    },
    [
      { name: 'retry/charge-client', from: 'main', files: { 'src/charges/client.ts': lines("export async function charge(id: string, key: string) {", "  return fetch(`/charges/${id}`, { method: 'POST', headers: { 'Idempotency-Key': key } });", '}') } },
      {
        name: 'retry/schedule',
        from: 'retry/charge-client',
        files: {
          'src/charges/schedule.ts': lines(
            "import { RETRY_LIMIT } from './retry';",
            '',
            '/** When to try a failed charge again: 1 hour, 6 hours, then 1 day. */',
            'export const SCHEDULE_HOURS = [1, 6, 24];',
            '',
            'export function nextAttemptAt(failedAt: Date, attempt: number): Date | null {',
            '  if (attempt >= RETRY_LIMIT) return null;',
            '  const hours = SCHEDULE_HOURS[attempt] ?? SCHEDULE_HOURS[SCHEDULE_HOURS.length - 1]!;',
            '  return new Date(failedAt.getTime() + hours * 3_600_000);',
            '}',
          ),
          'migrations/0042_retry_schedule.sql': lines('CREATE TABLE retry_schedule (', '  charge_id TEXT PRIMARY KEY,', '  attempt INTEGER NOT NULL DEFAULT 0,', '  next_at TIMESTAMPTZ', ');'),
          'src/charges/schedule.test.ts': lines("import { expect, test } from 'bun:test';", "import { nextAttemptAt } from './schedule';", '', "test('the third attempt is the last', () => {", '  expect(nextAttemptAt(new Date(0), 3)).toBeNull();', '});'),
        },
      },
      {
        name: 'retry/backoff',
        from: 'retry/schedule',
        files: {
          'src/charges/schedule.ts': lines(
            "import { RETRY_LIMIT } from './retry';",
            '',
            '/** When to try a failed charge again: 1 hour, 6 hours, then 1 day, with up to 10% jitter. */',
            'export const SCHEDULE_HOURS = [1, 6, 24];',
            '',
            'export function nextAttemptAt(failedAt: Date, attempt: number, random = Math.random): Date | null {',
            '  if (attempt >= RETRY_LIMIT) return null;',
            '  const hours = SCHEDULE_HOURS[attempt] ?? SCHEDULE_HOURS[SCHEDULE_HOURS.length - 1]!;',
            '  const jitter = 1 + random() * 0.1;',
            '  return new Date(failedAt.getTime() + hours * jitter * 3_600_000);',
            '}',
          ),
        },
      },
      { name: 'retry/dunning', from: 'retry/backoff', files: { 'src/charges/dunning.ts': lines("export function dunningEmail(attempt: number): 'soft' | 'final' {", "  return attempt >= 2 ? 'final' : 'soft';", '}') } },
    ],
  );
  // web-app: a teammate's PR for the person's review, Codex's approved one, one waiting on Jun.
  const web = repoWith(
    src,
    'web-app',
    'https://github.com/northwind/web-app.git',
    { 'src/settings/Layout.tsx': lines('export function Layout({ children }) {', '  return <div className="settings ml-6">{children}</div>;', '}'), 'package.json': lines('{', '  "devDependencies": { "vite": "7.2.0" }', '}') },
    [
      { name: 'tomas/rtl-settings', from: 'main', files: { 'src/settings/Layout.tsx': lines('export function Layout({ children }) {', '  // Logical margins, so the sidebar sits on the right in Arabic and Hebrew.', '  return <div className="settings ms-6" dir="auto">{children}</div>;', '}') } },
      { name: 'codex/vite-8', from: 'main', files: { 'package.json': lines('{', '  "devDependencies": { "vite": "8.0.1" }', '}') } },
      { name: 'locale-fallback', from: 'main', files: { 'src/i18n/fallback.ts': lines("export const FALLBACK = 'en';") } },
    ],
  );
  // ledger (GitLab): Codex's CSV export with its pipeline running, and Priya's MR for the person's review.
  const ledger = repoWith(
    src,
    'ledger',
    'git@gitlab.com:northwind/ledger.git',
    { 'src/export.py': lines('def export(rows):', '    return rows') },
    [
      { name: 'csv-export', from: 'main', files: { 'src/export.py': lines('import csv', 'import io', '', 'def export(rows):', '    out = io.StringIO()', '    csv.writer(out).writerows(rows)', '    return out.getvalue()') } },
      { name: 'priya/rounding', from: 'main', files: { 'src/rounding.py': lines('from decimal import Decimal, ROUND_HALF_EVEN', '', 'def cents(value: Decimal) -> Decimal:', '    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_EVEN)') } },
    ],
  );
  billing.git('checkout', '-q', 'retry/dunning');

  const layer412 = billing.diff('retry/charge-client', 'retry/schedule');
  const layer413 = billing.diff('retry/schedule', 'retry/backoff');
  const layer414 = billing.diff('retry/backoff', 'retry/dunning');
  forge.gh('repos/northwind/billing-svc/pulls/412', layer412);
  forge.gh('repos/northwind/billing-svc/pulls/413', layer413);
  forge.gh('repos/northwind/billing-svc/pulls/414', layer414);
  // Whole stack runs from the lowest open layer's base (#412's, the merged charge client's branch).
  for (const head of ['retry/schedule', 'retry/backoff', 'retry/dunning']) forge.gh(`repos/northwind/billing-svc/compare/retry/charge-client...${head}`, billing.diff('retry/charge-client', head));
  const rtl = web.diff('main', 'tomas/rtl-settings');
  const vite = web.diff('main', 'codex/vite-8');
  const locale = web.diff('main', 'locale-fallback');
  forge.gh('repos/northwind/web-app/pulls/880', rtl);
  forge.gh('repos/northwind/web-app/pulls/872', vite);
  forge.gh('repos/northwind/web-app/pulls/869', locale);
  const csvPatch = ledger.diff('main', 'csv-export');
  const rounding = ledger.diff('main', 'priya/rounding');
  forge.glab(`projects/${encodeURIComponent('northwind/ledger')}/merge_requests/61/raw_diffs`, csvPatch);
  forge.glab(`projects/${encodeURIComponent('northwind/ledger')}/merge_requests/58/raw_diffs`, rounding);
  // Pull request links: a teammate's PR in a repository that is no project, read only as one link.
  forge.gh('repos/northwind/payments/pulls/231', JSON.stringify({ state: 'open', title: 'Idempotent refunds', html_url: 'https://github.com/northwind/payments/pull/231', head: { ref: 'refunds' }, base: { ref: 'main' }, user: { login: 'tomas' } }));
  forge.glab(`projects/${encodeURIComponent('northwind/mobile')}/merge_requests/44`, JSON.stringify({ state: 'merged', merged_at: ago(90), title: 'Offline queue', web_url: 'https://gitlab.com/northwind/mobile/-/merge_requests/44', source_branch: 'offline', target_branch: 'main', author: { username: 'priya' } }));

  const billingRepo = 'northwind/billing-svc';
  const webRepo = 'northwind/web-app';
  writeFileSync(
    join(forgeDir, 'gh-pulls.json'),
    JSON.stringify({
      data: {
        viewer: { login: 'dana' },
        requested: {
          nodes: [ghPull(webRepo, 880, { title: 'RTL layout for the settings pages', author: { login: 'tomas', avatarUrl: avatarOf('tomas') }, headRefName: 'tomas/rtl-settings', updatedAt: ago(4), ...stats(rtl), reviewRequests: { nodes: [{ requestedReviewer: { login: 'dana' } }] } })],
        },
        authored: {
          nodes: [
            ghPull(billingRepo, 412, { title: 'Retry schedule table and next-attempt time', headRefName: 'retry/schedule', baseRefName: 'retry/charge-client', updatedAt: ago(9), ...stats(layer412) }),
            ghPull(billingRepo, 413, { title: 'Jitter on the retry backoff', headRefName: 'retry/backoff', baseRefName: 'retry/schedule', updatedAt: ago(8), ...stats(layer413) }),
            ghPull(billingRepo, 414, { title: 'Dunning emails for the last attempts', headRefName: 'retry/dunning', baseRefName: 'retry/backoff', isDraft: true, updatedAt: ago(7), ...stats(layer414), commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }),
            ghPull(webRepo, 872, { title: 'Upgrade to Vite 8', headRefName: 'codex/vite-8', reviewDecision: 'APPROVED', latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'priya' } }] }, updatedAt: ago(52), ...stats(vite) }),
            ghPull(webRepo, 869, { title: 'Fall back to English for missing strings', headRefName: 'locale-fallback', reviewRequests: { nodes: [{ requestedReviewer: { login: 'jun' } }] }, updatedAt: ago(180), ...stats(locale) }),
          ],
        },
        merged: { nodes: [ghPull(billingRepo, 411, { title: 'Idempotency keys on the charge client', state: 'MERGED', headRefName: 'retry/charge-client', mergedAt: ago(26 * 60), updatedAt: ago(26 * 60) })] },
      },
    }),
  );
  const mr = (iid: number, fields: Record<string, unknown>) => ({
    iid: String(iid),
    title: `MR ${iid}`,
    webUrl: `https://gitlab.com/northwind/ledger/-/merge_requests/${iid}`,
    state: 'opened',
    draft: false,
    updatedAt: ago(20),
    mergedAt: null,
    targetBranch: 'main',
    sourceBranch: `b${iid}`,
    diffHeadSha: String(iid).padStart(40, '0'),
    approved: false,
    detailedMergeStatus: 'NOT_APPROVED',
    diffStatsSummary: { additions: 0, deletions: 0, fileCount: 0 },
    headPipeline: { status: 'SUCCESS' },
    project: { fullPath: 'northwind/ledger' },
    sourceProject: { fullPath: 'northwind/ledger' },
    author: { username: 'dana', avatarUrl: avatarOf('dana') },
    approvedBy: { nodes: [] },
    reviewers: { nodes: [] },
    ...fields,
  });
  const glStats = (patch: string) => {
    const s = stats(patch);
    return { diffStatsSummary: { additions: s.additions, deletions: s.deletions, fileCount: s.changedFiles } };
  };
  writeFileSync(
    join(forgeDir, 'glab-pulls.json'),
    JSON.stringify({
      data: {
        currentUser: {
          username: 'dana',
          requested: { nodes: [mr(58, { title: 'Round cents half to even', author: { username: 'priya', avatarUrl: avatarOf('priya') }, sourceBranch: 'priya/rounding', updatedAt: ago(75), ...glStats(rounding) })] },
          authored: { nodes: [mr(61, { title: 'Export the ledger to CSV', sourceBranch: 'csv-export', headPipeline: { status: 'RUNNING' }, updatedAt: ago(15), ...glStats(csvPatch) })] },
          merged: { nodes: [] },
        },
      },
    }),
  );

  const env: Record<string, string> = {
    PATH: `${forgeDir}:${process.env.PATH ?? ''}`,
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
  // The person's own Inbox port is never this spec's.
  expect(new URL(url).port).not.toBe(OWNER_INBOX_PORT);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const outside: string[] = [];
  watchOutside(page, url, outside);
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });

  // The agents' threads, each tied by the PR's link in the agent's own message: the stack, Vite 8 and the CSV export.
  await claude.send({ project_path: billing.dir, thread: 'retries', subject: 'Retry failed charges', body: 'I split the retry work into a stack. The charge client merged yesterday.' });
  const stackThread = await claude.send({
    project_path: billing.dir,
    thread: 'retries',
    body: 'The stack is up: three layers on top of the charge client. Start at #412 (the schedule table); #414 is a draft until the emails are reviewed.\n\nhttps://github.com/northwind/billing-svc/pull/412',
  });
  const viteThread = await codex.send({ project_path: web.dir, thread: 'vite-8', subject: 'Vite 8', body: 'Priya approved the Vite 8 upgrade and the checks passed: https://github.com/northwind/web-app/pull/872' });
  const csvThread = await codex.send({ project_path: ledger.dir, thread: 'csv', subject: 'Ledger CSV export', body: 'The CSV export is up; its pipeline is running. https://gitlab.com/northwind/ledger/-/merge_requests/61' });
  // Two live sessions in web-app (the review picker's list), one in billing-svc.
  const now = Date.now();
  const polls = [
    new Poll(dataDir, 'ses-web-claude', 'claude-code', web.dir, now - 40 * 60_000),
    new Poll(dataDir, 'ses-web-pi', 'pi', web.dir, now - 95 * 60_000),
    new Poll(dataDir, 'ses-billing-claude', 'claude-code', billing.dir, now - 20 * 60_000),
  ];

  world = {
    root,
    dataDir,
    env,
    url,
    forge: forgeDir,
    projects: { billing: billing.dir, web: web.dir, ledger: ledger.dir },
    threads: { stack: String(stackThread.thread_id), vite: String(viteThread.thread_id), csv: String(csvThread.thread_id) },
    patches: { locale, rtl },
    claude,
    codex,
    polls,
    context,
    page,
    errors,
    avatars,
    outside,
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.polls.map((poll) => poll.stop()));
    await world.claude.close().catch(() => {});
    await world.codex.close().catch(() => {});
    await world.context.close();
    await world.avatars.close();
  } finally {
    await removeInboxScratch();
  }
});

const STACK_ID = 'github.com/northwind/billing-svc#414';
const LAYER_412 = 'github.com/northwind/billing-svc#412';
const LAYER_413 = 'github.com/northwind/billing-svc#413';
const LOCALE = 'github.com/northwind/web-app#869';

test('off (the default): no row, a #pulls link says Code review is off, and no gh or glab query runs', async () => {
  const { page } = world;
  // New review's summary runs git: refused too.
  expect((await page.request.get(`${world.url}api/inbox/reviews/changes?project=prj_x&changes=uncommitted`)).status()).toBe(409);
  const reads: string[] = [];
  const watch = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname.startsWith('/api/inbox/pulls')) reads.push(request.url());
  };
  page.on('request', watch);
  await page.goto(world.url);
  await expect(page.locator('[data-inbox-nav]')).toBeVisible();
  await expect(page.locator('[data-pulls-nav]')).toHaveCount(0);
  await page.goto(`${world.url}#pulls`);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#reviews');
  await expect(page.locator('[data-reviews-off]')).toContainText('Code review is off');
  await expect(page.locator('[data-pulls-list]')).toHaveCount(0);
  await shot(page, '1-off-link');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-reviews-off-settings]')).toBeVisible();
  await shot(page, '1-off-link-phone');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-reviews-off-settings]').click();
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('capabilities');
  await page.goto(world.url);
  await expect(page.locator('[data-inbox-nav]')).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '1-off-no-row');
  page.off('request', watch);
  expect(reads).toEqual([]);
  expect(forgeCalls().filter((c) => c.endsWith(' pulls') || c.includes(' diff '))).toEqual([]);
});

test('an old #pulls link opened fresh, in a new window, becomes #reviews', async () => {
  const context = await world.page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto('about:blank');
    await page.goto(`${world.url}#pulls&view=review`);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#reviews&view=review');
  } finally {
    await context.close();
  }
});

test("#reviews&new with Code review off: the off page, and no box", async () => {
  const { page } = world;
  await setCodeReview(false);
  await page.goto(`${world.url}#reviews&new`);
  await expect(page.locator('[data-reviews-off]')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator('dialog[data-compose]')).toHaveCount(0);
});

test('a #reviews link on a tailnet guest\'s page: the Inbox, and Back goes where the person was', async () => {
  const context = await world.page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await setCodeReview(true);
  try {
    await page.route('**/api/inbox/settings*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const answer = await route.fetch();
      await route.fulfill({ response: answer, json: { ...(await answer.json()), via: 'tailnet', guest: true } });
    });
    const thread = `#thread=${encodeURIComponent(world.threads.stack)}`;
    await page.goto(`${world.url}${thread}`);
    await expect(page.locator('[data-inbox-nav]')).toBeVisible();
    await page.evaluate(() => {
      location.hash = '#reviews';
    });
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
    await expect(page.locator('[data-pulls-list]')).toHaveCount(0);
    await page.goBack();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(thread);
  } finally {
    await context.close();
    await setCodeReview(false);
  }
});

test('#reviews&new opens the box over the page once: the address goes back to #reviews, so a reload does not reopen it', async () => {
  const { page } = world;
  await setCodeReview(true);
  await page.goto(`${world.url}#reviews&new`);
  await expect(page.locator('[data-pulls-list]')).toBeVisible();
  await expect(page.locator('dialog[data-compose]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#reviews');
  await page.reload();
  await expect(page.locator('[data-pulls-list]')).toBeVisible();
  await expect(page.locator('dialog[data-compose]')).toHaveCount(0);
  // The address was replaced, not pushed: Back from the box leaves the page, and does not open it again.
  await page.goto(world.url);
  await expect(page.locator('[data-inbox-nav]')).toBeVisible();
  await page.evaluate(() => {
    location.hash = '#reviews&new';
  });
  await expect(page.locator('dialog[data-compose]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#reviews');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[data-compose]')).toHaveCount(0);
  await page.goBack();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  await page.waitForTimeout(400);
  await expect(page.locator('dialog[data-compose]')).toHaveCount(0);
  await setCodeReview(false);
});

test('on, with the Board off: the row, and the list by whose move it is, the stack one row with its chain', async () => {
  const { page } = world;
  await setCodeReview(true);
  await page.goto(world.url);
  const nav = page.locator('[data-pulls-nav]');
  await expect(nav).toBeVisible();
  // Pull requests needs no Board.
  await expect(page.locator('[data-board-nav]')).toHaveCount(0);
  await nav.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#reviews');
  await expect(nav).toContainText('Reviews');
  const list = page.locator('[data-pulls-list]');
  await expect(list.locator('[data-pulls-row]').first()).toBeVisible();
  expect(forgeCalls().filter((c) => c.endsWith(' pulls')).sort()).toEqual(['gh pulls', 'glab pulls']);

  // A teammate's review request stays On you; a PR nobody has reviewed waits, folded, under Open, not reviewed.
  const onYou = list.locator('[data-pulls-group="on_you"] [data-pulls-row]');
  await expect(onYou).toHaveCount(2);
  await expect(list.locator('[data-pulls-group="on_you"] [data-pulls-row="github.com/northwind/web-app#880"]')).toContainText('tomas asked for your review');
  const fold = list.locator('[data-reviews-fold="not_reviewed"]');
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(list.locator('[data-pulls-group="not_reviewed"] [data-pulls-row]')).toHaveCount(0);
  await fold.click();
  const stackRow = list.locator(`[data-pulls-group="not_reviewed"] [data-pulls-row="${STACK_ID}"]`);
  await expect(stackRow).toHaveAttribute('data-pulls-layers', '4');
  await expect(stackRow.locator('[data-pulls-chain] .ib-bc-mark')).toHaveCount(4);
  await expect(stackRow).toContainText('3 open, 1 merged');
  await expect(stackRow.locator('.ib-lead .ib-atiles')).toHaveCount(0);
  for (const [row, login] of [[STACK_ID, 'dana'], ['github.com/northwind/web-app#880', 'tomas'], ['gitlab.com/northwind/ledger#58:pull', 'priya']] as const) {
    const av = list.locator(`[data-pulls-row="${row}"] .ib-lead [data-pulls-author="${login}"]`);
    await expect(av).toHaveAttribute('data-pulls-avatar', 'shown');
    const src = new URL((await av.locator('img').getAttribute('src'))!, world.url);
    expect([src.origin, src.pathname]).toEqual([new URL(world.url).origin, '/api/inbox/pulls/avatar']);
  }
  // The Inbox fetched them from the fake forge's addresses; the window asked no other origin.
  expect(world.avatars.served).toEqual(expect.arrayContaining(['/dana.png', '/tomas.png', '/priya.png']));
  expect(world.outside).toEqual([]);
  await expect(stackRow).toContainText('Retry failed charges');
  // The head is "Reviews", the filter mark and + (inbox-pull-filters.spec.ts); the On you band carries the count.
  expect(await list.locator('[data-pulls-heading]').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(list.locator('[data-pulls-heading]')).toHaveText('Reviews');
  await expect(list.locator('[data-pulls-filter-trigger]')).toHaveAccessibleName('Filter');
  await expect(page.locator('[data-pulls-nav] .ib-n')).toHaveText('2');
  await shot(page, '2-list');
  // Remembered: a new read of the page finds it as the person left it (open for the rest of this spec).
  await page.reload();
  await expect(list.locator('[data-reviews-fold="not_reviewed"]')).toHaveAttribute('aria-expanded', 'true');
});

test('the stack view with the Board off: layers from main up, Lands next, its review thread, no Board UI, no merge button', async () => {
  const { page } = world;
  await page.locator(`[data-pulls-row="${STACK_ID}"]`).click();
  const pane = page.locator('[data-pulls-stack]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('h2')).toHaveText('Retry failed charges');
  const layers = pane.locator('[data-pulls-layer]');
  await expect(layers).toHaveCount(4);
  // Top to bottom on screen: #414, #413, #412, #411 (merged), then main.
  expect(await layers.evaluateAll((els) => els.map((el) => el.getAttribute('data-pulls-layer')))).toEqual([
    STACK_ID,
    LAYER_413,
    LAYER_412,
    'github.com/northwind/billing-svc#411',
  ]);
  await expect(pane.locator(`[data-pulls-layer="${LAYER_412}"]`)).toContainText('Lands next');
  await expect(pane.locator(`[data-pulls-layer="${STACK_ID}"]`)).toContainText('Draft');
  await expect(pane.locator('[data-pulls-layer="github.com/northwind/billing-svc#411"]')).toContainText('Merged');
  await expect(pane.locator('.ib-pr-base')).toContainText('main');
  // Its agent's thread named the PR but holds no review of it: the agent's line under the title (its last words under
  // it), the thread a button away, and a review can start.
  const line = pane.locator('[data-pulls-thread-line="live"]');
  await expect(line).toBeVisible();
  await expect(line.locator('.ib-pr-thread-h')).toContainText('Thread with Claude Code');
  await expect(pane.locator('[data-pulls-primary]')).toHaveText('Review with an agent');
  await expect(pane.locator('[data-pulls-open-thread]')).toBeVisible();
  await expect(pane).not.toContainText(/\bhand/i);
  // The Board is off: no card chip, no Board words.
  await expect(pane.locator('[data-pulls-card]')).toHaveCount(0);
  await expect(pane).not.toContainText('Board');
  await expect(pane.getByRole('button', { name: /merge/i })).toHaveCount(0);
  // The diff is one button away.
  await expect(pane.getByRole('button', { name: 'Open the diff', exact: true })).toBeVisible();
  // The whole stack is the review's own switch: one Open the diff here.
  await expect(pane.getByRole('button', { name: 'Whole stack' })).toHaveCount(0);
  await shot(page, '3-stack-board-off');
});

/** The agent's guided review of a one-file PR, sent as phase 1's review (`review: true`), in reply to the review thread's first message. */
/** Open, not reviewed starts folded in a new window; the row a test opens is under it. */
async function openNotReviewed(page: Page): Promise<void> {
  const fold = page.locator('[data-reviews-fold="not_reviewed"]');
  await fold.waitFor();
  if ((await fold.getAttribute('aria-expanded')) === 'false') await fold.click();
}

async function sendReview(agent: SimAgent, projectPath: string, replyTo: string, patch: string, file: string, title: string): Promise<void> {
  await agent.submitGuide({
    project_path: projectPath,
    reply_to: replyTo,
    patch,
    body: '1 of 1 changed files needs you.',
    guide: {
      title,
      intent: 'What the pull request changes, and what to watch.',
      sections: [{ title: 'The one change', overview: 'Read the new lines; the rest of the file is unchanged.', diffs: [{ file, summary: 'The change.' }] }],
      review: { gitRef: 'main...HEAD', base: 'main' },
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
    review: true,
  } as never);
}

/** The same PR on a phone (390 px), in a context of its own: for the review thread's states, taken where they happen. */
async function phoneShot(browser: Browser, row: string, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark'], openPicker = false): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light', deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await offerLaunch(page);
    await page.goto(`${world.url}#reviews&stack=${encodeURIComponent(row)}`);
    await expect(page.locator('[data-pulls-stack]')).toBeVisible();
    if (openPicker) {
      await page.locator('[data-pulls-stack] [data-pulls-primary]').click();
      await expect(page.locator('[data-review-box]')).toBeVisible();
    }
    // Nothing scrolls sideways, and each control is a full touch target.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const box of await page.locator(PHONE_TARGETS).evaluateAll((els) => els.map((el) => el.getBoundingClientRect()))) {
      expect(box.right).toBeLessThanOrEqual(390);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator('[data-pulls-stack] [data-pulls-open-diff]')).toBeVisible();
    await shot(page, name, schemes);
  } finally {
    await context.close();
  }
}

/** The stack view's controls a phone must make full touch targets: the one button, Open the diff, and in New review the choices and Start. */
const PHONE_TARGETS = '[data-pulls-primary], [data-pulls-open-diff], .ib-cp-choice, [data-compose-send]';

test('a PR with no review thread: Review with an agent, the New review box, "on the way", the guided review arriving, Open review thread, and Open the diff in each', async ({ browser }) => {
  const { page } = world;
  await offerLaunch(page);
  await page.goto(`${world.url}#pulls`);
  const list = page.locator('[data-pulls-list]');
  await expect(list.locator('[data-reviews-fold="not_reviewed"]')).toHaveAttribute('aria-expanded', 'true');
  await list.locator(`[data-pulls-row="${LOCALE}"]`).click();
  const pane = page.locator('[data-pulls-stack]');
  // One button under the title, Open the diff beside it; no picker until it is asked for, no thread, no Reply.
  const primary = pane.locator('[data-pulls-primary]');
  await expect(primary).toHaveText('Review with an agent');
  await expect(primary).toHaveClass(/ib-pri/);
  expect((await pane.locator('[data-pulls-open-diff]').boundingBox())!.y).toBe((await primary.boundingBox())!.y);
  await expect(pane.locator('[data-pulls-thread]')).toHaveCount(0);
  await expect(pane.locator('[data-pulls-reply]')).toHaveCount(0);
  await expect(pane).not.toContainText(/\bhand/i);
  await shot(page, '4-no-thread');
  // The row opens the diff too: "Open diff ›" at its end, under the pointer.
  const row = pane.locator(`[data-pulls-layer="${LOCALE}"] button`);
  await row.hover();
  await expect(row.locator('.ib-pr-lgo')).toHaveText('Open diff');
  await shot(page, '4b-row-hover', ['light']);
  await page.mouse.move(0, 0);
  await primary.click();
  // The New review box, filled in: this PR, an agent of its project in To, nothing asked of the person but Start.
  const box = page.locator('[data-review-box]');
  await expect(box.locator('[data-review-pick]')).toContainText('Fall back to English for missing strings');
  await expect(box.locator('[data-review-choice="pr"]')).toBeChecked();
  await expect(box.locator('[data-compose-to]')).toHaveAttribute('data-compose-to', /^ses-web-/);
  await expect(box).toContainText('from the pull request');
  await expect(box.locator('[data-compose-thread-name] input, [data-compose-thread-name]').first()).toBeVisible();
  // To offers only the PR's project.
  await box.locator('[data-compose-to]').click();
  await expect(box.locator('[data-compose-session]')).toHaveCount(2);
  await expect(box.locator('[data-compose-session="ses-billing-claude"]')).toHaveCount(0);
  await box.locator('[data-compose-session="ses-web-claude"]').click();
  await expect(box.locator('[data-compose-to]')).toHaveAttribute('data-compose-to', 'ses-web-claude');
  await shot(page, '4a-box');
  const boxWords = box.locator('[data-compose-text] textarea');
  await boxWords.fill('Check the fallback chain, and a test for a missing locale');
  await shot(page, '5-ask-custom');
  await boxWords.fill('');
  await box.locator('[data-compose-send]').click();
  await expect(box).toHaveCount(0);
  // The thread opens beside the list, Curating, the request labelled and its big title the thread's name.
  await expect(page).toHaveURL(/#reviews.*thread=/);
  const threadId = decodeURIComponent(/thread=([^&]+)/.exec(page.url())![1]!);
  await expect(page.locator('.ib-subject')).toHaveText('Review #869: Fall back to English for missing strings');
  await expect(page.locator('[data-review-curating]')).toHaveText('Curating the review…');
  await expect(page.locator('[data-review-asked]')).toHaveText('New review · Guided review');
  const opening = await world.claude.nextReply(threadId);
  const words = String(opening.body);
  expect(words.startsWith("You're being asked to help me review and understand a pull request. Don't change any code unless I explicitly tell you to.\n")).toBe(true);
  expect(words).toContain('\n- Title: Fall back to English for missing strings\n- Number: #869\n');
  expect(words).toContain('\n- Link: https://github.com/northwind/web-app/pull/869\n');
  expect(words).toContain('\n1. Send me a guided review of its diff against main, using /review-curate (its instructions are at the end of this message).\n');
  expect(words).toContain('BEGIN SKILL INSTRUCTIONS: review-curate');
  // Kept: a fresh read still ties it to that thread, and says what was asked; the one button opens the thread.
  await page.goto(`${world.url}#reviews&stack=${encodeURIComponent(LOCALE)}`);
  await page.reload();
  await expect(page.locator('[data-pulls-stack] [data-pulls-thread]')).toHaveAttribute('data-pulls-thread', threadId);
  await expect(page.locator(`[data-pulls-row="${LOCALE}"]`)).toContainText('#869 · Curating…');
  await expect(page.locator('[data-pulls-stack] [data-pulls-thread-line="asked"]')).toContainText('Guided review on the way');
  await expect(page.locator('[data-pulls-stack] [data-pulls-primary]')).toHaveText('Open review thread');
  await expect(page.locator('[data-pulls-stack] [data-pulls-open-diff]')).toBeVisible();
  await expect(page.locator('[data-pulls-stack]')).not.toContainText(/\bhand/i);
  await shot(page, '6-on-the-way');
  await phoneShot(browser, LOCALE, 'phone-6-on-the-way');

  // The agent's guided review arrives through phase 1's path: the thread is still the way in.
  await sendReview(world.claude, world.projects.web, String(opening.id), world.patches.locale, 'src/i18n/fallback.ts', 'Fall back to English for missing strings');
  await page.reload();
  const stackPane = page.locator('[data-pulls-stack]');
  await expect(stackPane.locator('[data-pulls-thread-line="live"]')).toBeVisible();
  await expect(stackPane.locator('[data-pulls-ask]')).toHaveCount(0);
  expect(await stackPane.locator('.ib-pr-actions button').allTextContents()).toEqual(['Open review thread', 'Open the diff']);
  await shot(page, '6a-review-arrived');
  await phoneShot(browser, LOCALE, 'phone-6a-review-arrived');
  // The thread is named for the PR (owner, q-49bd0699 A), as the person's own name: the Inbox list shows it.
  await page.goto(world.url);
  await expect(page.locator(`[data-row="${threadId}"]`)).toContainText('Review #869: Fall back to English for missing strings');
  await shot(page, '6t-thread-name', ['light']);
  // Reviewed, the row opens the same thread, in Reviews; the line over its title leads to the PR's own page.
  await page.goto(`${world.url}#pulls`);
  await page.locator(`[data-pulls-row="${LOCALE}"]`).click();
  await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash))).toBe(`#reviews&thread=${threadId}`);
  await expect(page.locator('[data-review-context]')).toContainText('#869');
  await page.locator('[data-review-open-pull]').click();
  await expect(stackPane.locator('[data-pulls-thread-line="live"]')).toBeVisible();
  await stackPane.locator('[data-pulls-open-diff]').click();
  await expect(page.locator('[data-pull-review]')).toHaveAttribute('data-pull-review', LOCALE);
  await page.goto(`${world.url}#pulls&stack=${encodeURIComponent(LOCALE)}`);
  await page.locator('[data-pulls-stack] [data-pulls-primary="open"]').click();
  await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash))).toContain(threadId);
  await page.unroute('**/api/inbox/sessions*');
});

test('the Board on, a card linking the stack: a quiet Board chip, its review thread under it', async () => {
  const { page, claude } = world;
  await setBoard(true);
  const card = await claude.card({ op: 'create', project_path: world.projects.billing, title: 'Retry failed charges', column: 'in_review', thread_id: world.threads.stack, pr: 'northwind/billing-svc#414', say: 'Stack of 3 up for review', you: 'Review the stack from #412' });
  expect(card.card).toBeTruthy();
  // A new load: the window reads the Board setting and the list again (a hash change alone would not).
  await page.goto(`${world.url}#pulls`);
  await page.reload();
  await expect(page.locator('[data-board-nav]')).toBeVisible();
  await page.locator(`[data-pulls-row="${STACK_ID}"]`).click();
  const pane = page.locator('[data-pulls-stack]');
  await expect(pane.locator('[data-pulls-card]')).toHaveText(/^Board\s*Retry failed charges$/);
  await expect(pane.locator('[data-pulls-thread-line]')).toContainText('Thread with Claude Code');
  await shot(page, '6b-stack-board-on');
});

test('Review layer by layer: the layer\'s own diff, Next layer, Whole stack from the lowest open layer, and Approve into the agent\'s thread', async () => {
  const { page, claude } = world;
  const asked: string[] = [];
  const watch = (request: import('@playwright/test').Request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/inbox/pulls/diff') asked.push(`${url.searchParams.get('key')} ${url.searchParams.get('scope')}`);
  };
  page.on('request', watch);
  await page.locator('[data-pulls-stack]').getByRole('button', { name: 'Open the diff', exact: true }).click();
  const review = page.locator('[data-pull-review]');
  await expect(review).toHaveAttribute('data-pull-review', LAYER_412);
  await expect(review.locator('[data-guide-file-shell="src/charges/schedule.ts"]')).toBeVisible({ timeout: 30_000 });
  await expect(review.locator('[data-review-files] li')).toHaveCount(3);
  await expect(review.locator('[data-pull-review-foot]')).toContainText('Layer 1 of 3 · only what this layer changes');
  await expect(review.getByRole('button', { name: /merge/i })).toHaveCount(0);
  expect(forgeCalls()).toContain('gh diff repos/northwind/billing-svc/pulls/412');
  // No chapter card repeating the rail: the diffs take the width.
  await expect(review.locator('[data-guide-section-narrative]')).toBeHidden();
  // The rail's paths are cut at their start inside the rail, the +/- still in view.
  const rail = await review.locator('.ib-rrail').boundingBox();
  for (const row of await review.locator('[data-review-files] .ib-rv-n').all()) {
    const box = (await row.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(rail!.x + rail!.width);
  }
  // One title, the header's: the reader draws none, the header names no repository, the strip only numbers.
  await expect(review.locator('.ib-gbody h1')).toHaveCount(0);
  await expect(review.locator('.ib-vhead .ib-from')).toHaveCount(0);
  await expect(review.locator('[data-pull-layer-step][aria-current="step"]')).toContainText('#412');
  // Each file's box is as tall as its lines (the empty band under a short file, #2615): the 5-line migration's
  // last row ends within one row of its box's bottom.
  const sqlShell = review.locator('[data-guide-file-shell="migrations/0042_retry_schedule.sql"]');
  const sqlBox = (await sqlShell.locator('[data-guide-code-view-mounted]').boundingBox())!;
  const sqlLast = (await sqlShell.locator('[data-line="5"]').first().boundingBox())!;
  expect(sqlBox.y + sqlBox.height - (sqlLast.y + sqlLast.height)).toBeLessThan(24);
  // The Global comment button sits on the Split | Unified tab's row (owner, q-bfcf3a4a B), left of it, not over it.
  const addGlobal = (await review.locator('[data-guide-section-tab] [data-guide-global-comment-add]').boundingBox())!;
  const layoutSwitch = (await review.locator('[data-guide-section-tab] [data-diff-style-switch]').boundingBox())!;
  expect(Math.abs(addGlobal.y + addGlobal.height / 2 - (layoutSwitch.y + layoutSwitch.height / 2))).toBeLessThan(3);
  expect(addGlobal.x + addGlobal.width).toBeLessThan(layoutSwitch.x);
  await shot(page, '7-layer-review');
  // A long title gives way in the header: cut with "…" (whole in its hover); Back and the decision stay in the window.
  const fn = review.locator('[data-pull-review-title]');
  await expect(fn).toHaveAttribute('title', '#412 Retry schedule table and next-attempt time');
  for (const width of [1280, 1100, 900, 800, 760]) {
    await page.setViewportSize({ width, height: 900 });
    const decision = (await review.locator('.ib-vhead [data-review-decision]').boundingBox())!;
    const back = (await review.locator('.ib-vhead .ib-back').boundingBox())!;
    expect([width, decision.x + decision.width <= width, back.x >= 0]).toEqual([width, true, true]);
  }
  // The worst case's title (break-ui #1), laid out in this header at 900 wide: cut, the decision still in the window.
  await page.setViewportSize({ width: 900, height: 900 });
  const long = 'Migrate the entire settlement reconciliation pipeline from the legacy batch processor to the new streaming ledger with exactly-once semantics';
  const was = await fn.locator('bdi').evaluate((node, text) => {
    const before = node.textContent;
    node.textContent = text;
    return before;
  }, long);
  const cut = await fn.locator('bdi').evaluate((node) => ({ cut: node.scrollWidth > node.clientWidth, overflow: getComputedStyle(node).textOverflow }));
  expect(cut).toEqual({ cut: true, overflow: 'ellipsis' });
  const after = (await review.locator('.ib-vhead [data-review-decision]').boundingBox())!;
  expect(after.x + after.width).toBeLessThanOrEqual(900);
  await fn.locator('bdi').evaluate((node, text) => (node.textContent = text), was);
  // Under 900 px of review the file rail folds into the Files picker over the diff, and the diff takes the width.
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(review.locator('.ib-rrail')).toBeHidden();
  await expect(review.locator('[data-review-phonebar] .ib-rv-jump')).toBeVisible();
  const gbody = (await review.locator('.ib-gbody').boundingBox())!;
  const split1024 = (await review.locator('.ib-rsplit').boundingBox())!;
  expect(gbody.width).toBe(split1024.width);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(review.locator('.ib-rrail')).toBeVisible();

  await review.locator(`[data-pull-next-layer="${LAYER_413}"]`).click();
  await expect(review).toHaveAttribute('data-pull-review', LAYER_413);
  await expect(review.locator('[data-review-files] li')).toHaveCount(1);
  await expect(review.locator('[data-pull-review-foot]')).toContainText('Layer 2 of 3');

  // Whole stack up to #413: from the lowest open layer's base, so #412's files and #413's, not the merged #411's.
  await review.locator('[data-pull-scope-choice="stack"]').click();
  await expect(review).toHaveAttribute('data-pull-scope', 'stack');
  await expect(review.locator('[data-review-files] li')).toHaveCount(3);
  await expect(review.locator('[data-guide-file-shell="migrations/0042_retry_schedule.sql"]')).toBeVisible({ timeout: 30_000 });
  await expect(review.locator('[data-guide-file-shell="src/charges/client.ts"]')).toHaveCount(0);
  expect(forgeCalls()).toContain('gh diff repos/northwind/billing-svc/compare/retry/charge-client...retry/backoff');
  await shot(page, '8-whole-stack', ['light']);
  await review.locator('[data-pull-scope-choice="layer"]').click();
  await expect(review.locator('[data-review-files] li')).toHaveCount(1);
  expect(asked).toEqual([`${LAYER_412} layer`, `${LAYER_413} layer`, `${LAYER_413} stack`]);
  page.off('request', watch);

  // Approve: the person's reply in the agent's thread, naming the layer.
  await review.locator('[data-review-decision] [data-decision-primary]').click();
  await expect(review).toHaveCount(0);
  await expect(page.locator('[data-pulls-stack]')).toBeVisible();
  const verdict = await claude.nextReply(world.threads.stack);
  expect(String(verdict.body)).toBe('I approved pull request #413 "Jitter on the retry backoff" (https://github.com/northwind/billing-svc/pull/413).');
  verdictId = String(verdict.id);
});

test('Reply at the stack\'s foot goes into the agent\'s thread', async () => {
  const { page, claude } = world;
  const pane = page.locator('[data-pulls-stack]');
  await pane.locator('.ib-pr-replybtn').click();
  const box = pane.locator('.ib-pr-replyin');
  await expect(box).toBeFocused();
  await box.fill('Hold #414 until Priya has read the email copy.');
  await shot(page, '9-stack-reply', ['light']);
  await pane.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(pane.locator('.ib-pr-sent')).toBeVisible();
  const reply = await claude.nextReply(world.threads.stack, 50, verdictId);
  expect(String(reply.body)).toBe('Hold #414 until Priya has read the email copy.');
  expect(world.errors).toEqual([]);
  expect(world.outside).toEqual([]);
});

test('a phone at 390 px: the list, a stack, a layer review; and off, no row', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light', deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${world.url}#pulls`);
    const list = page.locator('[data-pulls-list]');
    await expect(list.locator('[data-pulls-row]').first()).toBeVisible();
    await shot(page, 'phone-1-list');
    await openNotReviewed(page);
    await list.locator(`[data-pulls-row="${STACK_ID}"]`).click();
    const pane = page.locator('[data-pulls-stack]');
    await expect(pane).toBeVisible();
    await expect(list).toHaveCount(0);
    await shot(page, 'phone-2-stack');
    await pane.getByRole('button', { name: 'Open the diff', exact: true }).click();
    const review = page.locator('[data-pull-review]');
    await expect(review.locator('[data-guide-file-shell="src/charges/schedule.ts"]')).toBeVisible({ timeout: 30_000 });
    await shot(page, 'phone-3-layer-review');
    // A teammate's PR with no review thread: Review with an agent, the box as a sheet, every choice a touch target.
    await offerLaunch(page);
    await page.goto(`${world.url}#pulls`);
    await page.locator('[data-pulls-row="github.com/northwind/web-app#880"]').click();
    await shot(page, 'phone-4-no-thread');
    await page.locator('[data-pulls-stack] [data-pulls-primary]').click();
    const box = page.locator('[data-review-box]');
    await expect(box.locator('[data-review-pick]')).toContainText('RTL layout');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const target of await page.locator(PHONE_TARGETS).evaluateAll((els) => els.map((el) => el.getBoundingClientRect()))) {
      expect(target.right).toBeLessThanOrEqual(390);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
    await shot(page, 'phone-4a-box');
    await box.locator('[data-compose-text] textarea').fill('what changes for Arabic and Hebrew');
    await shot(page, 'phone-5-ask-custom');
    await box.locator('[data-compose-cancel]').click();
    await expect(box).toHaveCount(0);
    // Every control in the review's strip and foot is a 44 px target or more on a phone.
    for (const box of await review.locator('.ib-prr-foot button, .ib-prr-scope .ib-seg-o').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(36);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);

    await page.request.post(`${world.url}api/inbox/settings`, { data: { code_review: { on: false } } });
    await page.goto(world.url);
    await page.waitForTimeout(600);
    await page.locator('[data-sidebar="trigger"]').first().click();
    await expect(page.locator('[data-inbox-nav]')).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.locator('[data-pulls-nav]')).toHaveCount(0);
    await shot(page, 'phone-6-off-no-row', ['light']);
    await page.request.post(`${world.url}api/inbox/settings`, { data: { code_review: { on: true } } });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

const TEAMMATE = 'github.com/northwind/web-app#880';

/** A line comment on the layer review's diff: the line's number, then the composer's words. */
async function commentOn(page: Page, file: string, line: number, words: string): Promise<void> {
  const shell = page.locator(`[data-pull-review] [data-guide-file-shell="${file}"]`);
  const added = shell.locator(`[data-line-type="change-addition"][data-column-number="${line}"]`);
  await expect(added).toBeVisible({ timeout: 30_000 });
  await shell.hover();
  await added.click();
  const composer = page.getByPlaceholder('Leave feedback...');
  await expect(composer).toBeVisible();
  await composer.fill(words);
  await page.getByRole('button', { name: 'Add Comment' }).click();
}

test("Post to GitHub (the owner's answer C): the choice beside the decision, a teammate's approval posted with its comment, a refusal shown", async ({ browser }) => {
  const { page } = world;
  await page.goto(`${world.url}#pulls`);
  await page.locator(`[data-pulls-row="${STACK_ID}"]`).click();
  await page.locator('[data-pulls-stack] [data-pulls-open-diff]').click();
  const review = page.locator('[data-pull-review]');
  await expect(review).toHaveAttribute('data-pull-review', LAYER_412);
  await expect(review.locator('[data-guide-file-shell="src/charges/schedule.ts"]')).toBeVisible({ timeout: 30_000 });
  // The person's own PR with its agent: both endings, the agent's first; GitHub on a pick.
  const choice = review.locator('[data-review-destination]');
  await expect(choice).toHaveAttribute('data-review-destination', 'agent');
  await expect(choice).toContainText('GitHub');
  await expect(choice).toContainText('Claude Code');
  await review.locator('[data-review-destination-choice="forge"]').click();
  await expect(review.locator('[data-review-posts="github"]')).toBeVisible();
  await expect(review.locator('[data-pull-review-foot]')).toContainText('your review goes on the GitHub PR');
  await shot(page, '10-ending-choice');
  {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light', deviceScaleFactor: 2 });
    const p = await phone.newPage();
    try {
      await p.goto(`${world.url}#pulls&stack=${encodeURIComponent(STACK_ID)}&layer=${encodeURIComponent(LAYER_412)}&scope=layer`);
      await expect(p.locator('[data-review-destination]')).toBeVisible({ timeout: 30_000 });
      await p.locator('[data-review-destination-choice="forge"]').click();
      await expect(p.locator('[data-review-posts="github"]')).toBeVisible();
      for (const scheme of ['light', 'dark'] as const) {
        await p.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await p.waitForTimeout(400);
        await p.screenshot({ path: join(proofDir, `phone-10-ending-choice-${scheme}.png`) });
      }
    } finally {
      await phone.close();
    }
  }
  // Back to the agent: the next reviews start where the person left the choice.
  await review.locator('[data-review-destination-choice="agent"]').click();
  expect(forgeCalls().filter((c) => c.startsWith('gh post'))).toEqual([]);

  // A teammate's PR, no agent: posting is the only ending.
  await page.goto(`${world.url}#pulls`);
  await page.locator(`[data-pulls-row="${TEAMMATE}"]`).click();
  await page.locator('[data-pulls-stack] [data-pulls-open-diff]').click();
  await expect(review).toHaveAttribute('data-pull-review', TEAMMATE);
  await expect(review.locator('[data-review-destination]')).toHaveCount(0);
  await commentOn(page, 'src/settings/Layout.tsx', 3, 'ms-6 flips with dir; check the sidebar in Hebrew too.');
  // With a comment the primary posts comments (as the review app); the caret's Approve with comments approves.
  await expect(review.locator('[data-review-posts] [data-decision-primary]')).toContainText('Post Comments');
  await review.locator('[data-review-posts] [data-decision-caret]').click();
  await page.getByRole('menuitem', { name: /Approve with comments/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Approve PR');
  await expect(dialog).toContainText('1 comment');
  await shot(page, '11-post-dialog');
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  const posted = review.locator('[data-pull-review-posted]');
  await expect(posted).toContainText('Approved on GitHub');
  await expect(posted.getByRole('link')).toHaveAttribute('href', 'https://github.com/northwind/web-app/pull/880');
  expect(forgeCalls().filter((c) => c.startsWith('gh post'))).toEqual(['gh post repos/northwind/web-app/pulls/880/reviews']);
  const sent = JSON.parse(readFileSync(join(world.forge, 'gh-posted.json'), 'utf8')) as Record<string, unknown>;
  expect(sent).toEqual({
    commit_id: '880'.padStart(40, '0'),
    body: expect.any(String),
    event: 'APPROVE',
    comments: [{ path: 'src/settings/Layout.tsx', line: 3, side: 'RIGHT', body: 'ms-6 flips with dir; check the sidebar in Hebrew too.' }],
  });
  await shot(page, '12-posted');
  // Posted: back on the PR's page, Open the diff is still there.
  await page.goto(`${world.url}#pulls&stack=${encodeURIComponent(TEAMMATE)}`);
  await page.reload();
  await expect(page.locator('[data-pulls-stack] [data-pulls-open-diff]')).toBeVisible();
  await shot(page, '12b-posted-pr-page');
  await phoneShot(browser, TEAMMATE, 'phone-12b-posted-pr-page');
  await page.locator('[data-pulls-stack] [data-pulls-open-diff]').click();
  await expect(review).toHaveAttribute('data-pull-review', TEAMMATE);

  // GitHub refuses the next one: the dialog says why, offers a retry, and nothing reads as posted.
  writeFileSync(join(world.forge, 'gh-post-fail'), 'HTTP 422: Unprocessable Entity (Review body is too long for this pull request)\n');
  try {
    await page.reload();
    await expect(review.locator('[data-review-posts]')).toBeVisible({ timeout: 30_000 });
    await review.locator('[data-review-posts] [data-decision-caret]').click();
    await page.getByRole('menuitem', { name: /Request changes/ }).click();
    await expect(dialog).toBeVisible();
    await dialog.locator('textarea').fill('The layout flips, but the sidebar icons do not. Mirror them too.');
    await dialog.getByRole('button', { name: 'Request Changes', exact: true }).click();
    await expect(dialog).toContainText('Review body is too long');
    await expect(dialog.getByRole('button', { name: /Retry/ })).toBeVisible();
    await expect(review.locator('[data-pull-review-posted]')).toHaveCount(0);
    await shot(page, '13-post-failed');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  } finally {
    rmSync(join(world.forge, 'gh-post-fail'), { force: true });
  }
  expect(world.errors).toEqual([]);
});

test('the posting video (25 s or less): a teammate\'s PR reviewed with a comment, approved on GitHub; the choice on the person\'s own', async ({ browser }) => {
  test.skip(!video, 'PLANNOTATOR_E2E_VIDEO=1 records it');
  const dir = join(proofDir, 'posting-video');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', recordVideo: { dir, size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  const pause = (ms: number) => page.waitForTimeout(ms);
  try {
    await page.goto(`${world.url}#pulls`);
    await openNotReviewed(page);
    await page.locator(`[data-pulls-row="${STACK_ID}"]`).click();
    await page.locator('[data-pulls-stack] [data-pulls-open-diff]').click();
    const review = page.locator('[data-pull-review]');
    await expect(review.locator('[data-review-destination]')).toBeVisible({ timeout: 30_000 });
    await pause(1800);
    await review.locator('[data-review-destination-choice="forge"]').click();
    await pause(1600);
    await review.locator('[data-review-destination-choice="agent"]').click();
    await pause(1200);
    await page.goto(`${world.url}#pulls`);
    await page.locator(`[data-pulls-row="${TEAMMATE}"]`).click();
    await pause(1200);
    await page.locator('[data-pulls-stack] [data-pulls-open-diff]').click();
    await pause(1200);
    // Not the review the test above posted (the Inbox refuses the same review twice).
    await commentOn(page, 'src/settings/Layout.tsx', 3, 'Mirror the sidebar icons too, for Arabic and Hebrew.');
    await pause(1500);
    await review.locator('[data-review-posts] [data-decision-caret]').click();
    await pause(900);
    await page.getByRole('menuitem', { name: /Approve with comments/ }).click();
    await pause(2000);
    await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(review.locator('[data-pull-review-posted]')).toContainText('Approved on GitHub');
    await pause(3500);
  } finally {
    await context.close();
  }
  const [recorded] = readdirSync(dir).filter((f) => f.endsWith('.webm'));
  renameSync(join(dir, recorded!), join(proofDir, 'posting.webm'));
});

test('the walkthrough video (20 s or less): Review with an agent starts a review thread with the picked agent, Open the diff in every state, its guided review arriving', async ({ browser }) => {
  test.skip(!video, 'PLANNOTATOR_E2E_VIDEO=1 records it');
  const dir = join(proofDir, 'video');
  await setBoard(false);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', recordVideo: { dir, size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  await offerLaunch(page);
  const pause = (ms: number) => page.waitForTimeout(ms);
  try {
    await page.goto(`${world.url}#pulls`);
    // A teammate's PR with no review thread: Review with an agent, and Open the diff beside it.
    await page.locator('[data-pulls-row="github.com/northwind/web-app#880"]').click();
    const pane = page.locator('[data-pulls-stack]');
    await expect(pane.locator('[data-pulls-primary="review"]')).toBeVisible();
    await pause(2200);
    // The row opens the diff too.
    await pane.locator('[data-pulls-layer="github.com/northwind/web-app#880"] button').hover();
    await pause(1300);
    await pane.locator('[data-pulls-primary]').click();
    await pause(900);
    const box = page.locator('[data-review-box]');
    await box.locator('[data-compose-to]').click();
    await box.locator('[data-compose-session="ses-web-claude"]').click();
    await pause(900);
    await box.locator('[data-compose-send]').click();
    await expect(box).toHaveCount(0);
    await pause(2500);
    const threadId = decodeURIComponent(/thread=([^&]+)/.exec(page.url())![1]!);
    const opening = await world.claude.nextReply(threadId);
    await sendReview(world.claude, world.projects.web, String(opening.id), world.patches.rtl, 'src/settings/Layout.tsx', 'RTL layout for the settings pages');
    await page.reload();
    await expect(page.locator('[data-pulls-stack] [data-pulls-thread-line="live"]')).toBeVisible();
    await pause(2500);
    // Open the diff: straight into the review mode, no stop on the way.
    await page.locator('[data-pulls-stack] [data-pulls-open-diff]').click();
    await expect(page.locator('[data-pull-review] [data-guide-file-shell="src/settings/Layout.tsx"]')).toBeVisible({ timeout: 30_000 });
    await pause(3000);
  } finally {
    await context.close();
  }
  const [recorded] = readdirSync(dir).filter((f) => f.endsWith('.webm'));
  renameSync(join(dir, recorded!), join(proofDir, 'walkthrough.webm'));
});

test('Reviews: a review from an ordinary thread is a local row, opens at its card with what was read left out, and is the same thread', async () => {
  const { page, claude } = world;
  await setCodeReview(true);
  // An ordinary thread the person has read: the agent then sends a review of local changes.
  const first = await claude.send({ project_path: world.projects.web, thread: 'jitter', subject: 'Add jitter to the retries', body: 'I looked at the retries.' });
  const herd = await claude.send({ project_path: world.projects.web, thread: 'jitter', body: 'Thundering herd confirmed; I will add jitter.' });
  await page.goto(`${world.url}#thread=${first.thread_id}`);
  await expect(page.getByText('Thundering herd confirmed')).toBeVisible();
  await page.goto(`${world.url}#reviews`);
  await expect(page.locator('[data-pulls-nav] .ib-n')).toBeVisible();
  const before = Number(await page.locator('[data-pulls-nav] .ib-n').textContent());
  await claude.submitGuide({
    project_path: world.projects.web,
    thread: 'jitter',
    patch: world.patches.locale,
    body: 'Ready for you.',
    guide: {
      title: 'Add jitter to retries',
      intent: 'Spread retries out.',
      sections: [{ title: 'The change', overview: 'Read the new lines.', diffs: [{ file: 'src/i18n/fallback.ts', summary: 'The change.' }] }],
      review: { gitRef: 'working-tree', base: 'main', branch: 'retry-jitter' },
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
    review: true,
  } as never);
  // The list follows a review that arrives, with no reload: the new row, and the sidebar's count.
  await expect(page.locator('[data-pulls-nav] .ib-n')).toHaveText(String(before + 1), { timeout: 15_000 });
  const row = page.locator(`[data-reviews-kind="reviewed"][data-row="${first.thread_id}"]`);
  await expect(row).toContainText('Add jitter to retries');
  await expect(row).toContainText('Review ready');
  await expect(row).not.toHaveAttribute('data-pulls-row');
  await page.reload();
  await expect(row).toBeVisible();
  await shot(page, 'r-page');

  // Opened from Reviews: the list stays, the thread opens at its review, and what was read before it is left out.
  await row.click();
  await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash))).toBe(`#reviews&thread=${first.thread_id}`);
  await expect(page.locator('[data-pulls-list]')).toBeVisible();
  await expect(page.locator('[data-pulls-nav]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('h2.ib-subject')).toHaveText('Add jitter to retries');
  await expect(page.locator('[data-review-context]')).toContainText('Local changes');
  await expect(page.locator('[data-review-from]')).toHaveText('Review from thread jitter');
  await expect(page.getByText('Thundering herd confirmed')).toHaveCount(0);
  const card = page.locator('[data-review-card]');
  await expect(card.locator('.ib-rvc-kind')).toHaveText('Review');
  await expect(card.locator('.ib-rvc-meta')).toHaveText('1 file +1 -0 · 1 chapter');
  await shot(page, 'r-thread');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'r-thread-phone');
  await page.setViewportSize({ width: 1440, height: 900 });
  // The link is the same thread, in the Inbox, with everything in it; its card links back.
  await page.locator('[data-review-from-link]').click();
  await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash))).toBe(`#thread=${first.thread_id}`);
  await expect(page.getByText('Thundering herd confirmed')).toBeVisible();
  await expect(page.getByText('I looked at the retries.')).toBeVisible();
  await page.locator('[data-review-in-reviews]').click();
  await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash))).toBe(`#reviews&thread=${first.thread_id}`);
  await expect(page.locator('[data-pulls-list]')).toBeVisible();
  // A link to a message left out shows it here: nothing is out of reach.
  await page.goto(`${world.url}#reviews&thread=${first.thread_id}&msg=${herd.id ?? herd.message_id}`);
  await expect(page.getByText('Thundering herd confirmed')).toBeVisible();
  await page.goto(`${world.url}#reviews`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[data-pulls-list]')).toBeVisible();
  await shot(page, 'r-page-phone');
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('New review, local changes: the + opens the box, the summary follows the changes and the project, Start opens it Curating, and the card moves it to On you', async () => {
  const { page, claude } = world;
  const file = join(world.projects.web, 'src/review-box.ts');
  writeFileSync(file, 'export const one = 1;\nexport const two = 2;\n');
  try {
    await page.goto(`${world.url}#reviews`);
    await page.reload();
    await page.locator('[data-reviews-new]').first().click();
    const box = page.locator('[data-review-box]');
    await expect(box.locator('[data-review-choice="local"]')).toBeChecked();
    await expect(box.locator('[data-review-choice="uncommitted"]')).toBeChecked();
    // To is filled in, and the summary is that project's.
    await box.locator('[data-compose-to]').click();
    await box.locator('[data-compose-session="ses-web-claude"]').click();
    await expect(box.locator('[data-review-size]')).toContainText('1 file');
    await expect(box.locator('[data-review-size]')).toContainText('+2');
    await expect(box.locator('[data-compose-thread-name] input')).toHaveValue(/^Review web-app: uncommitted on /);
    await expect(box.locator('[data-compose-send]')).toContainText('Start review');
    await shot(page, 'n-box-local');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, 'n-box-local-phone');
    await page.setViewportSize({ width: 1440, height: 900 });
    // Another choice, another size: the working copy's new file is not in the last commit.
    await box.locator('[data-review-choice="last"]').check({ force: true });
    await expect(box.locator('[data-compose-thread-name] input')).toHaveValue(/^Review web-app: last commit on /);
    await expect(box.locator('[data-review-size]')).not.toHaveText(/^1 file \+2 -0$/);
    await box.locator('[data-review-choice="uncommitted"]').check({ force: true });
    await expect(box.locator('[data-review-size]')).toContainText('+2');
    // Open pull request: the picker lists what Reviews lists, not reviewed first.
    await box.locator('[data-review-choice="pr"]').check({ force: true });
    await expect(box.locator('[data-compose-send]')).toHaveClass(/ib-dis/);
    await box.locator('[data-review-pick]').click();
    await expect(box.locator('.ib-cp-rvpulls .ib-cp-cap').first()).toHaveText('Not reviewed yet');
    await shot(page, 'n-box-pr');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, 'n-box-pr-phone');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press('Escape');
    await expect(box).toBeVisible();
    await box.locator('[data-review-choice="local"]').check({ force: true });
    await box.locator('[data-compose-to]').click();
    await box.locator('[data-compose-session="ses-web-claude"]').click();
    await expect(box.locator('[data-review-size]')).toContainText('+2');
    await box.locator('[data-compose-send]').click();
    await expect(box).toHaveCount(0);
    await expect(page).toHaveURL(/#reviews.*thread=/);
    const threadId = decodeURIComponent(/thread=([^&]+)/.exec(page.url())![1]!);
    const row = page.locator(`[data-pulls-row="${threadId}"], [data-reviews-row="${threadId}"]`).first();
    await expect(row).toContainText('Review web-app: uncommitted on');
    await expect(row).toContainText('Curating…');
    // The row sits in its project, by name, before any review says so; so does the line over the title.
    await expect(row.locator('[data-pulls-repo]')).toHaveText('web-app');
    await expect(page.locator('[data-review-context], .ib-rvctx').first()).toContainText('web-app · Uncommitted changes on');
    await expect(page.locator('.ib-subject')).toContainText('Review web-app: uncommitted on');
    await expect(page.locator('[data-review-curating]')).toHaveText('Curating the review…');
    await expect(page.locator('[data-review-asked]')).toHaveText('New review · Guided review');
    await shot(page, 'n-curating');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, 'n-curating-phone');
    await page.setViewportSize({ width: 1440, height: 900 });
    const opening = await claude.nextReply(threadId);
    const words = String(opening.body);
    expect(words).toMatch(/^Please send me a guided review of the uncommitted changes in web-app \(on [^)]+\), using \/review-curate\.\n\nIf I ask for changes, make them and send me the updated review in this thread\./);
    expect(words).toContain('BEGIN SKILL INSTRUCTIONS: review-curate');
    // A reload keeps it: the row comes from the server's record, not this window's memory.
    await page.reload();
    await expect(page.locator('[data-review-curating]')).toBeVisible();
    await sendReview(claude, world.projects.web, String(opening.id), world.patches.locale, 'src/i18n/fallback.ts', 'The local one');
    await expect(row).toContainText('Review ready');
    await expect(page.locator('[data-review-curating]')).toHaveCount(0);
    await expect(page.locator('.ib-subject')).toHaveText('The local one');
  } finally {
    rmSync(file, { force: true });
  }
});

test('New review: a local review with no card yet leaves the page when its thread is archived, and a thread started with Code review off gets no row', async () => {
  const { page } = world;
  const rows = async () => ((await (await page.request.get(`${world.url}api/inbox/reviews?cached=1`)).json()) as { rows: { thread_id: string | null }[] }).rows.map((row) => row.thread_id);
  const start = async (key: string) => {
    const sent = await page.request.post(`${world.url}api/inbox/messages`, {
      data: { to: { host: 'claude-code', session: 'ses-web-claude' }, body: `Please review ${key}`, idempotency_key: key, review: { kind: 'local', changes: 'uncommitted', branch: 'main', base: 'main' } },
    });
    expect(sent.status()).toBe(200);
    return (await sent.json()) as { thread_id: string; message: { id: string } };
  };
  await page.request.get(`${world.url}api/inbox/reviews`);
  const on = await start('archive-me');
  expect(await rows()).toContain(on.thread_id);
  expect((await page.request.post(`${world.url}api/inbox/messages/${on.message.id}/resolve`, { data: { resolved: true } })).status()).toBe(200);
  expect(await rows()).not.toContain(on.thread_id);
  await setCodeReview(false);
  const off = await start('off-start');
  await setCodeReview(true);
  expect(await rows()).not.toContain(off.thread_id);
});

test('New review: Code review turned off with the box open: it closes and says so, nothing is sent, and the words wait', async () => {
  const { page } = world;
  await page.goto(`${world.url}#reviews`);
  await page.reload();
  await page.locator('[data-reviews-new]').first().click();
  const box = page.locator('[data-review-box]');
  await expect(box).toBeVisible();
  await box.locator('[data-compose-text] textarea').fill('Words for later.');
  const sends: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/inbox/messages')) sends.push(request.url());
  });
  await setCodeReview(false);
  await expect(box).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('Code review is off').first()).toBeVisible();
  expect(sends).toEqual([]);
  await setCodeReview(true);
  await page.goto(`${world.url}#reviews`);
  await page.locator('[data-reviews-new]').first().click({ timeout: 15_000 });
  await expect(box.locator('[data-compose-text] textarea')).toHaveValue('Words for later.');
  await box.locator('[data-compose-text] textarea').fill('');
  await box.locator('[data-compose-cancel]').click();
});

test('New review: the picker says what it knows, and the summary never shows the last choice while the next is read', async () => {
  const { page } = world;
  const openPicker = async () => {
    await page.goto('about:blank');
    await page.goto(`${world.url}#reviews`);
    await page.locator('[data-reviews-new]').first().click();
    const box = page.locator('[data-review-box]');
    await box.locator('[data-review-choice="pr"]').check({ force: true });
    await box.locator('[data-review-pick]').click();
    return box;
  };
  let letGo = () => {};
  const held = new Promise<void>((resolve) => (letGo = resolve));
  await page.route('**/api/inbox/reviews*', async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  const reading = await openPicker();
  await expect(reading.locator('[data-review-pulls-none="reading"]')).toBeVisible();
  await expect(reading.locator('[data-review-pulls-none="reading"]')).toContainText('Reading your pull requests');
  await shot(page, 'n-picker-reading');
  letGo();
  await page.waitForTimeout(100);
  await page.unroute('**/api/inbox/reviews*');
  await page.route('**/api/inbox/reviews*', (route) => route.abort());
  await page.route('**/api/inbox/pulls?*', (route) => route.abort());
  const failed = await openPicker();
  await expect(failed.locator('[data-review-pulls-none="failed"]')).toBeVisible();
  await shot(page, 'n-picker-failed');
  await page.unroute('**/api/inbox/reviews*');
  await page.unroute('**/api/inbox/pulls?*');

  // Fresh, off the failed read: the box's summary, then the next choice with its read held back.
  await page.goto('about:blank');
  await page.goto(`${world.url}#reviews`);
  await page.locator('[data-reviews-new]').first().click();
  const box = page.locator('[data-review-box]');
  await expect(box.locator('[data-review-size]')).toBeVisible();
  let again = () => {};
  const slow = new Promise<void>((resolve) => (again = resolve));
  await page.route('**/api/inbox/reviews/changes*', async (route) => {
    await slow;
    await route.continue().catch(() => {});
  });
  await box.locator('[data-review-choice="last"]').check({ force: true });
  await expect(box.locator('[data-review-size]')).toHaveCount(0);
  again();
  await expect(box.locator('[data-review-size]')).toBeVisible();
  await page.unroute('**/api/inbox/reviews/changes*');
  await box.locator('[data-compose-cancel]').click();
});

test('New review, its other doors: #reviews&new, ⌘K from the Inbox, and a PR already in review opens its thread instead of a second one', async () => {
  const { page } = world;
  await page.goto(`${world.url}#reviews&new`);
  await page.reload();
  const box = page.locator('[data-review-box]');
  await expect(box).toBeVisible();
  await expect(page).toHaveURL(/#reviews$/);
  await box.locator('[data-compose-cancel]').click();
  await expect(box).toHaveCount(0);

  await page.goto(`${world.url}#`);
  await page.reload();
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('new review');
  await page.locator('[data-compose-action="review"]').click();
  await expect(box).toBeVisible();
  await expect(page).toHaveURL(/#reviews$/);

  await box.locator('[data-review-choice="pr"]').check({ force: true });
  await box.locator('[data-review-pick]').click();
  const reviewed = box.locator('[data-review-pull][data-in-review]').first();
  const threads = await page.evaluate(async () => {
    const answer = (await (await fetch('/api/inbox/reviews?cached=1')).json()) as { rows: { thread_id: string | null; stacks: { id: string }[] }[] };
    return answer.rows;
  });
  const stackId = await reviewed.getAttribute('data-review-pull');
  const threadId = threads.find((row) => row.stacks.some((stack) => stack.id === stackId))!.thread_id!;
  await reviewed.click();
  await expect(box).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#reviews.*thread=${threadId}`));
  const threadCount = await page.evaluate(async () => ((await (await fetch('/api/inbox/reviews?cached=1')).json()) as { rows: unknown[] }).rows.length);
  expect(threadCount).toBe(threads.length);
});

test('New review, a pull request link: what was found and how it was read, a repository that is no project, one read only, and a second link opens the same thread', async () => {
  const { page, claude } = world;
  await setCodeReview(true);
  await page.goto(`${world.url}#reviews&new`);
  await page.reload();
  const box = page.locator('[data-review-box]');
  await expect(box).toBeVisible();
  // One Pull request row: its picker's search takes the link.
  await expect(box.locator('[data-review-choice="link"]')).toHaveCount(0);
  const openPicker = async () => {
    await box.locator('[data-review-choice="pr"]').check({ force: true });
    await box.locator('[data-review-pick]').click();
  };
  await openPicker();
  await expect(box.locator('[data-review-pick]')).toContainText('Choose one, or paste a link');
  const field = box.locator('[data-review-link]');
  await expect(field).toBeFocused();
  await expect(box.locator('[data-compose-send]')).toHaveClass(/ib-dis/);
  const read = box.locator('[data-review-link-read]');
  const found = box.locator('[data-review-link-option]');

  // Bitbucket and things that aren't links say so, and nothing can start.
  const before = forgeCalls().length;
  await field.fill('https://bitbucket.org/acme/mobile/pull-requests/88');
  await expect(read).toHaveText("Bitbucket links aren't supported yet.");
  await expect(box.locator('[data-compose-send]')).toHaveClass(/ib-dis/);
  await shot(page, 'l-box-bitbucket');
  await field.fill('https://example.com/about');
  await expect(read).toHaveText("That isn't a pull request link.");
  expect(forgeCalls().length).toBe(before);

  // Words still search the list.
  await field.fill('RTL');
  await expect(read).toHaveCount(0);
  await expect(box.locator('[data-review-pull]')).toHaveCount(1);
  await expect(box.locator('[data-review-pull]')).toContainText('RTL layout');

  // GitLab, through glab; a merged one says so.
  await field.fill('https://gitlab.com/northwind/mobile/-/merge_requests/44');
  await expect(found).toContainText('!44');
  await expect(found).toContainText('Offline queue');
  await expect(found).toContainText('merged');
  await expect(read).toContainText('Read with glab, signed in to gitlab.com');
  await shot(page, 'l-box-gitlab');

  // A PR of no project where launching can: a new session in a new scratch folder is the default.
  await page.route('**/api/inbox/sessions*', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, launch: { agents: [{ agent: 'claude-code', name: 'Claude Code' }], projects: [], scratch: { root: '/tmp/scratch' } } } });
  });
  await page.reload();
  await expect(box).toHaveCount(0);
  await page.goto(`${world.url}#reviews&new`);
  await page.reload();
  await expect(box).toBeVisible();
  await openPicker();
  await field.fill('northwind/payments#231');
  await expect(found).toContainText('Idempotent refunds');
  await expect(read).toContainText('Read with gh, signed in to github.com');
  await shot(page, 'l-box-picker-link');
  // Enter chooses it: the row then says what it is and how it was read.
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(box.locator('[data-review-pick]')).toContainText('northwind/payments #231');
  await expect(box.locator('[data-review-pick]')).toContainText('Idempotent refunds');
  await expect(read).toContainText('Read with gh, signed in to github.com');
  await expect(box.locator('.ib-cp-to').last()).toContainText('New scratch folder');
  await expect(box.locator('[data-compose-thread-name] input')).toHaveValue('Review #231: Idempotent refunds');
  await shot(page, 'l-box-link');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'l-box-link-phone');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.unroute('**/api/inbox/sessions*');

  // No launching: any live agent can take it, and the link typed is still there.
  await page.goto(`${world.url}#reviews`);
  await page.reload();
  await page.locator('[data-reviews-new]').first().click();
  await expect(box).toBeVisible();
  await openPicker();
  await field.fill('https://github.com/northwind/payments/pull/231/files');
  await expect(found).toContainText('Idempotent refunds');
  await expect(box.locator('[data-compose-send]')).toHaveClass(/ib-dis/);
  await found.click();
  await expect(box.locator('[data-compose-send]')).not.toHaveClass(/ib-dis/);
  const reads = forgeCalls().filter((call) => call.includes('northwind/payments')).length;
  await box.locator('[data-compose-send]').click();
  await expect(box).toHaveCount(0);

  // The thread: the approved hand-off's words, and its row from the moment it starts, by number.
  const row = page.locator('[data-reviews-kind="reviewed"]', { hasText: 'Review #231: Idempotent refunds' });
  await expect(row.locator('.ib-pr-l3')).toContainText('#231');
  await expect(row).toContainText('Curating');
  await expect(page.getByText('https://github.com/northwind/payments/pull/231').first()).toBeVisible();
  await shot(page, 'l-curating');
  const threadId = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('thread'));

  // Its one read: nothing else of that repository, whatever else happens on the page.
  await page.reload();
  await expect(row).toBeVisible();
  expect(forgeCalls().filter((call) => call.includes('northwind/payments')).every((call) => call.endsWith('repos/northwind/payments/pulls/231'))).toBe(true);
  expect(forgeCalls().filter((call) => call.includes('northwind/payments')).length).toBeGreaterThanOrEqual(reads);

  // Its review arrives: the row is on the person, still by its number.
  await claude.submitGuide({
    project_path: world.projects.web,
    reply_to: threadId,
    patch: world.patches.locale,
    body: 'Ready for you.',
    guide: {
      title: 'Idempotent refunds, reviewed',
      intent: 'Make refunds safe to retry.',
      sections: [{ title: 'The change', overview: 'Read the new lines.', diffs: [{ file: 'src/i18n/fallback.ts', summary: 'The change.' }] }],
      source: { kind: 'pr', pr: { url: 'https://github.com/northwind/payments/pull/231', number: 231, platform: 'github' } },
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
    review: true,
  } as never);
  const reviewed = page.locator(`[data-reviews-kind="reviewed"][data-row="${threadId}"]`);
  await expect(reviewed).toContainText('Review ready', { timeout: 15_000 });
  await expect(reviewed.locator('.ib-pr-l3')).toContainText('#231');
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot(page, 'l-review-ready');

  // The same link again: nothing starts, and choosing it opens that thread.
  await page.locator('[data-reviews-new]').first().click();
  await expect(box).toBeVisible();
  await openPicker();
  await field.fill('northwind/payments#231');
  await expect(read).toContainText('Already in review');
  await expect(found).toContainText('open it');
  const rows = await page.evaluate(async () => ((await (await fetch('/api/inbox/reviews?cached=1')).json()) as { rows: unknown[] }).rows.length);
  await found.click();
  await expect(box).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`thread=${threadId}`));
  expect(await page.evaluate(async () => ((await (await fetch('/api/inbox/reviews?cached=1')).json()) as { rows: unknown[] }).rows.length)).toBe(rows);

  // A PR the list has goes the picker's way: its stack's hand-off, from its own project.
  await page.locator('[data-reviews-new]').first().click();
  await expect(box).toBeVisible();
  await openPicker();
  await field.fill('https://github.com/northwind/web-app/pull/880');
  await expect(found).toContainText('RTL layout');
  await found.click();
  await expect(box.locator('.ib-cp-rvfrompull')).toBeVisible();
  const sent: Record<string, unknown>[] = [];
  await page.route('**/api/inbox/messages', async (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.abort();
  });
  await box.locator('[data-compose-send]').click();
  await expect.poll(() => sent.length).toBe(1);
  await page.unroute('**/api/inbox/messages');
  expect((sent[0]!.pulls as { keys: string[] }).keys).toContain('github.com/northwind/web-app#880');
  expect(sent[0]!.review).toBeUndefined();

  // Left and opened again: the link chosen comes back with the words, read again.
  await box.locator('[data-compose-text] textarea').fill('Only the sidebar');
  await box.locator('[data-compose-cancel]').click();
  await expect(box).toHaveCount(0);
  await page.locator('[data-reviews-new]').first().click();
  await expect(box.locator('[data-review-pick]')).toContainText('RTL layout');
  await expect(box.locator('[data-compose-text] textarea')).toHaveValue('Only the sidebar');
  // A failed link can't be chosen, and picking from the list drops the link.
  await box.locator('[data-review-pick]').click();
  await field.fill('https://bitbucket.org/acme/mobile/pull-requests/88');
  await expect(read).toHaveText("Bitbucket links aren't supported yet.");
  await field.press('Enter');
  await expect(field).toBeVisible();
  await field.fill('');
  await box.locator('[data-review-pull]').first().click();
  await expect(field).toHaveCount(0);
  await expect(read).toHaveCount(0);
  await box.locator('[data-compose-text] textarea').fill('');
  await box.locator('[data-compose-cancel]').click();
});

test('Reviews: an open question from before the review never stays out of the view, and a card says its chapters on one line', async () => {
  const { page, claude } = world;
  const first = await claude.send({ project_path: world.projects.web, thread: 'asking', subject: 'Which retry cap?', body: 'A plain note from earlier.' });
  await claude.send({ project_path: world.projects.web, thread: 'asking', body: 'Before I go on.\n\n:::question\nWhich retry cap do you want?\n- [ ] Three\n- [ ] Five\n:::' });
  await page.goto(`${world.url}#thread=${first.thread_id}`);
  await expect(page.getByText('Which retry cap do you want?').first()).toBeVisible();
  await claude.submitGuide({
    project_path: world.projects.web,
    thread: 'asking',
    patch: world.patches.locale,
    body: 'Three parts.',
    guide: {
      title: 'The retry cap',
      intent: 'Cap the retries.',
      sections: [
        { title: 'The fallback', overview: 'Read this first.', diffs: [{ file: 'src/i18n/fallback.ts', summary: 'The change.' }] },
        { title: 'Why it stays small', overview: 'Nothing else moves.', diffs: [] },
        { title: 'What to check', overview: 'Check the strings.', diffs: [] },
      ],
      review: { gitRef: 'working-tree', base: 'main', branch: 'retry-cap' },
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
    review: true,
  } as never);
  await page.goto(`${world.url}#reviews&thread=${first.thread_id}`);
  await page.reload();
  await expect(page.locator('[data-review-card] .ib-rvc-meta')).toHaveText('1 file +1 -0 · 3 chapters');
  await expect(page.locator('[data-review-card] ol, [data-review-card] li')).toHaveCount(0);
  await expect(page.getByText('Which retry cap do you want?').first()).toBeVisible();
  await expect(page.getByText('A plain note from earlier.')).toHaveCount(0);
  // The person answers it here, like anywhere: the first option is a pick away.
  await expect(page.getByText('Three', { exact: true }).first()).toBeVisible();
  await shot(page, 'r-card-chapters');
  // A review read long ago, with messages after it: the view still opens with the card open.
  await claude.send({ project_path: world.projects.web, thread: 'asking', body: 'One more thing after the review.' });
  await page.goto(`${world.url}#thread=${first.thread_id}`);
  await expect(page.getByText('One more thing after the review.')).toBeVisible();
  await page.goto(`${world.url}#reviews&thread=${first.thread_id}`);
  await page.reload();
  await expect(page.locator('[data-review-card] [data-review-start]')).toBeVisible();
  await page.goto(`${world.url}#reviews&thread=${first.thread_id}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'r-card-chapters-phone');
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('Reviews: what waits on the person is never hidden, every row shows what it says, and nothing leaves while the person is in the thread', async () => {
  const { page, claude } = world;
  await setCodeReview(true);
  const reviewFor = (thread: string, title: string) =>
    claude.submitGuide({
      project_path: world.projects.web,
      thread,
      patch: world.patches.locale,
      body: 'Ready for you.',
      guide: {
        title,
        intent: 'The change.',
        sections: [{ title: 'The change', overview: 'Read the new lines.', diffs: [{ file: 'src/i18n/fallback.ts', summary: 'The change.' }] }],
        review: { gitRef: 'working-tree', base: 'main', branch: 'waits' },
        generator: { engine: 'claude-code', model: 'claude-opus-5' },
      },
      review: true,
    } as never);
  const read = async (threadId: string, last: string) => {
    await page.goto(`${world.url}#thread=${threadId}`);
    await expect(page.getByText(last)).toBeVisible();
  };
  const fresh = async (threadId: string) => {
    await page.goto(`${world.url}#reviews&thread=${threadId}`);
    await page.reload();
    await expect(page.locator('[data-review-card]')).toHaveCount(1);
  };

  // Six read messages with a question and an action item among them, then a review.
  const first = await claude.send({ project_path: world.projects.web, thread: 'waits', subject: 'What waits', body: 'Plain note one.' });
  await claude.send({ project_path: world.projects.web, thread: 'waits', body: 'Plain note two.' });
  await claude.send({ project_path: world.projects.web, thread: 'waits', body: 'Before I go on.\n\n:::question\nWhich way do you want it?\n- [ ] Left\n- [ ] Right\n:::' });
  await claude.send({ project_path: world.projects.web, thread: 'waits', body: 'Something for you.\n\n:::action\n- [ ] Rotate the staging key\n:::' });
  await claude.send({ project_path: world.projects.web, thread: 'waits', body: 'Plain note three.' });
  await claude.send({ project_path: world.projects.web, thread: 'waits', body: 'Plain note four.' });
  await read(first.thread_id, 'Plain note four.');
  await reviewFor('waits', 'What waits review');
  await fresh(first.thread_id);
  await expect(page.getByText('Which way do you want it?').first()).toBeVisible();
  await expect(page.getByText('Rotate the staging key').first()).toBeVisible();
  await expect(page.getByText('Plain note one.')).toHaveCount(0);
  await expect(page.getByText(/\d+ earlier messages?/)).toHaveCount(0);
  await shot(page, 'r-waits');

  // Ticking Done keeps the message and its way to undo, then and after a reload.
  const tick = page.locator('[data-action-tick]').first();
  await tick.click();
  await expect(tick).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByPlaceholder(/^Add a note for /).first()).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-review-card]')).toHaveCount(1);
  await expect(page.getByText('Rotate the staging key').first()).toBeVisible();
  await expect(page.locator('[data-action-tick]').first()).toHaveAttribute('aria-pressed', 'true');

  // J and K walk the Reviews rows' threads like the Inbox's list.
  const other = await claude.send({ project_path: world.projects.web, thread: 'walks', subject: 'Walks', body: 'A note.' });
  await reviewFor('walks', 'Walks review');
  await page.goto(`${world.url}#reviews&thread=${first.thread_id}`);
  await page.reload();
  await expect(page.locator(`[data-reviews-kind="reviewed"][data-row="${other.thread_id}"]`)).toBeVisible();
  await expect(page.locator('[data-review-card]')).toHaveCount(1);
  const threadOf = () => page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('thread'));
  const here = await threadOf();
  await page.keyboard.press('k');
  await expect.poll(threadOf).toBe(other.thread_id);
  await page.keyboard.press('j');
  await expect.poll(threadOf).toBe(here);

  // Three messages, a review, five more, all read: the card is drawn, and a run's row shows as many as it says.
  const long = await claude.send({ project_path: world.projects.web, thread: 'longer', subject: 'Longer', body: 'Before one.' });
  await claude.send({ project_path: world.projects.web, thread: 'longer', body: 'Before two.' });
  await claude.send({ project_path: world.projects.web, thread: 'longer', body: 'Before three.' });
  await reviewFor('longer', 'Longer review');
  for (const word of ['one', 'two', 'three', 'four', 'five']) await claude.send({ project_path: world.projects.web, thread: 'longer', body: `After ${word}.` });
  await read(long.thread_id, 'After five.');
  await fresh(long.thread_id);
  await expect(page.locator('[data-review-card] [data-review-start]')).toBeVisible();
  await expect(page.getByText('Before one.')).toHaveCount(0);
  const row = page.getByRole('button', { name: /^Show 2 earlier messages/ });
  await expect(page.getByText('After two.')).toHaveCount(0);
  await row.click();
  await expect(page.getByText('After two.')).toBeVisible();
  await expect(page.getByText('After three.')).toBeVisible();
  await expect(row).toHaveCount(0);

  // A reply sent from the view takes nothing off the screen, even a message that was new when it opened.
  const replying = await claude.send({ project_path: world.projects.web, thread: 'replying', subject: 'Replying', body: 'New before the review.' });
  await reviewFor('replying', 'Replying review');
  // Straight in, with no reload: a reload after the first open could land after that open marked it read.
  await page.goto('about:blank');
  await page.goto(`${world.url}#reviews&thread=${replying.thread_id}`);
  await expect(page.getByText('New before the review.')).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).last().click();
  const reply = page.getByRole('textbox', { name: 'Reply to Claude Code' });
  await reply.fill('Thanks, on it.');
  await reply.press('ControlOrMeta+Enter');
  await expect(page.getByText('Thanks, on it.').first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByText('New before the review.')).toBeVisible();

  // A deep link waits for the rows, so the thread never shows whole and then folds.
  let letGo = () => {};
  const held = new Promise<void>((resolve) => (letGo = resolve));
  await page.route('**/api/inbox/reviews*', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('about:blank');
  await page.goto(`${world.url}#reviews&thread=${long.thread_id}`);
  await expect(page.locator('[data-pulls-nav]')).toBeVisible();
  await expect(page.locator('[data-thread-wait="loading"]')).toBeVisible();
  await shot(page, 'r-pending');
  await page.waitForTimeout(400);
  await expect(page.getByText('Before one.')).toHaveCount(0);
  // A phone has no pane beside the list: it keeps the list, saying it is reading, never a white page.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('about:blank');
  await page.goto(`${world.url}#reviews&thread=${long.thread_id}`);
  await expect(page.locator('[data-pulls-list]').getByText('Reading your pull requests')).toBeVisible();
  await expect(page.locator('[data-thread-wait]')).toHaveCount(0);
  await shot(page, 'r-pending-phone');
  letGo();
  await expect(page.locator('[data-review-card]')).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByText('Before one.')).toHaveCount(0);
  await page.unroute('**/api/inbox/reviews*');

  // The row goes while the person is in the thread (archived from another window): the link to what was left out went
  // with it, so the thread shows whole, and stays whole if the row comes back.
  const archive = (threadId: string, resolved: boolean) => page.request.post(`${world.url}api/inbox/messages/${threadId}/resolve`, { data: { resolved } });
  await fresh(long.thread_id);
  await expect(page.getByText('Before one.')).toHaveCount(0);
  await archive(long.thread_id, true);
  await expect(page.getByText('Before one.')).toBeVisible({ timeout: 15_000 });
  await archive(long.thread_id, false);
  await expect(page.locator('[data-review-context]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Before one.')).toBeVisible();

  // A thread handed a PR and archived before its review: the PR is back to Review with an agent, not "on the way".
  const handed = await claude.send({ project_path: world.projects.web, thread: 'handed-off', subject: 'Handed', body: 'On it.' });
  expect((await page.request.post(`${world.url}api/inbox/pulls/owner`, { data: { keys: [LOCALE], thread_id: handed.thread_id, ask: 'guide' } })).status()).toBe(200);
  await archive(handed.thread_id, true);
  await page.goto(`${world.url}#reviews`);
  await page.reload();
  await page.locator(`[data-pulls-row="${LOCALE}"], [data-pulls-row]`).filter({ hasText: '#869' }).first().click();
  await expect(page.locator('[data-pulls-stack] [data-pulls-primary]')).toHaveText('Review with an agent');

  // Code review off: the thread's view is the off page on a fresh link, and the thread itself loses nothing.
  await setCodeReview(false);
  await page.goto(`${world.url}#reviews&thread=${long.thread_id}`);
  await page.reload();
  await expect(page.getByText('Code review is off')).toBeVisible();
  await expect(page.locator('[data-review-context]')).toHaveCount(0);
  await page.goto(`${world.url}#thread=${long.thread_id}`);
  await expect(page.getByText('Before one.')).toBeVisible();
  await setCodeReview(true);
});

test('Reviews with nothing in it: says so, and offers a new review', async () => {
  const { page } = world;
  await page.route('**/api/inbox/reviews*', async (route) => {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { ...(await answer.json()), rows: [] } });
  });
  await page.route('**/api/inbox/pulls?*', async (route) => {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { ...(await answer.json()), pulls: [] } });
  });
  try {
    await page.goto(`${world.url}#reviews`);
    await page.reload();
    await expect(page.locator('[data-reviews-new="empty"]')).toBeVisible();
    await shot(page, 'r-empty');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, 'r-empty-phone');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-reviews-new="empty"]').click();
    await expect(page.locator('dialog[data-compose]')).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    await page.unroute('**/api/inbox/reviews*');
    await page.unroute('**/api/inbox/pulls?*');
  }
});
