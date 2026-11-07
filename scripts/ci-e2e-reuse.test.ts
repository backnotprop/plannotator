/**
 * Guard for the reuse of passed e2e specs (scripts/ci-e2e-reuse.ts).
 *
 * Each failure this catches would let a PR's e2e skip a spec it should run:
 * a key that stays the same when the PR's source or the harness changed, a
 * spec counted as passed when a test failed in one browser or never ran, a
 * changed spec left out, or a plan that drops a spec from every shard. The
 * others would make reuse never happen (a merge of main changing the key).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { E2E_SHARDS, SHARD_1_EXTRA_S, shardOf, shards, specFiles, specTimes } from './ci-e2e-shard';
import { FULL_LABEL, LOOKBACK_RUNS, findEarlier, fullRunReason, passedSpecs, planRun, reuseKey, type GitHub, type Report } from './ci-e2e-reuse';

describe('the reuse key', () => {
  let repo = '';
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_NOSYSTEM;

  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'init.defaultBranch=main', ...args], { cwd: repo });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  };
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, text] of Object.entries(files)) write(file, text);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  /** GitHub's merge commit of the PR into main: parents main, then the PR's head. Returns the key of a run on it. */
  const runKey = (main: string, head: string) => {
    git('checkout', '-q', '--detach', main);
    git('merge', '-q', '--no-ff', '--no-edit', head);
    return reuseKey('HEAD^1', 'HEAD^2', 'HEAD', repo);
  };

  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    repo = mkdtempSync(join(tmpdir(), 'e2e-reuse-key-'));
    git('init', '-q');
  });
  afterAll(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = savedSystem;
  });

  test('stays the same for a merge of main and for spec or unit test edits; changes with source or harness', () => {
    const base = commit(
      {
        'packages/inbox/a.ts': 'export const a = 1;\n',
        'packages/inbox/b.ts': 'export const b = 1;\n',
        'tests/e2e/x.spec.ts': "test('x', () => {});\n",
        'tests/e2e/world.ts': 'export const world = 1;\n',
        'tests/e2e/playwright.config.ts': 'export default {};\n',
        'package.json': '{"name":"p"}\n',
      },
      'base',
    );
    git('checkout', '-q', '-b', 'pr');
    const pr1 = commit({ 'packages/inbox/a.ts': 'export const a = 2;\n' }, 'pr: change a');
    const key = runKey(base, pr1);

    // main moves on elsewhere and the PR merges it: the PR's own change is the same.
    git('checkout', '-q', 'main');
    const main2 = commit({ 'packages/inbox/b.ts': 'export const b = 2;\n' }, 'main: change b');
    git('checkout', '-q', 'pr');
    git('merge', '-q', '--no-edit', main2);
    const pr2 = git('rev-parse', 'HEAD');
    expect(runKey(main2, pr2)).toBe(key);

    // Edits to a spec file or a unit test file leave the key alone (the plan checks each spec's blob).
    git('checkout', '-q', 'pr');
    const pr3 = commit({ 'tests/e2e/x.spec.ts': "test('x2', () => {});\n", 'packages/inbox/a.test.ts': 'test;\n' }, 'pr: spec and unit test');
    expect(runKey(main2, pr3)).toBe(key);

    // A change to source or to a test helper is a new key.
    git('checkout', '-q', 'pr');
    const pr4 = commit({ 'packages/inbox/a.ts': 'export const a = 3;\n' }, 'pr: change a again');
    expect(runKey(main2, pr4)).not.toBe(key);
    git('checkout', '-q', 'pr');
    const pr5 = commit({ 'packages/inbox/a.ts': 'export const a = 2;\n', 'tests/e2e/world.ts': 'export const world = 2;\n' }, 'pr: helper');
    expect(runKey(main2, pr5)).not.toBe(key);

    // main changing the harness (the Playwright config, the lockfile) is a new key for an unchanged PR.
    git('checkout', '-q', 'main');
    const main3 = commit({ 'tests/e2e/playwright.config.ts': 'export default { retries: 1 };\n' }, 'main: harness');
    expect(runKey(main3, pr3)).not.toBe(key);
  });
});

