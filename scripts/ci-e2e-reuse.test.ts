import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { E2E_SHARDS, SHARD_1_EXTRA_S, repoRoot, shardOf, shards, specFiles, specTimes } from './ci-e2e-shard';
import {
  FULL_LABEL,
  LOOKBACK_RUNS,
  MAX_PASS_AGE_MS,
  decidePlan,
  findEarlier,
  fullRunReason,
  passRecords,
  passedSpecs,
  planOutputs,
  planRun,
  quarantineHashes,
  reuseKey,
  type Current,
  type GitHub,
  type PassRecord,
  type Passed,
  type PlanDeps,
  type Report,
} from './ci-e2e-reuse';

const scratchDirs: string[] = [];
const scratch = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `e2e-reuse-${name}-`));
  scratchDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe('the reuse key', () => {
  let repo = '';
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_NOSYSTEM;

  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'init.defaultBranch=main', ...args], { cwd: repo });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const runKey = (main: string, head: string) => {
    git('checkout', '-q', '--detach', main);
    git('merge', '-q', '--no-ff', '--no-edit', head);
    return reuseKey('HEAD^1', 'HEAD^2', 'HEAD', repo);
  };
  const fresh = (files: Record<string, string>) => {
    repo = scratch('key');
    git('init', '-q');
    const base = commit(files, 'base');
    git('checkout', '-q', '-b', 'pr');
    return base;
  };

  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });
  afterAll(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = savedSystem;
  });

  test('stays the same for a merge of main and for spec or unit test edits; changes with source or harness', () => {
    const base = fresh({
      'packages/inbox/a.ts': 'export const a = 1;\n',
      'packages/inbox/b.ts': 'export const b = 1;\n',
      'tests/e2e/x.spec.ts': "test('x', () => {});\n",
      'tests/e2e/world.ts': 'export const world = 1;\n',
      'tests/e2e/playwright.config.ts': 'export default {};\n',
      'package.json': '{"name":"p"}\n',
    });
    const pr1 = commit({ 'packages/inbox/a.ts': 'export const a = 2;\n' }, 'pr: change a');
    const key = runKey(base, pr1);

    git('checkout', '-q', 'main');
    const main2 = commit({ 'packages/inbox/b.ts': 'export const b = 2;\n' }, 'main: change b');
    git('checkout', '-q', 'pr');
    git('merge', '-q', '--no-edit', main2);
    const pr2 = git('rev-parse', 'HEAD');
    expect(runKey(main2, pr2)).toBe(key);

    git('checkout', '-q', 'pr');
    const pr3 = commit({ 'tests/e2e/x.spec.ts': "test('x2', () => {});\n", 'packages/inbox/a.test.ts': 'test;\n' }, 'pr: spec and unit test');
    expect(runKey(main2, pr3)).toBe(key);

    git('checkout', '-q', 'pr');
    const pr4 = commit({ 'packages/inbox/a.ts': 'export const a = 3;\n' }, 'pr: change a again');
    expect(runKey(main2, pr4)).not.toBe(key);
    git('checkout', '-q', 'pr');
    const pr5 = commit({ 'packages/inbox/a.ts': 'export const a = 2;\n', 'tests/e2e/world.ts': 'export const world = 2;\n' }, 'pr: helper');
    expect(runKey(main2, pr5)).not.toBe(key);

    git('checkout', '-q', 'main');
    const main3 = commit({ 'tests/e2e/playwright.config.ts': 'export default { retries: 1 };\n' }, 'main: harness');
    expect(runKey(main3, pr3)).not.toBe(key);
  });

  test('a moved line and a whitespace edit inside a string are new keys; main changing the same file further down is not', () => {
    const body = (lines: string[]) => `${lines.join('\n')}\n`;
    const tail = Array.from({ length: 20 }, (_, i) => `export const t${i} = ${i};`);
    const base = fresh({ 'packages/inbox/f.ts': body(['export function f() {', '  a();', '  b();', '  c();', '}', 'export const s = "x y";', ...tail]) });
    const first = commit({ 'packages/inbox/f.ts': body(['export function f() {', '  return;', '  a();', '  b();', '  c();', '}', 'export const s = "xy";', ...tail]) }, 'pr: return first');
    const key = runKey(base, first);

    git('checkout', '-q', 'main');
    const mainTail = [...tail.slice(0, 19), 'export const t19 = 190;'];
    const main2 = commit({ 'packages/inbox/f.ts': body(['export function f() {', '  a();', '  b();', '  c();', '}', 'export const s = "x y";', ...mainTail]) }, 'main: tail');
    git('checkout', '-q', 'pr');
    git('merge', '-q', '--no-edit', main2);
    const merged = git('rev-parse', 'HEAD');
    expect(runKey(main2, merged)).toBe(key);

    git('checkout', '-q', 'pr');
    const moved = commit({ 'packages/inbox/f.ts': body(['export function f() {', '  a();', '  b();', '  c();', '  return;', '}', 'export const s = "xy";', ...mainTail]) }, 'pr: return last');
    expect(runKey(main2, moved)).not.toBe(key);

    git('checkout', '-q', 'pr');
    git('reset', '-q', '--hard', merged);
    const spaced = commit({ 'packages/inbox/f.ts': body(['export function f() {', '  return;', '  a();', '  b();', '  c();', '}', 'export const s = "x  y";', ...mainTail]) }, 'pr: spaces');
    expect(runKey(main2, spaced)).not.toBe(key);
  });
});

