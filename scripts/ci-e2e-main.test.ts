/**
 * Guard for the full browser suite's runs on main (scripts/ci-e2e-main.ts).
 *
 * Each failure this catches would cost main its browser coverage or blame the
 * wrong PR: a scheduled run that skips although main's head never had a full
 * run (or reruns the whole suite every two hours on the same commit); a green
 * run picked from a run that skipped its specs; a failed spec read as passed;
 * a merge read as the wrong PR; a search that names one PR for two breaks,
 * blames a merge for a flaky spec, or guesses past a commit it could not build.
 */
import { describe, expect, test } from 'bun:test';
import { BUILD_JOB, blameOf, failedSpecs, findCulprits, headCovered, lastGreen, prOfSubject, type Job, type ProbeResult, type Run } from './ci-e2e-main';
import { repoRoot } from './ci-e2e-shard';

const run = (id: number, sha: string, over: Partial<Run> = {}): Run => ({ id, event: 'schedule', head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success', ...over });
const ran: Job[] = [{ name: BUILD_JOB, status: 'completed', conclusion: 'success' }];
const skipped: Job[] = [{ name: BUILD_JOB, status: 'completed', conclusion: 'skipped' }];

describe("the head check of a scheduled run", () => {
  test("goes on when main's head had no run that ran its specs, and skips when it had", () => {
    const jobs: Record<number, Job[]> = { 10: skipped, 11: ran };
    const jobsOf = (id: number) => jobs[id] ?? [];
    // A run that skipped its specs, a cancelled one and a PR run do not count.
    const runs = [run(10, 'A'), run(12, 'A', { conclusion: 'cancelled' }), run(13, 'A', { event: 'pull_request', head_branch: 'feat' })];
    expect(headCovered(runs, 'A', 99, jobsOf)).toBeNull();
    // A manual run that ran them (a release's) counts; so does one still going.
    expect(headCovered([...runs, run(11, 'A', { event: 'workflow_dispatch' })], 'A', 99, jobsOf)?.id).toBe(11);
    expect(headCovered([run(14, 'A', { status: 'in_progress', conclusion: null })], 'A', 99, jobsOf)?.id).toBe(14);
    // Not itself, and not another commit's run.
    expect(headCovered([run(99, 'A', { status: 'in_progress', conclusion: null }), run(11, 'B')], 'A', 99, jobsOf)).toBeNull();
  });
});

describe('the green run a blame starts from', () => {
  test('the newest earlier run on main that ran its specs and passed, on an ancestor of the red commit', () => {
    const jobs: Record<number, Job[]> = { 5: ran, 6: skipped, 7: ran, 8: ran };
    const jobsOf = (id: number) => jobs[id] ?? [];
    const runs = [
      run(9, 'R', { conclusion: 'failure' }), // this run
      run(8, 'X'), // not an ancestor of R
      run(7, 'D', { conclusion: 'failure' }),
      run(6, 'C'), // green, but it skipped its specs
      run(5, 'B', { event: 'workflow_dispatch' }),
    ];
    expect(lastGreen(runs, 9, jobsOf, (sha) => sha !== 'X')?.id).toBe(5);
    expect(lastGreen(runs, 5, jobsOf, () => true)).toBeNull();
  });
});

describe('failed specs from a Playwright report', () => {
  test('a spec file with a failed or timed-out test, never one that passed or skipped', () => {
    const report = {
      config: { rootDir: `${repoRoot}/tests/e2e` },
      suites: [
        { file: 'a.spec.ts', specs: [{ tests: [{ status: 'expected' }] }, { tests: [{ status: 'unexpected' }] }] },
        { file: 'b.spec.ts', specs: [{ tests: [{ status: 'expected' }, { status: 'skipped' }] }] },
        { file: 'c.spec.ts', suites: [{ specs: [{ tests: [{ status: 'unexpected' }] }] }] },
      ],
    };
    expect(failedSpecs(report)).toEqual(['tests/e2e/a.spec.ts', 'tests/e2e/c.spec.ts']);
  });
});

describe('the PR of a merge on main', () => {
  test('a merge, a train merge and a squash; none for a plain commit', () => {
    expect(prOfSubject('Merge pull request #2584 from backnotprop/feat/guide-global-comments')).toBe(2584);
    expect(prOfSubject('Merge #2920 (feat/inbox-bro-experimental) into train D')).toBe(2920);
    expect(prOfSubject('Keep a comment when adding it fails (#2611)')).toBe(2611);
    expect(prOfSubject('chore: bump version to 0.28.54')).toBeNull();
  });
});

/** A probe over commits 0..n-1: a spec fails from the commit that breaks it on, except where it is flaky or unbuildable. */
function world(breaks: Record<string, number>, opts: { unbuildable?: number[]; passAtRed?: string[] } = {}) {
  const calls: string[] = [];
  const commits = Array.from({ length: 12 }, (_, i) => `c${i}`);
  const probe = (sha: string, specs: string[]): ProbeResult => {
    calls.push(sha);
    const i = commits.indexOf(sha);
    if (opts.unbuildable?.includes(i)) return { error: 'bun run build:hook failed' };
    const failing = specs.filter((s) => breaks[s] !== undefined && i >= breaks[s]! && !(i === commits.length - 1 && opts.passAtRed?.includes(s)));
    return { failing };
  };
  return { commits, probe, calls };
}

describe('the search for the merge that turned main red', () => {
  test('one break: the first commit where the specs fail, in a few reruns', () => {
    const w = world({ 'a.spec.ts': 7, 'b.spec.ts': 7 });
    const search = findCulprits(w.commits, ['a.spec.ts', 'b.spec.ts'], w.probe);
    expect(search.culprits).toEqual([{ sha: 'c7', specs: ['a.spec.ts', 'b.spec.ts'] }]);
    expect(search.unpinned).toBeNull();
    // The rerun on the red commit, then a bisection: not one rerun per commit.
    expect(w.calls.length).toBeLessThanOrEqual(1 + Math.ceil(Math.log2(w.commits.length)) + 1);
    const blame = blameOf(search, ['a.spec.ts', 'b.spec.ts'], (sha) => ({ pr: Number(sha.slice(1)) + 100, subject: sha }), { run: 1, sha: 'g' }, { run: 2, sha: 'c11' });
    expect(blame).toMatchObject({ verdict: 'pinned', pr: 107, sha: 'c7', specs: ['a.spec.ts', 'b.spec.ts'] });
  });

  test('two breaks: two commits, and no single PR', () => {
    const w = world({ 'a.spec.ts': 3, 'b.spec.ts': 9 });
    const search = findCulprits(w.commits, ['a.spec.ts', 'b.spec.ts'], w.probe);
    expect(search.culprits).toEqual([
      { sha: 'c3', specs: ['a.spec.ts'] },
      { sha: 'c9', specs: ['b.spec.ts'] },
    ]);
    const blame = blameOf(search, ['a.spec.ts', 'b.spec.ts'], () => ({ pr: 1, subject: '' }), null, { run: 2, sha: 'c11' });
    expect(blame).toMatchObject({ verdict: 'several', pr: null, sha: null });
  });

  test('a spec that passes on a rerun of the red commit is flaky and blames no one', () => {
    const w = world({ 'a.spec.ts': 11 }, { passAtRed: ['a.spec.ts'] });
    const search = findCulprits(w.commits, ['a.spec.ts'], w.probe);
    expect(search).toMatchObject({ confirmed: [], flaky: ['a.spec.ts'], culprits: [] });
    expect(w.calls).toEqual(['c11']);
    expect(blameOf(search, ['a.spec.ts'], () => ({ pr: 1, subject: '' }), null, { run: 2, sha: 'c11' })).toMatchObject({ verdict: 'flaky', pr: null });
    // With a real break next to it, the real one is still pinned and the flaky one listed.
    const w2 = world({ 'a.spec.ts': 11, 'b.spec.ts': 4 }, { passAtRed: ['a.spec.ts'] });
    const both = blameOf(findCulprits(w2.commits, ['a.spec.ts', 'b.spec.ts'], w2.probe), ['a.spec.ts', 'b.spec.ts'], () => ({ pr: 5, subject: '' }), null, { run: 2, sha: 'c11' });
    expect(both).toMatchObject({ verdict: 'pinned', sha: 'c4', specs: ['b.spec.ts'], flaky: ['a.spec.ts'] });
  });

  test('a commit that cannot be built is stepped around, and when it hides the break the range is named, not a guess', () => {
    const around = world({ 'a.spec.ts': 8 }, { unbuildable: [5] });
    expect(findCulprits(around.commits, ['a.spec.ts'], around.probe).culprits).toEqual([{ sha: 'c8', specs: ['a.spec.ts'] }]);
    const hidden = world({ 'a.spec.ts': 6 }, { unbuildable: [5] });
    const search = findCulprits(hidden.commits, ['a.spec.ts'], hidden.probe);
    expect(search.culprits).toEqual([]);
    expect(search.unpinned).toMatchObject({ shas: ['c5', 'c6'], specs: ['a.spec.ts'] });
    expect(blameOf(search, ['a.spec.ts'], () => ({ pr: 1, subject: '' }), null, { run: 2, sha: 'c11' })).toMatchObject({ verdict: 'unpinned', pr: null });
  });
});
