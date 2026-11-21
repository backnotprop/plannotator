/**
 * Reuse of passed e2e specs between runs of one PR (.github/workflows/inbox-e2e.yml).
 *
 *   bun run scripts/ci-e2e-reuse.ts plan                       # the plan job
 *   bun run scripts/ci-e2e-reuse.ts passed <report.json> <out>  # each shard, after its specs
 *
 * Most reruns of the e2e on a PR repeat work: main is merged into the PR to pick
 * up a quarantine or a fix after a red run, or the run was cancelled half way,
 * and the PR's own change is the same as before. In the week to 6 Nov 2026,
 * 158 of 590 PR runs had the same own change as an earlier run of the same PR,
 * and they used about 25,700 of the 86,000 PR shard-minutes.
 *
 * So each shard records the spec files that fully passed (from Playwright's
 * JSON report) with each file's blob, and the plan job of the next run on the
 * same PR looks for the newest earlier run with the same key:
 *
 *  - the key is the PR's own change, `git diff <merge-base> <PR head>` (3 lines
 *    of context) as a `git patch-id --verbatim`, so a moved line or a
 *    whitespace edit is a new key, without the spec files and unit test files
 *    (they cannot change the binary or the app), plus the blobs of the files
 *    that drive the run itself (HARNESS) in the tested merge commit. A merge of main that
 *    leaves the PR's own change as it was keeps the key; any change the PR makes
 *    to source or test helpers, or a change on main to the harness (Playwright,
 *    the lockfile, this workflow), changes it and the run is a full one.
 *  - a spec is left out only when it passed in that run, or was left out there
 *    for the same reason, with the same blob and the same quarantine entries
 *    (tests/e2e/quarantine.json) as now, and the run that really ran it did so
 *    in the last MAX_PASS_AGE_MS. A left-out spec keeps that run's pass and
 *    age; it is never passed on as a new pass. A spec that changed, a new
 *    spec, a spec whose quarantine entries changed, an old pass and a spec that
 *    failed or never finished run again.
 *  - the specs that remain are spread over as many shards as they need, each
 *    about as long as a shard of a full run (at least one: shard 1 also runs
 *    the update specs and the phone door's proofs).
 *
 * A run is always full on a schedule or by hand, for a PR from a fork, when the
 * PR has the `ci:e2e-all` label, with no earlier run of the same key, and when
 * anything here fails (the plan never fails the job: it falls back to full).
 *
 * What a left-out spec does not prove: that it still passes with the newer
 * main the PR was merged with. That is the same as a PR that merges without
 * merging main first, which the merge loop already allows; the two-hourly run
 * on main covers main itself.
 *
 * scripts/ci-e2e-reuse.test.ts checks the key, the report reading, the pass
 * records, the lookup and the plan, its fallback included.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { E2E_SHARDS, SHARD_1_EXTRA_S, repoRoot, specFiles, specTimes } from './ci-e2e-shard';

/** The label that makes a PR's next run a full one. */
export const FULL_LABEL = 'ci:e2e-all';
/** Changes the key leaves out: they reach neither the binary nor the built apps. */
export const KEY_EXCLUDES = ['tests/e2e/*.spec.ts', '*.test.ts', '*.test.tsx'];
/** Files that drive the run itself; a change to any of them, from the PR or from main, makes the run a full one. */
export const HARNESS = [
  '.github/workflows/inbox-e2e.yml',
  'bun.lock',
  'package.json',
  'scripts/ci-e2e-reuse.ts',
  'scripts/ci-e2e-shard.ts',
  'tests/e2e/global-setup.ts',
  'tests/e2e/playwright.config.ts',
  'tests/e2e/quarantine.ts',
];
/** How many earlier runs of the PR the plan looks through for one with the same key. */
export const LOOKBACK_RUNS = 10;
export const PLAN_DIR = '.local/e2e-plan';
/** `e2e-reuse-<attempt>`: a "Re-run all jobs" uploads it again. */
export const REUSE_ARTIFACT_PREFIX = 'e2e-reuse-';
export const PASSED_ARTIFACT_PREFIX = 'e2e-passed-';