describe('the specs a shard passed', () => {
  const root = '/repo';
  const rootDir = '/repo/tests/e2e';
  const ok = { status: 'expected', results: [{ status: 'passed' }] };
  const failed = { status: 'unexpected', results: [{ status: 'failed' }] };
  const skippedAtRuntime = { status: 'skipped', results: [{ status: 'skipped' }] };
  const neverRan = { status: 'skipped', results: [] };
  const interrupted = { status: 'skipped', results: [{ status: 'interrupted' }] };

  test('a file passes only when every test of it passed in every browser, nested describes included', () => {
    const report: Report = {
      config: { rootDir },
      suites: [
        { file: 'a.spec.ts', specs: [{ tests: [ok, skippedAtRuntime] }], suites: [{ specs: [{ tests: [ok] }] }] },
        { file: 'b.spec.ts', specs: [{ tests: [ok, failed] }] },
        { file: 'c.spec.ts', specs: [{ tests: [ok] }], suites: [{ suites: [{ specs: [{ tests: [failed] }] }] }] },
      ],
      errors: [],
    };
    expect(passedSpecs(report, root)).toEqual(['tests/e2e/a.spec.ts']);
  });

  test('tests that never ran (a cancelled or interrupted shard) do not count as passed', () => {
    const report: Report = {
      config: { rootDir },
      suites: [
        { file: 'done.spec.ts', specs: [{ tests: [ok] }, { tests: [ok] }] },
        { file: 'half.spec.ts', specs: [{ tests: [ok] }, { tests: [neverRan] }] },
        { file: 'stopped.spec.ts', specs: [{ tests: [ok] }, { tests: [interrupted] }] },
        { file: 'empty.spec.ts', specs: [] },
      ],
    };
    expect(passedSpecs(report, root)).toEqual(['tests/e2e/done.spec.ts']);
  });

  test('a report with a top-level error passes nothing', () => {
    const report: Report = { config: { rootDir }, suites: [{ file: 'a.spec.ts', specs: [{ tests: [ok] }] }], errors: [{ message: 'global setup failed' }] };
    expect(passedSpecs(report, root)).toEqual([]);
  });

  test("each pass carries this run, the time the shard's specs started, the blob and the quarantine hash", () => {
    const report: Report = { config: { rootDir }, stats: { startTime: '2026-11-07T10:00:00.000Z' }, suites: [{ file: 'a.spec.ts', specs: [{ tests: [ok] }] }] };
    const current = { blobs: { 'tests/e2e/a.spec.ts': 'B' }, quarantine: { 'tests/e2e/a.spec.ts': 'Q' } };
    expect(passRecords(report, current, '42', '2026-11-07T11:00:00.000Z', root)).toEqual({
      'tests/e2e/a.spec.ts': { blob: 'B', quarantine: 'Q', run: '42', ranAt: '2026-11-07T10:00:00.000Z' },
    });
  });
});