describe('the specs a shard passed', () => {
  const root = '/repo';
  const rootDir = '/repo/tests/e2e';
  const ok = { status: 'expected', results: [{ status: 'passed' }] };
  const failed = { status: 'unexpected', results: [{ status: 'failed' }] };
  const skippedAtRuntime = { status: 'skipped', results: [{ status: 'skipped' }] };
  const neverRan = { status: 'skipped', results: [] };
  // What Playwright 1.64 writes for the test running when the shard is stopped.
  const interrupted = { status: 'skipped', results: [{ status: 'interrupted' }] };

  test('a file passes only when every test of it passed in every browser, nested describes included', () => {
    const report: Report = {
      config: { rootDir },
      suites: [
        { file: 'a.spec.ts', specs: [{ tests: [ok, skippedAtRuntime] }], suites: [{ specs: [{ tests: [ok] }] }] },
        // Chromium passed, WebKit failed.
        { file: 'b.spec.ts', specs: [{ tests: [ok, failed] }] },
        // A failure inside a describe.
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
});

describe('the plan', () => {
  const files = specFiles();
  const times = specTimes();
  const blobs = Object.fromEntries(files.map((f, i) => [f, `blob${i}`]));

  test('with nothing passed earlier, a full run: every spec on every shard', () => {
    const plan = planRun(files, times, {}, blobs, 'no earlier run');
    expect(plan).toMatchObject({ count: E2E_SHARDS, specs: null, reused: [] });
    expect(shardOf(1, plan).files).toEqual(shards()[0]!);
  });

  test('a spec is left out only when it passed at the blob it has now', () => {
    const [same, changed, failed] = files;
    const passed = { [same!]: blobs[same!]!, [changed!]: 'an older blob' };
    const plan = planRun(files, times, passed, blobs, 'reuses run 1');
    expect(plan.reused).toEqual([same!]);
    expect(plan.specs).toContain(changed!);
    expect(plan.specs).toContain(failed!);
    expect(plan.specs).not.toContain(same!);
  });

  test('the planned shards together run every spec not left out, each once, none longer than a full run needs', () => {
    const passed = Object.fromEntries(files.slice(0, Math.floor(files.length * 0.8)).map((f) => [f, blobs[f]!]));
    const plan = planRun(files, times, passed, blobs, 'reuses run 1');
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
    const passed = Object.fromEntries(files.map((f) => [f, blobs[f]!]));
    const plan = planRun(files, times, passed, blobs, 'reuses run 1');
    expect(plan).toMatchObject({ count: 1, specs: [] });
    expect(shardOf(1, plan).files).toEqual([]);
  });
});

describe('the earlier run it reuses', () => {
  const repo = 'o/r';
  const ctx = { repo, headRef: 'feat/x', runId: '100' };
  type FakeRun = { id: number; event?: string; branch?: string; fromRepo?: string; conclusion?: string; artifacts: Record<string, object> };
  /** A GitHub with these runs (newest first); each artifact is one JSON file, as the workflow uploads it. */
  const fake = (runs: FakeRun[]): GitHub => ({
    api: (path) => {
      if (path.includes('/workflows/')) {
        return { workflow_runs: runs.map((r) => ({ id: r.id, event: r.event ?? 'pull_request', head_branch: r.branch ?? 'feat/x', conclusion: r.conclusion ?? 'success', head_repository: { full_name: r.fromRepo ?? repo } })) };
      }
      const id = Number(path.match(/runs\/(\d+)\/artifacts/)![1]);
      return { artifacts: Object.keys(runs.find((r) => r.id === id)!.artifacts).map((name) => ({ name, expired: false })) };
    },
    download: (runId, artifact, dir) => {
      mkdirSync(dir, { recursive: true });
      const body = runs.find((r) => String(r.id) === runId)!.artifacts[artifact]!;
      writeFileSync(join(dir, artifact === 'e2e-reuse' ? 'reuse.json' : 'passed.json'), JSON.stringify(body));
    },
  });
  const scratch = () => mkdtempSync(join(tmpdir(), 'e2e-reuse-find-'));

  test('takes the newest run with the same key: what it left out and what each shard and attempt passed', () => {
    const runs: FakeRun[] = [
      { id: 100, artifacts: { 'e2e-reuse': { key: 'K', passed: { 'tests/e2e/self.spec.ts': 'b0' } } } },
      { id: 99, artifacts: { 'e2e-reuse': { key: 'OTHER', passed: {} }, 'e2e-passed-1-1': { passed: { 'tests/e2e/other.spec.ts': 'b9' } } } },
      {
        id: 98,
        artifacts: {
          'e2e-reuse': { key: 'K', passed: { 'tests/e2e/a.spec.ts': 'b1' } },
          'e2e-passed-1-1': { passed: { 'tests/e2e/b.spec.ts': 'b2' } },
          'e2e-passed-2-2': { passed: { 'tests/e2e/c.spec.ts': 'b3' } },
          'inbox-window-proof-1': {},
        },
      },
      { id: 97, artifacts: { 'e2e-reuse': { key: 'K', passed: { 'tests/e2e/old.spec.ts': 'b4' } } } },
    ];
    expect(findEarlier('K', scratch(), ctx, fake(runs))).toEqual({
      run: '98',
      passed: { 'tests/e2e/a.spec.ts': 'b1', 'tests/e2e/b.spec.ts': 'b2', 'tests/e2e/c.spec.ts': 'b3' },
    });
  });

  test("never another branch's, a fork's or a non-PR run, nor one past the lookback", () => {
    const same = { 'e2e-reuse': { key: 'K', passed: {} }, 'e2e-passed-1-1': { passed: { 'tests/e2e/a.spec.ts': 'b1' } } };
    const others: FakeRun[] = [
      { id: 90, branch: 'feat/other', artifacts: same },
      { id: 89, fromRepo: 'someone/r', artifacts: same },
      { id: 88, event: 'workflow_dispatch', artifacts: same },
    ];
    expect(findEarlier('K', scratch(), ctx, fake(others))).toBeNull();
    const noKey = Array.from({ length: LOOKBACK_RUNS }, (_, i): FakeRun => ({ id: 80 - i, artifacts: {} }));
    expect(findEarlier('K', scratch(), ctx, fake([...noKey, { id: 1, artifacts: same }]))).toBeNull();
    // Runs that skipped every job do not use up the lookback.
    const skipped = Array.from({ length: LOOKBACK_RUNS }, (_, i): FakeRun => ({ id: 60 - i, conclusion: 'skipped', artifacts: {} }));
    expect(findEarlier('K', scratch(), ctx, fake([...skipped, { id: 3, artifacts: same }]))?.run).toBe('3');
    // A run whose plan found no key (it could not compute one) is never a match.
    expect(findEarlier('', scratch(), ctx, fake([{ id: 2, artifacts: { 'e2e-reuse': { key: '', passed: {} } } }]))).toBeNull();
  });
});

describe('a full run, always', () => {
  const pr = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'o/r', HEAD_REPO: 'o/r', PR_LABELS: '["ci:full"]' };
  test('for the nightly and manual runs, a fork and the label; not for an ordinary PR', () => {
    expect(fullRunReason(pr)).toBe('');
    expect(fullRunReason({ ...pr, GITHUB_EVENT_NAME: 'schedule', PR_LABELS: 'null' })).not.toBe('');
    expect(fullRunReason({ ...pr, GITHUB_EVENT_NAME: 'workflow_dispatch', PR_LABELS: 'null' })).not.toBe('');
    expect(fullRunReason({ ...pr, HEAD_REPO: 'someone/fork' })).not.toBe('');
    expect(fullRunReason({ ...pr, PR_LABELS: JSON.stringify(['ci:full', FULL_LABEL]) })).not.toBe('');
  });
});
