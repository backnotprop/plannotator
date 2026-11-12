import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { E2E_CONFIG, fileFilter, repoRoot, shardOf } from './ci-e2e-shard';
import type { Report } from './ci-e2e-reuse';

export const BUILD_JOB = 'Inbox window (build the apps)';
export const LOOKBACK_RUNS = 100;
export const MAIN_EVENTS = ['schedule', 'workflow_dispatch'];

export type Run = { id: number; event: string; head_branch: string; head_sha: string; status: string; conclusion: string | null };
export type Job = { name: string; status: string; conclusion: string | null };

export interface GitHub {
  api(path: string): unknown;
}

function ranSpecs(run: Run, jobsOf: (id: number) => Job[]): boolean {
  if (run.status !== 'completed') return true;
  if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') return false;
  return jobsOf(run.id).some((job) => job.name === BUILD_JOB && job.conclusion === 'success');
}

export function headCovered(runs: Run[], sha: string, selfId: number, jobsOf: (id: number) => Job[]): Run | null {
  for (const run of runs) {
    if (run.id === selfId || run.head_sha !== sha || run.head_branch !== 'main' || !MAIN_EVENTS.includes(run.event)) continue;
    if (ranSpecs(run, jobsOf)) return run;
  }
  return null;
}

export function lastGreen(runs: Run[], selfId: number, jobsOf: (id: number) => Job[], isAncestor: (sha: string) => boolean): Run | null {
  for (const run of runs) {
    if (run.id >= selfId || run.head_branch !== 'main' || !MAIN_EVENTS.includes(run.event)) continue;
    if (run.status !== 'completed' || run.conclusion !== 'success') continue;
    if (!ranSpecs(run, jobsOf) || !isAncestor(run.head_sha)) continue;
    return run;
  }
  return null;
}

type ReportTest = { status?: string };
type ReportSpec = { file?: string; tests?: ReportTest[] };
type ReportSuite = { file?: string; specs?: ReportSpec[]; suites?: ReportSuite[] };

export function failedSpecs(report: Report, root = repoRoot): string[] {
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
  root = real(root);
  const rootDir = real(report.config?.rootDir ?? join(root, 'tests/e2e'));
  const failed = new Set<string>();
  const walk = (suite: ReportSuite, file: string | undefined) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const f = spec.file ?? here;
      if (!f) continue;
      if ((spec.tests ?? []).some((t) => t.status === 'unexpected' || t.status === 'flaky')) failed.add(relative(root, resolve(rootDir, f)).replaceAll('\\', '/'));
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of (report.suites ?? []) as ReportSuite[]) walk(suite, undefined);
  return [...failed].sort();
}

export function prOfSubject(subject: string): number | null {
  const m = /^Merge pull request #(\d+)\b/.exec(subject) ?? /^Merge #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
}

export type ProbeResult = { failing: string[] } | { error: string };
export interface Culprit {
  sha: string;
  specs: string[];
}
export interface Search {
  confirmed: string[];
  flaky: string[];
  culprits: Culprit[];
  unpinned: { shas: string[]; specs: string[]; why: string } | null;
}

const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
const both = (a: string[], b: string[]) => a.filter((x) => b.includes(x));

export function findCulprits(commits: string[], specs: string[], probe: (sha: string, specs: string[]) => ProbeResult): Search {
  const out: Search = { confirmed: [], flaky: [], culprits: [], unpinned: null };
  const n = commits.length;
  if (n === 0 || specs.length === 0) return out;
  const atRed = probe(commits[n - 1]!, specs);
  if ('error' in atRed) {
    out.unpinned = { shas: commits, specs, why: `the red commit could not be rebuilt: ${atRed.error}` };
    return out;
  }
  out.confirmed = both(specs, atRed.failing);
  out.flaky = minus(specs, out.confirmed);
  let remaining = out.confirmed;
  let lo = -1;
  while (remaining.length > 0) {
    let good = lo;
    let bad = n - 1;
    let badFailing = remaining;
    const untestable = new Set<number>();
    for (;;) {
      const open: number[] = [];
      for (let i = good + 1; i < bad; i++) if (!untestable.has(i)) open.push(i);
      if (open.length === 0) break;
      const mid = open[Math.floor((open.length - 1) / 2)]!;
      const result = probe(commits[mid]!, remaining);
      if ('error' in result) {
        untestable.add(mid);
        continue;
      }
      const failing = both(remaining, result.failing);
      if (failing.length > 0) {
        bad = mid;
        badFailing = failing;
      } else good = mid;
    }
    if (bad - good > 1) {
      out.unpinned = { shas: commits.slice(good + 1, bad + 1), specs: remaining, why: 'commits between them could not be built or run' };
      break;
    }
    out.culprits.push({ sha: commits[bad]!, specs: badFailing });
    remaining = minus(remaining, badFailing);
    lo = bad;
  }
  return out;
}