describe('the quarantine hash', () => {
  const files = ['tests/e2e/a.spec.ts', 'tests/e2e/b.spec.ts'];
  const entry = { spec: 'a.spec.ts', title: 'flaky one', why: 'w', evidence: [1, 2] };

  test("changes when a spec's quarantine entries change, not for another spec's or for an entry's reason", () => {
    const before = quarantineHashes(files, [entry]);
    expect(quarantineHashes(files, [])['tests/e2e/a.spec.ts']).not.toBe(before['tests/e2e/a.spec.ts']);
    expect(quarantineHashes(files, [{ ...entry, dependents: [{ title: 'next one' }] }])['tests/e2e/a.spec.ts']).not.toBe(before['tests/e2e/a.spec.ts']);
    const other = quarantineHashes(files, [entry, { spec: 'b.spec.ts', title: 't', why: 'w', evidence: [3, 4] }]);
    expect(other['tests/e2e/a.spec.ts']).toBe(before['tests/e2e/a.spec.ts']);
    expect(other['tests/e2e/b.spec.ts']).not.toBe(before['tests/e2e/b.spec.ts']);
    expect(quarantineHashes(files, [{ ...entry, why: 'better words', evidence: [1, 2, 3] }])).toEqual(before);
  });

  test('every spec in the repo gets a hash from the real quarantine file', () => {
    const all = specFiles();
    const entries = (JSON.parse(readFileSync(join(repoRoot, 'tests/e2e/quarantine.json'), 'utf8')) as { tests: { spec: string; title: string }[] }).tests;
    const hashes = quarantineHashes(all, entries);
    expect(Object.keys(hashes).sort()).toEqual([...all].sort());
  });
});

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

describe('the plan', () => {
  const files = specFiles();
  const times = specTimes();
  const current: Current = {
    blobs: Object.fromEntries(files.map((f, i) => [f, `blob${i}`])),
    quarantine: Object.fromEntries(files.map((f) => [f, 'q'])),
    now: NOW,
  };
  const pass = (f: string, over: Partial<PassRecord> = {}): PassRecord => ({ blob: current.blobs[f]!, quarantine: 'q', run: '1', ranAt: hoursAgo(2), ...over });
  const passAll = (list: string[]): Passed => Object.fromEntries(list.map((f) => [f, pass(f)]));

  test('with nothing passed earlier, a full run: every spec on every shard', () => {
    const plan = planRun(files, times, {}, current, 'no earlier run');
    expect(plan).toMatchObject({ count: E2E_SHARDS, specs: null, reused: [] });
    expect(shardOf(1, plan).files).toEqual(shards()[0]!);
    expect(planOutputs(plan)).toBe(`count=16\nmatrix=${JSON.stringify(Array.from({ length: 16 }, (_, i) => i + 1))}\n`);
  });

  test('a spec is left out only with the same blob, the same quarantine entries and a pass from the last day', () => {
    const [same, changed, failed, requarantined, stale, future] = files;
    const passed: Passed = {
      [same!]: pass(same!),
      [changed!]: pass(changed!, { blob: 'an older blob' }),
      [requarantined!]: pass(requarantined!, { quarantine: 'q-before' }),
      [stale!]: pass(stale!, { ranAt: new Date(NOW - MAX_PASS_AGE_MS - 60_000).toISOString() }),
      [future!]: pass(future!, { ranAt: hoursAgo(-2) }),
    };
    const plan = planRun(files, times, passed, current, 'reuses run 1');
    expect(plan.reused).toEqual([same!]);
    for (const f of [changed, failed, requarantined, stale, future]) expect(plan.specs).toContain(f!);
    expect(plan.specs).not.toContain(same!);
  });

  test('the planned shards together run every spec not left out, each once, none longer than a full run needs', () => {
    const plan = planRun(files, times, passAll(files.slice(0, Math.floor(files.length * 0.8))), current, 'reuses run 1');
    expect(plan.count).toBeGreaterThan(0);
    expect(plan.count).toBeLessThan(E2E_SHARDS);
    const planned = Array.from({ length: plan.count }, (_, i) => shardOf(i + 1, plan).files);
    expect(planned.flat().sort()).toEqual([...plan.specs!].sort());
    const known = Object.values(times).sort((a, b) => a - b);
    const weight = (f: string) => times[f.split('/').pop()!] ?? known[Math.floor(known.length / 2)]!;
    const fullShard = (files.reduce((s, f) => s + weight(f), 0) + SHARD_1_EXTRA_S) / E2E_SHARDS;
    const longest = Math.max(...plan.specs!.map(weight));
    const loads = planned.map((list, i) => list.reduce((s, f) => s + weight(f), i === 0 ? SHARD_1_EXTRA_S : 0));
    expect(Math.max(...loads)).toBeLessThanOrEqual(Math.max(fullShard * 1.15, longest + SHARD_1_EXTRA_S));
  });

  test('when every spec passed earlier, one shard still runs (it carries the update specs and the phone door proofs)', () => {
    const plan = planRun(files, times, passAll(files), current, 'reuses run 1');
    expect(plan).toMatchObject({ count: 1, specs: [] });
    expect(shardOf(1, plan).files).toEqual([]);
  });
});