/** How long a pass counts, from the start of the shard that really ran the spec. */
export const MAX_PASS_AGE_MS = 24 * 3600_000;
export const QUARANTINE_JSON = 'tests/e2e/quarantine.json';

/** One spec's pass: the blob and quarantine entries it passed with, and the run and time it really ran in. */
export interface PassRecord {
  blob: string;
  quarantine: string;
  run: string;
  ranAt: string;
}
/** Spec file (repo-relative) -> its pass. */
export type Passed = Record<string, PassRecord>;
/** What a spec has now, to compare a pass against. */
export interface Current {
  blobs: Record<string, string>;
  quarantine: Record<string, string>;
  now: number;
}

export interface Plan {
  /** How many shards run. */
  count: number;
  /** The specs to spread over them, or null for every spec over E2E_SHARDS shards (a full run). */
  specs: string[] | null;
  /** The specs left out because they passed earlier at the same blob. */
  reused: string[];
  /** Why the run is full, or which run it reuses. */
  why: string;
}

function git(args: string[], cwd: string, input?: string): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/**
 * The key of a PR run: its own change (merge base to `head`, without KEY_EXCLUDES)
 * and the HARNESS blobs in `tested`, the commit the run checks out.
 */
export function reuseKey(base: string, head: string, tested: string, cwd = repoRoot): string {
  const mergeBase = git(['merge-base', base, head], cwd).trim();
  // Default context and --verbatim: without them a moved line or a whitespace edit (in a string too) keeps the key.
  const diff = git(['diff', '-U3', '--no-color', '--no-ext-diff', '--no-renames', mergeBase, head, '--', '.', ...KEY_EXCLUDES.map((p) => `:(exclude)${p}`)], cwd);
  const patchId = diff ? git(['patch-id', '--verbatim'], cwd, diff).split(' ')[0] || 'none' : 'none';
  const harness = git(['ls-tree', tested, '--', ...HARNESS], cwd).trim();
  return createHash('sha256').update(`own ${patchId}\n${harness}\n`).digest('hex');
}

/** The blob of every file under tests/e2e in `commit`, by repo-relative path. */
export function specBlobs(commit = 'HEAD', cwd = repoRoot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of git(['ls-tree', '-r', commit, '--', 'tests/e2e'], cwd).split('\n')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

type QuarantineEntry = { spec: string; title: string; describe?: string; dependents?: { title: string }[] };

/**
 * Per spec file (repo-relative), a hash of what tests/e2e/quarantine.json
 * leaves out of it in CI: each entry's title, describe and dependents. An
 * edit to an entry's reason or evidence keeps it.
 */
export function quarantineHashes(files: string[], entries: QuarantineEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of files) {
    const name = file.split('/').pop();
    const mine = entries
      .filter((e) => e.spec === name)
      .map((e) => JSON.stringify([e.title, e.describe ?? null, (e.dependents ?? []).map((d) => d.title).sort()]))
      .sort();
    out[file] = createHash('sha256').update(JSON.stringify(mine)).digest('hex').slice(0, 16);
  }
  return out;
}

function readQuarantine(root = repoRoot): QuarantineEntry[] {
  return (JSON.parse(readFileSync(join(root, QUARANTINE_JSON), 'utf8')) as { tests: QuarantineEntry[] }).tests;
}

type ReportTest = { status?: string; results?: { status?: string }[] };
type ReportSpec = { file?: string; tests?: ReportTest[] };
type ReportSuite = { file?: string; specs?: ReportSpec[]; suites?: ReportSuite[] };
export type Report = { config?: { rootDir?: string }; suites?: ReportSuite[]; errors?: unknown[]; stats?: { startTime?: string } };

/** A test that passed, or that ran and skipped itself. A test that never ran (an interrupted or cancelled run) has no results. */
function testPassed(t: ReportTest): boolean {
  if (t.status === 'expected') return true;
  const results = t.results ?? [];
  return t.status === 'skipped' && results.length > 0 && results.every((r) => r.status === 'skipped');
}