export interface Blame {
  verdict: 'pinned' | 'several' | 'flaky' | 'unpinned';
  pr: number | null;
  sha: string | null;
  specs: string[];
  culprits: { pr: number | null; sha: string; subject: string; specs: string[] }[];
  flaky: string[];
  green: { run: number; sha: string } | null;
  red: { run: number; sha: string };
  note: string;
}

export function blameOf(search: Search, failed: string[], describe: (sha: string) => { pr: number | null; subject: string }, green: Blame['green'], red: Blame['red']): Blame {
  const culprits = search.culprits.map((c) => ({ ...describe(c.sha), sha: c.sha, specs: c.specs }));
  const base = { culprits, flaky: search.flaky, green, red };
  if (search.unpinned) {
    const shas = search.unpinned.shas.map((s) => s.slice(0, 9)).join(', ');
    return { ...base, verdict: 'unpinned', pr: null, sha: null, specs: failed, note: `${search.unpinned.why}; the break is in one of ${shas}` };
  }
  if (search.confirmed.length === 0) {
    return { ...base, verdict: 'flaky', pr: null, sha: null, specs: failed, note: 'every failed spec passed when rerun on the red commit: flaky, no merge to blame' };
  }
  if (culprits.length === 1) {
    const [c] = culprits;
    const flaky = search.flaky.length ? ` (flaky, passed on a rerun: ${search.flaky.join(', ')})` : '';
    return { ...base, verdict: 'pinned', pr: c!.pr, sha: c!.sha, specs: c!.specs, note: `${c!.pr ? `#${c!.pr}` : c!.sha.slice(0, 9)} turned them red${flaky}` };
  }
  return { ...base, verdict: 'several', pr: null, sha: null, specs: failed, note: `${culprits.length} merges each turned some of the specs red: no single PR to blame` };
}

export function unpinned(note: string, failed: string[], green: Blame['green'], red: Blame['red']): Blame {
  return { verdict: 'unpinned', pr: null, sha: null, specs: failed, culprits: [], flaky: [], green, red, note };
}

export function summaryOf(blame: Blame, repo: string): string {
  const link = (sha: string) => `[${sha.slice(0, 9)}](https://github.com/${repo}/commit/${sha})`;
  const prLink = (pr: number | null) => (pr ? `#${pr}` : 'no PR found');
  const lines = [`## Which merge turned the browser suite red`, '', `**${blame.verdict}**: ${blame.note}`, ''];
  if (blame.green) lines.push(`Green: run ${blame.green.run} on ${link(blame.green.sha)}. Red: run ${blame.red.run} on ${link(blame.red.sha)}.`, '');
  for (const c of blame.culprits) lines.push(`- ${prLink(c.pr)} (${link(c.sha)}, ${c.subject}): ${c.specs.join(', ')}`);
  if (blame.flaky.length) lines.push(`- flaky, passed on a rerun on the red commit: ${blame.flaky.join(', ')}`);
  if (!blame.culprits.length && blame.specs.length) lines.push(`- failed specs: ${blame.specs.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

function ghCli(): GitHub {
  return {
    api: (path) => {
      const r = Bun.spawnSync(['gh', 'api', path], { cwd: repoRoot, stdin: 'ignore' });
      if (r.exitCode !== 0) throw new Error(`gh api ${path}: ${r.stderr.toString().trim()}`);
      return JSON.parse(r.stdout.toString());
    },
  };
}

function git(args: string[], cwd = repoRoot): { ok: boolean; out: string } {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdin: 'ignore' });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
}

function jobsFetcher(github: GitHub, repo: string): (id: number) => Job[] {
  const cache = new Map<number, Job[]>();
  return (id) => {
    if (!cache.has(id)) cache.set(id, (github.api(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`) as { jobs: Job[] }).jobs);
    return cache.get(id)!;
  };
}