type FakeRun = { id: number; event?: string; branch?: string; fromRepo?: string; conclusion?: string; artifacts: Record<string, object> };
function fakeGitHub(runs: FakeRun[], repo = 'o/r', calls: string[] = []): GitHub {
  return {
    api: (path) => {
      calls.push(path);
      if (path.includes('/workflows/')) {
        return {
          workflow_runs: runs.map((r) => ({ id: r.id, event: r.event ?? 'pull_request', head_branch: r.branch ?? 'feat/x', conclusion: r.conclusion ?? 'success', head_repository: { full_name: r.fromRepo ?? repo } })),
        };
      }
      const id = Number(path.match(/runs\/(\d+)\/artifacts/)![1]);
      return { artifacts: Object.keys(runs.find((r) => r.id === id)!.artifacts).map((name) => ({ name, expired: false })) };
    },
    download: (runId, artifact, dir) => {
      calls.push(`download ${runId} ${artifact}`);
      mkdirSync(dir, { recursive: true });
      const body = runs.find((r) => String(r.id) === runId)!.artifacts[artifact]!;
      writeFileSync(join(dir, artifact.startsWith('e2e-reuse-') ? 'reuse.json' : 'passed.json'), JSON.stringify(body));
    },
  };
}
const rec = (blob: string, run = '1', ranAt = hoursAgo(1)): PassRecord => ({ blob, quarantine: 'q', run, ranAt });

