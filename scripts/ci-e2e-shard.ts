/**
 * One shard of the Inbox window e2e (.github/workflows/inbox-e2e.yml).
 *
 *   bun run scripts/ci-e2e-shard.ts <k>     # k = 1..E2E_SHARDS
 *
 * The Playwright specs ran as one job with one worker, about 67 min. They now
 * run as E2E_SHARDS jobs with E2E_WORKERS Playwright workers each: a shard is
 * a set of whole spec files. Playwright's own --shard splits by test count, and
 * the specs' times differ too much for that (one shard would take 17 min), so
 * the files are spread by their measured time instead
 * (tests/e2e/shard-times.json, seconds per spec from a one-worker CI run).
 *
 * Inside a shard, Playwright gives each free worker the next whole file, in
 * file-name order (the WebKit-only files after the rest). So a long spec late
 * in a shard can leave one worker running alone. The balancer replays that
 * queue: longest spec first, each into the shard whose replayed wall time grows
 * least. A spec with no time yet counts as the median, so a new spec always
 * runs somewhere. Shard 1 also runs the update specs on the release-numbered
 * binary after its own specs, so that time is added to its wall time.
 *
 * Two workers on one runner share nothing: every spec makes its own temp
 * folders, its servers take free ports, and it signals only processes it
 * proved it started (tests/e2e/inbox-scratch.ts).
 *
 * scripts/ci-e2e-shard.test.ts checks that the shards together are every spec,
 * each once, that the workflow's matrix runs every shard, and that no shard's
 * wall time is far above an even split.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dir, '..');
export const E2E_SHARDS = 8;
/** Playwright workers per shard (the config keeps 1 for local runs). */
export const E2E_WORKERS = 2;
export const E2E_CONFIG = 'tests/e2e/playwright.config.ts';
/** Seconds shard 1 spends after its specs: the update specs on the release-numbered binary, and the phone-door tests. */
export const SHARD_1_EXTRA_S = 90;

/** Every spec Playwright's testMatch can find, relative to the repo root, sorted. */
export function specFiles(): string[] {
  return [...new Bun.Glob('tests/e2e/**/*.spec.ts').scanSync({ cwd: repoRoot })].map((f) => f.replaceAll('\\', '/')).sort();
}

/** Measured seconds per spec, by file name. */
export function specTimes(): Record<string, number> {
  return JSON.parse(readFileSync(join(repoRoot, 'tests/e2e/shard-times.json'), 'utf8')) as Record<string, number>;
}

/** Seconds per spec: its measured time, else the median of the measured ones. */
export function weigher(times = specTimes()): (file: string) => number {
  const known = Object.values(times).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  return (file: string) => times[file.split('/').pop()!] ?? median;
}

/**
 * The wall time of one shard's specs: Playwright's queue replayed, each free
 * worker taking the next file in the order Playwright runs them (file name;
 * the `webkit` project's `*-webkit.spec.ts` files after the `chromium` ones).
 */
export function wallTime(files: string[], weight: (file: string) => number, workers = E2E_WORKERS): number {
  const webkitOnly = (f: string) => f.endsWith('-webkit.spec.ts');
  const queue = [...files.filter((f) => !webkitOnly(f)).sort(), ...files.filter(webkitOnly).sort()];
  const free = Array<number>(workers).fill(0);
  for (const file of queue) free[free.indexOf(Math.min(...free))] += weight(file);
  return Math.max(...free);
}

/** The spec files of each shard (index 0 is shard 1). */
export function shards(files = specFiles(), times = specTimes(), n = E2E_SHARDS, workers = E2E_WORKERS): string[][] {
  const weight = weigher(times);
  const extra = (k: number) => (k === 0 ? SHARD_1_EXTRA_S : 0);
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  const out: string[][] = Array.from({ length: n }, () => []);
  const load = Array<number>(n).fill(0);
  for (const file of ordered) {
    let best = 0;
    let bestWall = Infinity;
    for (let k = 0; k < n; k++) {
      const wall = wallTime([...out[k], file], weight, workers) + extra(k);
      // Ties go to the shard with the least work so far, then the lowest number.
      if (wall < bestWall || (wall === bestWall && load[k] < load[best])) {
        best = k;
        bestWall = wall;
      }
    }
    out[best].push(file);
    load[best] += weight(file);
  }
  return out.map((list) => list.sort());
}

/** A Playwright file filter that matches this one file only. */
export function fileFilter(file: string): string {
  return `${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/** Memory in use on this machine (MiB), or null off Linux. */
function usedMiB(): number | null {
  if (!existsSync('/proc/meminfo')) return null;
  const info = readFileSync('/proc/meminfo', 'utf8');
  const kb = (key: string) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? NaN);
  const used = (kb('MemTotal') - kb('MemAvailable')) / 1024;
  return Number.isFinite(used) ? Math.round(used) : null;
}

if (import.meta.main) {
  const k = Number(process.argv[2]);
  if (!Number.isInteger(k) || k < 1 || k > E2E_SHARDS) {
    console.error(`usage: bun run scripts/ci-e2e-shard.ts <1..${E2E_SHARDS}>`);
    process.exit(2);
  }
  const files = shards()[k - 1];
  const expected = Math.round(wallTime(files, weigher()) / 60);
  console.log(`e2e shard ${k}/${E2E_SHARDS}: ${files.length} specs, ${E2E_WORKERS} workers, about ${expected} min\n  ${files.join('\n  ')}`);
  // The machine's peak memory while the specs run, when, and the largest processes then, so a smaller runner can be judged from the log.
  const atStart = usedMiB();
  let peak = atStart;
  let peakAt = '';
  let topAtPeak = '';
  let snappedAt = 0;
  const sampler = setInterval(() => {
    const now = usedMiB();
    if (now === null || (peak !== null && now <= peak)) return;
    peak = now;
    peakAt = new Date().toISOString();
    if (now - snappedAt < 200) return;
    snappedAt = now;
    topAtPeak = Bun.spawnSync(['ps', '-eo', 'rss=,args=', '--sort=-rss']).stdout.toString().split('\n').slice(0, 8)
      .map((line) => line.trim().replace(/^(\d+)\s+(.{0,140}).*$/, (_, kb, args) => `${Math.round(Number(kb) / 1024)} MiB  ${args}`)).join('\n  ');
  }, 2000);
  const child = Bun.spawn(['bunx', 'playwright', 'test', '-c', E2E_CONFIG, `--workers=${E2E_WORKERS}`, ...files.map(fileFilter)], {
    cwd: repoRoot,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  const code = await child.exited;
  clearInterval(sampler);
  if (peak !== null) console.log(`e2e shard ${k}/${E2E_SHARDS}: peak memory in use on this machine ${peak} MiB (${atStart} MiB before the specs)${peakAt ? ` at ${peakAt}; largest processes near it:\n  ${topAtPeak}` : ''}`);
  process.exit(code ?? 1);
}
