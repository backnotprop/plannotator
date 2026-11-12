import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { E2E_SHARDS, SHARD_1_EXTRA_S, repoRoot, specFiles, specTimes } from './ci-e2e-shard';

export const FULL_LABEL = 'ci:e2e-all';
export const KEY_EXCLUDES = ['tests/e2e/*.spec.ts', '*.test.ts', '*.test.tsx'];
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
export const LOOKBACK_RUNS = 10;
export const PLAN_DIR = '.local/e2e-plan';
export const REUSE_ARTIFACT_PREFIX = 'e2e-reuse-';
export const PASSED_ARTIFACT_PREFIX = 'e2e-passed-';

export const MAX_PASS_AGE_MS = 24 * 3600_000;
export const QUARANTINE_JSON = 'tests/e2e/quarantine.json';

export interface PassRecord {
  blob: string;
  quarantine: string;
  run: string;
  ranAt: string;
}
export type Passed = Record<string, PassRecord>;
export interface Current {
  blobs: Record<string, string>;
  quarantine: Record<string, string>;
  now: number;
}

export interface Plan {
  count: number;
  specs: string[] | null;
  reused: string[];
  why: string;
}

function git(args: string[], cwd: string, input?: string): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

export function reuseKey(base: string, head: string, tested: string, cwd = repoRoot): string {
  const mergeBase = git(['merge-base', base, head], cwd).trim();
  const diff = git(['diff', '-U3', '--no-color', '--no-ext-diff', '--no-renames', mergeBase, head, '--', '.', ...KEY_EXCLUDES.map((p) => `:(exclude)${p}`)], cwd);
  const patchId = diff ? git(['patch-id', '--verbatim'], cwd, diff).split(' ')[0] || 'none' : 'none';
  const harness = git(['ls-tree', tested, '--', ...HARNESS], cwd).trim();
  return createHash('sha256').update(`own ${patchId}\n${harness}\n`).digest('hex');
}

export function specBlobs(commit = 'HEAD', cwd = repoRoot): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of git(['ls-tree', '-r', commit, '--', 'tests/e2e'], cwd).split('\n')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

type QuarantineEntry = { spec: string; title: string; describe?: string; dependents?: { title: string }[] };

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

function testPassed(t: ReportTest): boolean {
  if (t.status === 'expected') return true;
  const results = t.results ?? [];
  return t.status === 'skipped' && results.length > 0 && results.every((r) => r.status === 'skipped');
}

export function passedSpecs(report: Report, root = repoRoot): string[] {
  if ((report.errors ?? []).length > 0) return [];
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

export function reusable(pass: PassRecord | undefined, file: string, current: Current): boolean {
  if (!pass || pass.blob !== current.blobs[file] || pass.quarantine !== current.quarantine[file]) return false;
  const ranAt = Date.parse(pass.ranAt);
  return Number.isFinite(ranAt) && current.now - ranAt <= MAX_PASS_AGE_MS && ranAt <= current.now + 60_000;
}

export function mergePassed(carried: Passed, shardsPassed: Passed[]): Passed {
  return Object.assign({}, carried, ...shardsPassed);
}

export function passRecords(report: Report, current: Omit<Current, 'now'>, run: string, fallbackTime: string, root = repoRoot): Passed {
  const ranAt = report.stats?.startTime && Number.isFinite(Date.parse(report.stats.startTime)) ? new Date(report.stats.startTime).toISOString() : fallbackTime;
  const out: Passed = {};
  for (const f of passedSpecs(report, root)) {
    if (current.blobs[f] && current.quarantine[f]) out[f] = { blob: current.blobs[f], quarantine: current.quarantine[f], run, ranAt };
  }
  return out;
}

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

export function findEarlier(key: string, scratch: string, ctx: { repo: string; headRef: string; runId: string }, github: GitHub): { run: string; passed: Passed } | null {
  const { repo, headRef, runId } = ctx;
  const runs = github.api(`repos/${repo}/actions/workflows/inbox-e2e.yml/runs?event=pull_request&branch=${encodeURIComponent(headRef)}&per_page=30`) as { workflow_runs: Run[] };
  const earlier = runs.workflow_runs
    .filter((r) => String(r.id) !== runId && r.event === 'pull_request' && r.head_branch === headRef && r.head_repository?.full_name === repo && r.conclusion !== 'skipped')
    .slice(0, LOOKBACK_RUNS);
  for (const run of earlier) {
    const id = String(run.id);
    const artifacts = github.api(`repos/${repo}/actions/runs/${id}/artifacts?per_page=100`) as { artifacts: { name: string; expired: boolean }[] };
    const names = artifacts.artifacts.filter((a) => !a.expired).map((a) => a.name);
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

export function fullRunReason(env: Record<string, string | undefined>): string {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') return `a ${env.GITHUB_EVENT_NAME ?? 'unknown'} run is always full`;
  if (!env.HEAD_REPO || env.HEAD_REPO !== env.GITHUB_REPOSITORY) return 'a PR from a fork is always full';
  const labels = (JSON.parse(env.PR_LABELS || '[]') as string[] | null) ?? [];
  if (labels.includes(FULL_LABEL)) return `the PR has the ${FULL_LABEL} label`;
  return '';
}

export interface PlanDeps {
  files: string[];
  times: Record<string, number>;
  current: Current;
  key: () => string;
  github: (repo: string) => GitHub;
  scratch: string;
}

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
  const passed: Passed = {};
  if (key && earlier) for (const f of plan.reused) passed[f] = earlier.passed[f]!;
  return { plan, reuse: { key, passed } };
}

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
