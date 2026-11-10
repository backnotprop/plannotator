/**
 * Pull requests in the Inbox (approval "inbox-code-review-direction", items 4
 * and 5; code review in the Inbox, phase 2), proved in a real browser against
 * the compiled binary. The binary runs `plannotator inbox --background` under
 * a temp PLANNOTATOR_DATA_DIR; simulated agents write through `plannotator
 * inbox mcp` (scripts/inbox-sim.ts); Chromium drives the window. HOME is
 * the scratch folder. `gh` and `glab` are sh fakes first on PATH: nothing reaches
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
 * 11. The flat PR view (the code review app's layering, measured against it
 *     on one diff): a 37 px bar, the rail to the window's foot, the column
 *     opening on a 33 px --muted row with the layers as tabs and the controls,
 *     the first file 16 px under it, no card around a file, one hairline
 *     between files, quiet words on that row, the comments column's fill, and
 *     a file's scrollbar only under the pointer.
 * 12. Every changed file stays in the review whatever the tree can hold; the
 *     folded sheets (comments, Files) cover the diff and nothing else, but a
 *     phone's Comments takes the whole window; the controls' row and the foot
 *     on long words.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/pull-requests (desktop light and
 * dark at 1440, phone at 390), and a walkthrough video (webm) when
 * PLANNOTATOR_E2E_VIDEO=1.
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { NO_BROWSER } from '../helpers/no-browser';
import { COLLIDING_PATHS_DIFF } from '../helpers/colliding-paths-diff';
import { expectNoBlankFiles } from './on-screen-files';
import { diffRowBox } from './diff-row-box';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { startFakeAvatars, type FakeAvatars } from '../helpers/fake-avatars';

const DISPLAY_NAME = 'Dana Reviewer';
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
/** The commit the fake forge's compare says a head left its base at. */
const MERGE_BASE = 'b'.repeat(40);
/** A file with lines far from its one change, in the teammate's PR: the expand arrows have somewhere to open. */
const TOKENS_PATH = 'src/settings/tokens.ts';
const TOKENS = Array.from({ length: 60 }, (_, i) => `export const SPACE_${i + 1} = ${i + 1};`);
// Past the change the two sides number far apart: new line 75 is old line 45.
const TOKENS_CHANGED = TOKENS.flatMap((line, i) => (i === 29 ? ['export const SPACE_30 = 32;', ...Array.from({ length: 30 }, (_, n) => `export const EXTRA_${n} = ${n};`)] : [line]));

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
    // A PR's details: its context, who is asked to review, and the pictures and threads of its context's GraphQL read.
    'if [ "$1" = pr ] && [ "$2" = view ]; then',
    '  echo "gh details $3" >> "$calls"',
    '  if [ -f "$dir/details-fail" ]; then echo "HTTP 502" >&2; exit 1; fi',
    '  if [ -f "$dir/ctx-$3.json" ]; then cat "$dir/ctx-$3.json"; else echo \'{"body":"","state":"OPEN","isDraft":false,"labels":[],"comments":[],"reviews":[],"reviewDecision":"","mergeable":"","mergeStateStatus":"","statusCheckRollup":[],"closingIssuesReferences":[]}\'; fi',
    '  exit 0',
    'fi',
    'if [ "$1" = api ] && [ "${2##*/}" = requested_reviewers ]; then',
    '  n="${2%/requested_reviewers}"; n="${n##*/}"; if [ -f "$dir/req-$n.json" ]; then cat "$dir/req-$n.json"; else echo \'{"users":[],"teams":[]}\'; fi; exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then',
    '  case "$*" in *"reviewThreads(first"*) for a in "$@"; do case "$a" in number=*) n="${a#number=}";; esac; done; if [ -f "$dir/ctxg-$n.json" ]; then cat "$dir/ctxg-$n.json"; else echo \'{"data":{"repository":{"pullRequest":null}}}\'; fi; exit 0;; esac',
    // Others (a read of its own): nothing open past the person's own lists.
    '  case "$*" in *"query InboxPullsOthers"*) echo "gh others" >> "$calls"; echo \'{"data":{"viewer":{"login":"dana"},"others0":{"issueCount":0,"nodes":[]}}}\'; exit 0;; esac',
    '  case "$*" in *"requested: search"*) echo "gh pulls" >> "$calls"; cat "$dir/gh-pulls.json"; exit 0;; esac',
    '  echo "gh graphql-other" >> "$calls"; echo \'{"data":null}\'; exit 1',
    'fi',
    // A review posted (Post to GitHub): `gh api <endpoint> --method POST --input -`, the review on stdin, kept.
    'if [ "$1" = api ] && [ "$3" = --method ]; then',
    '  echo "gh post $2" >> "$calls"',
    // `gh-posted.json` the last one, `gh-posts.jsonl` every one.
    '  tee "$dir/gh-posted.json" >> "$dir/gh-posts.jsonl"',
    '  echo >> "$dir/gh-posts.jsonl"',
    '  if [ -f "$dir/gh-post-fail" ]; then cat "$dir/gh-post-fail" >&2; exit 1; fi',
    '  echo \'{"id":1}\'; exit 0',
    'fi',
    // Where a head left its base, for the expand arrows' old side.
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$6" = .merge_base_commit.sha ]; then',
    `  echo "gh merge-base $4" >> "$calls"; echo ${MERGE_BASE}; exit 0`,
    'fi',
    // A PR read around its patch (`--jq … | tojson`): the list's `headRefOid` for that number, and its description.
    // A plain `.head.sha` read (the whole diff's) gets the head raw, as gh prints a string.
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then',
    '  echo "gh head $4" >> "$calls"; n="${4##*/}"; body=null; [ -f "$dir/gh-body-$n.json" ] && body=$(cat "$dir/gh-body-$n.json"); sha=$(printf "%040d" "$n"); [ -f "$dir/gh-head-$n" ] && sha=$(cat "$dir/gh-head-$n"); case "$6" in *tojson*) printf \'{"sha":"%s","body":%s}\\n\' "$sha" "$body";; *) echo "$sha";; esac; exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ]; then',
    '  echo "gh diff $4" >> "$calls"',
    '  f="$dir/gh-$(name "$4").patch"',
    // GitHub reads an owner or repository in any case (`Northwind/Payments` is `northwind/payments`); a case-sensitive disk does not.
    '  [ -f "$f" ] || f="$dir/gh-$(name "$4" | tr A-Z a-z).patch"',
    '  if [ -f "$f" ]; then cat "$f"; exit 0; fi',
    '  echo "HTTP 404: Not Found" >&2; exit 1',
    'fi',
    // A read shaped by `--jq` on github.com (no --hostname): All files' tree and a file of it, canned as `gh-<endpoint>.json`.
    'if [ "$1" = api ] && [ "$3" = --jq ]; then',
    '  echo "gh read $2" >> "$calls"',
    '  f="$dir/gh-$(name "$2").json"',
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
  // A display name too: the comment cards read it, as in plan and code review, and nothing posted carries it.
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), inboxBoard: false, displayName: DISPLAY_NAME }));
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const forgeDir = join(root, 'forge');
  const forge = writeForge(forgeDir);
  // Two layers' descriptions, read through the real path (`--jq`); no other PR here has one.
  writeFileSync(join(forgeDir, 'gh-body-413.json'), JSON.stringify('Backs off between the attempts.'));
  writeFileSync(join(forgeDir, 'gh-body-414.json'), JSON.stringify('The emails, in a draft until they are reviewed.'));
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
    { 'src/settings/Layout.tsx': lines('export function Layout({ children }) {', '  return <div className="settings ml-6">{children}</div>;', '}'), 'package.json': lines('{', '  "devDependencies": { "vite": "7.2.0" }', '}'), [TOKENS_PATH]: lines(...TOKENS) },
    [
      { name: 'tomas/rtl-settings', from: 'main', files: { [TOKENS_PATH]: lines(...TOKENS_CHANGED), 'src/settings/Layout.tsx': lines('export function Layout({ children }) {', '  // Logical margins, so the sidebar sits on the right in Arabic and Hebrew.', '  return <div className="settings ms-6" dir="auto">{children}</div>;', '}') } },
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
  // The teammate's head and base, on the forge only: this clone never fetched them.
  forge.gh(`repos/northwind/web-app/contents/${TOKENS_PATH}?ref=${'880'.padStart(40, '0')}`, lines(...TOKENS_CHANGED));
  forge.gh(`repos/northwind/web-app/contents/${TOKENS_PATH}?ref=${MERGE_BASE}`, lines(...TOKENS));
  forge.gh('repos/northwind/web-app/pulls/872', vite);
  forge.gh('repos/northwind/web-app/pulls/869', locale);
  const csvPatch = ledger.diff('main', 'csv-export');
  const rounding = ledger.diff('main', 'priya/rounding');
  forge.glab(`projects/${encodeURIComponent('northwind/ledger')}/merge_requests/61/raw_diffs`, csvPatch);
  forge.glab(`projects/${encodeURIComponent('northwind/ledger')}/merge_requests/58/raw_diffs`, rounding);
  // Pull request links: a teammate's PR in a repository that is no project, read only as one link.
  forge.gh('repos/northwind/payments/pulls/231', JSON.stringify({ state: 'open', title: 'Idempotent refunds', html_url: 'https://github.com/northwind/payments/pull/231', head: { ref: 'refunds', sha: 'a'.repeat(40) }, base: { ref: 'main' }, user: { login: 'tomas' } }));
  forge.gh('user', JSON.stringify({ login: 'dana' }));
  forge.gh('repos/northwind/never-opened/pulls/77', JSON.stringify({ state: 'open', title: 'Never opened', html_url: 'https://github.com/northwind/never-opened/pull/77', head: { ref: 'x', sha: 'b'.repeat(40) }, base: { ref: 'main' }, user: { login: 'tomas' } }));
  forge.gh('repos/northwind/payments/pulls/234', JSON.stringify({ state: 'open', title: 'Yours', html_url: 'https://github.com/northwind/payments/pull/234', head: { ref: 'y', sha: 'd'.repeat(40) }, base: { ref: 'main' }, user: { login: 'dana' } }));
  forge.gh('repos/northwind/payments/pulls/233', JSON.stringify({ state: 'open', title: 'Not yours', html_url: 'https://github.com/northwind/payments/pull/233', head: { ref: 'x', sha: 'c'.repeat(40) }, base: { ref: 'main' }, user: { login: 'tomas' } }));
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
            ghPull(webRepo, 869, { title: 'Fall back to English for missing strings', headRefName: 'locale-fallback', reviewRequests: { nodes: [{ requestedReviewer: { login: 'jun', avatarUrl: avatarOf('jun') } }] }, updatedAt: ago(180), ...stats(locale) }),
          ],
        },
        merged: { nodes: [ghPull(billingRepo, 411, { title: 'Idempotency keys on the charge client', state: 'MERGED', headRefName: 'retry/charge-client', mergedAt: ago(26 * 60), updatedAt: ago(26 * 60) })] },
      },
    }, (key, value) =>
      // The same call answers the Pull requests board (the searches everywhere, `every…`): here, the same PRs.
      key === 'data' ? { ...value, everyRequested: value.requested, everyAuthored: value.authored, everyAssigned: value.assigned, everyMerged: value.merged } : value,
    ),
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
  // Refused before anything runs, the details' route too.
  const refused = await page.request.get(`${world.url}api/inbox/pulls/details?key=${encodeURIComponent(LAYER_412)}`);
  expect([refused.status(), ((await refused.json()) as { code: string }).code]).toEqual([409, 'code_review_off']);
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
  // All files' routes are refused before anything runs, like the list's.
  for (const route of ['repo-files', 'repo-file']) {
    const asked = await page.request.get(`${world.url}api/inbox/pulls/${route}?key=${encodeURIComponent(TEAMMATE)}&snapshot=${'880'.padStart(40, '0')}&path=package.json`);
    expect([asked.status(), ((await asked.json()) as { code?: string }).code]).toEqual([409, 'code_review_off']);
  }
  expect(forgeCalls().filter((c) => c.endsWith(' pulls') || c.includes(' diff ') || c.includes(' read '))).toEqual([]);
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

