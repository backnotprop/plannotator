/**
 * One shard of the Inbox window e2e (.github/workflows/inbox-e2e.yml).
 *
 *   bun run scripts/ci-e2e-shard.ts <k>     # k = 1..E2E_SHARDS
 *
 * The Playwright specs ran as one job with one worker, about 67 min. They now
 * run as E2E_SHARDS jobs, each with one worker, as before: a shard is a set of
 * whole spec files. Playwright's own --shard splits by test count, and the
 * specs' times differ too much for that (one shard would take 17 min), so the
 * files are spread by their measured time instead (tests/e2e/shard-times.json,
 * seconds per spec from a CI run): longest first, each into the shard with the
 * least time so far. A spec with no time yet counts as the median, so a new
 * spec always runs somewhere. Shard 1 also runs the update specs on the
 * release-numbered binary, so it starts with that time already counted.
 *
 * On a PR the plan job may leave out specs that passed in an earlier run of
 * the same change (scripts/ci-e2e-reuse.ts). Its plan (E2E_PLAN, a JSON file)
 * then gives the specs that remain and how many shards share them; with no
 * plan, or a full one, every spec runs over E2E_SHARDS shards as above. Each
 * shard also writes Playwright's JSON report (E2E_REPORT), from which the
 * workflow records the specs it passed for the next run.
 *
 *   bun run scripts/ci-e2e-shard.ts smoke   # the PR smoke (browser-smoke.yml)
 *
 * `smoke` runs SMOKE_SPECS only, the Inbox's core paths, in one job of about
 * five minutes on every PR; the whole suite runs on main every two hours.
 *
 * scripts/ci-e2e-shard.test.ts checks that the shards together are every spec,
 * each once, that the workflow's matrix runs every shard, and that the smoke
 * specs exist and the smoke workflow runs them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dir, '..');
export const E2E_SHARDS = 16;
export const E2E_CONFIG = 'tests/e2e/playwright.config.ts';
/** Seconds shard 1 spends on the release-numbered binary's update specs. */
export const SHARD_1_EXTRA_S = 90;

/**
 * The PR smoke: whole spec files, about 75 s together, that walk the Inbox's
 * core paths on the compiled binary. inbox.spec.ts: agents' threads land in the
 * list, a row opens the thread, picks and words go out with Send and the agent
 * reads them, Settings opens and saves. inbox-message-comments.spec.ts: a
 * comment on words in an agent's message, sent and read back by the agent.
 * Whole files, not single tests: both are serial specs whose tests build on
 * each other.
 */
export const SMOKE_SPECS = ['tests/e2e/inbox.spec.ts', 'tests/e2e/inbox-message-comments.spec.ts'];

/** Every spec Playwright's testMatch can find, relative to the repo root, sorted. */
export function specFiles(): string[] {
  return [...new Bun.Glob('tests/e2e/**/*.spec.ts').scanSync({ cwd: repoRoot })].map((f) => f.replaceAll('\\', '/')).sort();
}

/** Measured seconds per spec, by file name. */
export function specTimes(): Record<string, number> {
  return JSON.parse(readFileSync(join(repoRoot, 'tests/e2e/shard-times.json'), 'utf8')) as Record<string, number>;
}

/** The spec files of each shard (index 0 is shard 1). */
export function shards(files = specFiles(), times = specTimes(), n = E2E_SHARDS): string[][] {
  const known = Object.values(times).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (file: string) => times[file.split('/').pop()!] ?? median;
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  const load = Array.from({ length: n }, (_, i) => (i === 0 ? SHARD_1_EXTRA_S : 0));
  const out: string[][] = Array.from({ length: n }, () => []);
  for (const file of ordered) {
    const k = load.indexOf(Math.min(...load));
    out[k].push(file);
    load[k] += weight(file);
  }
  return out.map((list) => list.sort());
}

/** The specs of shard k (1-based) and the shard count, from the reuse plan when it leaves specs out. */
export function shardOf(k: number, plan: { count: number; specs: string[] | null } | null): { count: number; files: string[] } {
  if (!plan || plan.specs === null) return { count: E2E_SHARDS, files: shards()[k - 1] ?? [] };
  return { count: plan.count, files: shards(plan.specs, specTimes(), plan.count)[k - 1] ?? [] };
}

/** A Playwright file filter that matches this one file only. */
export function fileFilter(file: string): string {
  return `${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/** Runs Playwright on these spec files, with the JSON report the workflow reads. Returns its exit code. */
function runSpecs(files: string[], passWithNoTests: boolean): number {
  const report = resolve(process.env.E2E_REPORT ?? join(repoRoot, '.local/e2e-report/report.json'));
  const noTests = passWithNoTests ? ['--pass-with-no-tests'] : [];
  const child = Bun.spawnSync(['bunx', 'playwright', 'test', '-c', E2E_CONFIG, '--reporter=list,json', ...noTests, ...files.map(fileFilter)], {
    cwd: repoRoot,
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: report },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return child.exitCode ?? 1;
}

if (import.meta.main && process.argv[2] === 'smoke') {
  console.log(`e2e smoke: ${SMOKE_SPECS.length} specs\n  ${SMOKE_SPECS.join('\n  ')}`);
  process.exit(runSpecs(SMOKE_SPECS, false));
} else if (import.meta.main) {
  const planFile = process.env.E2E_PLAN;
  // A missing plan would mean the 16-shard split on a smaller matrix, which drops specs: fail instead.
  if (planFile && !existsSync(planFile)) {
    console.error(`e2e shard: no plan at ${planFile}`);
    process.exit(2);
  }
  const plan = planFile ? (JSON.parse(readFileSync(planFile, 'utf8')) as { count: number; specs: string[] | null }) : null;
  const k = Number(process.argv[2]);
  const count = plan?.specs ? plan.count : E2E_SHARDS;
  if (!Number.isInteger(k) || k < 1 || k > count) {
    console.error(`usage: bun run scripts/ci-e2e-shard.ts <1..${count}> | smoke`);
    process.exit(2);
  }
  const { files } = shardOf(k, plan);
  console.log(`e2e shard ${k}/${count}: ${files.length} specs\n  ${files.join('\n  ')}`);
  // No file filter would run every spec: a shard the plan left empty runs nothing.
  if (files.length === 0) process.exit(0);
  // A planned shard may hold only specs whose every test is quarantined in CI.
  process.exit(runSpecs(files, Boolean(plan?.specs)));
}
