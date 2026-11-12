import { appendFileSync } from 'node:fs';

export const JSON_VERSION_FILES = [
  'package.json',
  'apps/opencode-plugin/package.json',
  'apps/dsh-plugin/package.json',
  'apps/cline-plugin/package.json',
  'apps/pi-extension/package.json',
  'apps/hook/.claude-plugin/plugin.json',
  'apps/copilot/plugin.json',
  'packages/server/package.json',
];
export const MARKETPLACE_FILE = '.github/plugin/marketplace.json';
export const MARKETPLACE_PLUGIN = 'plannotator-copilot';
export const OPENPACKAGE_FILE = 'openpackage.yml';
export const FEEDBACK_INDEX_FILE = 'packages/inbox/feedbackSearch.data.json';
export const FEEDBACK_INDEX_TEST = 'packages/inbox/feedbackSearch.test.ts';
export const BUMP_FILES = [...JSON_VERSION_FILES, MARKETPLACE_FILE, OPENPACKAGE_FILE, FEEDBACK_INDEX_FILE];
const RELEASE_NOTES = /^RELEASE_NOTES[^/]*\.md$/;
export const LOOKBACK_RUNS = 100;

export interface Decision {
  reuse: boolean;
  why: string;
  run?: { id: number; url: string; sha: string };
  indexChanged: boolean;
}

export interface Deps {
  git(args: string[]): string;
  gitCode(args: string[]): number;
  api(path: string): unknown;
}

type Run = {
  id: number;
  html_url?: string;
  head_sha?: string;
  head_branch?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  path?: string;
  head_repository?: { full_name?: string } | null;
};

const full = (why: string): Decision => ({ reuse: false, why, indexChanged: false });

export function passedMainRuns(api: Deps['api'], repo: string): Run[] {
  const body = api(`repos/${repo}/actions/workflows/test.yml/runs?branch=main&event=push&status=success&per_page=${LOOKBACK_RUNS}`) as { workflow_runs?: Run[] };
  if (!body || !Array.isArray(body.workflow_runs)) throw new Error('the runs list has no workflow_runs');
  return body.workflow_runs.filter(
    (r) =>
      typeof r.id === 'number' &&
      typeof r.head_sha === 'string' &&
      /^[0-9a-f]{40}$/.test(r.head_sha) &&
      r.event === 'push' &&
      r.head_branch === 'main' &&
      r.status === 'completed' &&
      r.conclusion === 'success' &&
      (r.path ?? '').split('@')[0] === '.github/workflows/test.yml' &&
      r.head_repository?.full_name === repo,
  );
}

export function nearestAncestorRun(runs: Run[], head: string, deps: Pick<Deps, 'git' | 'gitCode'>): Run | null {
  let best: { run: Run; distance: number } | null = null;
  const seen = new Set<string>();
  for (const run of runs) {
    const sha = run.head_sha!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (deps.gitCode(['merge-base', '--is-ancestor', sha, head]) !== 0) continue;
    const distance = Number(deps.git(['rev-list', '--count', `${sha}..${head}`]).trim());
    if (!Number.isInteger(distance)) throw new Error(`rev-list --count ${sha}..${head} gave no number`);
    if (!best || distance < best.distance) best = { run, distance };
  }
  return best?.run ?? null;
}

