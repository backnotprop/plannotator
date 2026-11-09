/**
 * One lane of the Test workflow (.github/workflows/test.yml).
 *
 *   bun run scripts/ci-test-lane.ts <lane>
 *
 * The suite used to run as two serial processes in one job (`bun test`, about
 * 22 min, then the DOM list under --isolate, about 20 min), which ran into the
 * job's 45 min timeout. The same files now run in parallel jobs, one lane each:
 *
 *  - `heavy-*`: the files that drive real agent processes against a real Inbox
 *    take 1.5 to 4 min each, so each one runs on its own (one process per file).
 *  - `unit-1`..`unit-N`: everything else in the plain `bun test` sweep, split by
 *    Bun's own `--shard=k/N`. Bun shards the file list it discovers, so a new
 *    test file always lands in some shard. The heavy files are left out with
 *    `--path-ignore-patterns`, and because a CLI `--path-ignore-patterns`
 *    REPLACES bunfig.toml's `pathIgnorePatterns` (it does not add to them), the
 *    bunfig patterns are read from bunfig.toml and passed again.
 *  - `dom-1`..`dom-N`: tests/dom-test-list.txt with happy-dom and `--isolate`,
 *    split by `--shard=k/N`.
 *
 * scripts/ci-test-lanes.test.ts holds the workflow's matrix to exactly these
 * lanes, so a lane cannot be dropped without the guard failing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dir, '..');

/** Files that run on their own, one lane per entry, one process per file. */
export const HEAVY_LANES: Readonly<Record<string, readonly string[]>> = {
  'heavy-mod': ['apps/hook/hooks/mod/inbox.test.ts'],
  'heavy-agents': ['apps/opencode-plugin/inbox-v2-wake.test.ts', 'apps/pi-extension/inbox.test.ts'],
};
export const UNIT_SHARDS = 3;
export const DOM_SHARDS = 4;
export const DOM_LIST = 'tests/dom-test-list.txt';

export function heavyFiles(): string[] {
  return Object.values(HEAVY_LANES).flat();
}

export function laneNames(): string[] {
  return [
    ...Object.keys(HEAVY_LANES),
    ...Array.from({ length: UNIT_SHARDS }, (_, i) => `unit-${i + 1}`),
    ...Array.from({ length: DOM_SHARDS }, (_, i) => `dom-${i + 1}`),
  ];
}

/** bunfig.toml's [test] pathIgnorePatterns, the ones the plain sweep honours. */
export function bunfigIgnorePatterns(): string[] {
  const config = Bun.TOML.parse(readFileSync(join(repoRoot, 'bunfig.toml'), 'utf8')) as {
    test?: { pathIgnorePatterns?: unknown };
  };
  const patterns = config.test?.pathIgnorePatterns;
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string')) {
    throw new Error('bunfig.toml: [test] pathIgnorePatterns is not a list of strings');
  }
  return patterns as string[];
}

/** The paths in tests/dom-test-list.txt, in order. */
export function domList(): string[] {
  return readFileSync(join(repoRoot, DOM_LIST), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

export interface LaneRun {
  args: string[];
  env: Record<string, string>;
}

/** The `bun test` runs that make up one lane, run one after another. */
export function laneRuns(lane: string): LaneRun[] {
  const heavy = HEAVY_LANES[lane];
  if (heavy) return heavy.map((file) => ({ args: ['test', `./${file}`], env: {} }));

  const unit = /^unit-(\d+)$/.exec(lane);
  if (unit && Number(unit[1]) >= 1 && Number(unit[1]) <= UNIT_SHARDS) {
    const ignore = [...bunfigIgnorePatterns(), ...heavyFiles()];
    return [{
      args: ['test', `--shard=${unit[1]}/${UNIT_SHARDS}`, ...ignore.map((p) => `--path-ignore-patterns=${p}`)],
      env: {},
    }];
  }

  const dom = /^dom-(\d+)$/.exec(lane);
  if (dom && Number(dom[1]) >= 1 && Number(dom[1]) <= DOM_SHARDS) {
    return [{
      args: ['test', '--isolate', `--shard=${dom[1]}/${DOM_SHARDS}`, ...domList()],
      env: { DOM_TESTS: '1' },
    }];
  }

  throw new Error(`unknown lane "${lane}"; lanes: ${laneNames().join(', ')}`);
}

if (import.meta.main) {
  const lane = process.argv[2];
  if (!lane) {
    console.error(`usage: bun run scripts/ci-test-lane.ts <lane>\nlanes: ${laneNames().join(', ')}`);
    process.exit(2);
  }
  const runs = laneRuns(lane);
  // A missing file would make `bun test` treat the path as a filter that
  // matches nothing; refuse it here so a renamed file fails loudly.
  for (const file of lane.startsWith('dom-') ? domList() : HEAVY_LANES[lane] ?? []) {
    if (!existsSync(join(repoRoot, file))) {
      console.error(`${file}: listed for lane ${lane} but not found`);
      process.exit(1);
    }
  }
  let failed = false;
  for (const run of runs) {
    console.log(`lane ${lane}: bun ${run.args.slice(0, 3).join(' ')}${run.args.length > 3 ? ` (+${run.args.length - 3} args)` : ''}`);
    const child = Bun.spawnSync([process.execPath, ...run.args], {
      cwd: repoRoot,
      env: { ...process.env, ...run.env },
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    if (child.exitCode !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