test("#reviews&new with Code review off: the off page, no box, and the address forgets it", async () => {
  const { page } = world;
  await setCodeReview(false);
  await page.goto(`${world.url}#reviews&new`);
  await expect(page.locator('[data-reviews-off]')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator('dialog[data-compose]')).toHaveCount(0);
  await expect(page).not.toHaveURL(/&new/);
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
  // A fresh load: the page is still on #reviews from the test before, where Code review was off. A hash change alone
  // can land before the switch reaches it, and an off window rightly forgets `&new`.
  await page.goto('about:blank');
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
  // One read per host: never more.
  expect(forgeCalls().filter((c) => c.endsWith(' pulls')).sort()).toEqual(['gh pulls', 'glab pulls']);
  // The Pull requests board in the right pane (the person's own PRs everywhere) is answered by that same read.
  await expect(page.locator('[data-prs-page] [data-pr-tile]').first()).toBeVisible();
  await page.waitForTimeout(400);
  expect(forgeCalls().filter((c) => c.endsWith(' pulls')).sort()).toEqual(['gh pulls', 'glab pulls']);

  // A teammate's review request stays On you; a PR nobody has reviewed waits, folded, under Open, not reviewed.
  const onYou = list.locator('[data-pulls-group="on_you"] [data-pulls-row]');
  await expect(onYou).toHaveCount(2);
  await expect(list.locator('[data-pulls-group="on_you"] [data-pulls-row="github.com/northwind/web-app#880"]')).toContainText("Review requested · tomas's PR");
  // A face by every name, but not twice in a row: tomas is pictured at the row's left, so his name in the words has none.
  const asked = list.locator('[data-pulls-row="github.com/northwind/web-app#880"] [data-reviews-status]');
  await expect(asked).toHaveText("Review requested · tomas's PR");
  await expect(asked.locator('[data-person="tomas"]')).toHaveCount(1);
  await expect(asked.locator('[data-face]')).toHaveCount(0);
  // The board's popover: who it waits on, with their picture, read through the Inbox's own route like the authors'.
  await page.locator('[data-prs-page] [data-pr-tile="github.com/northwind/web-app#869"]').hover();
  const waits = page.locator('[data-pr-pop="github.com/northwind/web-app#869"] .ib-prpop-status');
  await expect(waits).toHaveText('Waits on jun');
  const jun = waits.locator('[data-person="jun"] [data-face="jun"]');
  await expect(jun).toHaveAttribute('data-face-state', 'shown');
  expect(new URL((await jun.locator('img').getAttribute('src'))!, world.url).pathname).toBe('/api/inbox/pulls/avatar');
  await page.mouse.move(0, 0);
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
    // Round, as in the details.
    expect(await av.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%');
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
const PHONE_TARGETS = '[data-pulls-primary], [data-pulls-open-diff], .ib-cp-choice input, [data-compose-send]';

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
  expect(words.startsWith("You're being asked to help me review and understand a pull request.\n")).toBe(true);
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
  await expect(review.locator('[data-review-files] [data-review-file]')).toHaveCount(3);
  await expect(review.locator('[data-pull-layer-row][aria-current="step"]')).toContainText('This layer');
  await expect(review.getByRole('button', { name: /merge/i })).toHaveCount(0);
  expect(forgeCalls()).toContain('gh diff repos/northwind/billing-svc/pulls/412');
  // No chapter card repeating the rail: the diffs take the width.
  await expect(review.locator('[data-guide-section-narrative]')).toBeHidden();
  // The rail is one column of names: a folder holding one thing merges into it, rows of 28 px touching, in the app's
  // sans; A, D and R stay, and each row has its +/- in the review app's columns. The diffs follow its order.
  await expect(review.locator('[data-review-file="migrations/0042_retry_schedule.sql"]')).toContainText('migrations/0042_retry_schedule.sql');
  await expect(review.locator('[data-review-folder="migrations"]')).toHaveCount(0);
  const railRow = await review.locator('[data-review-file]').first().evaluate((row) => {
    const name = row.querySelector('.ib-prp-base')!;
    return { height: row.getBoundingClientRect().height, font: getComputedStyle(name).fontFamily, text: row.textContent ?? '' };
  });
  expect(railRow.height).toBe(28);
  expect(railRow.font).not.toMatch(/mono/i);
  expect(railRow.text).toContain('A');
  expect(railRow.text).toMatch(/\+\d/);
  const railOrder = await review.locator('[data-review-file]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-review-file')));
  const diffOrder = await review.locator('[data-guide-file-shell]').evaluateAll((shells) => shells.map((shell) => shell.getAttribute('data-guide-file-shell')));
  // (Within a section the viewer draws tests after code, whatever the patch's order, so tests sit out of this check.)
  const code = (paths: (string | null)[]) => paths.filter((path) => !path?.includes('.test.'));
  expect(code(diffOrder)).toEqual(code(railOrder));
  // One title, the header's: the reader draws none, the header names no repository.
  await expect(review.locator('.ib-gbody h1')).toHaveCount(0);
  await expect(review.locator('.ib-vhead .ib-from')).toHaveCount(0);
  await expect(review.locator('[data-pull-layer-row][aria-current="step"]')).toContainText('#412');
  // Each file's box is as tall as its lines (the empty band under a short file, #2615): the 5-line migration's
  // last row ends within one row of its box's bottom.
  const sqlShell = review.locator('[data-guide-file-shell="migrations/0042_retry_schedule.sql"]');
  // boundingBox() does not wait: the view can be mounted before its lines are drawn on a busy runner.
  await expect(sqlShell.locator('[data-line="5"]').first()).toBeVisible();
  const sqlBox = (await sqlShell.locator('[data-guide-code-view-mounted]').boundingBox())!;
  const sqlLast = await diffRowBox(sqlShell.locator('[data-line="5"]').first());
  expect(sqlBox.y + sqlBox.height - (sqlLast.y + sqlLast.height)).toBeLessThan(24);
  // Global comment is a quiet mark in the bar; the diff controls (one Split / Unified button, Collapse all, the gear) sit
  // in the bar too, before it, as in a thread's review (the owner: in the Inbox they are always in the header).
  await expect(review.locator('.ib-vhead [data-guide-global-comment-add]')).toBeVisible();
  await expect(review.locator('.ib-vhead [data-diff-controls] [data-diff-layout-toggle]')).toBeVisible();
  await expect(review.locator('[data-diff-controls]')).toHaveCount(1);
  const barOrder = await review.locator('.ib-vhead').evaluate((bar) => {
    const left = (selector: string) => Math.round(bar.querySelector(selector)!.getBoundingClientRect().left);
    return [left('[data-diff-controls]') < left('[data-guide-global-comment-add]'), left('[data-guide-global-comment-add]') < left('[data-review-decision]')];
  });
  expect(barOrder).toEqual([true, true]);
  await expect(review.locator('[data-diff-style-switch]')).toHaveCount(0);
  await expect(review.locator('[data-guide-section-tab]')).toHaveCount(0);
  // Flat, as the code review app: a file is its header and its lines, no card, the header in the page's colour with
  // one hairline under it, and the first header at the top of the code.
  const frame = await review.evaluate((root) => {
    const read = (el: Element) => { const s = getComputedStyle(el); return { border: s.borderTopWidth, radius: s.borderTopLeftRadius, fill: s.backgroundColor }; };
    const none = { border: '0px', radius: '0px', fill: 'rgba(0, 0, 0, 0)' };
    const head = getComputedStyle(root.querySelector('[data-file-header]')!);
    return {
      none,
      section: read(root.querySelector('[data-guide-section]')!),
      box: read(root.querySelector('[data-guide-code-view-mounted]')!),
      head: { rule: head.borderBottomWidth, radius: head.borderTopLeftRadius, pageColour: head.backgroundColor === getComputedStyle(root.querySelector('.ib-gbody')!).backgroundColor },
      firstHeadTop: Math.round(root.querySelector('[data-file-header]')!.getBoundingClientRect().top - root.querySelector('.ib-gbody')!.getBoundingClientRect().top),
      // One surface: the rail and the code one colour, a hairline between them, no corner; the bar the strip that stands out.
      oneSurface: getComputedStyle(root.querySelector('.ib-gbody')!).backgroundColor === getComputedStyle(root.querySelector('.ib-rsplit')!).backgroundColor,
      railLine: getComputedStyle(root.querySelector('.ib-rrail')!).borderRightWidth,
      corner: getComputedStyle(root.querySelector('.ib-gbody')!).borderTopLeftRadius,
      cornerRight: getComputedStyle(root.querySelector('.ib-gbody')!).borderTopRightRadius,
      barApart: getComputedStyle(root.querySelector('.ib-vhead')!).backgroundColor !== getComputedStyle(root.querySelector('.ib-gbody')!).backgroundColor,
    };
  });
  expect(frame.section).toEqual(frame.none);
  expect(frame.box).toEqual(frame.none);
  expect(frame).toMatchObject({ head: { rule: '1px', radius: '0px', pageColour: true }, firstHeadTop: 0, oneSurface: true, railLine: '1px', corner: '0px', cornerRight: '0px', barApart: true });
  // A 37 px bar over everything; the rail runs to the foot of the page, the code beside it and right under the bar:
  // no row over the code (no empty band; the diff controls are in the bar).
  const layers = await review.evaluate((root) => {
    const box = (selector: string) => root.querySelector(selector)!.getBoundingClientRect();
    const [bar, rail, body] = ['.ib-vhead', '.ib-rrail', '.ib-gbody'].map(box) as [DOMRect, DOMRect, DOMRect];
    return {
      barHeight: bar.height,
      railTop: rail.top - bar.bottom,
      railFoot: root.getBoundingClientRect().bottom - rail.bottom,
      beside: body.left - rail.right,
      codeTop: Math.round(body.top - bar.bottom),
      row: root.querySelectorAll('[data-pull-tabs], .ib-prp-tabs').length,
    };
  });
  expect(layers).toEqual({ barHeight: 37, railTop: 0, railFoot: 0, beside: 0, codeTop: 0, row: 0 });
  await shot(page, '7-layer-review');
  // A long title gives way in the header: cut with "…" (whole in its hover); Back and the decision stay in the window.
  const fn = review.locator('[data-pull-review-title]');
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
  await expect.poll(() => fn.locator('bdi').evaluate((node) => ({ cut: node.scrollWidth > node.clientWidth, overflow: getComputedStyle(node).textOverflow }))).toEqual({ cut: true, overflow: 'ellipsis' });
  // Whole on hover, in the window's tooltip.
  await fn.hover();
  await expect(page.locator('[data-pn-tooltip]')).toContainText('#412 Retry schedule table and next-attempt time');
  await page.mouse.move(0, 0);
  const after = (await review.locator('.ib-vhead [data-review-decision]').boundingBox())!;
  expect(after.x + after.width).toBeLessThanOrEqual(900);
  await fn.locator('bdi').evaluate((node, text) => (node.textContent = text), was);
  // The world's window back to its size: the tests after this one share it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await review.locator(`[data-pull-next-layer="${LAYER_413}"]`).click();
  await expect(review).toHaveAttribute('data-pull-review', LAYER_413);
  await expect(review.locator('[data-review-files] [data-review-file]')).toHaveCount(1);
  await expect(review.locator('[data-pull-layer-row][aria-current="step"]')).toContainText('#413');

  // All 3 layers, from #413 too: the top open layer's whole stack, from the lowest open layer's base, so every open
  // layer's files, not the merged #411's. Its number and its title say so.
  const allLayers = review.locator('[data-pull-layer-all]');
  await expect(allLayers).toContainText('All 3 layers');
  await allLayers.click();
  await expect(review).toHaveAttribute('data-pull-scope', 'stack');
  await expect(review).toHaveAttribute('data-pull-review', STACK_ID);
  await expect(review.locator('[data-pull-review-title]').first()).toContainText('Whole stack up to #414');
  await expect(allLayers).toHaveAttribute('aria-pressed', 'true');
  await expect(review.locator('[data-review-files] [data-review-file]')).toHaveCount(4);
  await expect(review.locator('[data-guide-file-shell="migrations/0042_retry_schedule.sql"]')).toBeVisible({ timeout: 30_000 });
  await expect(review.locator('[data-guide-file-shell="src/charges/client.ts"]')).toHaveCount(0);
  expect(forgeCalls()).toContain('gh diff repos/northwind/billing-svc/compare/retry/charge-client...retry/dunning');
  await shot(page, '8-whole-stack', ['light']);
  await review.locator(`[data-pull-layer-row="${LAYER_413}"]`).click();
  await expect(review.locator('[data-review-files] [data-review-file]')).toHaveCount(1);
  expect(asked).toEqual([`${LAYER_412} layer`, `${LAYER_413} layer`, `${STACK_ID} stack`]);
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

/** A window of its own with a layer's diff replaced: the stubbed diff stays out of the shared window's cache. */
async function stubbedReview(browser: Browser, width: number, patch: string, answer: Record<string, unknown> = {}, scope = 'layer', pull = TEAMMATE): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  await page.route('**/api/inbox/pulls/diff*', async (route) => {
    // The window can close with a read still out.
    const real = await route.fetch().catch(() => null);
    if (real) await route.fulfill({ status: 200, json: { ...(await real.json()), patch, ...answer } });
  });
  await page.goto(`${world.url}#pulls&stack=${encodeURIComponent(pull)}&layer=${encodeURIComponent(pull)}&scope=${scope}`);
  await expect(page.locator('[data-pull-review] [data-guide-file-shell]').first()).toBeVisible({ timeout: 30_000 });
  return { context, page };
}

/**
 * The way to the details: the bar's PR title on a computer (the owner's "title only", PullDetails.tsx
 * `DETAILS_BUTTON`; it carries the checks' dot and the comments' count), the title's row on a phone.
 */
const detailsWayIn = (review: Locator) => review.locator('[data-pull-details-title], [data-pull-details-button]');

/** The details over the code, from the bar's title or, on a phone, the title's row. */
async function openDetails(review: Locator): Promise<Locator> {
  await detailsWayIn(review).click();
  const panel = review.locator('[data-pull-details]');
  await expect(panel).toBeVisible();
  return panel;
}

test('the details wait for the list: on a fresh load the forge is not asked about a PR the Inbox has not listed yet', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === '/api/inbox/pulls', async (route) => {
      await held;
      await route.continue();
    });
    const asked: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/inbox/pulls/details') asked.push(request.url());
    });
    const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/inbox/pulls/details', { timeout: 30_000 });
    await page.goto(`${world.url}#pulls&stack=${encodeURIComponent(STACK_ID)}&layer=${encodeURIComponent(LAYER_413)}&scope=layer`);
    await page.waitForTimeout(1500);
    expect(asked).toEqual([]);
    release();
    expect((await answered).status()).toBe(200);
    await expect(page.locator('[data-pull-review] [data-guide-file-shell]').first()).toBeVisible({ timeout: 30_000 });
    await openDetails(page.locator('[data-pull-review]'));
    await expect(page.locator('[data-pull-details-failed]')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the details as real gh answers them: a running check, a template for a body, a bot's hidden notes, a comment posing as the window's overlay", async ({ browser }) => {
  // A PR of its own: the server keeps a details read a minute, so the next test's #880 is not this one's.
  const pull = 'github.com/northwind/web-app#872';
  const number = '872';
  const write = (name: string, value: unknown) => writeFileSync(join(world.forge, name), JSON.stringify(value));
  const template = '<!-- Please describe\n\nyour-change-here -->';
  const posing = `A["<div class='pn-visible-viewport-overlay'><div data-pn-image-annotator-stage='1'>x</div></div>"]`;
  write(`gh-body-${number}.json`, template);
  write(`ctx-${number}.json`, {
    body: template, state: 'OPEN', isDraft: false, reviewDecision: '', mergeable: '', mergeStateStatus: '', closingIssuesReferences: [], labels: [],
    comments: [
      { id: 'c1', author: { login: 'kim' }, body: 'Plain words.\n\n<!-- bot-state\n\nhidden-bot-marker -->\n\nAfter.', createdAt: '2026-11-01T09:00:00Z', url: '' },
      { id: 'c2', author: { login: 'kim' }, body: `\`\`\`mermaid\ngraph TD\n  ${posing}\n\`\`\``, createdAt: '2026-11-01T10:00:00Z', url: '' },
    ],
    reviews: [],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-11-05T00:00:00Z', completedAt: '0001-01-01T00:00:00Z', detailsUrl: 'https://ci.example/1' },
    ],
  });
  // A page of comments on lines that fails: no answer the first time, an empty list after.
  write(`ctxg-${number}.json`, { errors: [{ message: 'Something went wrong' }] });
  const { context, page } = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF, {}, 'layer', pull);
  try {
    const review = page.locator('[data-pull-review]');
    const button = detailsWayIn(review);
    await expect(button.locator('[data-pull-details-checks]')).toHaveAttribute('data-pull-details-checks', 'pending', { timeout: 30_000 });
    const panel = await openDetails(review);
    await expect(panel.locator('[data-pull-details-check="pending"]')).toHaveCount(1);
    await expect(panel.locator('[data-pull-details-check="pass"]')).toHaveCount(0);
    await expect(panel).toContainText('No description.');
    await expect(panel).toContainText('Plain words.');
    await expect(panel).not.toContainText('your-change-here');
    await expect(panel).not.toContainText('hidden-bot-marker');

    // What a diagram in a comment draws can copy the marks of the window's overlays. It draws late, above the note
    // below, so it is waited for first; Escape still closes the panel.
    await expect(panel.locator('.pn-visible-viewport-overlay [data-pn-image-annotator-stage]').first()).toBeAttached({ timeout: 15_000 });

    await expect(panel.locator('[data-pull-details-threads-missing]')).toBeVisible();
    write(`ctxg-${number}.json`, { data: { repository: { pullRequest: { comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } } } } });
    await panel.locator('[data-pull-details-threads-missing] button').click();
    await expect(panel.locator('[data-pull-details-threads-missing]')).toHaveCount(0);
    await expect(panel.locator('.pn-visible-viewport-overlay [data-pn-image-annotator-stage]').first()).toBeAttached();
    await page.mouse.move(700, 5);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();

    // Opening it again reads again.
    const again = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/inbox/pulls/details');
    await button.click();
    await again;
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Plain words.');
  } finally {
    await context.close();
  }
});

