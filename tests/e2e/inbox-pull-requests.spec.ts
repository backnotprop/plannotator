/**
 * Pull requests in the Inbox (approval "inbox-code-review-direction", items 4
 * and 5; code review in the Inbox, phase 2), proved in a real browser against
 * the compiled binary. The binary runs `plannotator inbox --background` under
 * a temp PLANNOTATOR_DATA_DIR; simulated agents write through `plannotator
 * inbox mcp` (scripts/inbox-sim.ts); Chromium drives the window. HOME is
 * never changed. `gh` and `glab` are sh fakes first on PATH: nothing reaches
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
 *     button, Review with an agent, opens the picker inline: Ask for, the
 *     project's running agents as one radio list, Start a new agent; Start
 *     review thread sends the first message to the picked one, and the PR is
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
 *     folded sheets (comments, Files) cover the diff and nothing else; the
 *     controls' row and the foot on long words.
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
    // A PR read around its patch (`--jq`): the list's `headRefOid` for that number, and its description.
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then',
    '  echo "gh head $4" >> "$calls"; n="${4##*/}"; body=null; [ -f "$dir/gh-body-$n.json" ] && body=$(cat "$dir/gh-body-$n.json"); sha=$(printf "%040d" "$n"); [ -f "$dir/gh-head-$n" ] && sha=$(cat "$dir/gh-head-$n"); printf \'{"sha":"%s","body":%s}\\n\' "$sha" "$body"; exit 0',
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

  const onYou = list.locator('[data-pulls-group="on_you"] [data-pulls-row]');
  await expect(onYou).toHaveCount(3);
  await expect(list.locator(`[data-pulls-group="on_you"] [data-pulls-row="${STACK_ID}"]`)).toBeVisible();
  await expect(list.locator('[data-pulls-group="on_you"] [data-pulls-row="github.com/northwind/web-app#880"]')).toContainText('tomas asked for your review');
  await expect(list.locator('[data-pulls-group="ready"] [data-pulls-row]')).toHaveCount(1);
  await expect(list.locator('[data-pulls-group="ready"]')).toContainText('Upgrade to Vite 8');
  const fold = list.locator('[data-pulls-waiting-toggle]');
  await expect(fold).toHaveText(/2 waiting on others/);
  await expect(list.locator('[data-pulls-group="waiting"] [data-pulls-row]')).toHaveCount(0);
  const stackRow = list.locator(`[data-pulls-row="${STACK_ID}"]`);
  await expect(stackRow).toHaveAttribute('data-pulls-layers', '4');
  await expect(stackRow.locator('[data-pulls-chain] .ib-bc-mark')).toHaveCount(4);
  // The agent on the third line, its mark before its name; top left, the author's picture (her own stack too).
  await expect(stackRow).toContainText('3 open, 1 merged · Review thread with Claude Code · start at #412');
  await expect(stackRow.locator('.ib-pv [data-pulls-row-agent="claude-code"]')).toBeVisible();
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
  // The head is "Reviews" and the filter mark (inbox-pull-filters.spec.ts); the On you band carries the count.
  expect(await list.locator('[data-pulls-heading]').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(list.locator('[data-pulls-heading]')).toHaveText('Reviews');
  await expect(list.locator('[data-pulls-filter-trigger]')).toHaveAccessibleName('Filter');
  await expect(page.locator('[data-pulls-nav] .ib-n')).toHaveText('3');
  await shot(page, '2-list');
  await fold.click();
  await expect(list.locator('[data-pulls-group="waiting"] [data-pulls-row]')).toHaveCount(2);
  await fold.click();
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
  // Its review thread: the agent's line under the title (its last words under it), one button that opens the thread.
  const line = pane.locator('[data-pulls-thread-line="live"]');
  await expect(line).toBeVisible();
  await expect(line.locator('.ib-pr-thread-h')).toContainText('Review thread with Claude Code');
  await expect(pane.locator('[data-pulls-primary]')).toHaveText('Open review thread');
  await expect(pane).not.toContainText(/\bhand/i);
  // The Board is off: no card chip, no Board words.
  await expect(pane.locator('[data-pulls-card]')).toHaveCount(0);
  await expect(pane).not.toContainText('Board');
  await expect(pane.getByRole('button', { name: /merge/i })).toHaveCount(0);
  // It has a review thread: no picker, and no way to add a second agent; the diff is one button away.
  await expect(pane.locator('[data-pulls-primary="review"], [data-pulls-picker]')).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'Open the diff', exact: true })).toBeVisible();
  // The whole stack is the review's own switch: one Open the diff here.
  await expect(pane.getByRole('button', { name: 'Whole stack' })).toHaveCount(0);
  await shot(page, '3-stack-board-off');
});

