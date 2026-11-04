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
 *  1. Off (the default): no Pull requests row, a #pulls link lands on the
 *     Inbox, and no gh / glab query runs (the fakes' call log).
 *  2. On, with the Board off: the row; the list grouped by whose move it is
 *     (On you with a teammate's review request and the agent's stack, Ready
 *     to land, the folded "2 waiting on others"); the stack is one row with
 *     its chain.
 *  3. The stack view with the Board off: layers from main up, "Lands next" on
 *     the lowest open one, the agent's thread (tied by the PR's link in the
 *     agent's own message), no Board UI, no merge button.
 *  4. A PR with no agent: "No agent yet", the Agent line lists the
 *     project's live sessions as pills that pick; the purple Review starts a
 *     thread with the hand-off's words for the picked one, and the PR is that
 *     thread's from then on. "Open the diff" sits beside it in every state
 *     (before, on the way, arrived, posted), and each row opens its diff. (Launch an agent shows
 *     only while the Inbox can launch; the shots add compose's launch block to
 *     the sessions answer, since launching is not on main yet.)
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
    author: { login: 'dana' },
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

/** One live session: the bridge's long-poll, as the mod, Pi and OpenCode run it (compose's and Hand to an agent's sessions). */
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
 * block an Inbox that can launch adds, so Launch an agent shows. Nothing is launched.
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
          nodes: [ghPull(webRepo, 880, { title: 'RTL layout for the settings pages', author: { login: 'tomas' }, headRefName: 'tomas/rtl-settings', updatedAt: ago(4), ...stats(rtl), reviewRequests: { nodes: [{ requestedReviewer: { login: 'dana' } }] } })],
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
    author: { username: 'dana' },
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
          requested: { nodes: [mr(58, { title: 'Round cents half to even', author: { username: 'priya' }, sourceBranch: 'priya/rounding', updatedAt: ago(75), ...glStats(rounding) })] },
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
  // Two live sessions in web-app (Hand to an agent's menu), one in billing-svc.
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
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.polls.map((poll) => poll.stop()));
    await world.claude.close().catch(() => {});
    await world.codex.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

const STACK_ID = 'github.com/northwind/billing-svc#414';
const LAYER_412 = 'github.com/northwind/billing-svc#412';
const LAYER_413 = 'github.com/northwind/billing-svc#413';
const LOCALE = 'github.com/northwind/web-app#869';

test('off (the default): no row, a #pulls link lands on the Inbox, and no gh or glab query runs', async () => {
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
  await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('pulls');
  await expect(page.locator('[data-pulls-list]')).toHaveCount(0);
  await page.goto(world.url);
  await expect(page.locator('[data-inbox-nav]')).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '1-off-no-row');
  page.off('request', watch);
  expect(reads).toEqual([]);
  expect(forgeCalls().filter((c) => c.endsWith(' pulls') || c.includes(' diff '))).toEqual([]);
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
  await expect(stackRow).toContainText('3 open, 1 merged · start at #412');
  await expect(stackRow).toContainText('Retry failed charges');
  await expect(list.locator('[data-pulls-on-you]')).toHaveText('3 on you');
  // The head's title and count are never cut: the project filter gives way (unset, its folder mark).
  for (const selector of ['[data-pulls-heading]', '[data-pulls-on-you]']) {
    expect(await list.locator(selector).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await expect(list.locator('[data-board-project-chip]')).toHaveAccessibleName(/All projects/);
  await expect(page.locator('[data-pulls-nav] .ib-n')).toHaveText('3');
  await shot(page, '2-list');
  await fold.click();
  await expect(list.locator('[data-pulls-group="waiting"] [data-pulls-row]')).toHaveCount(2);
  await fold.click();
});

test('the stack view with the Board off: layers from main up, Lands next, the agent and its thread, no Board UI, no merge button', async () => {
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
  await expect(pane).toContainText('Claude Code');
  await expect(pane.locator('[data-pulls-thread]')).toBeVisible();
  await expect(pane.locator('[data-pulls-thread]')).toHaveText(/^Thread\s*Retry failed charges$/);
  // The Board is off: no card chip, no Board words.
  await expect(pane.locator('[data-pulls-card]')).toHaveCount(0);
  await expect(pane).not.toContainText('Board');
  await expect(pane.locator('[data-pulls-no-agent]')).toHaveCount(0);
  await expect(pane.getByRole('button', { name: /merge/i })).toHaveCount(0);
  // An agent has it: no Review (Hand to another agent asks again); the diff is one button away.
  await expect(pane.locator('[data-pulls-review]')).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'Open the diff', exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Whole stack' })).toBeVisible();
  await shot(page, '3-stack-board-off');
});

/** The agent's guided review of a one-file PR, sent as phase 1's review (`review: true`), in reply to the hand-off. */
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

/** The same PR on a phone (390 px), in a context of its own: for the hand-off's states, taken where they happen. */
async function phoneShot(browser: Browser, row: string, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light', deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await offerLaunch(page);
    await page.goto(`${world.url}#pulls`);
    const toggle = page.locator('[data-pulls-waiting-toggle][aria-expanded="false"]');
    if (await toggle.count()) await toggle.click();
    await page.locator(`[data-pulls-row="${row}"]`).click();
    await expect(page.locator('[data-pulls-stack]')).toBeVisible();
    // The pills wrap inside the screen: nothing scrolls sideways, and each is a full touch target.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const box of await page.locator('[data-pulls-hand-session], [data-pulls-launch], [data-pulls-review], [data-pulls-open-diff]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()))) {
      expect(box.right).toBeLessThanOrEqual(390);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator('[data-pulls-stack] [data-pulls-open-diff]')).toBeVisible();
    await shot(page, name, schemes);
  } finally {
    await context.close();
  }
}