test('the details, from the forge: who stands where, the checks, every comment; pictures through the Inbox; a failure says so', async ({ browser }) => {
  const number = TEAMMATE.split('#')[1]!;
  const pic = (login: string) => world.avatars.url(login);
  const longCheck = 'e2e (chromium, shard 3 of 8, retry the flaky ones) on the release branch after the migration step';
  // Real jobs share most of their words and differ at the end (matrix, shard, OS).
  const twinPrefix = 'Run changed specs against the staging build with the remote cache and the worker pool turned on';
  const dir = world.forge;
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  write(`ctx-${number}.json`, {
    body: '', state: 'OPEN', isDraft: false, reviewDecision: '', mergeable: '', mergeStateStatus: '', closingIssuesReferences: [],
    labels: [{ name: 'billing', color: 'ededed' }],
    comments: [
      { id: 'c1', author: { login: 'kim' }, body: 'Could the key include the attempt?', createdAt: '2026-11-01T09:00:00Z', url: 'https://github.com/n/w/pull/1#c1' },
      { id: 'c2', author: null, body: 'Words of a gone account.', createdAt: '2026-11-01T10:00:00Z', url: '' },
      { id: 'c3', author: { login: 'codecov[bot]' }, body: '## Coverage\n\nCoverage is up.', createdAt: '2026-11-01T11:00:00Z', url: '' },
    ],
    reviews: [{ id: 'r1', author: { login: 'mei' }, state: 'CHANGES_REQUESTED', body: '', submittedAt: '2026-11-01T08:00:00Z' }],
    statusCheckRollup: [
      { name: longCheck, workflowName: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/1' },
      { name: `${twinPrefix} (linux, 1/5)`, workflowName: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/3' },
      { name: `${twinPrefix} (windows, 1/5)`, workflowName: 'test', status: 'COMPLETED', conclusion: 'TIMED_OUT', detailsUrl: 'https://ci.example/4' },
      { name: 'lint', workflowName: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci.example/2' },
    ],
  });
  write(`ctxg-${number}.json`, { data: { repository: { pullRequest: {
    comments: { nodes: [{ author: { __typename: 'User', login: 'kim', avatarUrl: pic('kim') } }, { author: null }, { author: { __typename: 'Bot', login: 'codecov[bot]', avatarUrl: pic('codecov') } }] },
    reviews: { nodes: [{ author: { __typename: 'User', login: 'mei', avatarUrl: pic('mei') } }] },
    reviewThreads: { nodes: [{ id: 't', isResolved: false, isOutdated: false, line: 3, startLine: null, path: 'src/app.ts', diffSide: 'RIGHT', comments: { nodes: [{ id: 'rc', body: 'On a line.', author: { __typename: 'User', login: 'kim', avatarUrl: pic('kim') }, createdAt: '2026-11-01T09:30:00Z', url: '' }] } }] },
  } } } });
  write(`req-${number}.json`, { users: [{ login: 'ana', avatar_url: pic('ana'), type: 'User' }], teams: [{ slug: 'billing-platform' }] });

  const avatarCode = async (page: Page, login: string) => {
    const answer = await page.request.get(`${world.url}api/inbox/pulls/avatar?host=github.com&login=${encodeURIComponent(login)}`);
    return answer.ok() ? 'ok' : ((await answer.json()) as { code: string }).code;
  };
  const { context, page } = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF);
  try {
    const review = page.locator('[data-pull-review]');
    const button = detailsWayIn(review);
    // The bar's title says how the checks stand and how many people's comments, bots not counted.
    await expect(button.locator('[data-pull-details-checks]')).toHaveAttribute('data-pull-details-checks', 'fail');
    await expect(button.locator('[data-pull-details-comments]')).toHaveText('3');
    const panel = await openDetails(review);
    await expect(panel).toBeFocused();
    await expect(panel).toHaveAttribute('data-layout', 'columns');
    // Who stands where, with the worst first and a team among them.
    const reviewers = panel.locator('[data-pull-details-reviewer]');
    await expect(reviewers).toHaveCount(3);
    expect(await reviewers.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-pull-details-reviewer')))).toEqual(['mei', 'ana', 'northwind/billing-platform']);
    // Pictures come through the Inbox's own route, for reviewers and commenters past the list's authors; a team has none.
    const face = panel.locator('[data-pull-details-reviewer="mei"] img');
    await expect(face).toHaveAttribute('data-shown', '');
    expect(new URL((await face.getAttribute('src'))!, world.url).pathname).toBe('/api/inbox/pulls/avatar');
    await expect(panel.locator('[data-pull-details-reviewer="northwind/billing-platform"] img')).toHaveCount(0);
    await expect(panel.locator('[data-pull-details-reviewer="northwind/billing-platform"] .ib-prd-face')).toHaveAttribute('data-square', '');
    // Round, as on the Reviews list.
    expect(await face.evaluate((img) => getComputedStyle(img.closest('.ib-prd-pic')!).borderRadius)).toBe('50%');
    // A check's name takes up to two lines, then gives way in its middle: two jobs that share a long start still read
    // apart by their ends. The job's own name (no workflow before it), its state on its first line, the whole name in
    // its tip; the passed ones behind a line.
    const failed = panel.locator('[data-pull-details-check="fail"]', { has: page.locator(`.ib-prd-cfit[data-name="${longCheck}"]`) });
    const name = failed.locator('.ib-prd-rname');
    await expect(failed.locator('.ib-prd-rstate')).toHaveText('Failed');
    const twin = (end: string) => panel.locator(`.ib-prd-cfit[data-name="${twinPrefix} (${end}, 1/5)"]`);
    const looks = async (el: Locator) => el.evaluate((box) => ({ text: box.textContent!, lines: Math.round(box.getBoundingClientRect().height / parseFloat(getComputedStyle(box).lineHeight)) }));
    const linux = await looks(twin('linux'));
    const windows = await looks(twin('windows'));
    expect(linux.text).not.toBe(windows.text);
    expect(linux.text).toContain('…');
    expect(linux.text.endsWith('(linux, 1/5)')).toBe(true);
    expect(windows.text.endsWith('(windows, 1/5)')).toBe(true);
    expect([linux.lines, windows.lines]).toEqual([2, 2]);
    // A long name is two lines at most, its end in view; a failure's word on its first line.
    const long = await looks(failed.locator('.ib-prd-cfit'));
    expect(long.lines).toBeLessThanOrEqual(2);
    expect(long.text.endsWith('after the migration step')).toBe(true);
    expect(Math.abs((await failed.locator('.ib-prd-rstate').boundingBox())!.y - (await name.boundingBox())!.y)).toBeLessThan(4);
    await name.hover();
    await expect(page.locator('[data-pn-tooltip]')).toHaveText(`test / ${longCheck}`);
    await page.mouse.move(0, 0);
    await expect(failed.locator('a')).toHaveAttribute('href', 'https://ci.example/1');
    await expect(failed.locator('a')).toHaveAttribute('target', '_blank');
    await expect(panel.locator('[data-pull-details-check="pass"]')).toHaveCount(0);
    await panel.getByRole('button', { name: '1 passed' }).click();
    await expect(panel.locator('[data-pull-details-check="pass"]')).toHaveCount(1);
    // Comments in time order: a line comment goes to its file; a deleted account is one; bots wait behind a line.
    await expect(panel.locator('[data-pull-details-comment]')).toHaveCount(3);
    await expect(panel.locator('[data-pull-details-comment="c2"] b')).toHaveText('A deleted account');
    await expect(panel.locator('[data-pull-details-comment="c2"] .ib-prd-face')).toHaveAttribute('data-gone', '');
    await expect(panel).not.toContainText('Coverage is up.');
    await panel.locator('[data-pull-details-bots]').click();
    await expect(panel).toContainText('Coverage is up.');
    // A bot's report opening with a heading stays a comment's size.
    expect(await panel.locator('.ib-prd-cbody h2', { hasText: 'Coverage' }).evaluate((h) => parseFloat(getComputedStyle(h).fontSize))).toBeLessThanOrEqual(14);
    // Nothing in the code behind the panel peeks out: across its top band, what is on screen is the panel's own.
    // (Split | Unified is in the bar now, main 423fa3b92: no tab on the first file is left to check.)
    expect(
      await panel.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return [r.left + 24, r.left + r.width / 2, r.right - 24].every((x) => {
          const hit = document.elementFromPoint(x, r.top + 12);
          return !!hit && el.contains(hit);
        });
      }),
    ).toBe(true);
    // Escape closes it, back on its way in; the code is there again.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(review.locator('[data-guide-file-shell] [data-file-header]').first()).toBeVisible();
    // One thing over the code at a time.
    await page.setViewportSize({ width: 1280, height: 900 });
    await button.click();
    await review.locator('.ib-vcomments').click();
    await expect(panel).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(review.locator('.ib-gpanel')).toBeHidden();
    // A comment's file: the panel closes, on the file.
    await page.setViewportSize({ width: 1440, height: 900 });
    await button.click();
    await panel.locator('[data-pull-details-comment="rc"] .ib-prd-cfile').click();
    await expect(panel).toHaveCount(0);
    await expect(review.locator('[data-guide-file-shell="src/app.ts"]')).toBeInViewport();
    // The people it named keep their pictures past a new list, whoever is not in it stays refused.
    expect(await avatarCode(page, 'mei')).toBe('ok');
    await page.request.get(`${world.url}api/inbox/pulls?refresh=1`);
    expect(await avatarCode(page, 'mei')).toBe('ok');
    expect(await avatarCode(page, 'nobody-it-named')).toBe('avatar_unknown');
  } finally {
    await context.close();
  }

  // On a phone: one column, people and checks a line each, a long name on two lines at most, the title's row is the way in.
  const phone = await stubbedReview(browser, 390, COLLIDING_PATHS_DIFF);
  try {
    const review = phone.page.locator('[data-pull-review]');
    const panel = await openDetails(review);
    await expect(panel).toHaveAttribute('data-layout', 'column');
    const box = (await panel.boundingBox())!;
    expect([box.x, box.width]).toEqual([0, 390]);
    await panel.locator('.ib-prd-sum').last().click();
    const name = panel.locator(`.ib-prd-cfit[data-name="${longCheck}"]`);
    await expect(name).toBeVisible();
    expect(await name.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)))).toBeLessThanOrEqual(2);
    await expect(phone.page.evaluate(() => document.documentElement.scrollWidth)).resolves.toBeLessThanOrEqual(390);
    await panel.locator('[data-pull-details-close]').click();
    await expect(panel).toHaveCount(0);
    await expect(review.locator('[data-pull-details-button]')).toBeFocused();
  } finally {
    await phone.context.close();
  }

  // The forge not answering: the words still read, it says so, and Try again reads again.
  writeFileSync(join(dir, 'details-fail'), '');
  const other = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF, { description: 'Still here.' }, 'layer', STACK_ID);
  try {
    const review = other.page.locator('[data-pull-review]');
    const panel = await openDetails(review);
    await expect(panel).toContainText('Still here.');
    await expect(panel.locator('[data-pull-details-failed]')).toBeVisible();
    rmSync(join(dir, 'details-fail'));
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect(panel.locator('[data-pull-details-failed]')).toHaveCount(0);
    await expect(panel.locator('.ib-prd-side')).toHaveCount(0);
  } finally {
    await other.context.close();
    rmSync(join(dir, 'details-fail'), { force: true });
    for (const name of [`ctx-${number}.json`, `ctxg-${number}.json`, `req-${number}.json`]) rmSync(join(dir, name), { force: true });
    // The server keeps a details read a minute, keyed by the PR's last update: this read's thread on src/app.ts would
    // show on the rail of the next tests that open #880 within it. The PR updated a second later and the list read
    // again (at most every 20 s), that read is never reached, however soon the next test opens #880.
    const pulls = join(dir, 'gh-pulls.json');
    const listed = readFileSync(pulls, 'utf8');
    const updated = listed.replace(new RegExp(`("number":${number},[^}]*?"updatedAt":")([^"]+)`), (_, head: string, at: string) => `${head}${new Date(Date.parse(at) + 1_000).toISOString()}`);
    expect(updated).not.toBe(listed);
    writeFileSync(pulls, updated);
    const listReads = () => forgeCalls().filter((call) => call === 'gh pulls').length;
    const before = listReads();
    await expect
      .poll(async () => {
        await fetch(`${world.url}api/inbox/pulls?refresh=1`);
        return listReads();
      }, { timeout: 60_000, intervals: [2_000] })
      .toBeGreaterThan(before);
  }
});

test("the PR's description in its details: a short one whole, a long one folded, an empty one says so", async ({ browser }) => {
  const comment = '<!-- A template comment nobody should read. -->';
  const longBody = [
    comment,
    '## Why',
    '',
    'Charges that fail today are retried by hand.',
    '',
    '![Retry timeline](https://user-images.githubusercontent.com/1/timeline.png)',
    '',
    '<img src="https://github.com/user-attachments/assets/abc" alt="Dashboard after" width="600">',
    '',
    '| Area | Risk |',
    '| --- | --- |',
    '| `schedule.ts` | Low |',
    '',
    '<script>window.scripted = true</script>',
    '',
    '[The ticket](https://example.invalid/ticket)',
    '',
    ...Array.from({ length: 480 }, (_, i) => (i % 3 === 2 ? '' : `Line ${i} of the rollout notes.`)),
  ].join('\n');
  const first = (review: Locator) => review.locator('[data-guide-file-shell]').first();
  for (const width of [1440, 390]) {
    // Short: whole, no way to open it, the title not stacked a second time.
    const short = await stubbedReview(browser, width, COLLIDING_PATHS_DIFF, { description: `${comment}\n\nMoves the settings to logical properties.` });
    try {
      const review = short.page.locator('[data-pull-review]');
      const section = review.locator('[data-pull-description]');
      // Nothing above the code until it is asked for.
      await expect(section).toHaveCount(0);
      await openDetails(review);
      await expect(section).toHaveAttribute('data-pull-description', 'whole');
      await expect(section).toContainText('Moves the settings to logical properties.');
      await expect(section).not.toContainText('A template comment');
      await expect(section.getByRole('button')).toHaveCount(0);
      await expect(review.locator('[data-pull-review-title]')).toHaveCount(1);
      await expect(section.getByText('RTL layout for the settings pages')).toHaveCount(0);
    } finally {
      await short.context.close();
    }

    // Long: folded, and the first file stays on screen, opened too. Nothing it holds loads or runs.
    const asked: string[] = [];
    const long = await stubbedReview(browser, width, COLLIDING_PATHS_DIFF, { description: longBody });
    try {
      const { page } = long;
      page.on('request', (request) => asked.push(request.url()));
      await page.reload();
      const review = page.locator('[data-pull-review]');
      const section = review.locator('[data-pull-description]');
      await openDetails(review);
      await expect(section).toHaveAttribute('data-pull-description', 'folded');
      const more = section.getByRole('button', { name: 'Show more' });
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      expect((await section.boundingBox())!.height).toBeLessThanOrEqual(290);
      // What is clipped takes no Tab stops.
      expect(await section.locator('.ib-prr-desc-body').evaluate((body) => (body as HTMLElement).inert)).toBe(true);

      await more.click();
      await expect(section).toHaveAttribute('data-pull-description', 'open');
      await expect(section.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
      // It reads in the panel, whose own scroll takes the rest.
      const body = section.locator('.ib-prr-desc-body');
      await expect.poll(() => review.locator(width === 390 ? '.ib-prd' : '.ib-prd-main').evaluate((el) => el.scrollHeight > el.clientHeight * 2)).toBe(true);
      await expect(section.getByRole('link', { name: 'The ticket' })).toBeVisible();
      await expect(section.locator('table')).toContainText('schedule.ts');
      await expect(section).not.toContainText('A template comment');
      // A picture is its words: nothing asked of its host, no script run.
      await expect(section.getByText('Retry timeline')).toBeVisible();
      await expect(section.getByText('Dashboard after')).toBeVisible();
      await expect(section.locator('img')).toHaveCount(0);
      expect(asked.filter((url) => /githubusercontent|github\.com\/user-attachments/.test(url))).toEqual([]);
      expect(await page.evaluate(() => (window as { scripted?: boolean }).scripted)).toBeUndefined();

      await section.getByRole('button', { name: 'Show less' }).click();
      await expect(section).toHaveAttribute('data-pull-description', 'folded');
      // The words folded open on a click as well.
      await body.click({ force: true });
      await expect(section).toHaveAttribute('data-pull-description', 'open');
    } finally {
      await long.context.close();
    }

    // Empty: it says so, whether the forge said none or only spaces.
    for (const description of [null, '']) {
      const empty = await stubbedReview(browser, width, COLLIDING_PATHS_DIFF, { description });
      try {
        const review = empty.page.locator('[data-pull-review]');
        await expect(first(review)).toBeVisible();
        const panel = await openDetails(review);
        await expect(panel).toContainText('No description.');
        await expect(review.locator('[data-pull-description]')).toHaveCount(0);
        await expect(review.getByRole('button', { name: 'Show more' })).toHaveCount(0);
        // Whose PR it is: its author leads the details; beside the title too, past a phone; nothing above the diff.
        await expect(panel.locator('.ib-prd-who b')).toHaveText('tomas');
        if (width !== 390) await expect(review.locator('.ib-vhead [data-pull-review-readonly]')).toHaveText('by tomas');
        await expect(review.locator('.ib-gbody [data-pull-review-readonly]')).toHaveCount(0);
      } finally {
        await empty.context.close();
      }
    }
  }
});

test("a stranger's description: paths open on the forge, only the web's links are links, it can't reach the window's keys or width", async ({ browser }) => {
  const body = [
    '[guide](docs/guide.md) [api](/api/inbox/settings) [launch](vscode://file/etc/passwd) [ssh](ssh://a.example) [anchor](#why) [web](https://a.example/x)',
    '',
    '<div><a href="docs/raw" target="_top">raw</a> <a href="https://a.example/y" target="_top">top</a> <a href="#why">raw anchor</a></div>',
    '',
    '<div data-pn-image-annotator-stage>stage</div>',
    '',
    '![pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==)',
  ].join('\n');
  const { context, page } = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF, { description: body });
  try {
    const review = page.locator('[data-pull-review]');
    const section = review.locator('[data-pull-description]');
    await openDetails(review);
    const route = page.url();
    const link = (name: string) => section.getByRole('link', { name, exact: true });
    // Folded, what is clipped is inert: read it open, or whole when it fits.
    await expect(section).toContainText('guide');
    if (await section.getByRole('button', { name: 'Show more' }).count()) await section.getByRole('button', { name: 'Show more' }).click();
    // A path is the file on the forge, in a new tab; this window stays, Markdown and raw HTML alike, whatever its target says.
    for (const [name, path] of [['guide', '/docs/guide.md'], ['api', '/api/inbox/settings'], ['raw', '/docs/raw']] as const) {
      await expect(link(name)).toHaveAttribute('href', new RegExp(`^https://github\\.com/[^/]+/[^/]+/blob/[^/]+${path}$`));
      const opened = context.waitForEvent('page');
      await link(name).click();
      await (await opened).close();
      expect(page.url()).toBe(route);
    }
    await expect(link('raw')).not.toHaveAttribute('target', '_top');
    await expect(link('top')).toHaveAttribute('target', '_blank');
    // A scheme that launches an app is its words: no pointer, and a key or script click goes nowhere.
    for (const name of ['launch', 'ssh']) {
      const words = section.locator('a', { hasText: new RegExp(`^${name}$`) });
      expect(await words.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
      expect(await words.evaluate((el) => !el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))).toBe(true);
    }
    // An anchor never moves the window's route, which is its hash.
    for (const name of ['anchor', 'raw anchor']) {
      await link(name).click();
      expect(page.url()).toBe(route);
    }
    await expect(section.locator('img[alt="pixel"]')).toHaveCount(1);
    // Its `data-pn-image-annotator-stage` is no modal: Escape still closes the details, and then a sheet.
    await page.keyboard.press('Escape');
    await expect(review.locator('[data-pull-details]')).toHaveCount(0);
    await page.locator('.ib-vhead .ib-vcomments').click();
    await expect(page.locator('.ib-panel-open')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.ib-panel-open')).toHaveCount(0);
  } finally {
    await context.close();
  }
  // A short one with a wide table, drawn whole: the table scrolls in its own box, never the review.
  const wide = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF, { description: '<table width="5000"><tr><td>wide</td></tr></table>' });
  try {
    await openDetails(wide.page.locator('[data-pull-review]'));
    await expect(wide.page.locator('[data-pull-review] [data-pull-description]')).toHaveAttribute('data-pull-description', 'whole');
    await expect(wide.page.locator('[data-pull-description] table')).toBeAttached();
    expect(await wide.page.locator('[data-pull-review] .ib-prd-main').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  } finally {
    await wide.context.close();
  }
  // A long one is parsed only to its start while folded, and all of it on Show more.
  const tail = 'THE-LAST-WORDS';
  const long = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF, { description: `${Array.from({ length: 700 }, (_, i) => `Line ${i}.`).join('\n\n')}\n\n${tail}` });
  try {
    await openDetails(long.page.locator('[data-pull-review]'));
    const section = long.page.locator('[data-pull-review] [data-pull-description]');
    await expect(section).toHaveAttribute('data-pull-description', 'folded');
    await expect(section).not.toContainText(tail);
    await section.getByRole('button', { name: 'Show more' }).click();
    await expect(section).toContainText(tail);
  } finally {
    await long.context.close();
  }
  // A <details> opened in a short one stays open under the click, though it grew past the fold.
  const details = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF, { description: `<details><summary>More</summary>\n\n${Array.from({ length: 40 }, (_, i) => `Line ${i}.`).join('\n\n')}\n\n</details>` });
  try {
    await openDetails(details.page.locator('[data-pull-review]'));
    const section = details.page.locator('[data-pull-review] [data-pull-description]');
    await expect(section).toHaveAttribute('data-pull-description', 'whole');
    await section.locator('summary').click();
    await expect(section).toHaveAttribute('data-pull-description', 'open');
    await expect(section.locator('details')).toHaveAttribute('open', '');
    await expect(section.getByText('Line 39.', { exact: true })).toBeAttached();
    // Show less is the last word: a change of size does not open it again.
    await section.getByRole('button', { name: 'Show less' }).click();
    await expect(section).toHaveAttribute('data-pull-description', 'folded');
    await details.page.setViewportSize({ width: 1280, height: 900 });
    await details.page.waitForTimeout(250);
    await expect(section).toHaveAttribute('data-pull-description', 'folded');
  } finally {
    await details.context.close();
  }
});

