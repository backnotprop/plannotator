/**
 * Guard for the PR slice of browser specs (scripts/e2e-slice.ts, issue #3455).
 *
 * Each failure this catches would make a PR run the wrong browser specs while
 * its checks stay green: specs the PR edits or names dropped before mapped
 * ones, the budget cut taken from the wrong end or a drop not listed, an
 * `e2e:` line misread (the PR template's own placeholder selecting specs, a
 * comma or a glob missed), a changed path with no rule silently ignored, a
 * docs-only PR building the apps, a quarantined spec still run, the real rules
 * pointing at specs that do not exist, or the workflow no longer running the
 * slice on every PR.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, specFiles, specTimes } from './ci-e2e-shard';
import {
  DEFAULT_RULES,
  SLICE_HARD_MAX_SHARDS,
  SLICE_MAX_SHARDS,
  SLICE_SHARD_MINUTES,
  describeSlice,
  e2eLine,
  planOutputs,
  referencesOf,
  selectSlice,
  shardCount,
  shardTimeout,
  specsOfToken,
  specsReaching,
  type SliceInput,
  type SliceRules,
} from './e2e-slice';

const spec = (name: string) => `tests/e2e/${name}.spec.ts`;
const SPECS = ['a-long', 'a-short', 'b-one', 'b-two', 'smoke-x', 'edited', 'named', 'flaky', 'z-webkit'].map(spec);
const TIMES: Record<string, number> = {
  'a-long.spec.ts': 300,
  'a-short.spec.ts': 30,
  'b-one.spec.ts': 60,
  'b-two.spec.ts': 20,
  'smoke-x.spec.ts': 10,
  'edited.spec.ts': 120,
  'named.spec.ts': 90,
  'flaky.spec.ts': 15,
  'z-webkit.spec.ts': 5,
};
const RULES: SliceRules = {
  rules: [
    { name: 'area a', paths: ['packages/a/**'], specs: ['a-*.spec.ts'] },
    { name: 'area b', paths: ['packages/b/**'], specs: ['b-*.spec.ts', 'flaky.spec.ts'] },
    { name: 'dep bump', paths: ['**/package.json'], lines: 'some-dep', specs: ['b-one.spec.ts'] },
    { name: 'shared', paths: ['packages/**', 'package.json'], fallback: true, smoke: ['app'] },
  ],
  smoke: { app: ['smoke-x.spec.ts'] },
  noBrowser: [{ paths: ['docs/**', '**/*.md', 'apps/marketing/**'], why: 'docs' }],
  quarantine: [],
  helperFanout: 2,
};
const pick = (over: Partial<SliceInput>) => selectSlice({ changed: [], specs: SPECS, times: TIMES, rules: RULES, ...over });
const names = (list: { spec: string }[]) => list.map((c) => c.spec.replace('tests/e2e/', '').replace('.spec.ts', ''));

