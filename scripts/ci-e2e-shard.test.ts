/**
 * Guard for the Inbox window e2e shards (scripts/ci-e2e-shard.ts).
 *
 * Each failure this catches would make the e2e workflow pass while running
 * fewer specs than before: a spec in no shard (or in two), a shard missing
 * from the workflow's matrix, the shard job no longer calling the script, or
 * a file filter that also picks up another spec, or a shard that no longer
 * records the specs it passed (the next run would rerun them all). The balance check catches
 * stale times: a shard well past an even split holds the whole run up. The
 * smoke checks catch a PR smoke that runs nothing: a smoke spec renamed away,
 * one no Chromium run picks up, or the smoke workflow no longer running them
 * on the compiled binary.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_SHARDS, SHARD_1_EXTRA_S, SMOKE_SPECS, fileFilter, repoRoot, shards, specFiles, specTimes } from './ci-e2e-shard';

const workflow = Bun.YAML.parse(readFileSync(join(repoRoot, '.github/workflows/inbox-e2e.yml'), 'utf8')) as {
  jobs: Record<string, { needs?: string | string[]; strategy?: { matrix?: { shard?: number[] | string } }; steps?: { run?: string; if?: string; env?: Record<string, string> }[] }>;
};

describe('Inbox window e2e shards', () => {
  test('the shards together run every spec, each once, and none is empty', () => {
    const all = specFiles();
    expect(all.length).toBeGreaterThan(50);
    const split = shards();
    expect(split.length).toBe(E2E_SHARDS);
    for (const list of split) expect(list.length).toBeGreaterThan(0);
    expect(split.flat().sort()).toEqual(all);
  });

  test('a spec with no measured time still runs, in exactly one shard', () => {
    const times = specTimes();
    const files = [...specFiles(), 'tests/e2e/brand-new.spec.ts'];
    const split = shards(files, times);
    expect(split.flat().filter((f) => f === 'tests/e2e/brand-new.spec.ts')).toHaveLength(1);
  });

  test('no shard runs far past an even split of the measured time', () => {
    // Times for 165 of 210 specs left the shards at 5.8 to 17.5 min (run 42217775919): refresh
    // tests/e2e/shard-times.json when this fails. A spec with no time yet counts as the median.
    const times = specTimes();
    const known = Object.values(times).sort((a, b) => a - b);
    const median = known[Math.floor(known.length / 2)];
    const weight = (file: string) => times[file.split('/').pop()!] ?? median;
    const all = specFiles();
    const untimed = all.filter((f) => times[f.split('/').pop()!] === undefined);
    expect(untimed.length, `specs with no measured time: ${untimed.join(', ')}`).toBeLessThanOrEqual(all.length / 10);
    const even = (all.reduce((sum, f) => sum + weight(f), 0) + SHARD_1_EXTRA_S) / E2E_SHARDS;
    const longest = Math.max(...all.map(weight));
    const walls = shards().map((list, i) => list.reduce((sum, f) => sum + weight(f), 0) + (i === 0 ? SHARD_1_EXTRA_S : 0));
    expect(Math.max(...walls)).toBeLessThanOrEqual(Math.max(even * 1.1, longest + 60));
  });

  test("each file filter matches its own spec and no other", () => {
    const all = specFiles();
    for (const file of all) {
      const re = new RegExp(fileFilter(file), 'gi');
      const hits = all.filter((other) => {
        re.lastIndex = 0;
        return re.test(join(repoRoot, other));
      });
      expect(hits, file).toEqual([file]);
    }
  });

  test('the workflow runs every shard of the plan through the script, on the built apps, and records what passed', () => {
    const job = workflow.jobs['inbox-window-e2e'];
    expect(job.needs).toEqual(['build', 'plan']);
    // The plan job gives the matrix: 1..E2E_SHARDS for a full run (scripts/ci-e2e-reuse.test.ts).
    expect(job.strategy?.matrix?.shard).toBe('${{ fromJSON(needs.plan.outputs.matrix) }}');
    const planSteps = workflow.jobs.plan?.steps ?? [];
    expect(planSteps.some((step) => step.run?.trim() === 'bun run scripts/ci-e2e-reuse.ts plan')).toBe(true);
    const steps = job.steps ?? [];
    const run = steps.findIndex((step) => step.run?.trim() === 'bun run scripts/ci-e2e-shard.ts "$SHARD"');
    expect(run, 'shard step').toBeGreaterThanOrEqual(0);
    expect(steps[run].env?.SHARD).toBe('${{ matrix.shard }}');
    expect(steps[run].env?.E2E_PLAN).toBe('.local/e2e-plan/plan.json');
    const compile = steps.findIndex((step) => step.run?.includes('--outfile .local/plannotator') && !step.run.includes('0.28.10'));
    expect(compile, 'compile before the specs').toBeGreaterThanOrEqual(0);
    expect(compile).toBeLessThan(run);
    // Recorded even when the shard failed: the specs that did pass are left out next time.
    const record = steps.findIndex((step) => step.run?.startsWith('bun run scripts/ci-e2e-reuse.ts passed '));
    expect(record).toBeGreaterThan(run);
    expect(steps[record].if).toBe('always()');
  });
});

describe('the PR smoke', () => {
  test('every smoke spec exists and runs in Chromium, and the slice stays short', () => {
    const all = specFiles();
    expect(SMOKE_SPECS.length).toBeGreaterThan(0);
    for (const file of SMOKE_SPECS) {
      expect(all, file).toContain(file);
      // The webkit project runs *-webkit specs only, and inbox-thread-parity has its own config.
      expect(file).not.toMatch(/-webkit\.spec\.ts$|inbox-thread-parity/);
    }
    // About five minutes in all: the build takes about three. Measured seconds per spec.
    const times = specTimes();
    expect(SMOKE_SPECS.reduce((sum, f) => sum + (times[f.split('/').pop()!] ?? 0), 0)).toBeLessThanOrEqual(120);
  });

  test('browser-smoke.yml compiles the binary, then runs the smoke specs in the Playwright image', () => {
    const smoke = Bun.YAML.parse(readFileSync(join(repoRoot, '.github/workflows/browser-smoke.yml'), 'utf8')) as typeof workflow;
    const steps = smoke.jobs.smoke?.steps ?? [];
    const run = steps.findIndex((step) => step.run?.trim() === 'bash scripts/ci-e2e-in-image.sh . bun run scripts/ci-e2e-shard.ts smoke');
    expect(run, 'smoke step').toBeGreaterThanOrEqual(0);
    const compile = steps.findIndex((step) => step.run?.includes('--outfile .local/plannotator'));
    expect(compile, 'compile before the specs').toBeGreaterThanOrEqual(0);
    expect(compile).toBeLessThan(run);
  });
});