describe('the earlier run it reuses', () => {
  const ctx = { repo: 'o/r', headRef: 'feat/x', runId: '100' };

  test("takes the newest run with the same key and its newest attempt's plan: what it left out and what each shard and attempt passed", () => {
    const runs: FakeRun[] = [
      { id: 100, artifacts: { 'e2e-reuse-1': { key: 'K', passed: { 'tests/e2e/self.spec.ts': rec('b0') } } } },
      { id: 99, artifacts: { 'e2e-reuse-1': { key: 'OTHER', passed: {} }, 'e2e-passed-1-1': { passed: { 'tests/e2e/other.spec.ts': rec('b9') } } } },
      {
        id: 98,
        artifacts: {
          'e2e-reuse-1': { key: 'OLD ATTEMPT', passed: {} },
          'e2e-reuse-2': { key: 'K', passed: { 'tests/e2e/a.spec.ts': rec('b1', '90', hoursAgo(5)) } },
          'e2e-passed-1-1': { passed: { 'tests/e2e/b.spec.ts': rec('b2', '98') } },
          'e2e-passed-2-2': { passed: { 'tests/e2e/c.spec.ts': rec('b3', '98') } },
          'inbox-window-proof-1': {},
        },
      },
      { id: 97, artifacts: { 'e2e-reuse-1': { key: 'K', passed: { 'tests/e2e/old.spec.ts': rec('b4') } } } },
    ];
    expect(findEarlier('K', scratch('find'), ctx, fakeGitHub(runs))).toEqual({
      run: '98',
      passed: { 'tests/e2e/a.spec.ts': rec('b1', '90', hoursAgo(5)), 'tests/e2e/b.spec.ts': rec('b2', '98'), 'tests/e2e/c.spec.ts': rec('b3', '98') },
    });
  });

  test("never another branch's, a fork's or a non-PR run, nor one past the lookback", () => {
    const same = { 'e2e-reuse-1': { key: 'K', passed: {} }, 'e2e-passed-1-1': { passed: { 'tests/e2e/a.spec.ts': rec('b1') } } };
    const others: FakeRun[] = [
      { id: 90, branch: 'feat/other', artifacts: same },
      { id: 89, fromRepo: 'someone/r', artifacts: same },
      { id: 88, event: 'workflow_dispatch', artifacts: same },
    ];
    expect(findEarlier('K', scratch('find'), ctx, fakeGitHub(others))).toBeNull();
    const noKey = Array.from({ length: LOOKBACK_RUNS }, (_, i): FakeRun => ({ id: 80 - i, artifacts: {} }));
    expect(findEarlier('K', scratch('find'), ctx, fakeGitHub([...noKey, { id: 1, artifacts: same }]))).toBeNull();
    const skipped = Array.from({ length: LOOKBACK_RUNS }, (_, i): FakeRun => ({ id: 60 - i, conclusion: 'skipped', artifacts: {} }));
    expect(findEarlier('K', scratch('find'), ctx, fakeGitHub([...skipped, { id: 3, artifacts: same }]))?.run).toBe('3');
    expect(findEarlier('', scratch('find'), ctx, fakeGitHub([{ id: 2, artifacts: { 'e2e-reuse-1': { key: '', passed: {} } } }]))).toBeNull();
  });
});