describe('the slice: order', () => {
  test('edited specs first, then the e2e: line, then rule matches shortest first, then the smoke sets', () => {
    const slice = pick({
      changed: ['packages/a/x.ts', 'packages/b/y.ts', 'packages/c/z.ts', spec('edited')],
      body: 'Summary\n\ne2e: named\n',
    });
    expect(names(slice.chosen)).toEqual(['edited', 'named', 'flaky', 'b-two', 'a-short', 'b-one', 'a-long', 'smoke-x']);
    expect(slice.chosen[0].why).toContain('edited');
    expect(slice.chosen[1].why).toContain('e2e:');
    expect(slice.dropped).toEqual([]);
  });

  test('a spec picked twice keeps its earliest place', () => {
    const slice = pick({ changed: ['packages/a/x.ts', spec('a-long')], body: 'e2e: a-long' });
    expect(names(slice.chosen)).toEqual(['a-long', 'a-short']);
  });

  test('a deleted spec is not run', () => {
    expect(pick({ changed: [spec('gone')] }).chosen).toEqual([]);
  });

  test('a fallback (smoke) rule counts only for a path no closer rule matched', () => {
    expect(names(pick({ changed: ['packages/a/x.ts'] }).chosen)).toEqual(['a-short', 'a-long']);
    const slice = pick({ changed: ['packages/c/z.ts'] });
    expect(names(slice.chosen)).toEqual(['smoke-x']);
    expect(slice.smokeOnly).toEqual(['packages/c/z.ts']);
  });

  test('a rule with `lines` counts only when the diff touches those lines', () => {
    expect(names(pick({ changed: ['apps/x/package.json'], diffLines: { 'apps/x/package.json': ['"some-dep": "1.2.0"'] } }).chosen)).toEqual(['b-one']);
    const slice = pick({ changed: ['apps/x/package.json'], diffLines: { 'apps/x/package.json': ['"other": "1"'] } });
    expect(slice.chosen).toEqual([]);
    expect(slice.unmatched).toEqual(['apps/x/package.json']);
  });

  test('a changed helper under tests/e2e picks the specs that import it, or the smoke sets when many do', () => {
    const sources = { [spec('b-one')]: "import { x } from './helper';", [spec('a-short')]: "import { x } from './helper.ts';" };
    expect(names(pick({ changed: ['tests/e2e/helper.ts'], sources }).chosen)).toEqual(['a-short', 'b-one']);
    const many = { ...sources, [spec('named')]: "import './helper';" };
    expect(names(pick({ changed: ['tests/e2e/helper.ts'], sources: many }).chosen)).toEqual(['smoke-x']);
    expect(pick({ changed: ['tests/e2e/unused.ts'], sources }).unmatched).toEqual(['tests/e2e/unused.ts']);
  });

  test('a helper reached through another helper picks the specs at the end of the chain', () => {
    const sources = {
      'tests/e2e/peek.ts': 'export const peek = 1;',
      'tests/e2e/world.ts': "import { peek } from './peek';",
      [spec('b-two')]: "import { world } from './world';",
      [spec('a-short')]: "import { peek } from './peek';",
      [spec('b-one')]: "import { other } from './other';",
    };
    expect(names(pick({ changed: ['tests/e2e/peek.ts'], sources }).chosen)).toEqual(['b-two', 'a-short']);
  });

  test('a tests/helpers file picks the specs that import it with ../helpers; one no spec uses selects nothing and raises no notice', () => {
    const sources = {
      'tests/helpers/fake.ts': 'export {}',
      'tests/helpers/unit-only.ts': 'export {}',
      [spec('b-one')]: "import { fake } from '../helpers/fake';",
    };
    expect(names(pick({ changed: ['tests/helpers/fake.ts'], sources }).chosen)).toEqual(['b-one']);
    const quiet = pick({ changed: ['tests/helpers/unit-only.ts'], sources });
    expect(quiet.chosen).toEqual([]);
    expect(quiet.unmatched).toEqual([]);
  });

  test('a seed a spec starts by path (bun tests/e2e/<seed>.ts) picks that spec', () => {
    const sources = {
      'tests/e2e/seed.ts': 'console.log(1);',
      [spec('a-long')]: "const seeded = spawnSync('bun', [join(repo, 'tests/e2e/seed.ts'), dataDir, '4']);",
    };
    expect(names(pick({ changed: ['tests/e2e/seed.ts'], sources }).chosen)).toEqual(['a-long']);
    expect([...referencesOf(spec('a-long'), sources[spec('a-long')])]).toEqual(['tests/e2e/seed']);
    expect([...referencesOf('tests/e2e/x.spec.ts', "import a from './a.ts'; import b from \"../helpers/b\";")]).toEqual(['tests/e2e/a', 'tests/helpers/b']);
  });
});

