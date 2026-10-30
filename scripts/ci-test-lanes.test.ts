/**
 * Guard for the Test workflow's lanes (scripts/ci-test-lane.ts).
 *
 * The suite runs as parallel jobs, one lane each. Each failure this catches
 * would make CI pass while running fewer tests than before:
 *  - a lane in the script but missing from the workflow's matrix (its files
 *    never run), or a matrix entry the script does not know;
 *  - the plain shards losing a bunfig.toml ignore pattern (a CLI
 *    `--path-ignore-patterns` replaces bunfig's, so the e2e and relay specs
 *    would run where they cannot pass) or not leaving out a heavy file;
 *  - a heavy file that is gone, listed twice, or inside an ignored folder;
 *  - the DOM list naming a missing or repeated file, or a file the workflow
 *    runs in its own process (the real @pierre/diffs files must never share a
 *    process with the list, whose mocks are process-global).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOM_SHARDS,
  HEAVY_LANES,
  UNIT_SHARDS,
  bunfigIgnorePatterns,
  domList,
  heavyFiles,
  laneNames,
  laneRuns,
  repoRoot,
} from './ci-test-lane';

const workflow = readFileSync(join(repoRoot, '.github/workflows/test.yml'), 'utf8');

/** Every `lane: [a, b, ...]` matrix entry in the workflow, in order. */
function matrixLanes(): string[] {
  return [...workflow.matchAll(/^\s*lane:\s*\[([^\]]*)\]/gm)].flatMap((m) =>
    m[1].split(',').map((lane) => lane.trim()).filter(Boolean),
  );
}

describe('Test workflow lanes', () => {
  test('the workflow matrix runs every lane exactly once, and no other', () => {
    const lanes = matrixLanes();
    expect(lanes.length).toBe(new Set(lanes).size);
    expect([...lanes].sort()).toEqual([...laneNames()].sort());
    expect(laneNames().length).toBe(Object.keys(HEAVY_LANES).length + UNIT_SHARDS + DOM_SHARDS);
  });

  test('the unit and dom jobs run their lane through the script, after vendor.sh', () => {
    // A matrix that names every lane runs nothing if its job stops calling the
    // script (or calls it before the Pi extension's shared copies exist).
    const jobs = (Bun.YAML.parse(workflow) as { jobs: Record<string, { steps?: { run?: string; env?: Record<string, string> }[] }> }).jobs;
    for (const name of ['unit', 'dom']) {
      const runs = (jobs[name]?.steps ?? []).map((step) => step.run?.trim());
      const vendor = runs.indexOf('bash apps/pi-extension/vendor.sh');
      const lane = runs.indexOf('bun run scripts/ci-test-lane.ts "$LANE"');
      expect(vendor, `${name}: vendor.sh step`).toBeGreaterThanOrEqual(0);
      expect(lane, `${name}: lane step after vendor.sh`).toBeGreaterThan(vendor);
      expect(jobs[name].steps![lane].env?.LANE, `${name}: LANE`).toBe('${{ matrix.lane }}');
    }
  });

  test('every plain shard passes bunfig.toml ignore patterns again, plus every heavy file', () => {
    const patterns = bunfigIgnorePatterns();
    expect(patterns).toContain('tests/e2e/**');
    for (let k = 1; k <= UNIT_SHARDS; k++) {
      const [run] = laneRuns(`unit-${k}`);
      expect(run.args).toContain(`--shard=${k}/${UNIT_SHARDS}`);
      const ignored = run.args.filter((a) => a.startsWith('--path-ignore-patterns=')).map((a) => a.slice('--path-ignore-patterns='.length));
      expect([...ignored].sort()).toEqual([...patterns, ...heavyFiles()].sort());
    }
  });

  test('every heavy file exists, runs in one lane only, and is not under a bunfig ignore pattern', () => {
    const files = heavyFiles();
    expect(files.length).toBe(new Set(files).size);
    for (const file of files) {
      expect(existsSync(join(repoRoot, file)), file).toBe(true);
      for (const pattern of bunfigIgnorePatterns()) expect(new Bun.Glob(pattern).match(file), `${file} vs ${pattern}`).toBe(false);
    }
    for (const [lane, list] of Object.entries(HEAVY_LANES)) {
      expect(laneRuns(lane).map((run) => run.args)).toEqual(list.map((file) => ['test', `./${file}`]));
    }
  });

  test('the DOM list names existing files once each, none the workflow runs in its own process', () => {
    const list = domList();
    expect(list.length).toBeGreaterThan(300);
    expect(list.length).toBe(new Set(list).size);
    for (const file of list) expect(existsSync(join(repoRoot, file)), file).toBe(true);
    const inWorkflow = new Set(workflow.match(/[\w./-]+\.test\.tsx?/g) ?? []);
    expect(list.filter((file) => inWorkflow.has(file))).toEqual([]);
  });

  test('every DOM shard runs the whole list with happy-dom and --isolate', () => {
    for (let k = 1; k <= DOM_SHARDS; k++) {
      const [run] = laneRuns(`dom-${k}`);
      expect(run.env).toEqual({ DOM_TESTS: '1' });
      expect(run.args.slice(0, 3)).toEqual(['test', '--isolate', `--shard=${k}/${DOM_SHARDS}`]);
      expect(run.args.slice(3)).toEqual(domList());
    }
  });

  test('an unknown lane is refused', () => {
    expect(() => laneRuns('unit-0')).toThrow(/unknown lane/);
    expect(() => laneRuns(`dom-${DOM_SHARDS + 1}`)).toThrow(/unknown lane/);
  });
});