describe('deciding the plan', () => {
  const files = specFiles();
  const times = specTimes();
  const current: Current = { blobs: Object.fromEntries(files.map((f) => [f, 'B'])), quarantine: Object.fromEntries(files.map((f) => [f, 'q'])), now: NOW };
  const pr = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'o/r', HEAD_REPO: 'o/r', GITHUB_HEAD_REF: 'feat/x', GITHUB_RUN_ID: '100', PR_LABELS: '["ci:e2e"]' };
  const deps = (github: GitHub, key = () => 'K'): PlanDeps => ({ files, times, current, key, github: () => github, scratch: scratch('plan') });
  const [a, b] = files;

  test('a left-out spec keeps the pass of the run that really ran it, with its age; it is never passed on as new', () => {
    const runs: FakeRun[] = [
      {
        id: 99,
        artifacts: {
          'e2e-reuse-1': { key: 'K', passed: { [a!]: { blob: 'B', quarantine: 'q', run: '90', ranAt: hoursAgo(20) } } },
          'e2e-passed-1-1': { passed: { [b!]: { blob: 'B', quarantine: 'q', run: '99', ranAt: hoursAgo(1) } } },
        },
      },
    ];
    const { plan, reuse } = decidePlan(pr, deps(fakeGitHub(runs)));
    expect(plan.reused.sort()).toEqual([a!, b!].sort());
    expect(reuse).toEqual({
      key: 'K',
      passed: { [a!]: { blob: 'B', quarantine: 'q', run: '90', ranAt: hoursAgo(20) }, [b!]: { blob: 'B', quarantine: 'q', run: '99', ranAt: hoursAgo(1) } },
    });
    const later = decidePlan(pr, { ...deps(fakeGitHub([{ id: 101, artifacts: { 'e2e-reuse-1': reuse } }])), current: { ...current, now: NOW + 5 * 3600_000 } });
    expect(later.plan.specs).toContain(a!);
    expect(later.plan.reused).toEqual([b!]);
  });

  test('a failure in the lookup gives a full run and still keeps the key', () => {
    const broken: GitHub = {
      api: () => {
        throw new Error('HTTP 502');
      },
      download: () => {},
    };
    const { plan, reuse } = decidePlan(pr, deps(broken));
    expect(plan).toMatchObject({ count: E2E_SHARDS, specs: null, why: 'the reuse lookup failed' });
    expect(reuse).toEqual({ key: 'K', passed: {} });
    const noKey = decidePlan(pr, deps(fakeGitHub([]), () => {
      throw new Error('git merge-base: no merge base');
    }));
    expect(noKey.plan).toMatchObject({ count: E2E_SHARDS, specs: null, why: 'the reuse lookup failed' });
    expect(noKey.reuse.key).toBe('');
  });

  test('a scheduled run, a fork and the label never look at earlier runs', () => {
    const reusable: FakeRun[] = [{ id: 99, artifacts: { 'e2e-reuse-1': { key: 'K', passed: Object.fromEntries(files.map((f) => [f, rec('B')])) } } }];
    for (const env of [
      { GITHUB_EVENT_NAME: 'schedule' },
      { ...pr, HEAD_REPO: 'someone/r' },
      { ...pr, PR_LABELS: JSON.stringify(['ci:e2e', FULL_LABEL]) },
    ]) {
      const calls: string[] = [];
      const { plan } = decidePlan(env, deps(fakeGitHub(reusable, 'o/r', calls)));
      expect(plan).toMatchObject({ count: E2E_SHARDS, specs: null });
      expect(calls).toEqual([]);
    }
  });
});

describe('a full run, always', () => {
  const pr = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'o/r', HEAD_REPO: 'o/r', PR_LABELS: '["ci:e2e"]' };
  test('for the scheduled and manual runs, a fork and the label; not for an ordinary PR', () => {
    expect(fullRunReason(pr)).toBe('');
    expect(fullRunReason({ ...pr, GITHUB_EVENT_NAME: 'schedule', PR_LABELS: 'null' })).not.toBe('');
    expect(fullRunReason({ ...pr, GITHUB_EVENT_NAME: 'workflow_dispatch', PR_LABELS: 'null' })).not.toBe('');
    expect(fullRunReason({ ...pr, HEAD_REPO: 'someone/fork' })).not.toBe('');
    expect(fullRunReason({ ...pr, PR_LABELS: JSON.stringify(['ci:e2e', FULL_LABEL]) })).not.toBe('');
  });

  test('the workflow starts a run when ci:e2e-all is added to a PR, in the PR group, and passes the labels to the plan', () => {
    const wf = Bun.YAML.parse(readFileSync(join(repoRoot, '.github/workflows/inbox-e2e.yml'), 'utf8')) as {
      concurrency: { group: string };
      jobs: Record<string, { if?: string; steps?: { run?: string; env?: Record<string, string> }[] }>;
    };
    const triggers = `github.event.label.name == '${FULL_LABEL}'`;
    for (const id of ['build', 'plan', 'full-ci']) {
      expect(wf.jobs[id]!.if, id).toContain(triggers);
      expect(wf.jobs[id]!.if, id).toContain(`contains(github.event.pull_request.labels.*.name, '${FULL_LABEL}')`);
    }
    expect(wf.concurrency.group).toContain(`github.event.label.name != '${FULL_LABEL}'`);
    const planStep = wf.jobs.plan!.steps!.find((s) => s.run?.trim() === 'bun run scripts/ci-e2e-reuse.ts plan')!;
    expect(planStep.env?.PR_LABELS).toBe('${{ toJSON(github.event.pull_request.labels.*.name) }}');
  });
});