test("a description's web links never replace the window, however they are spelled; an empty address goes nowhere", async ({ browser }) => {
  const body = [
    '[one](//evil.example/a.md) [two](//evil.example/a.html) [three](HTTPS://evil.example/a.md) [four](Http://evil.example/a.html)',
    '',
    '<div><a href="" target="_top">empty</a> <a href=" " target="_top">space</a> <a href="mailto:a@example.com">rawmail</a></div>',
  ].join('\n');
  const { context, page } = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF, { description: body });
  try {
    await context.route(/evil\.example/, (route) => route.fulfill({ contentType: 'text/html', body: 'elsewhere' }));
    const review = page.locator('[data-pull-review]');
    const section = review.locator('[data-pull-description]');
    await openDetails(review);
    const address = page.url();
    for (const name of ['one', 'two', 'three', 'four']) {
      const opened = context.waitForEvent('page');
      await section.getByRole('link', { name, exact: true }).click();
      const tab = await opened;
      await tab.waitForURL(/evil\.example\/a\./);
      await tab.close();
      expect(page.url()).toBe(address);
      await expect(review).toHaveCount(1);
    }
    // A raw mailto has no target either: it stays the mail app's, with no empty tab.
    const opens = await section.locator('a', { hasText: /^rawmail$/ }).evaluate((el) => {
      let count = 0;
      const open = window.open;
      window.open = () => (count++, null);
      document.addEventListener('click', (event) => event.preventDefault(), { once: true });
      (el as HTMLElement).click();
      window.open = open;
      return count;
    });
    expect(opens).toBe(0);
    for (const name of ['empty', 'space']) {
      await section.locator('a', { hasText: new RegExp(`^${name}$`) }).focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
      expect(page.url()).toBe(address);
      await expect(review).toHaveCount(1);
    }
  } finally {
    await context.close();
  }
});

