/**
 * Guard for the Inbox window e2e shards (scripts/ci-e2e-shard.ts).
 *
 * Each failure this catches would make the e2e workflow pass while running
 * fewer specs than before: a spec in no shard (or in two), a shard missing
 * from the workflow's matrix, the shard job no longer calling the script, or
 * a file filter that also picks up another spec. The balance check catches a
 * shard that would hold the whole run up.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_SHARDS, E2E_WORKERS, SHARD_1_EXTRA_S, fileFilter, repoRoot, shards, specFiles, specTimes, wallTime, weigher } from './ci-e2e-shard';

const workflow = Bun.YAML.parse(readFileSync(join(repoRoot, '.github/workflows/inbox-e2e.yml'), 'utf8')) as {
  jobs: Record<string, { needs?: string; strategy?: { matrix?: { shard?: number[] } }; steps?: { run?: string; env?: Record<string, string> }[] }>;
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

  test('with two workers a shard, no shard runs far past an even split of the measured time', () => {
    // Filling shards by summed time alone left one at 758 s against an even 571 s: a long spec late in
    // file order runs with the other worker idle. The balancer replays Playwright's queue instead.
    const weight = weigher();
    const all = specFiles();
    const even = (all.reduce((sum, f) => sum + weight(f), 0) + SHARD_1_EXTRA_S) / (E2E_SHARDS * E2E_WORKERS);
    const longest = Math.max(...all.map(weight));
    const walls = shards().map((list, i) => wallTime(list, weight) + (i === 0 ? SHARD_1_EXTRA_S : 0));
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

  test('the workflow runs every shard through the script, on the built apps', () => {
    const job = workflow.jobs['inbox-window-e2e'];
    expect(job.needs).toBe('build');
    expect(job.strategy?.matrix?.shard).toEqual(Array.from({ length: E2E_SHARDS }, (_, i) => i + 1));
    const steps = job.steps ?? [];
    const run = steps.findIndex((step) => step.run?.trim() === 'bun run scripts/ci-e2e-shard.ts "$SHARD"');
    expect(run, 'shard step').toBeGreaterThanOrEqual(0);
    expect(steps[run].env?.SHARD).toBe('${{ matrix.shard }}');
    const compile = steps.findIndex((step) => step.run?.includes('--outfile .local/plannotator') && !step.run.includes('0.28.10'));
    expect(compile, 'compile before the specs').toBeGreaterThanOrEqual(0);
    expect(compile).toBeLessThan(run);
  });
});