function report(lines: string): void {
  console.log(lines);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines}\n`);
}

function head(): void {
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const sha = process.env.GITHUB_SHA ?? '';
  let run = true;
  try {
    const github = ghCli();
    const runs = (github.api(`repos/${repo}/actions/workflows/inbox-e2e.yml/runs?branch=main&head_sha=${sha}&per_page=50`) as { workflow_runs: Run[] }).workflow_runs;
    const covered = headCovered(runs, sha, Number(process.env.GITHUB_RUN_ID), jobsFetcher(github, repo));
    if (covered) {
      run = false;
      report(`e2e: main's head ${sha.slice(0, 9)} already had a full run (run ${covered.id}, ${covered.event}); this run skips.`);
    } else report(`e2e: main's head ${sha.slice(0, 9)} has had no full run yet; this run runs every spec.`);
  } catch (err) {
    report(`e2e: the lookup failed (${String(err).split('\n')[0]}); this run runs every spec.`);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}

function failed(shard: string, reportPath: string, outPath: string): void {
  let out: { shard: number; specs: string[]; note: string } = { shard: Number(shard), specs: [], note: '' };
  try {
    const rep = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as Report) : null;
    if (!rep || (rep.errors ?? []).length > 0) {
      const planFile = process.env.E2E_PLAN;
      const plan = planFile && existsSync(planFile) ? (JSON.parse(readFileSync(planFile, 'utf8')) as { count: number; specs: string[] | null }) : null;
      out = { ...out, specs: shardOf(Number(shard), plan).files, note: rep ? 'the report has a top-level error: every spec of the shard' : 'no report: every spec of the shard' };
    } else {
      out.specs = failedSpecs(rep);
      if (!out.specs.length) out.note = 'no failed spec in the report: the shard failed outside its spec run';
    }
  } catch (err) {
    out.note = `could not read the report: ${String(err).split('\n')[0]}`;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`e2e: shard ${shard} failed ${out.specs.length} spec files${out.note ? ` (${out.note})` : ''}.`);
}