/** The agent's guided review of a one-file PR, sent as phase 1's review (`review: true`), in reply to the review thread's first message. */
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
    await page.goto(`${world.url}#pulls`);
    const toggle = page.locator('[data-pulls-waiting-toggle][aria-expanded="false"]');
    if (await toggle.count()) await toggle.click();
    await page.locator(`[data-pulls-row="${row}"]`).click();
    await expect(page.locator('[data-pulls-stack]')).toBeVisible();
    if (openPicker) {
      await page.locator('[data-pulls-stack] [data-pulls-primary]').click();
      await expect(page.locator('[data-pulls-picker-session]').first()).toBeVisible();
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

/** The stack view's controls a phone must make full touch targets: the one button, Open the diff, the picker's Ask for options, its rows and Start. */
const PHONE_TARGETS = '[data-pulls-primary], [data-pulls-open-diff], [data-pulls-picker-session], [data-pulls-picker-new], [data-pulls-start], [data-pulls-picker-cancel], [data-pulls-ask-option]';

test('a PR with no review thread: Review with an agent, the picker (Ask for, the running agents, Start a new agent), "on the way", the guided review arriving, Open review thread, and Open the diff in each', async ({ browser }) => {
  const { page } = world;
  await offerLaunch(page);
  await page.goto(`${world.url}#pulls`);
  const list = page.locator('[data-pulls-list]');
  await list.locator('[data-pulls-waiting-toggle]').click();
  await list.locator(`[data-pulls-row="${LOCALE}"]`).click();
  const pane = page.locator('[data-pulls-stack]');
  // One button under the title, Open the diff beside it; no picker until it is asked for, no thread, no Reply.
  const primary = pane.locator('[data-pulls-primary]');
  await expect(primary).toHaveText('Review with an agent');
  await expect(primary).toHaveClass(/ib-pri/);
  await expect(primary).toHaveAttribute('aria-expanded', 'false');
  expect((await pane.locator('[data-pulls-open-diff]').boundingBox())!.y).toBe((await primary.boundingBox())!.y);
  await expect(pane.locator('[data-pulls-picker]')).toHaveCount(0);
  await expect(pane.locator('[data-pulls-thread]')).toHaveCount(0);
  await expect(pane.locator('[data-pulls-reply]')).toHaveCount(0);
  await expect(pane).not.toContainText(/\bhand/i);
  await shot(page, '4-no-thread');
  await primary.click();
  // Inline under the button, no menu: Ask for, then one radio list of web-app's running agents and Start a new agent.
  const picker = pane.locator('[data-pulls-picker]');
  await expect(primary).toHaveAttribute('aria-expanded', 'true');
  await expect(picker).toContainText('Ask for');
  await expect(picker).toContainText('Running in web-app');
  await expect(pane.locator('[role="menu"]')).toHaveCount(0);
  expect((await picker.boundingBox())!.y).toBeGreaterThan((await primary.boundingBox())!.y);
  const agents = picker.getByRole('radiogroup', { name: 'Agent, running in web-app' });
  await expect(agents.getByRole('radio')).toHaveCount(3);
  await expect(picker.locator('[data-pulls-picker-session]')).toHaveCount(2);
  await expect(picker.locator('[data-pulls-picker-session="ses-billing-claude"]')).toHaveCount(0);
  await expect(picker.locator('[data-pulls-picker-session] input:checked')).toHaveCount(1);
  await expect(picker.locator('[data-pulls-picker-new]')).toContainText('Start a new agent');
  await expect(picker.locator('[data-pulls-ask-choice]')).toHaveAttribute('data-pulls-ask-choice', 'guide');
  // A row only picks: nothing is sent until Start review thread.
  await picker.locator('[data-pulls-picker-session="ses-web-claude"]').click();
  await expect(picker.locator('[data-pulls-picker-session="ses-web-claude"] input')).toBeChecked();
  await expect(picker.locator('[data-pulls-start]')).toHaveText('Start review thread');
  await expect(picker.locator('[data-pulls-start]')).toHaveAttribute('data-pulls-start', 'ses-web-claude');
  await expect(pane.locator('[data-pulls-thread]')).toHaveCount(0);
  await shot(page, '4a-picker');
  // The row opens the diff too: "Open diff ›" at its end, under the pointer.
  const row = pane.locator(`[data-pulls-layer="${LOCALE}"] button`);
  await row.hover();
  await expect(row.locator('.ib-pr-lgo')).toHaveText('Open diff');
  await shot(page, '4b-row-hover', ['light']);
  await page.mouse.move(0, 0);
  await picker.locator('[data-pulls-ask-option="custom"]').click();
  await picker.locator('[data-pulls-ask-words]').fill('Check the fallback chain, and a test for a missing locale');
  await shot(page, '5-ask-custom');
  await picker.locator('[data-pulls-ask-option="guide"]').click();
  await picker.locator('[data-pulls-start]').click();
  await expect(picker).toHaveCount(0);
  // Focus lands on the line that names the review thread's agent.
  const line = pane.locator('[data-pulls-thread-line]');
  await expect(line).toBeFocused();
  await expect(line).toHaveText(/^Review thread with Claude Code\s*Guided review on the way$/);
  const threadId = String(await line.getAttribute('data-pulls-thread'));
  const opening = await world.claude.nextReply(threadId);
  const words = String(opening.body);
  expect(words.startsWith("You're being asked to help me review and understand a pull request. Don't change any code unless I explicitly tell you to.\n")).toBe(true);
  expect(words).toContain('\n- Title: Fall back to English for missing strings\n- Number: #869\n');
  expect(words).toContain('\n- Link: https://github.com/northwind/web-app/pull/869\n');
  expect(words).toContain('\n1. Send me a guided review of its diff against main, using /review-curate (its instructions are at the end of this message).\n');
  expect(words).toContain('BEGIN SKILL INSTRUCTIONS: review-curate');
  // Kept: a fresh read still ties it to that thread, and says what was asked; the one button opens the thread.
  await page.reload();
  await expect(page.locator('[data-pulls-stack] [data-pulls-thread]')).toHaveAttribute('data-pulls-thread', threadId);
  await expect(page.locator(`[data-pulls-row="${LOCALE}"]`)).toContainText('#869 · Review thread with Claude Code · your review');
  await expect(page.locator('[data-pulls-stack] [data-pulls-thread-line="asked"]')).toContainText('Guided review on the way');
  await expect(page.locator('[data-pulls-stack] [data-pulls-primary]')).toHaveText('Open review thread');
  await expect(page.locator('[data-pulls-stack] [data-pulls-picker]')).toHaveCount(0);
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
  await page.goto(`${world.url}#pulls`);
  await page.locator(`[data-pulls-row="${LOCALE}"]`).click();
  await expect(stackPane.locator('[data-pulls-thread-line="live"]')).toBeVisible();
  await stackPane.locator('[data-pulls-open-diff]').click();
  await expect(page.locator('[data-pull-review]')).toHaveAttribute('data-pull-review', LOCALE);
  await page.goto(`${world.url}#pulls`);
  await page.locator(`[data-pulls-row="${LOCALE}"]`).click();
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
  await expect(pane.locator('[data-pulls-thread-line]')).toContainText('Review thread with Claude Code');
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
  // sans; A, D and R stay, the +/- leave the row for its tip. The diffs follow its order.
  await expect(review.locator('[data-review-file="migrations/0042_retry_schedule.sql"]')).toContainText('migrations/0042_retry_schedule.sql');
  await expect(review.locator('[data-review-folder="migrations"]')).toHaveCount(0);
  const railRow = await review.locator('[data-review-file]').first().evaluate((row) => {
    const name = row.querySelector('.truncate')!;
    return { height: row.getBoundingClientRect().height, font: getComputedStyle(name).fontFamily, text: row.textContent ?? '' };
  });
  expect(railRow.height).toBe(28);
  expect(railRow.font).not.toMatch(/mono/i);
  expect(railRow.text).toContain('A');
  expect(railRow.text).not.toMatch(/[+-]\d/);
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
  const sqlBox = (await sqlShell.locator('[data-guide-code-view-mounted]').boundingBox())!;
  const sqlLast = (await sqlShell.locator('[data-line="5"]').first().boundingBox())!;
  expect(sqlBox.y + sqlBox.height - (sqlLast.y + sqlLast.height)).toBeLessThan(24);
  // Global comment is a quiet mark in the bar; Split | Unified a tab on the first file.
  await expect(review.locator('.ib-vhead [data-guide-global-comment-add]')).toBeVisible();
  await expect(review.locator('[data-guide-section-tab] [data-diff-style-switch]')).toBeVisible();
  await expect(review.locator('.ib-vhead [data-diff-style-switch]')).toHaveCount(0);
  // Flat: the code is a sheet on the rail's surface, a file its soft head and its lines, with no card and no rule.
  const frame = await review.evaluate((root) => {
    const read = (el: Element) => { const s = getComputedStyle(el); return { border: s.borderTopWidth, radius: s.borderTopLeftRadius, fill: s.backgroundColor }; };
    const none = { border: '0px', radius: '0px', fill: 'rgba(0, 0, 0, 0)' };
    const head = getComputedStyle(root.querySelector('[data-file-header]')!);
    return {
      none,
      section: read(root.querySelector('[data-guide-section]')!),
      box: read(root.querySelector('[data-guide-code-view-mounted]')!),
      head: { rule: head.borderBottomWidth, filled: head.backgroundColor !== 'rgba(0, 0, 0, 0)' },
      sameSurface: getComputedStyle(root.querySelector('.ib-vhead')!).backgroundColor === getComputedStyle(root.querySelector('.ib-rsplit')!).backgroundColor,
      sheet: getComputedStyle(root.querySelector('.ib-gbody')!).backgroundColor !== getComputedStyle(root.querySelector('.ib-rsplit')!).backgroundColor,
    };
  });
  expect(frame.section).toEqual(frame.none);
  expect(frame.box).toEqual(frame.none);
  expect(frame).toMatchObject({ head: { rule: '0px', filled: true }, sameSurface: true, sheet: true });
  // A 37 px bar over everything; the rail runs to the foot of the page, the code beside it.
  const layers = await review.evaluate((root) => {
    const box = (selector: string) => root.querySelector(selector)!.getBoundingClientRect();
    const [bar, rail, body] = ['.ib-vhead', '.ib-rrail', '.ib-gbody'].map(box) as [DOMRect, DOMRect, DOMRect];
    return { barHeight: bar.height, railTop: rail.top - bar.bottom, railFoot: root.getBoundingClientRect().bottom - rail.bottom, beside: body.left - rail.right };
  });
  expect(layers).toEqual({ barHeight: 37, railTop: 0, railFoot: 0, beside: 0 });
  // Scrolled past the first file, its Split | Unified tab has gone, and the same switch sits in the bar.
  await page.setViewportSize({ width: 1440, height: 420 });
  await review.locator('.ib-gbody').evaluate((el) => (el.scrollTop = 300));
  await expect(review.locator('.ib-vhead [data-diff-style-switch]')).toBeVisible();
  await review.locator('.ib-gbody').evaluate((el) => (el.scrollTop = 0));
  await expect(review.locator('.ib-vhead [data-diff-style-switch]')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
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

/** The details over the code, from the bar or, on a phone, the title's row. */
async function openDetails(review: Locator): Promise<Locator> {
  await review.locator('[data-pull-details-button]').click();
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

test('the details, from the forge: who stands where, the checks, every comment; pictures through the Inbox; a failure says so', async ({ browser }) => {
  const number = TEAMMATE.split('#')[1]!;
  const pic = (login: string) => world.avatars.url(login);
  const longCheck = 'e2e (chromium, shard 3 of 8, retry the flaky ones) on the release branch after the migration step';
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
    const button = review.locator('[data-pull-details-button]');
    // The bar's control says how the checks stand and how many people's comments, bots not counted.
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
    // A long check's whole name is in reach; the passed ones behind a line.
    const failed = panel.locator('[data-pull-details-check="fail"]');
    await expect(failed.locator('.ib-prd-rname')).toHaveText(`test / ${longCheck}`);
    expect(await failed.locator('.ib-prd-rname').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await failed.locator('.ib-prd-rname').hover();
    await expect(page.locator('[data-pn-tooltip]')).toContainText(longCheck);
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
    // The tab behind the panel does not peek out.
    await expect(review.locator('[data-guide-section-tab]').first()).toBeHidden();
    // Escape closes it, back on its button; the tab returns.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(review.locator('[data-guide-section-tab]').first()).toBeVisible();
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

  // On a phone: one column, people and checks a line each, a long name whole, the title's row is the way in.
  const phone = await stubbedReview(browser, 390, COLLIDING_PATHS_DIFF);
  try {
    const review = phone.page.locator('[data-pull-review]');
    const panel = await openDetails(review);
    await expect(panel).toHaveAttribute('data-layout', 'column');
    const box = (await panel.boundingBox())!;
    expect([box.x, box.width]).toEqual([0, 390]);
    await panel.locator('.ib-prd-sum').last().click();
    const name = panel.locator('[data-pull-details-check="fail"] .ib-prd-rname');
    await expect(name).toBeVisible();
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

test('the rail: a folder that does not fit gives way before the file name loses a letter', async ({ browser }) => {
  const file = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
  const fits = 'guides-and-shared-ui.md';
  const patch = [file(`docs/agent-guides/with-a-long-folder-name/${fits}`), file('src/one.ts')].join('');
  const { context, page } = await stubbedReview(browser, 1440, patch);
  try {
    const row = page.locator('[data-pull-review] .ib-prp-file').filter({ hasText: fits });
    await expect(row.locator('.ib-prp-dir')).toBeVisible({ timeout: 30_000 });
    const sizes = await row.locator('.ib-prp-base').evaluate((box) => {
      const range = document.createRange();
      range.selectNodeContents(box);
      return { box: box.getBoundingClientRect().width, text: range.getBoundingClientRect().width };
    });
    expect(sizes.box).toBeGreaterThanOrEqual(sizes.text);
    await expect(row.locator('.ib-prp-dir')).toHaveCSS('text-overflow', 'clip');
  } finally {
    await context.close();
  }
});

test('the same small gap between files, whatever separators a file draws: above its first hunk, between hunks, in Split and Unified', async ({ browser }) => {
  const hunk = (at: number) => `@@ -${at},3 +${at},3 @@\n ctx\n-old\n+new\n ctx\n`;
  const file = (path: string, ...ats: number[]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${ats.map(hunk).join('')}`;
  const patch = [file('one-at-the-top.ts', 1), file('one-further-down.ts', 27), file('two-hunks.ts', 1, 40), file('three-hunks.ts', 10, 40, 80), file('last.ts', 1)].join('');
  const { context, page } = await stubbedReview(browser, 1440, patch);
  try {
    const review = page.locator('[data-pull-review]');
    await expect(review.locator('[data-guide-file-shell]')).toHaveCount(5);
    await expect.poll(() => seams(review)).toEqual([12, 12, 12, 12]);
    await review.locator('[data-diff-style-switch] input[value="unified"]').locator('..').click();
    await expect.poll(() => seams(review)).toEqual([12, 12, 12, 12]);
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
    const row = review.locator('[data-review-files] button').filter({ has: page.locator('.ib-prp-fname') }).first();
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
    // The sidebar's room, for the diff beside the sheet.
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

    // A click on the diff beside it leaves the sheet open, and Escape still closes it.
    const body = (await review.locator('.ib-gbody').boundingBox())!;
    await comments.click();
    await page.mouse.click(body.x + 12, 500);
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
    const global = page.getByPlaceholder('Add a global comment...');
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
    await review.locator('.ib-prp-fileshead').click();
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
    await expect(review.locator('.ib-prp-fileshead')).toHaveText('9 files');
    // A row the tree could not place reads as its full path.
    await expect(review.locator('[data-review-file="docs/guide/intro.md"]')).toContainText('docs/guide/intro.md');
    // The diffs follow the rail, each path drawn once.
    const diffOrder = await review.locator('[data-guide-file-shell]').evaluateAll((shells) => shells.map((shell) => shell.getAttribute('data-guide-file-shell')!));
    expect(diffOrder).toEqual([...new Set(railOrder)]);
    // Of a symlink turned into a file the viewer draws one half: the new file's.
    await expect(review.locator('[data-guide-file-shell="a-link"]')).toContainText('+1');

    // A long name keeps its end in view, and the whole of it is in its tip.
    const cutName = await review.locator('[data-review-file^="src/extraordinarily"] .ib-rv-name').evaluate((name) => {
      const range = document.createRange();
      range.selectNodeContents(name);
      const box = name.getBoundingClientRect();
      return { cut: name.scrollWidth > name.clientWidth, endInView: range.getBoundingClientRect().right <= box.right + 1 };
    });
    expect(cutName).toEqual({ cut: true, endInView: true });
    await review.locator('[data-review-file^="src/extraordinarily"] .ib-rv-name').hover();
    await expect(page.locator('[data-pn-tooltip]')).toContainText('src/extraordinarily-long-module-file-name-for-the-rail-12.ts');
    // Any row's tip has what left the row: its path and its +/-.
    await review.locator('[data-review-file="aaa.ts"] .ib-rv-name').hover();
    await expect(page.locator('[data-pn-tooltip]')).toContainText(/aaa\.ts.*\+\d+.*-\d+/);

    // A path's two rows differ for a screen reader.
    expect(await review.locator('[data-review-file="a-link"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')))).toEqual(['a-link, added', 'a-link, deleted']);
    // The circle names its file, ticks without moving to it, and shows on the file's header.
    const circle = review.locator('[data-review-file="src/app.ts"] [role="checkbox"]');
    const header = review.locator('[data-guide-file-shell="src/app.ts"]').getByRole('button', { name: /viewed/i }).first();
    await expect(circle).toHaveAttribute('aria-label', 'Mark src/app.ts as viewed');
    await expect(circle).toHaveAttribute('aria-checked', 'false');
    const scroller = review.locator('.ib-gbody');
    const scrolled = await scroller.evaluate((el) => el.scrollTop);
    // It shows under the pointer, not before.
    await expect(circle).toBeHidden();
    await review.locator('[data-review-file="src/app.ts"]').hover();
    await circle.click();
    await expect(circle).toHaveAttribute('aria-checked', 'true');
    await expect(review.locator('.ib-prp-fileshead')).toHaveText('9 files1 viewed');
    await expect(review.locator('[data-review-file="src/app.ts"]')).toHaveAttribute('aria-label', 'src/app.ts, viewed');
    await expect(header).toHaveAttribute('title', /not viewed/);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrolled);

    // A path with two rows counts twice, so every row can end viewed.
    await review.locator('[data-review-file="a-link"]').first().hover();
    await review.locator('[data-review-file="a-link"] [role="checkbox"]').first().click();
    await expect(review.locator('.ib-prp-fileshead')).toHaveText('9 files3 viewed');

    // A reload keeps them; the header's button takes the tick back off the circle.
    await page.reload();
    await expect(header).toBeVisible({ timeout: 30_000 });
    await expect(circle).toHaveAttribute('aria-checked', 'true');
    await expect(review.locator('.ib-prp-fileshead')).toHaveText('9 files3 viewed');
    await header.click();
    await expect(circle).toHaveAttribute('aria-checked', 'false');
    await expect(review.locator('.ib-prp-fileshead')).toHaveText('9 files2 viewed');
  } finally {
    await context.close();
  }
});

test('the sheets cover the diff and nothing else, at 390, 800 and 1100; on a phone the Files sheet opens the same tree', async ({ browser }) => {
  for (const width of [1100, 800, 390]) {
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
    // One sheet at a time, from either side.
    await review.locator('.ib-vcomments').click();
    await expect(rail).toBeHidden();
    await button.click();
    await expect(review.locator('.ib-gpanel')).toBeHidden();
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
    // The key hides it and the page takes the room; the rail stays.
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
    await expect(review.locator('[data-review-file="aaa.ts"] .ib-rv-name')).toHaveCSS('font-size', '19px');
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
    // The bar has it at every width but a phone's, beside the title.
    for (const width of [800, 1040, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(review.locator('.ib-vhead [data-pull-review-readonly]')).toBeVisible();
    }
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

    // From 1500 wide the comments are a column beside the diff, with neither the card's fill nor the diff's; folded, a card.
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
        return { display: panel.display, panel: panel.backgroundColor, inner: inner.backgroundColor, card: token('--card'), ground: token('--background') };
      });
    await page.setViewportSize({ width: 1800, height: 900 });
    await expect.poll(async () => (await fill()).display).toBe('flex');
    const column = await fill();
    expect(column.inner).toBe(column.panel);
    expect([column.card, column.ground]).not.toContain(column.panel);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await fill()).display).toBe('none');
    await review.locator('.ib-vhead .ib-vcomments').click();
    await expect.poll(async () => (await fill()).display).toBe('flex');
    const sheet = await fill();
    expect(sheet.panel).toBe(sheet.card);
    expect(sheet.inner).toBe(sheet.card);
    await review.getByRole('button', { name: 'Close the comments' }).click();

    // The file's scrollbar stays off its header until the pointer is on the file, and the header keeps its 33 px.
    const thumb = shell.locator('[data-diff-hscrollbar] > div');
    await expect(thumb).toHaveCount(1);
    await page.mouse.move(2, 2);
    await expect(thumb).toHaveCSS('opacity', '0');
    await shell.hover();
    await expect(thumb).toHaveCSS('opacity', '1');
    const header = await shell.locator('[data-diff-hscrollbar]').evaluate((bar) => bar.parentElement!.getBoundingClientRect().height);
    expect(header).toBe(33);
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
    await list.locator(`[data-pulls-row="${STACK_ID}"]`).click();
    const pane = page.locator('[data-pulls-stack]');
    await expect(pane).toBeVisible();
    await expect(list).toHaveCount(0);
    await shot(page, 'phone-2-stack');
    await pane.getByRole('button', { name: 'Open the diff', exact: true }).click();
    const review = page.locator('[data-pull-review]');
    await expect(review.locator('[data-guide-file-shell="src/charges/schedule.ts"]')).toBeVisible({ timeout: 30_000 });
    await shot(page, 'phone-3-layer-review');
    // A teammate's PR with no review thread: Review with an agent, the picker inline, every row a touch target.
    await offerLaunch(page);
    await page.goto(`${world.url}#pulls`);
    await page.locator('[data-pulls-row="github.com/northwind/web-app#880"]').click();
    await shot(page, 'phone-4-no-thread');
    await page.locator('[data-pulls-stack] [data-pulls-primary]').click();
    const picker = page.locator('[data-pulls-stack] [data-pulls-picker]');
    await expect(picker.locator('[data-pulls-picker-session]')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const box of await page.locator(PHONE_TARGETS).evaluateAll((els) => els.map((el) => el.getBoundingClientRect()))) {
      expect(box.right).toBeLessThanOrEqual(390);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await shot(page, 'phone-4a-picker');
    await picker.locator('[data-pulls-ask-option="custom"]').click();
    await picker.locator('[data-pulls-ask-words]').fill('what changes for Arabic and Hebrew');
    await shot(page, 'phone-5-ask-custom');
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

/** From each file's code to the next file's header. */
function seams(review: Locator): Promise<number[]> {
  return review.locator('[data-guide-file-shell]').evaluateAll((shells) =>
    shells.slice(1).map((shell, index) => shell.querySelector('[slot="header-custom"]')!.getBoundingClientRect().top - shells[index]!.querySelector('diffs-container')!.getBoundingClientRect().bottom),
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
    writeFileSync(join(world.forge, 'gh-pulls.json'), list.replaceAll(read, pushed).replace(/("number":880,[^}]*?"updatedAt":")[^"]+/, `$1${new Date().toISOString()}`));
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
    await pane.locator('[data-pulls-picker-session="ses-web-pi"]').hover();
    await pause(300);
    await pane.locator('[data-pulls-picker-session="ses-web-claude"]').click();
    await pause(900);
    await pane.locator('[data-pulls-start]').hover();
    await pause(500);
    await pane.locator('[data-pulls-start]').click();
    const chip = pane.locator('[data-pulls-thread]');
    await expect(chip).toBeVisible();
    await expect(pane.locator('[data-pulls-thread-line]')).toContainText('Guided review on the way');
    await pane.locator('[data-pulls-open-diff]').hover();
    await pause(2500);
    const threadId = String(await chip.getAttribute('data-pulls-thread'));
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