describe('the slice: budget', () => {
  test('over budget, the mapped and smoke specs drop from the end and are listed, after the edited and named ones', () => {
    // 4 minutes: edited 120 + named 90 + flaky 15 + b-two 20 = 245 > 240, so the cut comes at b-two.
    const slice = pick({ changed: ['packages/a/x.ts', 'packages/b/y.ts', spec('edited')], body: 'e2e: named', budgetMinutes: 4 });
    expect(names(slice.chosen)).toEqual(['edited', 'named', 'flaky']);
    expect(names(slice.dropped)).toEqual(['b-two', 'a-short', 'b-one', 'a-long']);
    for (const d of slice.dropped) expect(d.why).toContain('4-minute budget');
    expect(slice.minutes).toBe(3.8);
    expect(slice.overBudget).toBe(false);
  });

  test('specs the PR edits or names are never dropped by the budget: over it, they all run on up to 8 shards and nothing mapped does', () => {
    // A 1-minute budget: edited 120 s and named 90 s are both over it on their own, and the 300 s spec comes before a short one in path order.
    const slice = pick({ changed: [spec('a-long'), spec('edited'), 'packages/b/y.ts'], body: 'e2e: named', budgetMinutes: 1 });
    expect(names(slice.chosen)).toEqual(['a-long', 'edited', 'named']);
    expect(slice.overBudget).toBe(true);
    expect(names(slice.dropped)).toEqual(['flaky', 'b-two', 'b-one']);
    expect(describeSlice(slice)).toContain('always run');
    // 75 spec-minutes of edited specs: 8 shards, past the usual 4; 150 minutes still 8.
    const big = Object.fromEntries(SPECS.map((s) => [s.replace('tests/e2e/', ''), 500]));
    const all = selectSlice({ changed: SPECS, specs: SPECS, times: big, rules: RULES });
    expect(all.chosen).toHaveLength(SPECS.length);
    expect(all.dropped).toEqual([]);
    expect(shardCount(all)).toBe(SLICE_HARD_MAX_SHARDS);
    const twice = selectSlice({ changed: SPECS, specs: SPECS, times: Object.fromEntries(SPECS.map((s) => [s.replace('tests/e2e/', ''), 1000])), rules: RULES });
    expect(shardCount(twice)).toBe(SLICE_HARD_MAX_SHARDS);
  });

  test('the default budget is 4 shards of 10 minutes, and the shard count follows the time', () => {
    expect(SLICE_MAX_SHARDS * SLICE_SHARD_MINUTES).toBe(40);
    expect(pick({ changed: ['packages/a/x.ts'] }).budgetMinutes).toBe(40);
    const big: Record<string, number> = Object.fromEntries(SPECS.map((s) => [s.replace('tests/e2e/', ''), 500]));
    const rules = { ...RULES, rules: [{ name: 'all', paths: ['packages/**'], specs: ['*.spec.ts'] }] };
    const slice = selectSlice({ changed: ['packages/x.ts'], specs: SPECS, times: big, rules });
    expect(slice.chosen).toHaveLength(4);
    expect(shardCount(slice)).toBe(4);
    expect(shardCount(pick({ changed: ['packages/a/x.ts'] }))).toBe(1);
    expect(shardCount(pick({ changed: [] }))).toBe(0);
  });

  test('the shard timeout covers setup, the longest shard twice and slack, and the outputs carry it', () => {
    expect(shardTimeout(pick({ changed: ['packages/a/x.ts'] }))).toBe(30);
    // Four shards of 600 s each, shard 1 with its 90 s head start: 5 + 3 + 2.5 × 11.5 = 36.75 → 37.
    const tenMinutes = Object.fromEntries(SPECS.map((s) => [s.replace('tests/e2e/', ''), 600]));
    const rules = { ...RULES, rules: [{ name: 'all', paths: ['packages/**'], specs: ['*.spec.ts'] }] };
    expect(shardTimeout(selectSlice({ changed: ['packages/x.ts'], specs: SPECS, times: tenMinutes, rules }))).toBe(37);
    const huge = selectSlice({ changed: SPECS, specs: SPECS, times: Object.fromEntries(SPECS.map((s) => [s.replace('tests/e2e/', ''), 3000])), rules: RULES });
    expect(shardTimeout(huge)).toBe(180);
    const withUpdates = selectSlice({ changed: ['tests/e2e/inbox-updates.spec.ts'], specs: [...SPECS, 'tests/e2e/inbox-updates.spec.ts'], times: TIMES, rules: RULES });
    expect(planOutputs(withUpdates)).toBe('count=1\nmatrix=[1]\nrelease=true\ntimeout=30\n');
  });

  test('a spec with no measured time counts as the median', () => {
    const slice = pick({ changed: [], body: 'e2e: new-one', specs: [...SPECS, spec('new-one')] });
    expect(slice.chosen[0].seconds).toBe(30);
  });
});