test('a PR with no agent: Ask for (Guided review / Custom curation), the picked agent, Review, "on the way", Start review, Hand to another agent, and Open the diff in each', async ({ browser }) => {
  const { page } = world;
  await offerLaunch(page);
  await page.goto(`${world.url}#pulls`);
  const list = page.locator('[data-pulls-list]');
  await list.locator('[data-pulls-waiting-toggle]').click();
  await list.locator(`[data-pulls-row="${LOCALE}"]`).click();
  const pane = page.locator('[data-pulls-stack]');
  await expect(pane.locator('[data-pulls-no-agent]')).toHaveText('No agent yet');
  // Inline, no menu: Ask for, then Agent with the agents as pills (one picked) and + New agent last.
  const hand = pane.locator('[data-pulls-handoff="first"]');
  await expect(hand).toContainText('Ask for');
  await expect(hand.locator('.ib-pr-lab').nth(1)).toHaveText('Agent');
  // The pills are one radio group: one agent is picked.
  await expect(hand.getByRole('radiogroup', { name: 'Agent' }).getByRole('radio')).toHaveCount(2);
  await expect(hand.locator('[data-pulls-hand-session] input:checked')).toHaveCount(1);
  await expect(pane.locator('[data-pulls-hand-menu], [role="menu"]')).toHaveCount(0);
  await expect(pane.locator('[data-pulls-reply]')).toHaveCount(0);
  // Only web-app's live sessions: billing-svc's is another project's.
  await expect(hand.locator('[data-pulls-hand-session]')).toHaveCount(2);
  await expect(hand.locator('[data-pulls-hand-session="ses-billing-claude"]')).toHaveCount(0);
  await expect(hand.locator('[data-pulls-launch]')).toHaveText('New agent');
  await expect(hand.locator('[data-pulls-ask-choice]')).toHaveAttribute('data-pulls-ask-choice', 'guide');
  // Review (just "Review", purple) sits under the two lines, Open the diff beside it.
  const grid = (await hand.locator('.ib-pr-hgrid').boundingBox())!;
  const reviewButton = hand.locator('[data-pulls-review]');
  await expect(reviewButton).toHaveText('Review');
  await expect(reviewButton).toHaveClass(/ib-pri/);
  expect((await reviewButton.boundingBox())!.y).toBeGreaterThan(grid.y + grid.height - 1);
  expect((await hand.locator('[data-pulls-open-diff]').boundingBox())!.y).toBe((await reviewButton.boundingBox())!.y);
  // A pill only picks: nothing is sent until Review.
  await hand.locator('[data-pulls-hand-session="ses-web-claude"]').click();
  await expect(hand.locator('[data-pulls-hand-session="ses-web-claude"] input')).toBeChecked();
  await expect(hand.locator('[data-pulls-review]')).toHaveAccessibleDescription('With Claude Code');
  await expect(pane.locator('[data-pulls-thread]')).toHaveCount(0);
  await shot(page, '4-no-agent');
  // The row opens the diff too: "Open diff ›" at its end, under the pointer.
  const row = pane.locator(`[data-pulls-layer="${LOCALE}"] button`);
  await row.hover();
  await expect(row.locator('.ib-pr-lgo')).toHaveText('Open diff');
  await shot(page, '4b-row-hover', ['light']);
  await page.mouse.move(0, 0);
  await hand.locator('[data-pulls-ask-option="custom"]').click();
  await hand.locator('[data-pulls-ask-words]').fill('Check the fallback chain, and a test for a missing locale');
  await shot(page, '5-ask-custom');
  await hand.locator('[data-pulls-ask-option="guide"]').click();
  await hand.locator('[data-pulls-review]').click();
  await expect(hand).toHaveCount(0);
  // Focus lands on the status line that says who has it.
  await expect(pane.locator('[data-pulls-said]')).toBeFocused();
  const chip = pane.locator('[data-pulls-thread]');
  await expect(chip).toBeVisible();
  await expect(pane.locator('[data-pulls-said]')).toContainText(/Claude Code\s*· guided review on the way\s*·\s*Hand to another agent/);
  const threadId = String(await chip.getAttribute('data-pulls-thread'));
  const opening = await world.claude.nextReply(threadId);
  const words = String(opening.body);
  expect(words.startsWith("You're being asked to help me review and understand a pull request. Don't change any code unless I explicitly tell you to.\n")).toBe(true);
  expect(words).toContain('\n- Title: Fall back to English for missing strings\n- Number: #869\n');
  expect(words).toContain('\n- Link: https://github.com/northwind/web-app/pull/869\n');
  expect(words).toContain('\n1. Send me a guided review of its diff against main, using /review-curate (its instructions are at the end of this message).\n');
  expect(words).toContain('BEGIN SKILL INSTRUCTIONS: review-curate');
  // Kept: a fresh read still ties it to that thread, and says what was asked.
  await page.reload();
  await expect(page.locator('[data-pulls-stack] [data-pulls-thread]')).toHaveAttribute('data-pulls-thread', threadId);
  await expect(page.locator(`[data-pulls-row="${LOCALE}"]`)).toContainText('#869 · Claude Code has it · your review');
  await expect(page.locator('[data-pulls-stack] [data-pulls-said-waiting]')).toContainText('guided review on the way');
  await expect(page.locator('[data-pulls-stack] [data-pulls-review]')).toHaveCount(0);
  await expect(page.locator('[data-pulls-stack] [data-pulls-open-diff]')).toBeVisible();
  await shot(page, '6-on-the-way');
  await phoneShot(browser, LOCALE, 'phone-6-on-the-way');

  // The agent's guided review arrives through phase 1's path: on the PR it is Start review.
  await sendReview(world.claude, world.projects.web, String(opening.id), world.patches.locale, 'src/i18n/fallback.ts', 'Fall back to English for missing strings');
  await page.reload();
  const startReview = page.locator('[data-pulls-stack] [data-pulls-start-review]');
  await expect(startReview).toBeVisible();
  await expect(page.locator('[data-pulls-stack] [data-pulls-ask]')).toHaveCount(0);
  const startBox = (await startReview.boundingBox())!;
  expect((await page.locator('[data-pulls-stack] [data-pulls-open-diff]').boundingBox())!.y).toBe(startBox.y);
  await shot(page, '6a-start-review');
  await phoneShot(browser, LOCALE, 'phone-6a-start-review');
  // Hand to another agent: the two lines again, "Hand again for", without the agent that has it; Escape folds them.
  await page.locator('[data-pulls-stack] [data-pulls-rehand]').click();
  const again = page.locator('[data-pulls-stack] [data-pulls-handoff="again"]');
  await expect(again).toContainText('Hand again for');
  await expect(again.locator('[data-pulls-hand-session]')).toHaveCount(1);
  await expect(again.locator('[data-pulls-hand-session="ses-web-pi"]')).toBeVisible();
  await expect(again.locator('[data-pulls-launch]')).toHaveCount(0);
  await expect(again.locator('[data-pulls-hand-session="ses-web-pi"] input')).toBeChecked();
  await shot(page, '6c-start-review-rehand');
  await again.locator('[data-pulls-ask-option="guide"]').focus();
  await page.keyboard.press('Escape');
  await expect(again).toHaveCount(0);
  await page.locator('[data-pulls-stack] [data-pulls-open-diff]').click();
  await expect(page.locator('[data-pull-review]')).toHaveAttribute('data-pull-review', LOCALE);
  await page.goto(`${world.url}#pulls`);
  await page.locator(`[data-pulls-row="${LOCALE}"]`).click();
  await expect(startReview).toBeVisible();
  await startReview.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('guide=');
  await page.unroute('**/api/inbox/sessions*');
});