/**
 * The spec files of a Playwright JSON report in which every test passed, as
 * repo-relative paths. None when the report has a top-level error (a global
 * setup or a file that did not load).
 */
export function passedSpecs(report: Report, root = repoRoot): string[] {
  if ((report.errors ?? []).length > 0) return [];
  // Both through realpath: a report written under a symlinked path (macOS /tmp) still maps into the repo.
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
  root = real(root);
  const rootDir = real(report.config?.rootDir ?? join(root, 'tests/e2e'));
  const ok = new Map<string, boolean>();
  const walk = (suite: ReportSuite, file: string | undefined) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const f = spec.file ?? here;
      if (!f) continue;
      const path = relative(root, resolve(rootDir, f)).replaceAll('\\', '/');
      const tests = spec.tests ?? [];
      ok.set(path, (ok.get(path) ?? true) && tests.length > 0 && tests.every(testPassed));
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, undefined);
  return [...ok].filter(([, pass]) => pass).map(([path]) => path).sort();
}

/**
 * The plan of a run: every spec over E2E_SHARDS shards, unless some passed
 * earlier at the blob they have now; then the rest, over as many shards as
 * they need at about a full run's shard length, at least one.
 */
export function planRun(files: string[], times: Record<string, number>, passed: Passed, current: Current, why: string): Plan {
  const reused = files.filter((f) => reusable(passed[f], f, current));
  if (reused.length === 0) return { count: E2E_SHARDS, specs: null, reused: [], why: why || 'no spec passed earlier at the same blob' };
  const keep = new Set(reused);
  const specs = files.filter((f) => !keep.has(f));
  const known = Object.values(times).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (file: string) => times[file.split('/').pop()!] ?? median;
  const sum = (list: string[]) => list.reduce((s, f) => s + weight(f), 0);
  const shardLength = (sum(files) + SHARD_1_EXTRA_S) / E2E_SHARDS;
  const count = Math.min(E2E_SHARDS, Math.max(1, Math.ceil((sum(specs) + SHARD_1_EXTRA_S) / shardLength)));
  return { count, specs, reused, why };
}

/** A pass still counts: same blob, same quarantine entries, and run in the last MAX_PASS_AGE_MS. */
export function reusable(pass: PassRecord | undefined, file: string, current: Current): boolean {
  if (!pass || pass.blob !== current.blobs[file] || pass.quarantine !== current.quarantine[file]) return false;
  const ranAt = Date.parse(pass.ranAt);
  return Number.isFinite(ranAt) && current.now - ranAt <= MAX_PASS_AGE_MS && ranAt <= current.now + 60_000;
}

/** The passed specs an earlier run leaves: what it reused itself (with the original run's record), and what its shards passed. */
export function mergePassed(carried: Passed, shardsPassed: Passed[]): Passed {
  return Object.assign({}, carried, ...shardsPassed);
}

/** The records of the specs a shard passed, stamped with this run and the time the shard's specs started. */
export function passRecords(report: Report, current: Omit<Current, 'now'>, run: string, fallbackTime: string, root = repoRoot): Passed {
  const ranAt = report.stats?.startTime && Number.isFinite(Date.parse(report.stats.startTime)) ? new Date(report.stats.startTime).toISOString() : fallbackTime;
  const out: Passed = {};
  for (const f of passedSpecs(report, root)) {
    if (current.blobs[f] && current.quarantine[f]) out[f] = { blob: current.blobs[f], quarantine: current.quarantine[f], run, ranAt };
  }
  return out;
}

/** What the plan needs from GitHub: a REST call, and an artifact of a run unpacked into a folder. */
export interface GitHub {
  api(path: string): unknown;
  download(runId: string, artifact: string, dir: string): void;
}