describe('the e2e: line', () => {
  test('space or comma separated names, globs and paths under tests/e2e; HTML comments and placeholders select nothing', () => {
    expect(e2eLine('e2e: a-long, b-one  tests/e2e/named.spec.ts\nother: x')).toEqual(['a-long', 'b-one', 'tests/e2e/named.spec.ts']);
    expect(e2eLine('- E2E: `b-*`')).toEqual(['b-*']);
    expect(e2eLine('e2e: <!-- spec names or globs, e.g. inbox-compose* -->')).toEqual([]);
    expect(e2eLine('e2e: none')).toEqual([]);
    expect(e2eLine('see the e2e: line below')).toEqual([]);
    expect(e2eLine(undefined)).toEqual([]);
    expect(specsOfToken('b-*', SPECS)).toEqual([spec('b-one'), spec('b-two')]);
    expect(specsOfToken('tests/e2e/named.spec.ts', SPECS)).toEqual([spec('named')]);
    expect(specsOfToken('named.spec.ts', SPECS)).toEqual([spec('named')]);
  });

  test("the PR template's own e2e: line selects nothing until the author fills it in", () => {
    const template = readFileSync(join(repoRoot, '.github/pull_request_template.md'), 'utf8');
    expect(template).toMatch(/^e2e:/m);
    expect(e2eLine(template)).toEqual([]);
  });

  test('a name that matches no spec is reported, not an error', () => {
    const slice = pick({ body: 'e2e: named, nope-*' });
    expect(names(slice.chosen)).toEqual(['named']);
    expect(slice.unknown).toEqual(['nope-*']);
  });
});

describe('the slice: notices and skips', () => {
  test('a changed path no rule matches is a notice and selects nothing', () => {
    const slice = pick({ changed: ['scripts/odd.sh', 'packages/a/x.ts'] });
    expect(slice.unmatched).toEqual(['scripts/odd.sh']);
    expect(names(slice.chosen)).toEqual(['a-short', 'a-long']);
  });

  test('docs, markdown and the marketing site select nothing and raise no notice', () => {
    const slice = pick({ changed: ['docs/agent-guides/x.md', 'packages/a/README.md', 'apps/marketing/src/page.astro'] });
    expect(slice.chosen).toEqual([]);
    expect(slice.unmatched).toEqual([]);
    expect(slice.dropped).toEqual([]);
    expect(planOutputs(slice)).toBe('count=0\nmatrix=[]\nrelease=false\ntimeout=30\n');
  });

  test('a quarantined spec is skipped with its issue, and so is a spec another workflow runs', () => {
    const rules = { ...RULES, quarantine: [{ spec: 'flaky.spec.ts', issue: 1234, why: 'times out' }] };
    const slice = selectSlice({ changed: ['packages/b/y.ts'], specs: SPECS, times: TIMES, rules, elsewhere: { specs: [spec('b-two')], why: 'smoke runs it' } });
    expect(names(slice.chosen)).toEqual(['b-one']);
    expect(slice.dropped).toEqual([
      { spec: spec('flaky'), why: 'quarantined for the slice (#1234): times out' },
      { spec: spec('b-two'), why: 'smoke runs it' },
    ]);
  });

  test('the slice quarantine never drops a spec the PR edits (it may be the fix), but still drops it when only named or mapped', () => {
    const rules = { ...RULES, quarantine: [{ spec: 'flaky.spec.ts', issue: 1234, why: 'times out' }] };
    const edited = selectSlice({ changed: [spec('flaky')], specs: SPECS, times: TIMES, rules });
    expect(names(edited.chosen)).toEqual(['flaky']);
    expect(edited.dropped).toEqual([]);
    const named = selectSlice({ changed: [], body: 'e2e: flaky', specs: SPECS, times: TIMES, rules });
    expect(named.chosen).toEqual([]);
    expect(named.dropped[0].why).toContain('#1234');
  });

  test('a WebKit-only spec is skipped with a notice on a Chromium-only run', () => {
    const slice = pick({ body: 'e2e: z-webkit named', skipWebkit: true });
    expect(names(slice.chosen)).toEqual(['named']);
    expect(slice.dropped[0].why).toContain('WebKit');
  });
});