test('the Board on, a card linking the stack: a quiet Board chip beside its thread', async () => {
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
  await expect(pane.locator('[data-pulls-thread]')).toHaveText(/^Thread\s*Retry failed charges$/);
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
  await shot(page, '7-layer-review');

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
    // A teammate's PR with no agent: the same two lines, each label over its line, the pills wrapping.
    await offerLaunch(page);
    await page.goto(`${world.url}#pulls`);
    await page.locator('[data-pulls-row="github.com/northwind/web-app#880"]').click();
    const hand = page.locator('[data-pulls-stack] [data-pulls-handoff="first"]');
    await expect(hand.locator('[data-pulls-hand-session]')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    for (const box of await hand.locator('[data-pulls-hand-session], [data-pulls-launch], [data-pulls-review], [data-pulls-open-diff]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()))) {
      expect(box.right).toBeLessThanOrEqual(390);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await shot(page, 'phone-4-no-agent');
    await hand.locator('[data-pulls-ask-option="custom"]').click();
    await hand.locator('[data-pulls-ask-words]').fill('what changes for Arabic and Hebrew');
    await shot(page, 'phone-5-ask-custom');
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

test('the walkthrough video (20 s or less): Review hands a PR to the picked agent, Open the diff in every state, its guided review arriving as Start review', async ({ browser }) => {
  test.skip(!video, 'PLANNOTATOR_E2E_VIDEO=1 records it');
  const dir = join(proofDir, 'video');
  await setBoard(false);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', recordVideo: { dir, size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  await offerLaunch(page);
  const pause = (ms: number) => page.waitForTimeout(ms);
  try {
    await page.goto(`${world.url}#pulls`);
    // A teammate's PR with no agent: Review, and Open the diff beside it.
    await page.locator('[data-pulls-row="github.com/northwind/web-app#880"]').click();
    const pane = page.locator('[data-pulls-stack]');
    await expect(pane.locator('[data-pulls-review]')).toBeVisible();
    await pause(2200);
    // The row opens the diff too.
    await pane.locator('[data-pulls-layer="github.com/northwind/web-app#880"] button').hover();
    await pause(1300);
    await pane.locator('[data-pulls-hand-session="ses-web-pi"]').hover();
    await pause(300);
    await pane.locator('[data-pulls-hand-session="ses-web-claude"]').click();
    await pause(900);
    await pane.locator('[data-pulls-review]').hover();
    await pause(500);
    await pane.locator('[data-pulls-review]').click();
    const chip = pane.locator('[data-pulls-thread]');
    await expect(chip).toBeVisible();
    await expect(pane.locator('[data-pulls-said]')).toContainText('guided review on the way');
    await pane.locator('[data-pulls-open-diff]').hover();
    await pause(2500);
    const threadId = String(await chip.getAttribute('data-pulls-thread'));
    const opening = await world.claude.nextReply(threadId);
    await sendReview(world.claude, world.projects.web, String(opening.id), world.patches.rtl, 'src/settings/Layout.tsx', 'RTL layout for the settings pages');
    await page.reload();
    await expect(page.locator('[data-pulls-stack] [data-pulls-start-review]')).toBeVisible();
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