function parseObject(text: string, file: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

function withoutVersion(file: string, text: string): string {
  if (file === OPENPACKAGE_FILE) {
    const lines = text.split('\n');
    const at = lines.flatMap((line, i) => (/^version:\s*[^\s#]+\s*(?:#.*)?$/.test(line) ? [i] : []));
    if (at.length !== 1) throw new Error(`${file} has ${at.length} top-level version lines`);
    lines[at[0]!] = 'version: <release>';
    return lines.join('\n');
  }
  const json = parseObject(text, file);
  if (file === MARKETPLACE_FILE) {
    const plugins = Array.isArray(json.plugins) ? (json.plugins as Record<string, unknown>[]) : [];
    const entries = plugins.filter((p) => p && typeof p === 'object' && p.name === MARKETPLACE_PLUGIN);
    if (entries.length !== 1 || typeof entries[0]!.version !== 'string') throw new Error(`${file} has no single ${MARKETPLACE_PLUGIN} version`);
    entries[0]!.version = '<release>';
    return JSON.stringify(json);
  }
  if (typeof json.version !== 'string') throw new Error(`${file} has no string version`);
  json.version = '<release>';
  return JSON.stringify(json);
}

export function bumpOnly(base: string, head: string, git: Deps['git']): { problem: string; indexChanged: boolean } {
  const changed = git(['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean);
  let indexChanged = false;
  for (const file of changed) {
    if (RELEASE_NOTES.test(file)) continue;
    if (!BUMP_FILES.includes(file)) return { problem: `${file} changed, and it is not a release bump file`, indexChanged };
    const after = git(['show', `${head}:${file}`]);
    if (file === FEEDBACK_INDEX_FILE) {
      const index = parseObject(after, file);
      if (!Array.isArray(index.features) || !Array.isArray(index.links)) return { problem: `${file} has no features and links lists`, indexChanged };
      git(['show', `${base}:${file}`]);
      indexChanged = true;
      continue;
    }
    const before = git(['show', `${base}:${file}`]);
    if (withoutVersion(file, before) !== withoutVersion(file, after)) return { problem: `${file} changed more than its version`, indexChanged };
  }
  return { problem: '', indexChanged };
}

export function decide(env: Record<string, string | undefined>, deps: Deps): Decision {
  try {
    const event = env.GITHUB_EVENT_NAME;
    if (event !== 'push' && event !== 'workflow_dispatch') return full(`a ${event ?? 'unknown'} run does not reuse`);
    const repo = env.GITHUB_REPOSITORY;
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return full('no GITHUB_REPOSITORY');
    const head = deps.git(['rev-parse', 'HEAD^{commit}']).trim();
    const run = nearestAncestorRun(passedMainRuns(deps.api, repo), head, deps);
    if (!run) return full(`no passed Test run on main among the last ${LOOKBACK_RUNS} is in this commit's history`);
    const sha = run.head_sha!;
    const { problem, indexChanged } = bumpOnly(sha, head, deps.git);
    const url = run.html_url ?? `https://github.com/${repo}/actions/runs/${run.id}`;
    if (problem) return full(`${problem} since ${sha.slice(0, 12)} (Test run ${url})`);
    return { reuse: true, why: `only release bump files changed since ${sha} (Test passed in run ${url})`, run: { id: run.id, url, sha }, indexChanged };
  } catch (err) {
    return full(`the lookup failed: ${String(err).split('\n')[0]}`);
  }
}

export function outputs(d: Decision): string {
  return `reuse=${d.reuse}\nindex-changed=${d.indexChanged}\n`;
}

function liveDeps(cwd: string): Deps {
  const spawn = (cmd: string[]) => Bun.spawnSync(cmd, { cwd, stdin: 'ignore' });
  return {
    git(args) {
      const r = spawn(['git', ...args]);
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
      return r.stdout.toString();
    },
    gitCode: (args) => spawn(['git', ...args]).exitCode ?? -1,
    api(path) {
      const r = spawn(['gh', 'api', path]);
      if (r.exitCode !== 0) throw new Error(`gh api ${path}: ${r.stderr.toString().trim()}`);
      return JSON.parse(r.stdout.toString());
    },
  };
}

if (import.meta.main) {
  const decision = decide(process.env, liveDeps(process.cwd()));
  const line = decision.reuse
    ? `Release tests: reusing main's Test run: ${decision.why}. Skipping the full bun test.`
    : `Release tests: running the full bun test: ${decision.why}.`;
  console.log(line);
  if (decision.reuse) console.log(`::notice title=Release tests reused::${decision.why}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs(decision));
}