function ghCli(repo: string): GitHub {
  const gh = (args: string[]) => {
    const r = Bun.spawnSync(['gh', ...args], { cwd: repoRoot, stdin: 'ignore' });
    if (r.exitCode !== 0) throw new Error(`gh ${args.join(' ')}: ${r.stderr.toString().trim()}`);
    return r.stdout.toString();
  };
  return {
    api: (path) => JSON.parse(gh(['api', path])),
    download: (runId, artifact, dir) => void gh(['run', 'download', runId, '-R', repo, '-n', artifact, '-D', dir]),
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

type Run = { id: number; event: string; head_branch: string; conclusion?: string | null; head_repository?: { full_name?: string } };

/**
 * The newest of the PR's last LOOKBACK_RUNS earlier runs (same repo, same
 * branch, pull_request, not skipped) whose key is `key`, and the specs it leaves passed:
 * what it left out itself and what each of its shards passed, every attempt.
 */
export function findEarlier(key: string, scratch: string, ctx: { repo: string; headRef: string; runId: string }, github: GitHub): { run: string; passed: Passed } | null {
  const { repo, headRef, runId } = ctx;
  const runs = github.api(`repos/${repo}/actions/workflows/inbox-e2e.yml/runs?event=pull_request&branch=${encodeURIComponent(headRef)}&per_page=30`) as { workflow_runs: Run[] };
  const earlier = runs.workflow_runs
    // A run that skipped every job (a push before the PR had ci:e2e, another label) has nothing to give.
    .filter((r) => String(r.id) !== runId && r.event === 'pull_request' && r.head_branch === headRef && r.head_repository?.full_name === repo && r.conclusion !== 'skipped')
    .slice(0, LOOKBACK_RUNS);
  for (const run of earlier) {
    const id = String(run.id);
    const artifacts = github.api(`repos/${repo}/actions/runs/${id}/artifacts?per_page=100`) as { artifacts: { name: string; expired: boolean }[] };
    const names = artifacts.artifacts.filter((a) => !a.expired).map((a) => a.name);
    // The plan of the newest attempt.
    const reuseName = names
      .filter((n) => /^e2e-reuse-\d+$/.test(n))
      .sort((a, b) => Number(b.slice(REUSE_ARTIFACT_PREFIX.length)) - Number(a.slice(REUSE_ARTIFACT_PREFIX.length)))[0];
    if (!reuseName) continue;
    const dir = join(scratch, id);
    github.download(id, reuseName, join(dir, reuseName));
    const reuse = readJson<{ key: string; passed: Passed }>(join(dir, reuseName, 'reuse.json'));
    if (!reuse.key || reuse.key !== key) continue;
    const shardsPassed: Passed[] = [];
    for (const name of names.filter((n) => n.startsWith(PASSED_ARTIFACT_PREFIX))) {
      github.download(id, name, join(dir, name));
      const file = join(dir, name, 'passed.json');
      if (existsSync(file)) shardsPassed.push(readJson<{ passed: Passed }>(file).passed);
    }
    return { run: id, passed: mergePassed(reuse.passed, shardsPassed) };
  }
  return null;
}

/** Why this run must be a full one, or '' when it may reuse. */
export function fullRunReason(env: Record<string, string | undefined>): string {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return `a ${env.GITHUB_EVENT_NAME ?? 'unknown'} run is always full`;
  if (!env.HEAD_REPO || env.HEAD_REPO !== env.GITHUB_REPOSITORY) return 'a PR from a fork is always full';
  const labels = (JSON.parse(env.PR_LABELS || '[]') as string[] | null) ?? [];
  if (labels.includes(FULL_LABEL)) return `the PR has the ${FULL_LABEL} label`;
  return '';
}

/** What the plan reads: the specs and their state now, the key, and GitHub. */
export interface PlanDeps {
  files: string[];
  times: Record<string, number>;
  current: Current;
  key: () => string;
  github: (repo: string) => GitHub;
  scratch: string;
}

/**
 * The plan of this run, and the reuse record it leaves for the next one (the
 * key, and the original pass of each spec it left out). Never throws: when
 * anything in the reuse fails, a full run.
 */
export function decidePlan(env: Record<string, string | undefined>, deps: PlanDeps): { plan: Plan; reuse: { key: string; passed: Passed } } {
  const { files, times, current } = deps;
  let key = '';
  let earlier: { run: string; passed: Passed } | null = null;
  let plan: Plan;
  if (env.GITHUB_EVENT_NAME !== 'pull_request') {
    plan = planRun(files, times, {}, current, fullRunReason(env));
  } else {
    try {
      const reason = fullRunReason(env);
      // The key is kept even for a full run, so the next run of the PR can reuse this one.
      key = deps.key();
      if (!reason) {
        const repo = env.GITHUB_REPOSITORY;
        const headRef = env.GITHUB_HEAD_REF;
        if (!repo || !headRef) throw new Error('no GITHUB_REPOSITORY or GITHUB_HEAD_REF');
        earlier = findEarlier(key, deps.scratch, { repo, headRef, runId: env.GITHUB_RUN_ID ?? '' }, deps.github(repo));
      }
      plan = planRun(files, times, earlier?.passed ?? {}, current, reason || (earlier ? `reuses run ${earlier.run}` : 'no earlier run of this PR with the same change'));
    } catch (err) {
      console.log(`::warning title=e2e reuse::${String(err).split('\n')[0]} (a full run instead)`);
      earlier = null;
      plan = planRun(files, times, {}, current, 'the reuse lookup failed');
    }
  }
  // A left-out spec keeps the pass of the run that really ran it, with that run's age.
  const passed: Passed = {};
  if (key && earlier) for (const f of plan.reused) passed[f] = earlier.passed[f]!;
  return { plan, reuse: { key, passed } };
}

/** The plan job's outputs: the shard count and the matrix (1..16 for a full run). */
export function planOutputs(plan: Plan): string {
  return `count=${plan.count}\nmatrix=${JSON.stringify(Array.from({ length: plan.count }, (_, i) => i + 1))}\n`;
}

function plan(): void {
  const out = join(repoRoot, PLAN_DIR);
  mkdirSync(out, { recursive: true });
  const files = specFiles();
  const { plan: result, reuse } = decidePlan(process.env, {
    files,
    times: specTimes(),
    current: { blobs: specBlobs('HEAD'), quarantine: quarantineHashes(files, readQuarantine()), now: Date.now() },
    // HEAD is GitHub's merge commit: main as it was (HEAD^1), then the PR's head (HEAD^2).
    key: () => reuseKey('HEAD^1', 'HEAD^2', 'HEAD'),
    github: ghCli,
    scratch: join(out, 'earlier'),
  });
  writeFileSync(join(out, 'plan.json'), `${JSON.stringify(result, null, 1)}\n`);
  writeFileSync(join(out, 'reuse.json'), `${JSON.stringify(reuse, null, 1)}\n`);
  const summary = result.specs
    ? `e2e: ${result.reused.length} specs that passed in the last day at the same blob are left out (${result.why}); ${result.specs.length} specs run on ${result.count} shards.`
    : `e2e: a full run, every spec on ${result.count} shards (${result.why}).`;
  console.log(summary);
  if (result.specs) console.log(`  run:\n    ${result.specs.join('\n    ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, planOutputs(result));
}

/** Records the specs a shard passed. Never fails the shard: with no report or on any error it records none. */
function passed(reportPath: string, outPath: string): void {
  let out: Passed = {};
  try {
    if (existsSync(reportPath)) {
      const files = specFiles();
      const current = { blobs: specBlobs('HEAD'), quarantine: quarantineHashes(files, readQuarantine()) };
      out = passRecords(readJson<Report>(reportPath), current, process.env.GITHUB_RUN_ID ?? 'local', new Date().toISOString());
    }
  } catch (err) {
    console.log(`::warning title=e2e reuse::${String(err).split('\n')[0]} (this shard records no passed specs)`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ passed: out }, null, 1)}\n`);
  console.log(`e2e: ${Object.keys(out).length} spec files passed in this shard${existsSync(reportPath) ? '' : ' (no report)'}.`);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'plan') plan();
  else if (cmd === 'passed' && rest.length === 2) passed(rest[0]!, rest[1]!);
  else {
    console.error('usage: bun run scripts/ci-e2e-reuse.ts plan | passed <report.json> <out.json>');
    process.exit(2);
  }
}