function realProbe(dir: string): (sha: string, specs: string[]) => ProbeResult {
  const helper = join(repoRoot, 'scripts/ci-e2e-in-image.sh');
  let count = 0;
  return (sha, specs) => {
    count++;
    console.log(`::group::rerun ${specs.length} specs on ${sha.slice(0, 9)}`);
    try {
      const step = (cmd: string[], env?: Record<string, string>) => Bun.spawnSync(cmd, { cwd: dir, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', env: { ...process.env, ...env } }).exitCode === 0;
      if (!step(['git', 'checkout', '--detach', '--force', sha])) return { error: `git checkout ${sha} failed` };
      const present = specs.filter((f) => existsSync(join(dir, f)));
      if (present.length === 0) return { failing: [] };
      const build: string[][] = [
        ['bun', 'install', '--frozen-lockfile'],
        ['bun', 'run', 'build:review'],
        ['bun', 'run', 'build:hook'],
        ['bun', 'build', 'apps/hook/server/index.ts', '--compile', '--no-compile-autoload-bunfig', '--define', '__CLI_VERSION__="0.0.0-dev"', '--outfile', '.local/plannotator'],
      ];
      for (const cmd of build) if (!step(cmd)) return { error: `${cmd.slice(0, 3).join(' ')} failed` };
      const out = join(dir, '.local/e2e-blame', `report-${count}-${sha.slice(0, 9)}.json`);
      step(['bash', helper, dir, 'bunx', 'playwright', 'test', '-c', E2E_CONFIG, '--reporter=list,json', ...present.map(fileFilter)], { PLAYWRIGHT_JSON_OUTPUT_NAME: out });
      if (!existsSync(out)) return { error: 'Playwright wrote no report' };
      const rep = JSON.parse(readFileSync(out, 'utf8')) as Report;
      if ((rep.errors ?? []).length > 0) return { failing: present };
      return { failing: both(present, failedSpecs(rep, dir)) };
    } finally {
      console.log('::endgroup::');
    }
  };
}

function blame(): void {
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const red = { run: Number(process.env.GITHUB_RUN_ID), sha: process.env.GITHUB_SHA ?? '' };
  const outDir = resolve(process.env.BLAME_OUT ?? join(repoRoot, '.local/e2e-blame'));
  const failedDir = resolve(process.env.E2E_FAILED_DIR ?? join(repoRoot, '.local/e2e-failed'));
  mkdirSync(outDir, { recursive: true });
  let failedFiles: string[] = [];
  let result: Blame;
  try {
    const records = existsSync(failedDir) ? readdirSync(failedDir).filter((f) => f.endsWith('.json')) : [];
    const notes: string[] = [];
    for (const f of records) {
      const rec = JSON.parse(readFileSync(join(failedDir, f), 'utf8')) as { shard: number; specs: string[]; note: string };
      failedFiles.push(...rec.specs);
      if (rec.note) notes.push(`shard ${rec.shard}: ${rec.note}`);
    }
    failedFiles = [...new Set(failedFiles)].sort();
    const github = ghCli();
    const jobsOf = jobsFetcher(github, repo);
    const runs = (github.api(`repos/${repo}/actions/workflows/inbox-e2e.yml/runs?branch=main&per_page=${LOOKBACK_RUNS}`) as { workflow_runs: Run[] }).workflow_runs;
    const isAncestor = (sha: string) => git(['merge-base', '--is-ancestor', sha, red.sha]).ok;
    const greenRun = lastGreen(runs, red.run, jobsOf, isAncestor);
    const green = greenRun ? { run: greenRun.id, sha: greenRun.head_sha } : null;
    if (failedFiles.length === 0) {
      result = unpinned(`no failed spec file to rerun${notes.length ? ` (${notes.join('; ')})` : ''}`, failedFiles, green, red);
    } else if (!green) {
      result = unpinned(`no green full run on main in the last ${LOOKBACK_RUNS} runs to start from`, failedFiles, green, red);
    } else if (green.sha === red.sha) {
      result = { ...unpinned('', failedFiles, green, red), verdict: 'flaky', note: `the same commit passed in run ${green.run}: flaky, no merge to blame` };
    } else {
      const commits = git(['rev-list', '--first-parent', '--reverse', `${green.sha}..${red.sha}`]).out.split('\n').filter(Boolean);
      const probeDir = join(process.env.RUNNER_TEMP ?? join(repoRoot, '.local'), 'e2e-probe');
      if (!existsSync(probeDir) && !git(['worktree', 'add', '--detach', probeDir, red.sha]).ok) throw new Error('git worktree add failed');
      const search = findCulprits(commits, failedFiles, realProbe(probeDir));
      const describe = (sha: string) => {
        const subject = git(['log', '-1', '--format=%s', sha]).out;
        let pr = prOfSubject(subject);
        if (pr === null) {
          try {
            const pulls = github.api(`repos/${repo}/commits/${sha}/pulls`) as { number: number }[];
            pr = pulls[0]?.number ?? null;
          } catch {
            pr = null;
          }
        }
        return { pr, subject };
      };
      result = blameOf(search, failedFiles, describe, green, red);
    }
  } catch (err) {
    result = unpinned(`the blame failed: ${String(err).split('\n')[0]}`, failedFiles, null, red);
  }
  writeFileSync(join(outDir, 'blame.json'), `${JSON.stringify(result, null, 1)}\n`);
  report(summaryOf(result, repo));
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'head') head();
  else if (cmd === 'failed' && rest.length === 3) failed(rest[0]!, rest[1]!, rest[2]!);
  else if (cmd === 'blame') blame();
  else {
    console.error('usage: bun run scripts/ci-e2e-main.ts head | failed <shard> <report.json> <out.json> | blame');
    process.exit(2);
  }
}
