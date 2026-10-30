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
 * scripts/ci-e2e-shard.test.ts checks that the shards together are every spec,
 * each once, and that the workflow's matrix runs every shard.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dir, '..');
export const E2E_SHARDS = 8;
export const E2E_CONFIG = 'tests/e2e/playwright.config.ts';
/** Seconds shard 1 spends on the release-numbered binary's update specs. */
export const SHARD_1_EXTRA_S = 90;

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

/** A Playwright file filter that matches this one file only. */
export function fileFilter(file: string): string {
  return `${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

if (import.meta.main) {
  const k = Number(process.argv[2]);
  if (!Number.isInteger(k) || k < 1 || k > E2E_SHARDS) {
    console.error(`usage: bun run scripts/ci-e2e-shard.ts <1..${E2E_SHARDS}>`);
    process.exit(2);
  }
  const files = shards()[k - 1];
  console.log(`e2e shard ${k}/${E2E_SHARDS}: ${files.length} specs\n  ${files.join('\n  ')}`);
  const child = Bun.spawnSync(['bunx', 'playwright', 'test', '-c', E2E_CONFIG, ...files.map(fileFilter)], {
    cwd: repoRoot,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}