test("a description's markup can't pose as the window's own overlays, even through a diagram's label: Escape still closes the details", async ({ browser }) => {
  const label = `A["<div class='pn-visible-viewport-overlay'><div data-pn-image-annotator-stage='1'>x</div></div>"]`;
  for (const description of ['<div data-pn-annotation-toolbar-row>x</div>', '<div data-quick-label-picker>x</div>', `\`\`\`mermaid\ngraph TD\n  ${label}\n\`\`\``]) {
    const { context, page } = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF, { description });
    try {
      const review = page.locator('[data-pull-review]');
      await openDetails(review);
      const section = page.locator('[data-pull-review] [data-pull-description]');
      const posing = section.locator('[data-pn-annotation-toolbar-row], [data-quick-label-picker], .pn-visible-viewport-overlay [data-pn-image-annotator-stage]');
      await expect(posing.first()).toBeAttached({ timeout: 15_000 });
      await page.keyboard.press('Escape');
      await expect(review.locator('[data-pull-details]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
});

test('a description with a list never scrolls sideways', async ({ browser }) => {
  for (const width of [1440, 390]) {
    const { context, page } = await stubbedReview(browser, width, COLLIDING_PATHS_DIFF, { description: '- one\n- two\n\n1. three\n2. four' });
    try {
      await openDetails(page.locator('[data-pull-review]'));
      const box = page.locator('[data-pull-review] .ib-prr-desc-body');
      await expect(box).toContainText('four');
      expect(await box.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    } finally {
      await context.close();
    }
  }
});

test('a <details> cut by the fold keeps its lines inside; Show more draws the whole body', async ({ browser }) => {
  const lines = Array.from({ length: 300 }, (_, i) => `log line ${i} of the failing worker`);
  for (const inside of [lines.join('\n\n'), `\`\`\`\n${lines.join('\n')}\n\`\`\``]) {
    const description = `<details><summary>Logs</summary>\n\n${inside}\n\n</details>\n\nAFTER-THE-LOGS`;
    const { context, page } = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF, { description });
    try {
      await openDetails(page.locator('[data-pull-review]'));
      const section = page.locator('[data-pull-review] [data-pull-description]');
      await expect(section).toHaveAttribute('data-pull-description', 'folded');
      await expect(section.locator('details')).toHaveCount(1);
      await expect(section.locator('details')).not.toHaveAttribute('open', '');
      // No line of the log anywhere outside its box.
      const outside = await section.locator('.ib-prr-desc-body').evaluate((el) =>
        [...el.querySelectorAll('*')].filter((node) => !node.children.length && !node.closest('details') && /log line \d/.test(node.textContent ?? '')).length,
      );
      expect(outside).toBe(0);
      expect(await section.locator('.ib-prr-desc-body').evaluate((el) => /<\/?details/.test(el.textContent ?? ''))).toBe(false);
      await section.getByRole('button', { name: 'Show more' }).click();
      await expect(section).toContainText('AFTER-THE-LOGS');
    } finally {
      await context.close();
    }
  }
});

test('each layer shows its own description, through the forge read: Next layer changes it, Whole stack keeps it, none is none', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    const open = async (key: string, scope: string) => {
      await page.goto(`${world.url}#pulls&stack=${encodeURIComponent(STACK_ID)}&layer=${encodeURIComponent(key)}&scope=${scope}`);
      await page.reload();
      await expect(page.locator('[data-pull-review] [data-guide-file-shell]').first()).toBeVisible({ timeout: 30_000 });
    };
    const review = page.locator('[data-pull-review]');
    const section = review.locator('[data-pull-description]');
    await open(LAYER_413, 'layer');
    await openDetails(review);
    await expect(section).toHaveText('Backs off between the attempts.');
    await page.keyboard.press('Escape');
    // Another layer is another PR: its details do not stay open over it.
    await review.locator(`[data-pull-next-layer="${STACK_ID}"]`).click();
    await expect(review).toHaveAttribute('data-pull-review', STACK_ID);
    await expect(review.locator('[data-pull-details]')).toHaveCount(0);
    await openDetails(review);
    await expect(section).toHaveText('The emails, in a draft until they are reviewed.');
    await page.keyboard.press('Escape');
    await review.locator('[data-pull-layer-all]').click();
    await expect(review).toHaveAttribute('data-pull-scope', 'stack');
    await openDetails(review);
    await expect(section).toHaveText('The emails, in a draft until they are reviewed.');
    await open(LAYER_412, 'layer');
    await openDetails(review);
    await expect(section).toHaveCount(0);
    // A layer opens folded, whatever the last one did.
    await page.route('**/api/inbox/pulls/diff*', async (route) => {
      const real = await route.fetch().catch(() => null);
      if (real) await route.fulfill({ status: 200, json: { ...(await real.json()), description: Array.from({ length: 60 }, (_, i) => `Line ${i}.`).join('\n\n') } });
    });
    await open(LAYER_413, 'layer');
    await openDetails(review);
    await section.getByRole('button', { name: 'Show more' }).click();
    await expect(section).toHaveAttribute('data-pull-description', 'open');
    await page.keyboard.press('Escape');
    await review.locator(`[data-pull-next-layer="${STACK_ID}"]`).click();
    await expect(review).toHaveAttribute('data-pull-review', STACK_ID);
    await openDetails(review);
    await expect(section).toHaveAttribute('data-pull-description', 'folded');
  } finally {
    await context.close();
  }
});

test("the rail: a stack's layers stay in view over a tree of many files; on a phone the layer's place stays on one line", async ({ browser }) => {
  const file = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
  const patch = Array.from({ length: 80 }, (_, i) => file(`src/area-${i % 9}/file-${i}.ts`)).join('');
  await setCodeReview(true);
  for (const width of [1440, 390]) {
    const { context, page } = await stubbedReview(browser, width, patch, {}, 'layer', STACK_ID);
    try {
      const review = page.locator('[data-pull-review]');
      if (width === 390) {
        const of = review.locator('.ib-prp-of');
        await expect(of).toBeVisible();
        // A real stack's title fills the row.
        await review.locator('.ib-prp-this .ib-prp-title').evaluate((title) => { title.textContent = "Flat PR view: the review app's layering of background colours"; });
        expect(await of.evaluate((el) => el.getClientRects().length === 1 && el.getBoundingClientRect().height < 24)).toBe(true);
        continue;
      }
      const layers = review.locator('.ib-prp-layers');
      await expect(layers.locator('[data-pull-layer-row][aria-current="step"]')).toBeVisible();
      expect(await layers.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    } finally {
      await context.close();
    }
  }
});

test("the rail: Changes | All files, the repository at the head read; a file the PR does not change opens in place of the diff, and Changes brings the diff back", async ({ browser }) => {
  const patch = 'diff --git a/src/settings/Layout.tsx b/src/settings/Layout.tsx\n--- a/src/settings/Layout.tsx\n+++ b/src/settings/Layout.tsx\n@@ -1 +1 @@\n-a\n+b\n';
  // #880's head as the fake forge reads it around its patch (the list's `headRefOid`).
  const head = '880'.padStart(40, '0');
  const canned = (endpoint: string, value: unknown) => {
    const file = join(world.forge, `gh-${endpoint.replace(/[/.%?&=]/g, '_')}.json`);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const text = '{\n  "name": "web-app-settings"\n}\n';
  const files = [
    canned(`repos/northwind/web-app/git/trees/${head}?recursive=1`, { truncated: false, paths: ['package.json', 'src/i18n/fallback.ts', 'src/settings/Layout.tsx'] }),
    canned(`repos/northwind/web-app/contents/package.json?ref=${head}`, { type: 'file', sha: 'd'.repeat(40), size: text.length, encoding: 'base64', content: Buffer.from(text).toString('base64') }),
  ];
  await setCodeReview(true);
  const { context, page } = await stubbedReview(browser, 1440, patch);
  try {
    const review = page.locator('[data-pull-review]');
    const rail = review.locator('.ib-rrail');
    // The review app's switch at the rail's head: Changes, with the PR's count, on.
    await expect(rail.locator('[data-tree-scope="changes"]')).toHaveText('Changes1');
    await expect(rail.locator('[data-tree-scope="changes"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(rail.locator('[data-tree-scope="all"]')).toHaveText('All files');
    // All files: the repository at the head the patch was read at, a file the PR does not change among them.
    await rail.locator('[data-tree-scope="all"]').click();
    await expect(rail.locator('[data-repo-file="package.json"]')).toBeVisible();
    expect(forgeCalls()).toContain(`gh read repos/northwind/web-app/git/trees/${head}?recursive=1`);
    // Picked, it shows whole in place of the diff, in the review app's file view.
    await rail.locator('[data-repo-file="package.json"]').click();
    const shown = review.locator('[data-pull-repo-file="package.json"]');
    await expect(shown.locator('[data-not-in-review]')).toBeVisible();
    await expect(shown).toContainText('web-app-settings');
    await expect(review.locator('[data-guide-file-shell]').first()).toBeHidden();
    // Changes: the PR's own files, and the diff where it was.
    await rail.locator('[data-tree-scope="changes"]').click();
    await expect(shown).toHaveCount(0);
    await expect(rail.locator('[data-review-files]')).toBeVisible();
    await expect(review.locator('[data-guide-file-shell]').first()).toBeVisible();
  } finally {
    await context.close();
    for (const file of files) rmSync(file, { force: true });
  }
});

test('the rail: a long path gives way in its middle, on one line, its name whole while it fits, and no row fades', async ({ browser }) => {
  const file = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
  const short = 'ui.md';
  const long = 'guides-and-shared-ui.md';
  const deep = 'test/e2e/app-shell/render-worker-reads-its-own-source-and-its-fixtures';
  // A file of a thousand deletions widens the rail's biggest numbers, so a small pair beside it shows any gap.
  const wide = 'src/wide.ts';
  const wideFile = `diff --git a/${wide} b/${wide}\n--- a/${wide}\n+++ b/${wide}\n@@ -1,1000 +1,1 @@\n${'-a\n'.repeat(1000)}+b\n`;
  const patch = [file(`docs/agent-guides/and-more/long-folder/${short}`), file(`notes/agent-guides/with-a-long-folder-name/${long}`), file('crates/core/src/a.rs'), file('src/one.ts'), file(`${deep}/a.ts`), file(`${deep}/b.ts`), wideFile].join('');
  const { context, page } = await stubbedReview(browser, 1440, patch);
  try {
    const rail = page.locator('[data-pull-review] [data-review-files]');
    const row = (name: string) => rail.locator(`.ib-prp-file[data-review-file$="/${name}"]`);
    await expect(row(short)).toBeVisible({ timeout: 30_000 });
    // Each part's words against its box: cut is narrower than its words.
    const cut = (part: Locator) => part.evaluate((box) => {
      const range = document.createRange();
      range.selectNodeContents(box);
      return box.getBoundingClientRect().width + 0.5 < range.getBoundingClientRect().width;
    });
    const shown = (part: Locator) => part.evaluate((el) => {
      const line = el.closest('.ib-prp-fname')!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.top >= line.top - 0.5 && box.bottom <= line.bottom + 0.5;
    });
    // A short name: whole, with its folder before it, cut in the folder's middle so its last folder stays.
    for (const part of await row(short).locator('.ib-prp-base > *').all()) expect(await cut(part)).toBe(false);
    expect(await shown(row(short).locator('.ib-prp-dir'))).toBe(true);
    expect(await cut(row(short).locator('.ib-prp-dir .ib-prp-cut'))).toBe(true);
    expect(await cut(row(short).locator('.ib-prp-dir .ib-prp-keep'))).toBe(false);
    await expect(row(short).locator('.ib-prp-dir .ib-prp-cut')).toHaveCSS('text-overflow', 'ellipsis');
    // A long name keeps the line: its folder leaves it whole, never a sliver.
    for (const part of await row(long).locator('.ib-prp-base > *').all()) expect(await cut(part)).toBe(false);
    expect(await shown(row(long).locator('.ib-prp-dir'))).toBe(false);
    // A folder whose last folder is longer than the row keeps that folder's end in view, whole: it gives way in its
    // own middle once the folders before it are spent, never at its end.
    const folder = rail.locator(`[data-review-folder="${deep}"] .ib-prp-folder`);
    await expect(folder.locator('.ib-prp-end')).toHaveText('-fixtures');
    expect(await cut(folder.locator('.ib-prp-dirname > .ib-prp-cut'))).toBe(true);
    expect(await cut(folder.locator('.ib-prp-cut2'))).toBe(true);
    expect(await cut(folder.locator('.ib-prp-end'))).toBe(false);
    expect(await folder.locator('.ib-prp-end').evaluate((el) => el.getBoundingClientRect().right <= el.closest('.ib-prp-fname')!.getBoundingClientRect().right + 0.5)).toBe(true);
    // Every row and folder is one line, and nothing is masked into a fade.
    const looks = await rail.evaluate((list) =>
      [...list.querySelectorAll('.ib-prp-file, .ib-prp-folder')].map((el) => ({
        lines: Math.round(el.getBoundingClientRect().height / 20),
        masked: [...el.querySelectorAll('*')].some((part) => getComputedStyle(part).maskImage !== 'none' || getComputedStyle(part).direction === 'rtl'),
      })),
    );
    expect(looks.length).toBeGreaterThanOrEqual(4);
    for (const look of looks) expect(look).toEqual({ lines: 1, masked: false });
    // Each row shows its numbers; the tip has the whole path.
    await expect(row(short).locator('.review-count-columns')).toHaveText('+1-1');
    // The review app's row: [viewed][letter] name, 6 px apart, its numbers 8 px from the row's end, nothing between.
    const anatomy = await row(short).evaluate((el) => {
      const at = (sel: string) => el.querySelector(sel)!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        order: at('[role="checkbox"]').right <= at('.review-change-letter').left + 2 && at('.review-change-letter').right <= at('.ib-prp-fname').left + 2,
        gap: style.columnGap,
        end: Math.round(box.right - at('.review-count-columns').right),
        letter: el.querySelector('.review-change-letter')!.textContent,
      };
    });
    expect(anatomy).toEqual({ order: true, gap: '6px', end: 8, letter: 'M' });
    // A row's +/- are one pair at its end: the − number's right edge on the row's end padding, the + at most 6 px before
    // it, beside a far wider number elsewhere on the rail; a folder's sums the same.
    const pair = (el: Locator) => el.evaluate((box) => {
      const row = box.getBoundingClientRect();
      const add = box.querySelector('.review-count-columns .additions')!.getBoundingClientRect();
      const del = box.querySelector('.review-count-columns .deletions')!.getBoundingClientRect();
      return { end: Math.round(row.right - del.right), gap: Math.round(del.left - add.right) };
    });
    for (const one of [await pair(row(short)), await pair(rail.locator(`[data-review-folder="${deep}"] .ib-prp-folder`))]) {
      expect(one.end).toBe(8);
      expect(one.gap).toBeLessThanOrEqual(6);
    }
    await expect(row('wide.ts').locator('.review-count-columns')).toHaveText('+1-1000');
    await row(long).hover();
    await expect(page.locator('[data-pn-tooltip]')).toContainText(`notes/agent-guides/with-a-long-folder-name/${long}`);
  } finally {
    await context.close();
  }
});

test('the next file\'s header right under the last code row, whatever separators a file draws: above its first hunk, between hunks, in Split and Unified', async ({ browser }) => {
  const hunk = (at: number) => `@@ -${at},3 +${at},3 @@\n ctx\n-old\n+new\n ctx\n`;
  const file = (path: string, ...ats: number[]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${ats.map(hunk).join('')}`;
  const patch = [file('one-at-the-top.ts', 1), file('one-further-down.ts', 27), file('two-hunks.ts', 1, 40), file('three-hunks.ts', 10, 40, 80), file('last.ts', 1)].join('');
  const { context, page } = await stubbedReview(browser, 1440, patch);
  try {
    const review = page.locator('[data-pull-review]');
    await expect(review.locator('[data-guide-file-shell]')).toHaveCount(5);
    await expect.poll(() => seams(review)).toEqual([0, 0, 0, 0]);
    await review.locator('.ib-vhead [data-diff-layout-toggle="split"]').click();
    await expect.poll(() => seams(review)).toEqual([0, 0, 0, 0]);
  } finally {
    await context.close();
  }
});

test('the row after the last hunk (approval pr-view-one-surface, 11-07 19:08): no row there, as in the code review app, whatever the file\'s length; nothing read for it; never "More unchanged context may be available"', async ({ browser }) => {
  const OLD = ['one', 'two', 'three', 'four', 'five'];
  const NEW = ['one', 'two', 'THREE', 'four', 'five'];
  const file = (path: string) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,5 +1,5 @@\n one\n two\n-three\n+THREE\n four\n five\n`;
  const text = (lines: string[]) => `${lines.join('\n')}\n`;
  // The whole texts the arrows' reader would get: more.ts goes on for two lines after its hunk, ends.ts stops with it.
  const reads: string[] = [];
  const contents: Record<string, { oldContent: string; newContent: string }> = {
    'more.ts': { oldContent: text([...OLD, 'six', 'seven']), newContent: text([...NEW, 'six', 'seven']) },
    'ends.ts': { oldContent: text(OLD), newContent: text(NEW) },
  };
  const { context, page } = await stubbedReview(browser, 1440, file('more.ts') + file('ends.ts'));
  try {
    await page.route('**/api/inbox/pulls/file*', (route) => {
      const path = new URL(route.request().url()).searchParams.get('path') ?? '';
      reads.push(path);
      return route.fulfill({ status: 200, json: contents[path] ?? { oldContent: null, newContent: null } });
    });
    await page.reload();
    const review = page.locator('[data-pull-review]');
    await expect(review.locator('[data-guide-file-shell]')).toHaveCount(2);
    // The trailing row's words as drawn, per file by path (the page draws the files in the rail's order, not the
    // patch's), only where they show.
    const rows = () =>
      review.locator('[data-guide-file-shell]').evaluateAll((shells) =>
        Object.fromEntries(
          shells.map((shell) => {
            const path = (shell as HTMLElement).dataset.guideFileShell;
            const row = shell.querySelector('diffs-container')?.shadowRoot?.querySelector<HTMLElement>('[data-separator-last]');
            return [path, row && row.checkVisibility() ? row.innerText.trim() : null];
          }),
        ),
      );
    await expect.poll(() => seams(review)).toEqual([0]);
    await expect.poll(rows).toEqual({ 'more.ts': null, 'ends.ts': null });
    expect(reads).toEqual([]);
    expect(await review.evaluate((root) => [...root.querySelectorAll('diffs-container')].some((host) => (host.shadowRoot?.textContent ?? '').includes('More unchanged context') && [...host.shadowRoot!.querySelectorAll<HTMLElement>('[data-separator-last]')].some((row) => row.checkVisibility())))).toBe(false);
  } finally {
    await context.close();
  }
});

test("a tooltip on screen does not take a sheet's Escape: ui's on the rail's Viewed circle", async ({ browser }) => {
  const { context, page } = await stubbedReview(browser, 1100, COLLIDING_PATHS_DIFF);
  try {
    const review = page.locator('[data-pull-review]');
    const panel = review.locator('.ib-gpanel');
    const comments = review.locator('.ib-vcomments');
    const tip = page.locator('[data-pn-tooltip]');
    const row = review.locator('[data-review-files] .ib-prp-file').first();
    const closesOverTip = async (hoverIt: () => Promise<void>) => {
      await comments.click();
      await expect(panel).toBeVisible();
      await hoverIt();
      await expect(tip).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(tip).toHaveCount(0);
      await expect(review).toBeVisible();
    };
    await closesOverTip(async () => {
      await row.hover();
      await row.locator('[role="checkbox"]').hover();
    });
  } finally {
    await context.close();
  }
});

test('Escape closes an open sheet wherever focus is; what used the key keeps it, and Tab out of a sheet closes it', async ({ browser }) => {
  const { context, page } = await stubbedReview(browser, 1280, COLLIDING_PATHS_DIFF);
  try {
    const review = page.locator('[data-pull-review]');
    // The sidebar's room, for the diff beside the sheet. The pointer off the left edge first: a new page's pointer rests
    // at 0,0 in Linux's Chromium, where the closed sidebar's peek would show the navigation again.
    await page.mouse.move(700, 450);
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.locator('.ib-side').getByRole('button', { name: /Reviews/ })).toBeHidden();
    const panel = review.locator('.ib-gpanel');
    const comments = review.locator('.ib-vcomments');
    const esc = () => page.keyboard.press('Escape');
    // Closed, back on its button, the review still open.
    const closes = async () => {
      await esc();
      await expect(panel).toBeHidden();
      await expect(comments).toBeFocused();
      await expect(review).toBeVisible();
    };

    // From its own button, and from a click on its heading.
    await comments.click();
    await comments.focus();
    await closes();
    await comments.click();
    await panel.locator('.ib-sheet-h b').click();
    await closes();

    // A click on the diff beside it leaves the sheet open, and Escape still closes it. On a line's code past its words, not
    // its number or the gutter's + that overlaps the code's start: those open the line's composer, which would take the
    // Escape (below). Found by its row, never a fixed point on the page.
    const code = review.locator('[data-guide-file-shell="aaa.ts"] [data-line][data-line-type="context"]').first();
    await comments.click();
    await code.click({ position: { x: 80, y: 4 } });
    await expect(comments).not.toBeFocused();
    await expect(page.getByPlaceholder('Leave feedback...')).toHaveCount(0);
    await expect(panel).toBeVisible();
    await closes();

    // A line's composer takes the first Escape.
    const line = review.locator('[data-guide-file-shell="src/app.ts"] [data-line-type="change-addition"][data-column-number]').first();
    await comments.click();
    await line.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await line.click({ position: { x: 4, y: 4 } });
    const composer = page.getByPlaceholder('Leave feedback...');
    await expect(composer).toBeFocused();
    await esc();
    await expect(composer).toBeHidden();
    await expect(panel).toBeVisible();
    await closes();

    // So does the global comment's.
    const addGlobal = review.locator('[data-guide-global-comment-add]');
    const global = page.locator('[data-comment-popover]').getByPlaceholder('Add a global comment…');
    await comments.click();
    await addGlobal.click();
    await expect(global).toBeFocused();
    await esc();
    await expect(global).toBeHidden();
    // Focus is back on what opened the composer, a frame later.
    await expect(addGlobal).toBeFocused();
    await expect(panel).toBeVisible();
    await closes();

    // A card's edit takes it too. (Its words are the panel's business, shared with the review app.)
    await line.click({ position: { x: 4, y: 4 } });
    await composer.fill('A line comment to edit.');
    await page.getByRole('button', { name: 'Add Comment' }).click();
    await comments.click();
    const card = panel.locator('[data-annotation-id]').first();
    await card.hover();
    await card.getByRole('button', { name: 'Edit annotation' }).click();
    const edit = panel.locator('textarea').first();
    await expect(edit).toBeFocused();
    await esc();
    await expect(edit).toBeHidden();
    await expect(panel).toBeVisible();
    await closes();
    // The world's other tests read this PR: its comment goes.
    await comments.click();
    await card.hover();
    await card.getByRole('button', { name: /delete/i }).click();
    await expect(card).toHaveCount(0);
    await closes();

    // A menu's Escape is the menu's: the decision's other choices over an open sheet.
    await comments.click();
    await page.getByRole('button', { name: 'More decisions' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await esc();
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(panel).toBeVisible();
    await closes();
  } finally {
    await context.close();
  }

  // On a phone the rail is the sheet: the same closing, and Tab past its last row closes it.
  const phone = await stubbedReview(browser, 390, COLLIDING_PATHS_DIFF);
  try {
    const review = phone.page.locator('[data-pull-review]');
    const rail = review.locator('.ib-rrail');
    const files = review.locator('[data-pull-review-files-button]');
    const closes = async () => {
      await phone.page.keyboard.press('Escape');
      await expect(rail).toBeHidden();
      await expect(files).toBeFocused();
      await expect(review).toBeVisible();
    };
    await files.click();
    await files.focus();
    await closes();
    await files.click();
    // A click on nothing in the sheet: the head's right end, clear of its Changes | All files switch.
    await review.locator('.ib-prp-fileshead').click({ position: { x: (await review.locator('.ib-prp-fileshead').boundingBox())!.width - 2, y: 6 } });
    await closes();
    // Focus never lands unseen on what the sheet covered.
    await files.click();
    await review.locator('[data-review-files] [data-review-file]').last().focus();
    // The row, then its circle, which shows for the focus; then out.
    await phone.page.keyboard.press('Tab');
    await expect(review.locator('[data-review-files] [data-review-file]').last().locator('[role="checkbox"]')).toBeFocused();
    await phone.page.keyboard.press('Tab');
    await expect(rail).toBeHidden();
    expect(await phone.page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    await expect(review).toBeVisible();
  } finally {
    await phone.context.close();
  }
});

test('every changed file stays in the review: rows for what the tree cannot hold, the diffs in the rail\'s order, Viewed from circle, header and reload', async ({ browser }) => {
  const { context, page } = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF);
  try {
    const review = page.locator('[data-pull-review]');
    const paths = () => review.locator('[data-review-file]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-review-file')!));
    const railOrder = await paths();
    // Git has README.md first: the tree puts the folder first, and the three files it has no node for come after it.
    expect(railOrder).toEqual(['src/app.ts', 'src/extraordinarily-long-module-file-name-for-the-rail-12.ts', 'a-link', 'aaa.ts', 'docs', 'README.md', 'a-link', 'docs/guide/intro.md', 'docs/index.md']);
    await expect(review.locator('.ib-prp-fileshead')).toHaveText('Changes9All files');
    // A row the tree could not place reads as its full path.
    await expect(review.locator('[data-review-file="docs/guide/intro.md"]')).toContainText('docs/guide/intro.md');
    // The diffs follow the rail, each path drawn once.
    const diffOrder = await review.locator('[data-guide-file-shell]').evaluateAll((shells) => shells.map((shell) => shell.getAttribute('data-guide-file-shell')!));
    expect(diffOrder).toEqual([...new Set(railOrder)]);
    // Of a symlink turned into a file the viewer draws one half: the new file's.
    await expect(review.locator('[data-guide-file-shell="a-link"]')).toContainText('+1');

    // A long name gives way in its middle and keeps its end in view, and the whole of it is in its tip.
    const cutName = await review.locator('[data-review-file^="src/extraordinarily"] .ib-prp-base').evaluate((name) => {
      const head = name.querySelector('.ib-prp-cut')!;
      const range = document.createRange();
      range.selectNodeContents(name.querySelector('.ib-prp-keep')!);
      const box = name.getBoundingClientRect();
      return { cut: head.scrollWidth > head.clientWidth, endInView: range.getBoundingClientRect().right <= box.right + 1, end: name.querySelector('.ib-prp-keep')?.textContent };
    });
    expect(cutName).toEqual({ cut: true, endInView: true, end: '-12.ts' });
    await review.locator('[data-review-file^="src/extraordinarily"] .ib-prp-base').hover();
    await expect(page.locator('[data-pn-tooltip]')).toContainText('src/extraordinarily-long-module-file-name-for-the-rail-12.ts');
    // Any row's tip has its path; its +/- are on the row.
    await review.locator('[data-review-file="aaa.ts"] .ib-prp-base').hover();
    await expect(page.locator('[data-pn-tooltip]')).toContainText('aaa.ts');
    await expect(review.locator('[data-review-file="aaa.ts"] .review-count-columns')).toHaveText(/\+\d+/);

    // A path's two rows differ for a screen reader.
    expect(await review.locator('[data-review-file="a-link"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')))).toEqual(['a-link, added', 'a-link, deleted']);
    // The circle names its file, ticks without moving to it, and shows on the file's header.
    const circle = review.locator('[data-review-file="src/app.ts"] [role="checkbox"]');
    const header = review.locator('[data-guide-file-shell="src/app.ts"]').getByRole('button', { name: /viewed/i }).first();
    await expect(circle).toHaveAttribute('aria-label', 'Mark src/app.ts as viewed');
    await expect(circle).toHaveAttribute('aria-checked', 'false');
    const scroller = review.locator('.ib-gbody');
    const scrolled = await scroller.evaluate((el) => el.scrollTop);
    // It is always there, as in the review app's tree.
    await expect(circle).toBeVisible();
    await circle.click();
    await expect(circle).toHaveAttribute('aria-checked', 'true');
    await expect(review.locator('.ib-prp-fileshead')).toHaveText('Changes9All files1 viewed');
    await expect(review.locator('[data-review-file="src/app.ts"]')).toHaveAttribute('aria-label', 'src/app.ts, viewed');
    await expect(header).toHaveAttribute('title', /not viewed/);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrolled);

    // A path with two rows counts twice, so every row can end viewed.
    await review.locator('[data-review-file="a-link"]').first().hover();
    await review.locator('[data-review-file="a-link"] [role="checkbox"]').first().click();
    await expect(review.locator('.ib-prp-fileshead')).toHaveText('Changes9All files3 viewed');

    // A reload keeps them; the header's button takes the tick back off the circle.
    await page.reload();
    await expect(header).toBeVisible({ timeout: 30_000 });
    await expect(circle).toHaveAttribute('aria-checked', 'true');
    await expect(review.locator('.ib-prp-fileshead')).toHaveText('Changes9All files3 viewed');
    await header.click();
    await expect(circle).toHaveAttribute('aria-checked', 'false');
    await expect(review.locator('.ib-prp-fileshead')).toHaveText('Changes9All files2 viewed');
  } finally {
    await context.close();
  }
});

test('the sheets cover the diff and nothing else at 800 and 1100, a phone\'s Comments the whole window; on a phone the Files sheet opens the same tree', async ({ browser }) => {
  for (const width of [1100, 800]) {
    const { context, page } = await stubbedReview(browser, width, COLLIDING_PATHS_DIFF);
    try {
      const review = page.locator('[data-pull-review]');
      await review.locator('.ib-vcomments').click();
      const panel = review.locator('.ib-gpanel');
      await expect(panel).toBeVisible();
      const sheet = (await panel.boundingBox())!;
      const body = (await review.locator('.ib-gbody').boundingBox())!;
      expect(Math.abs(sheet.y - body.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(sheet.y + sheet.height - (body.y + body.height))).toBeLessThanOrEqual(1);
      // Whatever sits in the bar is what a click there reaches.
      const uncovered = await review.locator('.ib-vhead :is(button, input, a)').evaluateAll((controls) =>
        controls.filter((control) => {
          const box = control.getBoundingClientRect();
          if (!box.width) return false;
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return !!hit?.closest('.ib-gpanel');
        }).length,
      );
      expect(uncovered).toBe(0);
    } finally {
      await context.close();
    }
  }

  // A phone's Comments sheet takes the whole window, the page hidden under it; Close gives focus back to the button.
  {
    const { context, page } = await stubbedReview(browser, 390, COLLIDING_PATHS_DIFF);
    try {
      const review = page.locator('[data-pull-review]');
      const button = review.locator('.ib-vcomments');
      await button.click();
      const panel = review.locator('.ib-gpanel');
      await expect(panel).toBeVisible();
      const sheet = (await panel.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(Math.abs(sheet.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(sheet.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(sheet.width - viewport.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(sheet.height - viewport.height)).toBeLessThanOrEqual(1);
      await expect(review.locator('.ib-vhead')).toBeHidden();
      await expect(review.locator('.ib-gbody')).toBeHidden();
      await expect(panel.getByRole('button', { name: 'Close the comments' })).toBeFocused();
      await panel.getByRole('button', { name: 'Close the comments' }).click();
      await expect(review.locator('.ib-vhead')).toBeVisible();
      await expect(button).toBeFocused();
    } finally {
      await context.close();
    }
  }

  const { context, page } = await stubbedReview(browser, 390, COLLIDING_PATHS_DIFF);
  try {
    const review = page.locator('[data-pull-review]');
    const rail = review.locator('.ib-rrail');
    const button = review.locator('[data-pull-review-files-button]');
    await expect(rail).toBeHidden();
    await expect(button).toHaveAttribute('aria-label', 'Files, 9');
    await button.click();
    await expect(rail).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    // Focus opens on the first row, and Escape closes the sheet, back on its button, the review still open.
    await expect(review.locator('[data-review-files] button').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(rail).toBeHidden();
    await expect(button).toBeFocused();
    await expect(review).toBeVisible();
    await button.click();
    await expect(rail).toBeVisible();
    const sheet = (await rail.boundingBox())!;
    const body = (await review.locator('.ib-gbody').boundingBox())!;
    expect(Math.abs(sheet.y - body.y)).toBeLessThanOrEqual(1);
    // One sheet at a time: Comments closes Files. A phone's Comments takes the whole window, so Files is not reached
    // from it; closed, the page is back with no Files sheet.
    await review.locator('.ib-vcomments').click();
    await expect(rail).toBeHidden();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await review.locator('.ib-gpanel').getByRole('button', { name: 'Close the comments' }).click();
    await expect(review.locator('.ib-gpanel')).toBeHidden();
    await expect(rail).toBeHidden();
    await button.click();
    await expect(rail).toBeVisible();
    // The circle leaves the sheet open; picking a file closes it, shows the file and gives focus back to the button.
    await review.locator('[data-review-file="src/app.ts"]').hover();
    await review.locator('[data-review-file="src/app.ts"] [role="checkbox"]').click();
    await expect(rail).toBeVisible();
    await review.locator('[data-review-file="docs/index.md"]').click();
    await expect(rail).toBeHidden();
    await expect(button).toBeFocused();
    await expect(review.locator('[data-guide-file-shell="docs/index.md"]')).toBeInViewport();
    // The comments' sheet closes the same way: Escape from inside, its X, each back on its button.
    const comments = review.locator('.ib-vcomments');
    const panel = review.locator('.ib-gpanel');
    await comments.click();
    await panel.getByRole('button', { name: 'Close the comments' }).focus();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(comments).toBeFocused();
    await comments.click();
    await panel.getByRole('button', { name: 'Close the comments' }).click();
    await expect(panel).toBeHidden();
    await expect(comments).toBeFocused();

    // Out of the phone the rail is a column again, with focus on it, never on the page; an open sheet does not come
    // back on the way back in.
    await button.click();
    await expect(rail).toBeVisible();
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect(button).toHaveCount(0);
    await expect(rail).toBeVisible();
    await expect(review.locator('[data-review-files] button').first()).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rail).toBeHidden();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await context.close();
  }
});

test('a stack in the rail: the layer on screen says so, and All layers is not pressed on a layer', async ({ browser }) => {
  const { context, page } = await stubbedReview(browser, 1280, COLLIDING_PATHS_DIFF, {}, 'layer', STACK_ID);
  try {
    const review = page.locator('[data-pull-review]');
    const here = review.locator('[data-pull-layer-row][aria-current="step"]');
    await expect(here).toBeVisible();
    await expect(here).toContainText('This layer');
    await expect(review.locator('[data-pull-layer-all]')).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await context.close();
  }
});

test('the sidebar toggle: first in the bar, ⌘B and the button both hide and show it, and the page takes the room', async ({ browser }) => {
  const { context, page } = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF);
  try {
    const review = page.locator('[data-pull-review]');
    const trigger = review.locator('.ib-vhead [data-sidebar="trigger"]');
    const left = async () => (await review.boundingBox())!.x;
    await expect(review.locator('.ib-vhead > :first-child')).toHaveAttribute('data-sidebar', 'trigger');
    // Open: the page sits beside the sidebar, whose rows a click reaches. Nothing lies under the page.
    const reviews = page.locator('.ib-side').getByRole('button', { name: /Reviews/ }).first();
    await expect(reviews).toBeVisible();
    const row = (await reviews.boundingBox())!;
    expect(await left()).toBeGreaterThanOrEqual(row.x + row.width);
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.ib-side'), [row.x + 8, row.y + 8])).toBe(true);
    const beside = await left();
    // The key hides it and the page takes the room; the rail stays. The pointer off the left edge, where the closed
    // sidebar's peek would show the navigation (a new page's pointer rests at 0,0 in Linux's Chromium).
    await page.mouse.move(700, 450);
    await page.keyboard.press('ControlOrMeta+b');
    await expect.poll(left).toBeLessThan(beside - 100);
    await expect(review.locator('.ib-rrail')).toBeVisible();
    await expect(reviews).toBeHidden();
    // The button brings it back.
    await trigger.click();
    await expect.poll(left).toBe(beside);
    await expect(reviews).toBeVisible();
    // A narrow window keeps the rail and the sidebar; the toggle is how to give the code the room.
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(review.locator('.ib-rrail')).toBeVisible();
    await expect(reviews).toBeVisible();
    await expect(review.locator('[data-pull-review-files-button]')).toHaveCount(0);
    const narrow = (await review.locator('.ib-gbody').boundingBox())!.width;
    await trigger.click();
    await expect.poll(async () => (await review.locator('.ib-gbody').boundingBox())!.width).toBeGreaterThan(narrow + 100);
  } finally {
    await context.close();
  }
});

test('the rail\'s edge drags, within its limits, and keeps its width over a reload', async ({ browser }) => {
  const { context, page } = await stubbedReview(browser, 1440, COLLIDING_PATHS_DIFF);
  try {
    const review = page.locator('[data-pull-review]');
    const rail = review.locator('.ib-rrail');
    const width = async () => (await rail.boundingBox())!.width;
    const before = await width();
    const drag = async (by: number) => {
      const handle = (await review.locator('[data-pull-rail-handle]').boundingBox())!;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 300);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + by, handle.y + 300, { steps: 4 });
      await page.mouse.up();
    };
    await drag(60);
    await expect.poll(width).toBe(before + 60);
    await page.reload();
    await expect(rail).toBeVisible({ timeout: 30_000 });
    await expect.poll(width).toBe(before + 60);
    // Never past its limits, and the diff keeps the rest.
    await drag(2000);
    await expect.poll(width).toBe(480);
    await drag(-2000);
    await expect.poll(width).toBe(180);
  } finally {
    await context.close();
  }
});

test('the rail follows Text size', async ({ browser }) => {
  const { context, page } = await stubbedReview(browser, 1280, COLLIDING_PATHS_DIFF);
  try {
    const review = page.locator('[data-pull-review]');
    // The rail reads the window's type ramp.
    await review.evaluate((section) => section.style.setProperty('--ib-fs-12-5', '19px'));
    await expect(review.locator('[data-review-file="aaa.ts"] .ib-prp-base')).toHaveCSS('font-size', '19px');
    await review.evaluate((section) => section.style.removeProperty('--ib-fs-12-5'));
  } finally {
    await context.close();
  }
});

test('the flat PR view: quiet words on the controls\' row, the comments column\'s fill, a file\'s scrollbar under the pointer only', async ({ browser }) => {
  // A window of its own: the stubbed diff stays out of the shared window's cache of the diffs it read.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  // A file with one line past the column's width, in place of a layer's real diff.
  const long = `diff --git a/src/long.ts b/src/long.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/long.ts\n@@ -0,0 +1,2 @@\n+export const ROW_1 = '${'a very long line '.repeat(40)}';\n+export const ROW_2 = 2;\n`;
  await page.route('**/api/inbox/pulls/diff*', async (route) => {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { ...(await answer.json()), patch: long } });
  });
  try {
    await page.goto(`${world.url}#pulls&stack=${encodeURIComponent(TEAMMATE)}&layer=${encodeURIComponent(TEAMMATE)}&scope=layer`);
    const review = page.locator('[data-pull-review]');
    const shell = review.locator('[data-guide-file-shell="src/long.ts"]');
    const box = shell.locator('[data-guide-code-view-mounted="true"]');
    await expect(box).toBeVisible({ timeout: 30_000 });

    // Whose PR it is: plain words (no band) beside its title, while the bar has room; never "tomas's pull request".
    const note = review.locator('[data-pull-review-readonly]');
    await expect(note).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(note).toHaveText('by tomas');
    // With his face by his name (the owner, q-331c0466).
    await expect(note.locator('[data-person="tomas"] [data-face="tomas"]')).toHaveCount(1);
    // The bar has it beside the title while there is room. Short of room (800 wide, the diff controls in the bar too) it
    // gives way before the title does: the title's tip names the author as well.
    for (const width of [1040, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(review.locator('.ib-vhead [data-pull-review-readonly]')).toBeVisible();
    }
    await page.setViewportSize({ width: 800, height: 900 });
    const narrow = await review.evaluate((root) => {
      const width = (selector: string) => root.querySelector(selector)!.getBoundingClientRect().width;
      return { title: width('[data-pull-review-title]') > width('[data-pull-review-readonly]') + 24, overflow: root.querySelector('.ib-vhead')!.scrollWidth - root.querySelector('.ib-vhead')!.clientWidth };
    });
    expect(narrow).toEqual({ title: true, overflow: 0 });
    await page.setViewportSize({ width: 1440, height: 900 });
    // A long name is cut on that row, never under the controls.
    const words = await note.evaluate((node) => {
      const before = node.textContent;
      node.textContent = `by ${'a-very-long-name-'.repeat(20)}`;
      return before;
    });
    for (const width of [800, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const out = await review.evaluate((root) => {
        const words = root.querySelector('[data-pull-review-readonly]')!.getBoundingClientRect();
        const add = root.querySelector('[data-guide-global-comment-add]')!.getBoundingClientRect();
        return words.right <= add.left;
      });
      expect([width, out]).toEqual([width, true]);
    }
    await note.evaluate((node, text) => (node.textContent = text), words);

    // From 1500 wide the comments are a column beside the diff, closed at first and opened by the bar's Comments button;
    // open, it is framed as the Guided Review's panel: the card's fill and a hairline down its left. Folded, a card.
    const fill = () =>
      review.evaluate((root) => {
        const token = (name: string) => {
          const probe = root.appendChild(document.createElement('div'));
          probe.style.background = `var(${name})`;
          const value = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return value;
        };
        const panel = getComputedStyle(root.querySelector('.ib-gpanel')!);
        const inner = getComputedStyle(root.querySelector('.ib-gpanel > [data-annotation-panel]')!);
        return { display: panel.display, panel: panel.backgroundColor, inner: inner.backgroundColor, edge: panel.borderLeftWidth, card: token('--card') };
      });
    await page.setViewportSize({ width: 1800, height: 900 });
    await expect.poll(async () => (await fill()).display).toBe('none');
    await review.locator('.ib-vhead .ib-vcomments').click();
    await expect.poll(async () => (await fill()).display).toBe('flex');
    const column = await fill();
    expect([column.panel, column.inner, column.edge]).toEqual([column.card, column.card, '1px']);
    // Crossing the fold closes it.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await fill()).display).toBe('none');
    await review.locator('.ib-vhead .ib-vcomments').click();
    await expect.poll(async () => (await fill()).display).toBe('flex');
    const sheet = await fill();
    expect(sheet.panel).toBe(sheet.card);
    expect(sheet.inner).toBe(sheet.card);
    await review.getByRole('button', { name: 'Close the comments' }).click();

    // The file's header keeps its 33 px.
    expect((await shell.locator('[data-file-header]').first().boundingBox())!.height).toBe(33);
  } finally {
    await context.close();
  }
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
    // The picker is the whole screen on a phone: something can be found and picked there.
    await box.locator('[data-review-pick]').click();
    const phonePicker = box.locator('[data-review-pulls]');
    const onScreen = await phonePicker.boundingBox();
    expect(onScreen).toMatchObject({ x: 0, y: 0, width: 390 });
    expect(onScreen!.height).toBeGreaterThan(700);
    await expect(phonePicker.getByRole('combobox')).toBeInViewport();
    await shot(page, 'phone-4b-picker', ['light']);
    await phonePicker.locator('.ib-cp-rvopt').first().click();
    await expect(phonePicker).toHaveCount(0);
    await box.locator('[data-compose-text] textarea').fill('what changes for Arabic and Hebrew');
    await shot(page, 'phone-5-ask-custom');
    await box.locator('[data-compose-cancel]').click();
    await expect(box).toHaveCount(0);
    // Every control in the row under the review's bar is a 44 px target or more on a phone (its 30 px plus its hit area).
    for (const box of await review.locator('.ib-prp-row2 button').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height + 14))) expect(box).toBeGreaterThanOrEqual(36);
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

/** From each file's code to the next file's header; null while either is not drawn yet (each file mounts on its own), so a poll waits. */
function seams(review: Locator): Promise<(number | null)[]> {
  return review.locator('[data-guide-file-shell]').evaluateAll((shells) =>
    shells.slice(1).map((shell, index) => {
      const head = shell.querySelector('[slot="header-custom"]');
      const code = shells[index]!.querySelector('diffs-container');
      return head && code ? head.getBoundingClientRect().top - code.getBoundingClientRect().bottom : null;
    }),
  );
}

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
  // The card's name line, as in the review app: the person's own name from the same source, marked as theirs.
  await expect(page.locator('.review-comment-header', { hasText: `${DISPLAY_NAME} (me)` }).first()).toBeVisible();
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
  // Marks, no words: each named for a screen reader and in its tip.
  await expect(choice.getByRole('radio', { name: 'Post to the PR on GitHub' })).toHaveCount(1);
  await expect(choice.getByRole('radio', { name: 'Send to Claude Code' })).toHaveCount(1);
  await review.locator('[data-review-destination-choice="forge"]').hover();
  await expect(page.locator('[data-pn-tooltip]')).toContainText('Post to the PR on GitHub');
  await review.locator('[data-review-destination-choice="forge"]').click();
  await expect(review.locator('[data-review-posts="github"]')).toBeVisible();
  await expect(review.locator('[data-review-destination-choice="forge"]')).toHaveAttribute('data-on', '');
  // GitHub refuses an approval of your own PR, so Approve rests while its caret stays live: one control, one fill.
  const ownApprove = review.locator('[data-review-posts] [data-decision-primary]');
  await expect(ownApprove).toHaveAttribute('aria-disabled', 'true');
  const look = (el: Element) => { const css = getComputedStyle(el); return [css.backgroundColor, css.opacity]; };
  const ownCaret = review.locator('[data-review-posts] [data-decision-caret]');
  const atRest = await ownApprove.evaluate(look);
  expect(atRest).toEqual(await ownCaret.evaluate(look));
  // Under the pointer: Approve does not change, and the caret lightens its own fill. Neither shows the enabled green.
  await ownApprove.hover();
  await expect.poll(() => ownApprove.evaluate(look)).toEqual(atRest);
  await page.waitForTimeout(250);
  expect(await ownApprove.evaluate(look)).toEqual(atRest);
  await ownCaret.hover();
  await page.waitForTimeout(250);
  const caretHover = await ownCaret.evaluate(look);
  expect(caretHover[0]).not.toBe(atRest[0]);
  // The grey's own hue: an oklab colour with next to no chroma, where the enabled green has plenty.
  const [, greenRed, blueYellow] = caretHover[0].match(/-?[\d.]+/g)!.map(Number);
  expect(Math.hypot(greenRed, blueYellow)).toBeLessThan(0.03);
  await page.mouse.move(2, 2);
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
  expect(JSON.stringify(sent)).not.toContain(DISPLAY_NAME);
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

test('a PR of 21 small files on a tall window: every file on screen draws, all the way down', async ({ browser }) => {
  const patch = Array.from({ length: 21 }, (_, i) => {
    const path = `src/small/f${String(i).padStart(2, '0')}.ts`;
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n export const a = 1;\n-export const b = ${i};\n+export const b = ${i + 1};\n`;
  }).join('');
  const context = await browser.newContext({ viewport: { width: 1920, height: 1200 }, colorScheme: 'light' });
  const page = await context.newPage();
  await page.route('**/api/inbox/pulls/diff*', async (route) => {
    const real = await route.fetch();
    await route.fulfill({ response: real, json: { ...(await real.json()), patch } });
  });
  try {
    await page.goto(`${world.url}#pulls&stack=${encodeURIComponent(TEAMMATE)}&layer=${encodeURIComponent(TEAMMATE)}&scope=layer`);
    const body = page.locator('[data-pull-review] .ib-gbody');
    await expect(body.locator('[data-guide-file-shell]')).toHaveCount(21, { timeout: 30_000 });
    await expectNoBlankFiles(body);
  } finally {
    await context.close();
  }
});

test('the expand arrows on the PR page: read from the forge, opening a gap grows the box; a comment on an opened line posts in the main comment', async () => {
  const { page } = world;
  // A page with no diff holds no workers.
  await page.goto(`${world.url}#pulls`);
  await page.reload();
  await expect(page.locator(`[data-pulls-row="${TEAMMATE}"]`)).toBeVisible({ timeout: 30_000 });
  expect(page.workers()).toEqual([]);
  await page.goto(`${world.url}#pulls&stack=${encodeURIComponent(TEAMMATE)}&layer=${encodeURIComponent(TEAMMATE)}&scope=layer`);
  const review = page.locator('[data-pull-review]');
  const shell = review.locator(`[data-guide-file-shell="${TOKENS_PATH}"]`);
  const arrow = shell.locator('[data-expand-button]').first();
  await expect(arrow).toBeVisible({ timeout: 30_000 });
  // Highlighting happens off the page's thread: a long file must not freeze it.
  await expect.poll(() => page.workers().length).toBeGreaterThan(0);
  // Arrows, and no read: a whole file is read and highlighted only when someone opens one.
  expect(forgeCalls()).not.toContain(`gh diff repos/northwind/web-app/contents/${TOKENS_PATH}?ref=${MERGE_BASE}`);
  // Layout.tsx's one hunk holds its whole diff from line 1: its only arrows would be in the row after the hunk, which
  // the page does not draw (approval pr-view-one-surface, 11-07 19:08), so it shows none. (No text to open taking the
  // arrows away: guideExpandContext.test.tsx.)
  await expect(review.locator('[data-guide-file-shell="src/settings/Layout.tsx"] [data-expand-button]').filter({ visible: true })).toHaveCount(0);
  const box = shell.locator('[data-guide-code-view-mounted]');
  const height = async () => (await box.boundingBox())!.height;
  const before = await height();
  // The gap above the hunk: its arrow opens down from the file's first line.
  await shell.locator('[data-expand-button][data-expand-down]').first().click();
  await expect.poll(height).toBeGreaterThan(before);
  expect(forgeCalls()).toContain(`gh diff repos/northwind/web-app/contents/${TOKENS_PATH}?ref=${MERGE_BASE}`);
  // Line 20 was in no hunk: GitHub takes no inline comment on it, so it goes in the review's main comment, quoted.
  const opened = shell.locator('[data-column-number="20"]').last();
  await expect(opened).toBeVisible({ timeout: 10_000 });
  await shell.hover();
  await opened.click();
  await page.getByPlaceholder('Leave feedback...').fill('Why 20 and not a named step?');
  await page.getByRole('button', { name: 'Add Comment' }).click();
  await expect(review.locator('[data-review-posts] [data-decision-primary]')).toContainText('Post Comments');
  // The old side's line 45 quotes the old text, not the new file's line 45.
  await box.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await shell.locator('[data-expand-up]:visible').last().click();
  const oldSide = shell.locator('[data-column-number="45"]').first();
  await expect(oldSide).toBeVisible({ timeout: 10_000 });
  await oldSide.click();
  await page.getByPlaceholder('Leave feedback...').fill('Why is this one kept?');
  await page.getByRole('button', { name: 'Add Comment' }).click();
  // After a reload the gap is closed again: going to the comment opens it first.
  await page.reload();
  await expect(shell.locator('[data-expand-button]').first()).toBeVisible({ timeout: 30_000 });
  await expect(shell.locator('[data-column-number="20"]')).toHaveCount(0);
  await review.getByRole('button', { name: 'Comments, 2' }).click();
  await review.locator('.ib-gpanel').getByText('Why 20 and not a named step?').first().click();
  await expect(shell.locator('[data-column-number="20"]').last()).toBeInViewport({ timeout: 10_000 });
  // The old side numbers apart from the new: its comment opens the line it was written on.
  await review.locator('.ib-gpanel').getByText('Why is this one kept?').first().click();
  await expect(shell.locator('[data-column-number="45"]').first()).toBeInViewport({ timeout: 10_000 });
  await expect(shell.getByText(TOKENS[44]!).first()).toBeInViewport();
  await review.locator('[data-review-posts] [data-decision-primary]').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-outside-diff-note]')).toContainText('outside the diff');
  await dialog.getByRole('button', { name: /Post/ }).last().click();
  await expect(review.locator('[data-pull-review-posted]')).toBeVisible();
  const sent = JSON.parse(readFileSync(join(world.forge, 'gh-posted.json'), 'utf8')) as { body: string; comments?: unknown[] };
  expect(sent.comments ?? []).toEqual([]);
  expect(sent.body).toContain('Why 20 and not a named step?');
  expect(sent.body).toContain(TOKENS[19]!);
  expect(sent.body).toContain(TOKENS[44]!);
  expect(sent.body).not.toContain(TOKENS[43]!);
  expect(world.errors).toEqual([]);
});


test('a saved line comment over a push: labelled, posted at the commit read, the typed words at the new head', async () => {
  const { page } = world;
  const endpoint = 'repos/northwind/web-app/pulls/880';
  const named = (e: string) => join(world.forge, `gh-${e.replace(/[/.%?&=]/g, '_')}.patch`);
  const read = '880'.padStart(40, '0');
  const pushed = 'f'.repeat(40);
  const list = readFileSync(join(world.forge, 'gh-pulls.json'), 'utf8');
  const patch = readFileSync(named(endpoint), 'utf8');
  const words = 'ms-6 flips with dir; check the sidebar in Hebrew too.';
  rmSync(join(world.forge, 'gh-posts.jsonl'), { force: true });
  try {
    await page.goto(`${world.url}#pulls&stack=${encodeURIComponent(TEAMMATE)}&layer=${encodeURIComponent(TEAMMATE)}&scope=layer`);
    const review = page.locator('[data-pull-review]');
    await expect(review.locator('[data-guide-file-shell="src/settings/Layout.tsx"]')).toBeVisible({ timeout: 30_000 });
    await commentOn(page, 'src/settings/Layout.tsx', 3, words);
    await expect(review.locator('.ib-vcomments')).toHaveAttribute('aria-label', 'Comments, 1');

    // Pushed: other code at that line, the old commit still on the PR.
    writeFileSync(named(endpoint), patch.replace(/ms-6/g, 'ms-8'));
    writeFileSync(join(world.forge, 'gh-head-880'), `${pushed}\n`);
    writeFileSync(named(`${endpoint}/commits?per_page=100`), `${read}\n${pushed}\n`);
    writeFileSync(join(world.forge, 'gh-pulls.json'), list.replaceAll(read, pushed).replace(/("number":880,[^}]*?"updatedAt":")[^"]+/g, `$1${new Date().toISOString()}`));
    // The list reads again on focus, at most every 20 s.
    await expect(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByText('ms-8').first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 90_000, intervals: [3_000] });

    await review.locator('.ib-vcomments').click();
    await expect(page.locator('[data-code-annotation-note]')).toHaveText('Written on older code');
    await page.locator('[data-pull-review] .ib-vcomments').click();

    await review.locator('[data-review-posts] [data-decision-primary]').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(`#880 — read at ${read.slice(0, 7)}`);
    await dialog.locator('textarea').fill('Everything else reads well.');
    await dialog.getByRole('button', { name: 'Post Comments', exact: true }).click();
    await expect(review.locator('[data-pull-review-posted]')).toContainText('on GitHub');

    const sent = readFileSync(join(world.forge, 'gh-posts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(sent).toEqual([
      { commit_id: read, body: 'See inline comments.', event: 'COMMENT', comments: [{ path: 'src/settings/Layout.tsx', line: 3, side: 'RIGHT', body: words }] },
      expect.objectContaining({ commit_id: pushed, body: 'Everything else reads well.', event: 'COMMENT' }),
    ]);
    expect((sent[1] as { comments?: unknown[] }).comments ?? []).toEqual([]);
    await expect(review.locator('.ib-vcomments')).toHaveAttribute('aria-label', 'Comments, 0');
    expect(world.errors).toEqual([]);
  } finally {
    writeFileSync(named(endpoint), patch);
    writeFileSync(join(world.forge, 'gh-pulls.json'), list);
    rmSync(join(world.forge, 'gh-head-880'), { force: true });
    rmSync(named(`${endpoint}/commits?per_page=100`), { force: true });
  }
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

test("A guided review of a PR's own diff posts its comment inline, and what posted isn't sent to the agent", async () => {
  const { page, claude } = world;
  const words = 'Should this fall back further?';
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('about:blank');
  // The PR's own page: its row opens its review thread now that it has one, so the stack is asked for by name.
  await page.goto(`${world.url}#reviews&stack=${encodeURIComponent(LOCALE)}`);
  const threadId = String(await page.locator('[data-pulls-stack] [data-pulls-thread]').first().getAttribute('data-pulls-thread'));
  await claude.submitGuide({
    project_path: world.projects.web,
    reply_to: threadId,
    patch: world.patches.locale,
    body: 'Another look.',
    review: true,
    guide: {
      title: 'Locale fallback, to post',
      intent: 'Read the fallback.',
      sections: [{ title: 'The change', overview: 'Read the new lines.', diffs: [{ file: 'src/i18n/fallback.ts', summary: 'The change.' }] }],
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
  } as never);
  await page.goto('about:blank');
  await page.goto(`${world.url}#thread=${encodeURIComponent(threadId)}`);
  await page.locator('[data-review-card]', { hasText: 'Locale fallback, to post' }).locator('[data-review-start]').click();

  const shell = page.locator('[data-guide-file-shell="src/i18n/fallback.ts"]').first();
  const added = shell.locator('[data-line-type="change-addition"][data-column-number="1"]');
  await expect(added).toBeVisible({ timeout: 30_000 });
  await shell.hover();
  await added.click();
  await page.getByPlaceholder('Leave feedback...').fill(words);
  await page.getByRole('button', { name: 'Add Comment' }).click();

  await page.waitForTimeout(800);
  await shot(page, 'post-inline-commented');
  await page.locator('[data-review-destination-choice="forge"]').click();
  await shot(page, 'post-inline-ending');
  const before = readFileSync(join(world.forge, 'gh-posts.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  await page.locator('[data-review-posts] [data-decision-primary]').click();
  const dialog = page.getByRole('dialog');
  await shot(page, 'post-inline-dialog');
  await dialog.getByRole('button', { name: 'Post Comments', exact: true }).click();
  await expect(page.locator('[data-review-posted], [data-pull-review-posted]').first()).toContainText('on GitHub');
  await shot(page, 'post-inline-posted');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await shot(page, 'post-inline-posted-390');
  await page.setViewportSize({ width: 1440, height: 900 });
  const sent = readFileSync(join(world.forge, 'gh-posts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { body: string; comments?: unknown[] });
  expect(sent.length).toBe(before + 1);
  expect(sent.at(-1)!.comments).toEqual([expect.objectContaining({ path: 'src/i18n/fallback.ts', line: 1, side: 'RIGHT', body: words })]);
  expect(sent.at(-1)!.body).not.toContain(words);

  // It's on GitHub now: the agent's ending sends the verdict, without it.
  await page.locator('[data-review-destination-choice="agent"]').click();
  await page.locator('[data-review-decision] [data-decision-primary]').click();
  await expect.poll(() => page.evaluate(async (id) => {
    const { thread } = (await (await fetch(`/api/inbox/threads/${encodeURIComponent(id)}`)).json()) as { thread: { messages: { author: { kind: string } }[] } };
    return thread.messages.at(-1)!.author.kind;
  }, threadId)).not.toBe('agent');
  const last = await page.evaluate(async (id) => {
    const { thread } = (await (await fetch(`/api/inbox/threads/${encodeURIComponent(id)}`)).json()) as { thread: { messages: unknown[] } };
    return JSON.stringify(thread.messages.at(-1));
  }, threadId);
  expect(last).not.toContain(words);
  expect(world.errors).toEqual([]);
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
  // The list follows a review that arrives, with no reload: the new row, and the sidebar's count. The count is
  // checked against the server's rows (its cached answer: no forge read), not a number read before the review: the
  // tests before this one leave rows whose move can still settle on the page's next read, so that number may be stale.
  const row = page.locator(`[data-reviews-kind="reviewed"][data-row="${first.thread_id}"]`);
  await expect(row).toContainText('Add jitter to retries', { timeout: 15_000 });
  await expect(row).toContainText('Review ready');
  const onYou = () => page.evaluate(async () => ((await (await fetch('/api/inbox/reviews?cached=1')).json()) as { rows: { thread_id: string | null; move: string }[] }).rows.filter((r) => r.move === 'on_you'));
  await expect.poll(async () => (await onYou()).some((r) => r.thread_id === first.thread_id), { message: 'the review is on the person' }).toBe(true);
  await expect.poll(async () => (await page.locator('[data-pulls-nav] .ib-n').textContent()) === String((await onYou()).length), { message: "the sidebar's count is the rows on the person", timeout: 15_000 }).toBe(true);
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
    await expect(page.locator('dialog.ib-cp[data-phone]')).toHaveCount(0);
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
  await page.goto('about:blank');
  await page.goto(`${world.url}#reviews&new`);
  const box = page.locator('[data-review-box]');
  await expect(box).toBeVisible();
  await expect(page).toHaveURL(/#reviews$/);
  await box.locator('[data-compose-cancel]').click();
  await expect(box).toHaveCount(0);

  await page.goto(`${world.url}#`);
  await page.reload();
  // ⌘K before the page's keys are wired does nothing, and the words typed after it land on the list's own shortcuts:
  // press it until the palette has the words' field, then type.
  const field = page.locator('dialog[data-search-palette] [role="combobox"]');
  await expect(async () => {
    if (!(await field.isVisible())) await page.keyboard.press('ControlOrMeta+k');
    await expect(field).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
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
  await page.goto('about:blank');
  await page.goto(`${world.url}#reviews&new`);
  const box = page.locator('[data-review-box]');
  await expect(box).toBeVisible();
  // One Pull request row: its picker's search takes the link.
  await expect(box.locator('[data-review-choice="link"]')).toHaveCount(0);
  // No visible labels on what is reviewed: each control says what it asks, and keeps its name.
  await expect(box.locator('.ib-cp-rvrow .ib-cp-tol')).toHaveCount(0);
  await expect(box.getByRole('radiogroup', { name: 'Review' })).toBeVisible();
  await expect(box.getByRole('radiogroup', { name: 'Changes' })).toBeVisible();
  for (const [width, height] of [[390, 844], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await shot(page, `l-nolabel-local-${width}`);
  }
  await box.locator('[data-review-choice="pr"]').check({ force: true });
  await expect(box.locator('.ib-cp-rvrow .ib-cp-tol')).toHaveCount(0);
  await expect(box.getByRole('button', { name: 'Pull request: none chosen' })).toBeVisible();
  for (const [width, height] of [[320, 700], [390, 844], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await shot(page, `l-nolabel-pr-empty-${width}`);
  }
  const openPicker = async () => {
    await box.locator('[data-review-choice="pr"]').check({ force: true });
    await box.locator('[data-review-pick]').click();
  };
  await openPicker();
  await expect(box.locator('[data-review-pick]')).toContainText('Choose or paste a pull request');
  const field = box.locator('[data-review-link]');
  await expect(field).toBeFocused();
  await expect(box.locator('[data-compose-send]')).toHaveClass(/ib-dis/);
  const read = box.locator('[data-review-link-read]');
  const found = box.locator('[data-review-link-option]');

  // Bitbucket and things that aren't links say so, and nothing can start.
  const linkReads = () => forgeCalls().filter((call) => call.includes(' diff ')).length;
  const before = linkReads();
  await field.fill('https://bitbucket.org/acme/mobile/pull-requests/88');
  await expect(read).toHaveText("Bitbucket links aren't supported yet.");
  await expect(box.locator('[data-compose-send]')).toHaveClass(/ib-dis/);
  await shot(page, 'l-box-bitbucket');
  await field.fill('https://example.com/about');
  await expect(read).toHaveText("That isn't a pull request link.");
  expect(linkReads()).toBe(before);

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
  await page.goto('about:blank');
  await page.goto(`${world.url}#reviews&new`);
  await expect(box).toBeVisible();
  await openPicker();
  await field.fill('northwind/payments#231');
  await expect(found).toContainText('Idempotent refunds');
  await expect(read).toContainText('Read with gh, signed in to github.com');
  await shot(page, 'l-box-picker-link');
  // Enter chooses it: the row then says what it is and how it was read.
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(box.locator('[data-review-pick]')).toContainText('northwind/payments');
  await expect(box.locator('[data-review-pick]')).toContainText('#231');
  await expect(box.locator('[data-review-pick]')).toContainText('Idempotent refunds');
  await expect(read).toContainText('Read with gh, signed in to github.com');
  await expect(box.locator('.ib-cp-to').last()).toContainText('New scratch folder');
  await expect(box.locator('[data-compose-thread-name] input')).toHaveValue('Review #231: Idempotent refunds');
  await shot(page, 'l-box-link');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'l-box-link-phone');
  // No labels: the toggle takes its row, slim, as tall as the row below, with room for a third choice at 320 too.
  await box.locator('[data-review-choices="kind"]').evaluate((group) => {
    const third = group.lastElementChild!.cloneNode(true) as HTMLElement;
    third.lastChild!.textContent = 'Walkthrough';
    third.removeAttribute('data-on');
    third.dataset.tryThird = '';
    group.append(third);
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await shot(page, `l-box-three-choices-${width}`, ['light']);
    const fit = await box.locator('[data-review-choices="kind"]').evaluate((group) => {
      const row = group.parentElement!;
      const toggle = group.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      return { height: rect.height, inside: toggle.right <= rect.right, toRow: row.parentElement!.querySelector('.ib-cp-to:not(.ib-cp-rvrow)')?.getBoundingClientRect().height ?? 0 };
    });
    expect(fit.inside).toBe(true);
    expect(fit.height).toBeLessThanOrEqual(fit.toRow + 1);
  }
  await box.locator('[data-try-third]').evaluate((third) => third.remove());
  // One chosen, at each size.
  for (const [width, height] of [[320, 700], [390, 844], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await shot(page, `l-nolabel-pr-picked-${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
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
      source: { kind: 'pr', pr: { url: 'https://github.com/northwind/payments/pull/999', number: 999, platform: 'github' } },
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

test('New review, a walkthrough: the words are the ask, its thread is named from them, and the code comes with no verdict', async () => {
  const { page, claude } = world;
  await setCodeReview(true);
  await page.goto('about:blank');
  await page.goto(`${world.url}#reviews&new`);
  const box = page.locator('[data-review-box]');
  await expect(box).toBeVisible();
  await box.locator('[data-review-choice="walkthrough"]').check({ force: true });
  // Nothing but the words: no changes to choose, no picker, and Start waits for them.
  await expect(box.locator('[data-review-choices="changes"]')).toHaveCount(0);
  await expect(box.locator('[data-review-pick]')).toHaveCount(0);
  const words = box.locator('[data-compose-text] textarea');
  await expect(words).toBeFocused();
  await expect(words).toHaveAttribute('placeholder', 'What should it walk you through?');
  await expect(box.locator('[data-compose-send]')).toHaveClass(/ib-dis/);
  await words.fill('How does a failed charge get retried? Start from the webhook.');
  await expect(box.locator('[data-compose-send]')).not.toHaveClass(/ib-dis/);
  await expect(box.locator('[data-compose-thread-name] input')).toHaveValue('Failed charge');
  await expect(box.locator('[data-compose-send]')).toContainText('Start walkthrough');
  await shot(page, 'w-box');
  for (const [width, height] of [[390, 844], [320, 700]] as const) {
    await page.setViewportSize({ width, height });
    await shot(page, `w-box-${width}`, ['light']);
    const row = box.locator('[data-review-choices="kind"]');
    expect(await row.evaluate((group) => group.getBoundingClientRect().right <= group.parentElement!.getBoundingClientRect().right)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await box.locator('[data-compose-send]').click();
  await expect(box).toHaveCount(0);

  // Its row from the start, by the word, under a name that came from what was typed.
  await expect(box.locator('[data-compose-thread-name] input')).toHaveCount(0);
  const row = page.locator('[data-reviews-kind="reviewed"]', { hasText: 'Failed charge' });
  await expect(row).toContainText('Walkthrough');
  // Being written, not curated: the row and the thread say so.
  await expect(row).toContainText('Writing…');
  await expect(row).not.toContainText('Curating');
  await expect(page.locator('[data-review-curating]')).toHaveText('Writing the walkthrough…');
  await expect(page.getByText('/review-walkthrough').first()).toBeVisible();
  const threadId = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('thread'));
  await shot(page, 'w-curating');

  // The agent names files and lines, and sends its own patch too: it isn't looked at.
  const longFile = join(world.projects.web, 'src/walk-long.ts');
  writeFileSync(longFile, Array.from({ length: 60 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n');
  const sent = await claude.submitGuide({
    project_path: world.projects.web,
    reply_to: threadId,
    patch: world.patches.locale,
    body: 'A failed charge starts at the webhook.',
    guide: {
      title: 'How a failed charge gets retried',
      intent: 'Follow one failed charge.',
      sections: [
        { title: 'Where it starts', overview: 'The webhook takes the event.', diffs: [{ file: 'src/i18n/fallback.ts', lines: '1-2', summary: 'The first lines.' }] },
        { title: 'Between', overview: 'Words with no code beside them.', diffs: [] },
        { title: 'Further down', overview: 'Two places in a long file.', diffs: [{ file: 'src/walk-long.ts', lines: '30-32, 50-51', summary: 'Those lines.' }] },
      ],
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
  } as never);
  const reviewed = page.locator(`[data-reviews-kind="reviewed"][data-row="${threadId}"]`);
  await expect(reviewed).toContainText('Ready', { timeout: 15_000 });
  await expect(reviewed).toContainText('Walkthrough');
  await expect(reviewed).toHaveAttribute('data-pulls-move', 'on_you');

  // The card asks nothing and counts nothing.
  const card = page.locator('[data-review-card]').last();
  await expect(card).toContainText('Walkthrough');
  await expect(card).not.toContainText('Waiting on you');
  await expect(card).not.toContainText('+0');
  await expect(card).toContainText('2 files');
  await shot(page, 'w-card');

  // Open: the code once, not side by side, and no verdict to give.
  await card.locator('[data-review-start]').click();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  // The top bar keeps its diff controls but no Split / Unified button: nothing is marked as changed.
  await expect(page.locator('[data-review-message] [data-diff-controls]')).toBeVisible();
  await expect(page.locator('[data-review-message] [data-diff-layout-toggle]')).toHaveCount(0);
  await expect(page.locator('[data-diff-style-switch]')).toHaveCount(0);
  await expect(page.getByText('No chapter files in the current diff')).toHaveCount(0);
  await expect(page.locator('[data-section-no-code]')).toHaveText('No code in this chapter.');
  await expect(page.locator('[aria-label="Walkthrough"]').first()).toBeVisible();
  await expect(page.getByText('export const line30 = 30;').first()).toBeVisible();
  await expect(page.getByText('unmodified line')).toHaveCount(0);
  // No ticks: no chapter Reviewed, no file Viewed, and no "N of M" line in the chapter menu.
  await expect(page.locator('[data-review-message]').getByRole('button', { name: /viewed/i })).toHaveCount(0);
  await page.locator('[data-review-jump]').first().click();
  await expect(page.locator('[data-review-jump-menu] [data-review-jump-row]').first()).toBeVisible();
  await expect(page.locator('[data-review-progress]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-review-jump-menu]')).toHaveCount(0);
  // Two ranges in a file leave no room over its header for a separator that isn't there: it sits as a one-range file's does.
  const gapOver = (file: string) => page.locator(`[data-guide-file-shell="${file}"]`).first().evaluate((shell) => {
    const body = [shell, ...shell.querySelectorAll('*')].flatMap((el) => (el.shadowRoot ? [...el.shadowRoot.querySelectorAll('[data-code], pre')] : []))[0];
    return body ? body.getBoundingClientRect().top - shell.getBoundingClientRect().top : Number.NaN;
  });
  expect(Math.abs((await gapOver('src/walk-long.ts')) - (await gapOver('src/i18n/fallback.ts')))).toBeLessThan(4);
  await page.waitForTimeout(1200);
  await shot(page, 'w-pane');
  // All files: the same code, nothing counted, and no words about changes.
  await page.getByRole('radio', { name: 'All files' }).first().check({ force: true });
  await expect(page.locator('[data-guide-file-shell="src/i18n/fallback.ts"]').first()).toBeVisible();
  await expect(page.getByText('Every changed file')).toHaveCount(0);
  await expect(page.getByText(/^\+0/)).toHaveCount(0);
  await shot(page, 'w-pane-files');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await shot(page, 'w-pane-phone');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('about:blank');
  await page.goto(`${world.url}#thread=${encodeURIComponent(threadId!)}`);
  await expect(page.getByRole('button', { name: 'Reply', exact: true }).first()).toBeVisible();
  await shot(page, 'w-thread');
  rmSync(longFile);
  // The list's mark says the word; a plain guided review's mark keeps its own.
  await expect(page.locator(`[data-row="${threadId}"] [data-guide-mark]`).first()).toHaveAttribute('aria-label', 'Walkthrough');
  await expect(page.locator('[data-guide-mark][aria-label="Guided review"]').first()).toBeAttached();

  // More asked: the row is with the agent, and its plain answer, no second walkthrough, brings it back.
  const moveOf = () => page.evaluate(async (id) => ((await (await fetch('/api/inbox/reviews')).json()) as { rows: { thread_id: string | null; move: string }[] }).rows.find((row) => row.thread_id === id)?.move, threadId);
  await page.evaluate(async (id) => {
    await fetch(`/api/inbox/messages/${id}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotency_key: '00000000-0000-4000-8000-00000000a001', words: 'Where does the 200 come from?' }) });
  }, sent.message_id);
  await expect.poll(moveOf).toBe('agents');
  await claude.send({ project_path: world.projects.web, reply_to: sent.message_id as string, body: 'From charge.ts, line 4.' });
  await expect.poll(moveOf).toBe('on_you');

  // Code review off: the field isn't there, and nothing is sent.
  await setCodeReview(false);
  await expect(claude.submitGuide({ project_path: world.projects.web, thread: 'walk-off', walkthrough: true, guide: { title: 'Off', intent: 'Off.', sections: [{ title: 'One', overview: 'One.', diffs: [{ file: 'src/i18n/fallback.ts' }] }] } } as never)).rejects.toThrow('walkthrough');
  await setCodeReview(true);
});

test("A link's review posts to its forge, though no list has it; the picker's links keep what's chosen, and only signed-in hosts are asked", async () => {
  const { page } = world;
  await setCodeReview(true);
  const box = page.locator('[data-review-box]');
  const field = box.locator('[data-review-link]');
  const read = box.locator('[data-review-link-read]');
  const found = box.locator('[data-review-link-option]');
  const threads = () => page.evaluate(async () => ((await (await fetch('/api/inbox/reviews?cached=1')).json()) as { rows: { thread_id: string | null }[] }).rows.filter((row) => row.thread_id).map((row) => row.thread_id));
  const openBox = async () => {
    await page.goto('about:blank');
    await page.goto(`${world.url}#reviews&new`);
    await expect(box).toBeVisible();
  };
  const openPicker = async () => {
    await box.locator('[data-review-choice="pr"]').check({ force: true });
    await box.locator('[data-review-pick]').click();
  };

  // A review of #231, reached by its link, is on no list: its ending offers GitHub all the same, and it posts.
  await page.goto(`${world.url}#reviews`);
  await page.locator('[data-reviews-kind="reviewed"]', { hasText: 'Idempotent refunds' }).first().click();
  // The thread's header and the dialog below both say #231, though the agent's guide named #999.
  await expect(page.locator('[data-review-context]')).toContainText('#231');
  await expect(page.locator('[data-review-context]')).not.toContainText('#999');
  await page.locator('[data-review-start]').last().click();
  const choice = page.locator('[data-review-destination-choice="forge"]');
  await expect(page.locator('[data-review-destination], [data-review-posts="github"]').first()).toBeVisible({ timeout: 15_000 });
  if (await choice.count()) await choice.click();
  await expect(page.locator('[data-review-posts="github"]')).toBeVisible();
  await shot(page, 'l-link-post');
  await page.locator('[data-review-posts] [data-decision-primary]').click();
  // The dialog says which PR, whatever PR the agent's guide named.
  await expect(page.locator('[data-review-posting-to]')).toHaveText('Posting to northwind/payments#231');
  await shot(page, 'l-link-approve-dialog');
  await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => forgeCalls().filter((call) => call.startsWith('gh post'))).toContain('gh post repos/northwind/payments/pulls/231/reviews');

  // A PR nothing started a thread on isn't read or posted to, even by a plain local request.
  const refused = await page.evaluate(async () => {
    const res = await fetch('/api/inbox/pulls/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'github.com/northwind/never-opened#77', action: 'approve', body: '', head_sha: 'b'.repeat(40), fileComments: [] }) });
    return res.status;
  });
  expect(refused).toBe(404);
  expect(forgeCalls().filter((call) => call.includes('never-opened'))).toEqual([]);

  // Capitals are the same PR: it opens the thread it's in, no second one.
  await openBox();
  await openPicker();
  await field.fill('Northwind/Payments#231');
  await expect(read).toContainText('Already in review');

  // Hosts no CLI here is signed in to are never asked, and the line claims nothing about them.
  const asked = () => forgeCalls().filter((call) => call.includes(' diff ') && !call.includes('payments')).length;
  const askedBefore = asked();
  for (const host of ['localhost', '169.254.169.254', 'github.com-evil.example']) {
    await field.fill(`https://${host}/o/r/pull/1`);
    await expect(read).toHaveAttribute('data-review-link-read', 'unreadable');
    await expect(read).toContainText(host);
    await expect(read).not.toContainText('Read with');
  }
  await field.fill('https://--hostname/o/r/pull/1');
  await expect(read).toHaveAttribute('data-review-link-read', 'not_a_link');
  expect(asked()).toBe(askedBefore);

  // The Inbox not answering isn't the link's fault.
  await page.route('**/api/inbox/reviews/link*', (route) => route.abort());
  await field.fill('https://github.com/northwind/payments/pull/232');
  await expect(read).toHaveAttribute('data-review-link-read', 'failed');
  await page.unroute('**/api/inbox/reviews/link*');

  // A stack's merged layer is about that PR, not the stack on top of it.
  await field.fill('https://github.com/northwind/billing-svc/pull/411');
  await expect(found).toContainText('merged');
  await field.press('Enter');
  await expect(box.locator('[data-compose-thread-name] input')).toHaveValue(/^Review #411/);

  // Typing another and leaving: the link chosen stays, as a list pick does.
  await box.locator('[data-review-pick]').click();
  await field.fill('https://gitlab.com/northwind/ledger/-/merge_requests/58');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(box.locator('[data-review-pick]')).toContainText('#411');
  await expect(box.locator('[data-compose-send]')).not.toHaveClass(/ib-dis/);

  // Typing a link leaves the agent the person chose; choosing it is what moves To.
  await openBox();
  await box.locator('[data-review-choice="pr"]').check({ force: true });
  await box.locator('[data-compose-to]').click();
  await box.locator('[data-compose-session="ses-billing-claude"]').click();
  await box.locator('[data-review-pick]').click();
  await field.fill('https://github.com/northwind/web-app/pull/869');
  await expect(found).toBeVisible();
  await page.waitForTimeout(400);
  await expect(box.locator('[data-compose-to]')).toHaveAttribute('data-compose-to', 'ses-billing-claude');
  await field.press('Escape');

  // A GitLab MR on the list goes the picker's way, with no read of its own; in review, it opens that thread.
  const ledgerAgent = new Poll(world.dataDir, 'ses-ledger-claude', 'claude-code', world.projects.ledger, Date.now());
  world.polls.push(ledgerAgent);
  await expect.poll(() => page.evaluate(async () => JSON.stringify(await (await fetch('/api/inbox/sessions')).json()))).toContain('ses-ledger-claude');
  await openBox();
  await openPicker();
  const mrReads = () => forgeCalls().filter((call) => call.endsWith('merge_requests/61')).length;
  const mrBefore = mrReads();
  await field.fill('https://gitlab.com/northwind/ledger/-/merge_requests/61');
  await expect(found).toContainText('Export the ledger to CSV');
  expect(mrReads()).toBe(mrBefore);
  await field.press('Enter');
  await expect(box.locator('[data-compose-to]')).toHaveAttribute('data-compose-to', /^ses-ledger-/);
  await box.locator('[data-compose-send]').click();
  await expect(box).toHaveCount(0);
  await expect(page).toHaveURL(/thread=/);
  const mrThread = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('thread'));
  const before = (await threads()).length;
  await openBox();
  await openPicker();
  await field.fill('https://gitlab.com/northwind/ledger/-/merge_requests/61');
  await expect(read).toContainText('Already in review');
  expect(mrReads()).toBe(mrBefore);
  await found.click();
  await expect(box).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`thread=${mrThread}`));
  expect((await threads()).length).toBe(before);
  // Whose PR it is comes from the Inbox's read, not from what the window says.
  const claimed = await page.evaluate(async () => {
    const url = 'https://github.com/northwind/payments/pull/233';
    await fetch(`/api/inbox/reviews/link?ref=${encodeURIComponent(url)}`);
    const res = await fetch('/api/inbox/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: { host: 'claude-code', session: 'ses-ledger-claude' }, body: 'Please review.', idempotency_key: '00000000-0000-4000-8000-000000000233', review: { kind: 'link', url, title: 'Not yours', mine: true, ask: 'guide' } }) });
    const { thread_id } = (await res.json()) as { thread_id: string };
    const rows = ((await (await fetch('/api/inbox/reviews?cached=1')).json()) as { rows: { thread_id: string | null; started?: { pull?: { mine: boolean } } }[] }).rows;
    return rows.find((row) => row.thread_id === thread_id)?.started?.pull?.mine;
  });
  expect(claimed).toBe(false);
  // Another link read between reading a PR and starting it doesn't change whose the first one is.
  const mine = await page.evaluate(async () => {
    const url = 'https://github.com/northwind/payments/pull/234';
    await fetch(`/api/inbox/reviews/link?ref=${encodeURIComponent(url)}`);
    await fetch(`/api/inbox/reviews/link?ref=${encodeURIComponent('https://github.com/northwind/payments/pull/233')}`);
    const res = await fetch('/api/inbox/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: { host: 'claude-code', session: 'ses-ledger-claude' }, body: 'Please review.', idempotency_key: '00000000-0000-4000-8000-000000000234', review: { kind: 'link', url, title: 'Yours', ask: 'guide' } }) });
    const { thread_id } = (await res.json()) as { thread_id: string };
    const rows = ((await (await fetch('/api/inbox/reviews?cached=1')).json()) as { rows: { thread_id: string | null; started?: { pull?: { mine: boolean } } }[] }).rows;
    return rows.find((row) => row.thread_id === thread_id)?.started?.pull?.mine;
  });
  expect(mine).toBe(true);
  world.polls.splice(world.polls.indexOf(ledgerAgent), 1);
  await ledgerAgent.stop();
});

test('A very long repository in a link: nothing on a phone scrolls sideways', async () => {
  const { page } = world;
  await setCodeReview(true);
  const repo = `northwind/${'a-very-long-repository-name-'.repeat(4)}end`;
  await page.route('**/api/inbox/reviews/link*', async (route) => {
    await route.fulfill({ json: { serverSession: '', ok: true, cli: 'gh', projects: [], thread_id: null, pull: { key: `github.com/${repo}#7`, platform: 'github', host: 'github.com', repo, number: 7, url: `https://github.com/${repo}/pull/7`, title: 'A title', author: 'tomas', mine: false, requested: false, state: 'open', base: 'main', head: 'b', head_repo: null, additions: 0, deletions: 0, files: 0, review: null, approved_by: null, reviewers: [], checks: null, updated_at: '', merged_at: null } } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('about:blank');
  await page.goto(`${world.url}#reviews&new`);
  const box = page.locator('[data-review-box]');
  const sideways = () => box.evaluate((dialog) => [dialog, ...dialog.querySelectorAll('*')].filter((el) => {
    const style = getComputedStyle(el);
    return /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
  }).map((el) => el.className));
  await box.locator('[data-review-choice="pr"]').check({ force: true });
  await box.locator('[data-review-pick]').click();
  await box.locator('[data-review-link]').fill(`https://github.com/${repo}/pull/7`);
  await expect(box.locator('[data-review-link-option]')).toBeVisible();
  expect(await sideways()).toEqual([]);
  // The title still has room beside it.
  expect((await box.locator('[data-review-link-option] .ib-cp-op').boundingBox())!.width).toBeGreaterThan(60);
  await shot(page, 'l-long-repo-picker', ['light']);
  await box.locator('[data-review-link]').press('Enter');
  await expect(box.locator('[data-review-pick]')).toContainText('#7');
  expect(await sideways()).toEqual([]);
  expect((await box.locator('[data-review-pick] b').boundingBox())!.width).toBeGreaterThan(40);
  await shot(page, 'l-long-repo-chosen', ['light']);
  await page.unroute('**/api/inbox/reviews/link*');
  await page.setViewportSize({ width: 1440, height: 900 });
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