describe('the real rules', () => {
  const specs = specFiles();
  const times = specTimes();
  const real = (changed: string[], over: Partial<SliceInput> = {}) => selectSlice({ changed, specs, times, ...over });

  test('every rule and smoke set names at least one spec that exists, and each quarantine entry an issue', () => {
    const exists = (pattern: string) => specs.some((s) => new Bun.Glob(pattern).match(s.split('/').pop()!));
    for (const rule of DEFAULT_RULES.rules) {
      for (const p of rule.specs ?? []) expect(exists(p), `${rule.name}: ${p}`).toBe(true);
      for (const app of rule.smoke ?? []) expect(DEFAULT_RULES.smoke[app], `${rule.name}: smoke ${app}`).toBeDefined();
    }
    for (const [app, list] of Object.entries(DEFAULT_RULES.smoke)) {
      expect(list.length, app).toBeGreaterThan(0);
      expect(list.length, app).toBeLessThanOrEqual(3);
      for (const p of list) expect(exists(p), `${app}: ${p}`).toBe(true);
    }
    for (const q of DEFAULT_RULES.quarantine) expect(q.issue).toBeGreaterThan(0);
  });

  test('a code review change picks the review specs; a docs-only change picks nothing', () => {
    const slice = real(['packages/review-editor/App.tsx']);
    expect(slice.chosen.some((c) => c.spec === 'tests/e2e/review-sidebar.spec.ts')).toBe(true);
    expect(slice.unmatched).toEqual([]);
    expect(real(['docs/agent-guides/inbox.md', 'README.md', 'apps/marketing/src/content/docs/x.md']).chosen).toEqual([]);
  });

  test("#3448's change set picks inbox-ended-session.spec.ts, the spec that caught its regression", () => {
    // The Inbox files #3448 changed (its unit tests and docs pick nothing).
    const changed = [
      'packages/inbox/agents/AgentsSection.tsx',
      'packages/inbox/agents/model.ts',
      'packages/inbox/components/ReplyRecipient.tsx',
      'packages/inbox/components/PhoneReplyRecipient.tsx',
      'packages/inbox/components/Thread.tsx',
      'packages/inbox/thread/recipientNames.ts',
      'packages/inbox/thread/useThreadSessions.ts',
      'packages/server/inbox-sessions.ts',
      'packages/server/inbox-agents-list.ts',
      'packages/server/inbox.ts',
      'packages/shared/inbox/store.ts',
    ];
    const slice = real(changed);
    expect(slice.chosen.map((c) => c.spec)).toContain('tests/e2e/inbox-ended-session.spec.ts');
  });

  describe('helpers in this repo reach their specs', () => {
    const files = [...new Bun.Glob('tests/{e2e,helpers}/**/*.{ts,tsx,mjs}').scanSync({ cwd: repoRoot })].filter((f) => !/\.test\.tsx?$/.test(f));
    const sources = Object.fromEntries(files.map((f) => [f, readFileSync(join(repoRoot, f), 'utf8')]));
    const cases: [string, string[]][] = [
      ['tests/e2e/inbox-board-reveal-seed.ts', ['tests/e2e/inbox-board-reveal.spec.ts', 'tests/e2e/inbox-checklist-reveal.spec.ts']],
      ['tests/e2e/inbox-snooze-intro-seed.ts', ['tests/e2e/inbox-snooze-intro.spec.ts']],
      ['tests/e2e/stale-page-inbox.ts', ['tests/e2e/inbox-stale-page-webkit.spec.ts']],
      ['tests/e2e/voice-inbox.ts', ['tests/e2e/inbox-voice.spec.ts']],
    ];
    for (const [helper, expected] of cases) {
      test(`${helper}, started by path`, () => {
        expect(specsReaching(helper, sources)).toEqual(expect.arrayContaining(expected));
      });
    }

    test('tests/e2e/sidebar-peek.ts reaches the specs of the worlds that import it, not only its direct importers', () => {
      const direct = specs.filter((s) => /['"]\.\/sidebar-peek['"]/.test(sources[s] ?? ''));
      const reached = specsReaching('tests/e2e/sidebar-peek.ts', sources);
      expect(reached.length).toBeGreaterThan(direct.length);
      for (const s of direct) expect(reached).toContain(s);
    });

    test('a tests/helpers file reached by many specs gives the smoke sets, not every importer', () => {
      expect(specsReaching('tests/helpers/tour-decided.ts', sources).length).toBeGreaterThan(DEFAULT_RULES.helperFanout);
      const slice = real(['tests/helpers/tour-decided.ts'], { sources });
      expect(slice.chosen.length).toBeLessThanOrEqual(Object.values(DEFAULT_RULES.smoke).flat().length);
      expect(slice.chosen.every((c) => c.why.includes('smoke'))).toBe(true);
    });
  });
});

describe('the workflow', () => {
  type Step = { run?: string; if?: string; env?: Record<string, string>; with?: Record<string, string> };
  type Job = {
    if?: string;
    needs?: string | string[];
    'runs-on'?: string;
    'timeout-minutes'?: string | number;
    outputs?: Record<string, string>;
    steps?: Step[];
    strategy?: { matrix?: { shard?: string } };
  };
  const wf = Bun.YAML.parse(readFileSync(join(repoRoot, '.github/workflows/e2e-slice.yml'), 'utf8')) as {
    on: { pull_request?: { types?: string[]; paths?: string[] }; pull_request_target?: unknown };
    jobs: Record<string, Job>;
  };

  test('runs on every PR, whatever it changes, with no label and never as pull_request_target', () => {
    expect(wf.on.pull_request).toBeDefined();
    expect(wf.on.pull_request?.paths).toBeUndefined();
    expect(wf.on.pull_request?.types).toEqual(expect.arrayContaining(['opened', 'synchronize', 'reopened', 'ready_for_review']));
    expect(wf.on.pull_request?.types).not.toContain('labeled');
    expect(wf.on.pull_request_target).toBeUndefined();
  });

  test('the plan job picks the slice; the shards run it only when it is not empty and the PR is not a draft, on GitHub runners', () => {
    expect(wf.jobs.plan.steps?.some((s) => s.run?.trim() === 'bun run scripts/e2e-slice.ts plan')).toBe(true);
    const slice = wf.jobs.slice;
    expect(slice.needs).toEqual(['plan']);
    expect(slice.if).toContain("needs.plan.outputs.count != '0'");
    expect(slice.if).toContain('github.event.pull_request.draft');
    expect(slice['runs-on']).toBe('ubuntu-24.04');
    expect(slice.strategy?.matrix?.shard).toBe('${{ fromJSON(needs.plan.outputs.matrix) }}');
    const steps = slice.steps ?? [];
    const run = steps.findIndex((s) => s.run?.trim() === 'bash scripts/ci-e2e-in-image.sh . bun run scripts/e2e-slice.ts shard "$SHARD"');
    expect(run, 'shard step').toBeGreaterThanOrEqual(0);
    expect(steps[run].env?.SHARD).toBe('${{ matrix.shard }}');
    const compile = steps.findIndex((s) => s.run?.includes('--outfile .local/plannotator') && !s.run.includes('0.28.10'));
    expect(compile).toBeGreaterThanOrEqual(0);
    expect(compile).toBeLessThan(run);
  });

  test('the shard timeout comes from the plan, no shard step holds a token, and artifact names carry the run attempt', () => {
    const slice = wf.jobs.slice;
    expect(slice['timeout-minutes']).toBe('${{ fromJSON(needs.plan.outputs.timeout) }}');
    expect(wf.jobs.plan.outputs?.timeout).toBe('${{ steps.plan.outputs.timeout }}');
    expect(wf.jobs.plan.outputs?.attempt).toBe('${{ github.run_attempt }}');
    for (const step of slice.steps ?? []) expect(JSON.stringify(step.env ?? {})).not.toContain('github.token');
    const uploads = [...(wf.jobs.plan.steps ?? []), ...(slice.steps ?? [])].filter((s) => s.with?.name);
    expect(uploads.length).toBeGreaterThan(0);
    for (const step of uploads) expect(step.with!.name).toMatch(/run_attempt|outputs\.attempt/);
  });
});
