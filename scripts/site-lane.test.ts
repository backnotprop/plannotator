/**
 * The site lane and the marketing publish guard (scripts/site-lane.ts,
 * scripts/site-deploy.ts, .github/workflows/deploy.yml). Fails when:
 *  - the lane can start on anything but a push to main of this repository, or
 *    gets a secret, an environment or a write permission;
 *  - a range that is not site-only takes the lane: a shared package or another
 *    input the site is built from, a site file the product fetches at runtime,
 *    code, a base it cannot read, or the switch off; or a site-only one does not;
 *  - the lane publishes without its checks (the build, every site test,
 *    security-build.test.ts) or past a plan that would run everything;
 *  - the marketing site is published by more than one job, outside the one
 *    concurrency group, with other permissions, or without the guard first;
 *  - the guard lets an older commit, the live one again, or one with no site
 *    change publish, or publishes on a record or an answer it cannot read;
 *  - the site imports a file outside apps/marketing that SITE_INPUTS misses;
 *  - a publish cut short after its sync lets an older tree publish next, or a
 *    moved site file reads as no site change;
 *  - the lane's command line fails (or says publish) on an error instead of
 *    answering "not site-only".
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { PASSED_MAIN_RUNS, buildGraph, plan, repoRoot, testFiles, type Change, type Plan, type RepoApi } from './ci-affected';
import { LIVE_FILE, LIVE_PREFIX, SITE_INPUTS, guard, isManual, liveCommits, runGuard, siteChangedSince, siteInput, staleKeys } from './site-deploy';
import { ciTests, cli, decideRange, laneRange, laneTests, offLane } from './site-lane';

type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = {
  name?: string; if?: string; needs?: string | string[]; environment?: string; permissions?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean }; env?: Record<string, string>; outputs?: Record<string, string>; steps?: Step[];
};
const WF_DIR = join(repoRoot, '.github/workflows');
const text = readFileSync(join(WF_DIR, 'deploy.yml'), 'utf8');
const wf = Bun.YAML.parse(text) as { on: Record<string, unknown>; jobs: Record<string, Job> };
const lane = wf.jobs['site-lane']!;
const publish = wf.jobs['deploy-marketing']!;
const stepIndex = (job: Job, pred: (s: Step) => boolean) => job.steps!.findIndex(pred);
let realGraph: ReturnType<typeof buildGraph> | undefined;
/** The graph of this checkout (needs `bun install` and vendor.sh, as the unit lanes have), built once. */
const graph = () => (realGraph ??= buildGraph());
const ch = (path: string, status = 'M', added: string[] = [], removed: string[] = []): Change => ({ status, path, added, removed });

describe('the lane starts only on a push to main of this repository', () => {
  test('deploy.yml has no PR trigger, and its push is main only, for site paths', () => {
    expect(Object.keys(wf.on).sort()).toEqual(['push', 'workflow_dispatch', 'workflow_run']);
    expect(wf.on.push).toEqual({ branches: ['main'], paths: ['apps/marketing/**'] });
  });

  test('the lane job runs only for that push, with no secret, no environment and read-only permissions', () => {
    expect(lane.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'backnotprop/plannotator'");
    expect(lane.environment).toBeUndefined();
    expect(lane.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(JSON.stringify(lane)).not.toContain('secrets.');
    // The token reaches only the step that reads Test's runs; nothing put in a run line comes from the event.
    const range = lane.steps!.find((s) => s.id === 'range')!;
    for (const s of lane.steps!) if (s !== range) expect(JSON.stringify(s), s.name ?? s.uses).not.toContain('github.token');
    for (const s of lane.steps!) if (s.run) expect(s.run, s.name).not.toContain('${{');
  });

  test('the other paths never take a push: detect-changes and the other sites need a passed Test run or a manual run', () => {
    expect(wf.jobs['detect-changes']!.if).not.toContain("github.event_name == 'push'");
    expect(wf.jobs['detect-changes']!.if).toContain("github.event.workflow_run.event == 'push'");
    for (const id of ['deploy-portal', 'deploy-paste', 'deploy-waitlist']) expect(wf.jobs[id]!.needs, id).toBe('detect-changes');
  });
});

describe('what the lane takes', () => {
  test('(a) a stylesheet-only range, alone or with docs the site is not built from', () => {
    expect(laneRange([ch('apps/marketing/src/styles/spaces/page.css')])).toEqual({ eligible: true });
    expect(laneRange([ch('apps/marketing/src/pages/index.astro'), ch('docs/agent-guides/inbox.md'), ch('README.md')])).toEqual({ eligible: true });
  });

  test('(b) a shared package, a skill the site imports, the lockfile, a manifest or patches: deploy after Test', () => {
    for (const p of ['packages/ui/shortcuts.ts', 'packages/server/inbox.ts', 'apps/skills/core/plannotator/SKILL.md', 'bun.lock', 'package.json', 'bunfig.toml', 'patches/x.patch', '.github/workflows/deploy.yml']) {
      const r = laneRange([ch('apps/marketing/src/styles/spaces/page.css'), ch(p)]);
      expect(r.eligible, p).toBe(false);
      expect(!r.eligible && r.why, p).toContain(p);
    }
  });

  test('(c) a site file the product fetches at runtime waits for Test', () => {
    for (const p of [
      'apps/marketing/public/assets/icon-sets/v1/index.json', 'apps/marketing/public/assets/decisions/v1/banner-dark.png',
      'apps/marketing/public/assets/inbox-film-poster.jpg', 'apps/marketing/src/lib/inbox-cloud-agent.md', 'apps/marketing/src/pages/[inbox]/muse.md.ts',
    ]) {
      const r = laneRange([ch(p)]);
      expect(!r.eligible && r.why, p).toContain('PUSH_RUNTIME_SITE');
    }
  });

  test('code, the CI itself, docs alone or nothing are not the lane', () => {
    for (const p of ['apps/hook/server/index.ts', 'scripts/site-lane.ts', '.github/workflows/test.yml', 'apps/portal/index.html']) expect(laneRange([ch('apps/marketing/x.css'), ch(p)]).eligible, p).toBe(false);
    expect(laneRange([ch('docs/agent-guides/inbox.md')])).toEqual({ eligible: false, why: 'no site file changed' });
    expect(laneRange([]).eligible).toBe(false);
  });

  test('a file the site is built from stays off the lane even if PUSH_LIGHT is widened to it', () => {
    const everything = () => true;
    for (const p of ['apps/skills/core/plannotator/SKILL.md', 'packages/ui/shortcuts/index.ts', 'bun.lock']) expect(offLane(p, everything), p).toContain('SITE_INPUTS');
    expect(offLane('apps/marketing/src/x.css', () => false)).toBe('a site file that is not light');
    expect(offLane('apps/marketing/src/lib/inbox-muse.md', everything)).toContain('PUSH_RUNTIME_SITE');
  });

  test('a path the lane takes outside apps/marketing is never one the site is built from', () => {
    for (const p of ['docs/a.md', 'adr/0001.md', 'README.md', 'AGENTS.md', 'LICENSE-MIT', '.github/assets/x.png']) {
      expect(offLane(p), p).toBeNull();
      expect(siteInput(p), p).toBe(false);
    }
  });

  test("every file outside apps/marketing the site's sources import, and what those import, is an input the lane refuses", () => {
    const g = graph();
    const tracked = g.files;
    const sources = tracked.filter((f) => f.startsWith('apps/marketing/') && /\.(astro|ts|tsx|mjs|js|css)$/.test(f) && !/\.test\.|\/test\//.test(f));
    const outside = new Set<string>();
    for (const f of sources) {
      const src = readFileSync(join(repoRoot, f), 'utf8');
      for (const m of src.matchAll(/(?:from\s+|import\s*\(?\s*|@import\s+|src=)(['"])(\.\.?\/[^'"]+)\1/g)) {
        const base = relative(repoRoot, resolve(repoRoot, dirname(f), m[2]!.replace(/\?.*$/, '')));
        const hit = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx'].map((e) => base + e).find((c) => tracked.includes(c));
        if (hit && !hit.startsWith('apps/marketing/')) outside.add(hit);
      }
    }
    expect([...outside]).toEqual(expect.arrayContaining(['packages/ui/shortcuts/index.ts', 'packages/ui/theme.css', 'apps/skills/core/plannotator/SKILL.md', 'packages/core/question-block.ts']));
    const seen = new Set(outside);
    const stack = [...outside];
    while (stack.length) for (const d of g.graph[stack.pop()!]?.imports ?? []) if (!seen.has(d)) { seen.add(d); stack.push(d); }
    expect([...seen].filter((f) => !siteInput(f) || offLane(f) === null)).toEqual([]);
  }, 60_000);
});

describe("the push's range is every commit since the last passed Test run", () => {
  // A throwaway main: base, then a site commit, a code commit, another site commit.
  const dir = mkdtempSync(join(tmpdir(), 'site-lane-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@example.invalid' };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, env: gitEnv });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };
  let n = 0;
  const commit = (...files: string[]) => {
    for (const f of files) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), `${f} ${n++}\n`); }
    git('add', '-A');
    git('commit', '-q', '-m', files.join(' '));
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const base = commit('apps/marketing/src/styles/spaces/page.css', 'packages/ui/shortcuts.ts', 'apps/marketing/public/assets/icon-sets/v1/index.json', 'docs/a.md');
  const site = commit('apps/marketing/src/styles/spaces/page.css');
  const code = commit('packages/ui/shortcuts.ts');
  const site2 = commit('apps/marketing/src/styles/spaces/page.css', 'docs/a.md');
  const icons = commit('apps/marketing/public/assets/icon-sets/v1/index.json');
  const RUN = 900;

  const decide = (head: string, passed: string | null, opts: { env?: Record<string, string>; fails?: boolean } = {}) => {
    git('checkout', '-q', '--detach', head);
    const api: RepoApi = async (p) => {
      if (opts.fails) throw new Error('GitHub API 502');
      if (p === PASSED_MAIN_RUNS) return { workflow_runs: passed ? [{ id: RUN - 5, head_sha: passed }] : [] };
      const [from, to] = p.replace(/^compare\//, '').split('...');
      return { status: from === to ? 'identical' : Bun.spawnSync(['git', 'merge-base', '--is-ancestor', from!, to!], { cwd: dir }).exitCode === 0 ? 'ahead' : 'behind' };
    };
    return decideRange({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: String(RUN), ...opts.env } as NodeJS.ProcessEnv, api, dir);
  };
  const why = async (...a: Parameters<typeof decide>) => { const r = await decide(...a); return r.eligible ? 'eligible' : r.why; };

  test('a site-only range from the last passed commit is the lane, with that base and the pushed commit', async () => {
    expect(await decide(site, base)).toMatchObject({ eligible: true, base, head: site });
    expect(await decide(site2, code)).toMatchObject({ eligible: true, base: code, head: site2 });
  });

  test('a code commit Test has not passed yet keeps a later site-only push off the lane', async () => {
    expect(await why(site2, site)).toContain('packages/ui/shortcuts.ts');
    expect(await why(site2, base)).toContain('packages/ui/shortcuts.ts');
  });

  test('(c) a runtime site file in the range waits for Test', async () => {
    expect(await why(icons, site2)).toContain('PUSH_RUNTIME_SITE');
  });

  test('(d) an unknown base is not the lane: no passed run, an API error, the same commit, or a base the push does not contain', async () => {
    expect(await why(site, null)).toContain('no earlier passed Test run');
    expect(await why(site, base, { fails: true })).toContain('GitHub API 502');
    expect(await why(site, site)).toContain('identical');
    expect(await why(site, code)).toContain('behind');
    expect(await why(site, base, { env: { GITHUB_RUN_ID: '' } })).toContain('without a run id');
  });

  test('the switches and any other event turn it off', async () => {
    expect(await why(site, base, { env: { SITE_LANE: 'off' } })).toBe('the repo variable SITE_LANE is off');
    expect(await why(site, base, { env: { CI_AFFECTED: 'off' } })).toContain('CI_AFFECTED is off');
    expect(await why(site, base, { env: { GITHUB_REF: 'refs/heads/other' } })).toContain('not a pull_request run or a push to main');
    expect(await why(site, base, { env: { GITHUB_EVENT_NAME: 'workflow_run' } })).toContain('not a pull_request run or a push to main');
  });
});

describe("the lane's checks", () => {
  const SITE_TESTS = ['apps/marketing/llms.test.ts', 'apps/marketing/security-build.test.ts'];
  const fake = (over: Partial<Plan>): Plan => ({
    mode: 'subset', reasons: [], changed: [], tests: [], total: 100, notes: [],
    unit: { lanes: ['unit-1'], files: [], shards: 1 }, dom: { lanes: [], files: [], shards: 0 }, gates: [], semgrep: { mode: 'skip', files: [] } as unknown as Plan['semgrep'],
    ...over,
  });

  test('every site test, and the tests the change reaches; the tree-scanning ones are left to Test', () => {
    const p = fake({
      tests: [{ path: 'packages/shared/html-assets.test.ts', why: 'reached' }, { path: 'scripts/x.test.ts', why: 'scanner' }, { path: 'packages/ui/A.test.tsx', why: 'reached' }],
      unit: { lanes: ['unit-1'], files: ['packages/shared/html-assets.test.ts', 'scripts/x.test.ts', 'packages/ui/A.test.tsx'], shards: 1 },
      dom: { lanes: ['dom-1'], files: ['packages/ui/A.test.tsx'], shards: 1 },
    });
    expect(laneTests(p, SITE_TESTS, new Set(['packages/ui/A.test.tsx']))).toEqual({
      eligible: true,
      unit: ['apps/marketing/llms.test.ts', 'apps/marketing/security-build.test.ts', 'packages/shared/html-assets.test.ts', 'packages/ui/A.test.tsx'],
      dom: ['packages/ui/A.test.tsx'],
    });
  });

  test('a change a PR would test in full, or one reaching a heavy lane, is not the lane', () => {
    for (const p of ['apps/marketing/package.json', 'apps/marketing/tsconfig.json', 'apps/marketing/bunfig.toml']) {
      const r = laneTests(plan({ files: [], graph: {} }, { changes: [ch(p, 'M', ['"x": "1"'], [])], docsOnly: false }), SITE_TESTS);
      expect(!r.eligible && r.why, p).toContain('would run everything');
    }
    expect(laneTests(plan({ files: [], graph: {} }, { changes: [ch('apps/marketing/src/lib/x.ts', 'D')], docsOnly: false }), SITE_TESTS).eligible).toBe(false);
    expect(laneTests(fake({ unit: { lanes: ['heavy-mod', 'unit-1'], files: [], shards: 1 } }), SITE_TESTS)).toMatchObject({ eligible: false });
  });

  test('the real stylesheet change runs security-build.test.ts and every other site test', () => {
    const g = graph();
    const site = testFiles(g).filter((f) => f.startsWith('apps/marketing/'));
    expect(site).toContain('apps/marketing/security-build.test.ts');
    const r = laneTests(plan(g, { changes: [ch('apps/marketing/src/styles/spaces/page.css')], docsOnly: false }), site);
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      expect(r.unit).toEqual(expect.arrayContaining(site));
      expect(r.unit.length).toBeLessThan(40);
    }
  }, 60_000);

  test('the job decides before it installs, then picks, builds and tests before it says publish', () => {
    const at = (pred: (s: Step) => boolean) => stepIndex(lane, pred);
    const range = at((s) => s.run === 'bun run scripts/site-lane.ts range');
    const install = at((s) => s.run === 'bun install --frozen-lockfile');
    const pick = at((s) => s.run === 'bun run scripts/site-lane.ts tests');
    const build = at((s) => s.run === 'bun run build:marketing');
    const tests = at((s) => s.run === 'bun run scripts/ci-test-lane.ts unit-1');
    const ready = at((s) => s.id === 'ready');
    expect([range, install, pick, build, tests, ready].every((i) => i >= 0)).toBe(true);
    expect(range < install && install < pick && pick < build && build < tests && tests < ready).toBe(true);
    expect(ready).toBe(lane.steps!.length - 1);
    expect(lane.steps![tests]!.env).toEqual({ CI_AFFECTED_TESTS: '${{ steps.tests.outputs.unit_tests }}', CI_AFFECTED_SHARDS: '1' });
    for (const s of lane.steps!.slice(pick + 1)) expect(s.if, s.name).toStartWith("steps.tests.outputs.eligible == 'true'");
    expect(lane.outputs?.publish).toBe('${{ steps.ready.outputs.publish }}');
  });
});

describe('one publish, reached two ways', () => {
  test('exactly one job publishes the site, in one concurrency group that queues and never cancels', () => {
    const syncs = Object.entries(wf.jobs).filter(([, j]) => (j.steps ?? []).some((s) => s.run?.includes('s3://plannotator-marketing/')));
    expect(syncs.map(([id]) => id)).toEqual(['deploy-marketing']);
    expect(publish.concurrency).toEqual({ group: 'deploy-marketing', 'cancel-in-progress': false });
    expect([publish.needs].flat().sort()).toEqual(['detect-changes', 'site-lane']);
    expect(publish.if).toBe(
      "!cancelled() && ((needs.detect-changes.result == 'success' && needs.detect-changes.outputs.marketing == 'true') || "
      + "(needs.site-lane.result == 'success' && needs.site-lane.outputs.publish == 'true'))",
    );
    expect(publish.env?.CANDIDATE).toBe('${{ needs.detect-changes.outputs.sha || needs.site-lane.outputs.sha }}');
    expect(publish.steps![0]!.with?.ref).toBe('${{ env.CANDIDATE }}');
    // No other workflow writes to the site's bucket.
    for (const f of Bun.spawnSync(['git', 'ls-files', '.github/workflows'], { cwd: repoRoot }).stdout.toString().split('\n').filter(Boolean)) {
      if (f !== '.github/workflows/deploy.yml') expect(readFileSync(join(repoRoot, f), 'utf8'), f).not.toContain('s3://plannotator-marketing');
    }
  });

  test('its permissions, environment and role are the ones it always had', () => {
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(publish.environment).toBe('production');
    const aws = publish.steps!.find((s) => s.uses?.startsWith('aws-actions/configure-aws-credentials@'))!;
    expect(aws.with).toEqual({ 'role-to-assume': '${{ secrets.AWS_ROLE_ARN }}', 'aws-region': 'us-east-1' });
    for (const s of publish.steps!) if (s.uses) expect(s.uses, s.uses).toMatch(/@[0-9a-f]{40}$/);
    for (const s of publish.steps!) if (s.run) expect(s.run, s.name).not.toContain('${{');
  });

  test('the guard runs after the build and the credentials, and every write to the bucket waits for it', () => {
    const at = (pred: (s: Step) => boolean) => stepIndex(publish, pred);
    const build = at((s) => s.run === 'bun run build:marketing');
    const creds = at((s) => !!s.uses?.startsWith('aws-actions/configure-aws-credentials@'));
    const g = at((s) => s.run === 'bun run scripts/site-deploy.ts guard');
    const sync = at((s) => !!s.run?.startsWith('aws s3 sync'));
    const types = at((s) => !!s.run?.includes('--content-type "text/markdown'));
    const mark = at((s) => s.run === 'bun run scripts/site-deploy.ts mark');
    const record = at((s) => s.run === 'bun run scripts/site-deploy.ts record');
    const inval = at((s) => !!s.run?.includes('create-invalidation'));
    // The commit joins the record before the bucket can hold its tree; the older record goes after.
    expect(build < creds && creds < g && g < mark && mark < sync && sync < types && types < record && record < inval).toBe(true);
    expect(publish.steps![g]!.env?.EVENT_NAME).toBe('${{ github.event_name }}');
    expect(publish.steps![g]!.id).toBe('guard');
    for (const s of publish.steps!.slice(g + 1)) expect(s.if, s.name).toBe("steps.guard.outputs.publish == 'true'");
    expect(publish.steps![sync]!.run).toContain(`--exclude "${LIVE_PREFIX}*"`);
  });

  test("detect-changes greps the site's inputs with SITE_INPUTS, over a diff that lists both paths of a rename", () => {
    expect(text).toContain(`echo "marketing=$(changed '${SITE_INPUTS}')"`);
    expect(text).toContain('CHANGED="$(git diff --no-renames --name-only "$BEFORE_SHA" "$CURRENT_SHA")"');
  });
});

describe('the guard', () => {
  const sha = (c: string) => c.repeat(40);
  // A linear main: 1 < 2 < 3 < 4; "x" is a commit off main.
  const order = (live: string, cand: string) => {
    if (live === cand) return 'identical';
    if (live === sha('x') || cand === sha('x')) return 'diverged';
    return live < cand ? 'ahead' : 'behind';
  };
  const decide = (candidate: string, live: string[], o: { manual?: boolean; site?: boolean } = {}) =>
    guard({ candidate, live, manual: !!o.manual, order: async (l) => order(l, candidate), siteChanged: async () => o.site ?? true });

  test('never publishes a commit older than a live one', async () => {
    expect(await decide(sha('2'), [sha('3')])).toMatchObject({ publish: false, why: expect.stringContaining('older than the live 333333333') });
    expect(await decide(sha('2'), [sha('1'), sha('3')])).toMatchObject({ publish: false });
  });

  test('publishes the first time, a newer commit with a site change, or past a live commit off main', async () => {
    expect(await decide(sha('2'), [])).toMatchObject({ publish: true });
    expect(await decide(sha('3'), [sha('2')])).toMatchObject({ publish: true });
    expect(await decide(sha('3'), [sha('x')])).toMatchObject({ publish: true });
    expect(await decide(sha('3'), [sha('1'), sha('2')])).toMatchObject({ publish: true, why: expect.stringContaining('interrupted') });
  });

  test('does not publish the live commit again, nor a newer one with no site change', async () => {
    expect(await decide(sha('3'), [sha('3')])).toMatchObject({ publish: false, why: expect.stringContaining('already live') });
    expect(await decide(sha('4'), [sha('3')], { site: false })).toMatchObject({ publish: false, why: expect.stringContaining('nothing the site is built from changed') });
  });

  test('a manual run publishes what it is asked to, and says so when that is older', async () => {
    expect(await decide(sha('3'), [sha('3')], { manual: true, site: false })).toMatchObject({ publish: true });
    expect(await decide(sha('2'), [sha('3')], { manual: true })).toMatchObject({ publish: true, why: expect.stringContaining('older than the live 333333333') });
  });

  test('fails on what it cannot read, so nothing is published on a doubt', async () => {
    await expect(guard({ candidate: sha('3'), live: [sha('2')], manual: false, order: async () => 'undefined', siteChanged: async () => true })).rejects.toThrow('answered');
    await expect(guard({ candidate: sha('3'), live: [sha('2')], manual: false, order: () => Promise.reject(new Error('GitHub 502')), siteChanged: async () => true })).rejects.toThrow('502');
    await expect(decide('main', [])).rejects.toThrow('not a commit id');
    expect(() => liveCommits({ Contents: 'x' })).toThrow();
  });

  test('reads the record from the bucket listing, and replaces it with the published commit', () => {
    const listing = { Contents: [{ Key: `${LIVE_PREFIX}${sha('2')}` }, { Key: LIVE_FILE }, { Key: `${LIVE_PREFIX}not-a-sha` }, { Key: `${LIVE_PREFIX}${sha('1')}` }] };
    expect(liveCommits(listing)).toEqual([sha('1'), sha('2')]);
    expect(liveCommits({})).toEqual([]);
    expect(liveCommits(null)).toEqual([]);
    expect(staleKeys([sha('1'), sha('3')], sha('3'))).toEqual([`${LIVE_PREFIX}${sha('1')}`]);
  });

  test("the incident: the lane publishes a newer commit, then late Test-gated deploys come in any order", async () => {
    // A fake bucket record and the guard and record steps as deploy-marketing runs them, one at a time (the group).
    let live: string[] = [];
    const deploy = async (c: string, siteChange = true) => {
      const v = await decide(c, live, { site: siteChange });
      if (v.publish) live = [c];
      return v.publish;
    };
    expect(await deploy(sha('3')), 'the lane publishes a site-only push').toBe(true);
    expect(await deploy(sha('2')), 'a late deploy of an older passed Test run').toBe(false);
    expect(await deploy(sha('3')), 'the Test-gated deploy of the same commit').toBe(false);
    expect(await deploy(sha('4'), false), 'a newer commit with no site change').toBe(false);
    expect(await deploy(sha('4')), 'a newer commit with a site change').toBe(true);
    expect(live).toEqual([sha('4')]);
  });
  test('a publish cut short after its sync (no final record step) never lets an older tree publish next', async () => {
    // The bucket's record as mark (before the sync) and record (after it) leave it.
    let records = [sha('1')];
    const run = async (c: string, finish = true) => {
      const v = await decide(c, records);
      if (!v.publish) return false;
      records = [...new Set([...records, c])].sort(); // mark
      if (finish) records = records.filter((k) => !staleKeys(records, c).includes(`${LIVE_PREFIX}${k}`)); // record
      return true;
    };
    expect(await run(sha('3'), false), 'synced 3, then the run failed or was cancelled').toBe(true);
    expect(records).toEqual([sha('1'), sha('3')]);
    expect(await run(sha('2')), 'a late deploy of 2 (newer than 1, older than the tree in the bucket)').toBe(false);
    expect(await run(sha('3')), 'a rerun of 3 repairs the record').toBe(true);
    expect(records).toEqual([sha('3')]);
  });

  test('the step: no record is a loud warning; only a manual run (EVENT_NAME workflow_dispatch) publishes an older commit', async () => {
    const io = (live: string[]) => ({ listLive: () => live, order: async (l: string, c: string) => order(l, c), siteChanged: () => true });
    const none = await runGuard({ CANDIDATE: sha('2') }, io([]));
    expect(none.verdict.publish).toBe(true);
    expect(none.lines.some((l) => l.startsWith('::warning title=Marketing site: no live record::'))).toBe(true);
    expect((await runGuard({ CANDIDATE: sha('2') }, io([sha('1')]))).lines.some((l) => l.startsWith('::warning'))).toBe(false);
    for (const [event, publishes] of [['workflow_dispatch', true], ['push', false], ['workflow_run', false], [undefined, false]] as const) {
      expect(isManual({ EVENT_NAME: event }), String(event)).toBe(publishes);
      expect((await runGuard({ CANDIDATE: sha('2'), EVENT_NAME: event }, io([sha('3')]))).verdict.publish, String(event)).toBe(publishes);
    }
  });

  test('reads a site change from real git history, a site file moved out of the site included', () => {
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@example.invalid' };
    const root = mkdtempSync(join(tmpdir(), 'site-deploy-'));
    try {
      const origin = join(root, 'origin');
      mkdirSync(origin);
      const git = (cwd: string, ...args: string[]) => {
        const r = Bun.spawnSync(['git', ...args], { cwd, env: gitEnv });
        if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
        return r.stdout.toString().trim();
      };
      const write = (f: string, body: string) => { mkdirSync(dirname(join(origin, f)), { recursive: true }); writeFileSync(join(origin, f), body); };
      git(origin, 'init', '-q', '-b', 'main');
      write('apps/marketing/public/page.txt', 'a page\n'.repeat(20));
      write('docs/a.md', 'a\n');
      git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', 'base');
      const live = git(origin, 'rev-parse', 'HEAD');
      write('docs/a.md', 'b\n');
      git(origin, 'commit', '-q', '-am', 'docs');
      const docs = git(origin, 'rev-parse', 'HEAD');
      git(origin, 'mv', 'apps/marketing/public/page.txt', 'docs/page.txt');
      git(origin, 'commit', '-q', '-m', 'move a page out of the site');
      const moved = git(origin, 'rev-parse', 'HEAD');
      // As the deploy job has it: a depth-1 checkout of the candidate, the live commit fetched by id.
      const work = join(root, 'work');
      for (const [cand, want] of [[docs, false], [moved, true]] as const) {
        Bun.spawnSync(['rm', '-rf', work]);
        git(root, 'clone', '-q', '--depth=1', `file://${origin}`, work);
        git(work, 'fetch', '-q', '--depth=1', 'origin', cand);
        git(work, 'checkout', '-q', '--detach', cand);
        expect(siteChangedSince(live, cand, work), cand === moved ? 'a page moved out of apps/marketing' : 'docs only').toBe(want);
      }
      expect(Bun.spawnSync(['git', 'diff', '--name-only', live, moved], { cwd: work, env: gitEnv }).stdout.toString().trim(), 'what rename detection would have shown: no site path').toBe('docs/a.md\ndocs/page.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the lane's command line answers \"not site-only\" on any error", () => {
  const withOutput = async (body: () => Promise<number>) => {
    const dir = mkdtempSync(join(tmpdir(), 'site-lane-cli-'));
    const saved = { out: process.env.GITHUB_OUTPUT, sum: process.env.GITHUB_STEP_SUMMARY };
    process.env.GITHUB_OUTPUT = join(dir, 'out');
    process.env.GITHUB_STEP_SUMMARY = join(dir, 'summary');
    writeFileSync(process.env.GITHUB_OUTPUT, '');
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, '');
    try {
      const code = await body();
      return { code, out: readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), summary: readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8') };
    } finally {
      if (saved.out === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = saved.out;
      if (saved.sum === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = saved.sum;
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('range: an error is eligible=false, exit 0, and the reason in the summary', async () => {
    const r = await withOutput(() => cli('range', { range: async () => { throw new Error('boom'); } }));
    expect(r).toMatchObject({ code: 0, out: 'eligible=false\n' });
    expect(r.summary).toContain('the lane could not decide: boom');
  });

  test('tests: a BASE that is not a commit id is eligible=false, never a plan', async () => {
    expect(() => ciTests({ BASE: 'main' })).toThrow('BASE is not a commit id');
    expect(() => ciTests({})).toThrow('BASE is not a commit id');
    const r = await withOutput(() => cli('tests', { tests: () => ciTests({ BASE: '$(true)' }) }));
    expect(r).toMatchObject({ code: 0, out: 'eligible=false\n' });
    expect(r.summary).toContain('BASE is not a commit id');
  });

  test('an unknown command fails; the real range step on another event says not site-only', async () => {
    expect(await cli('publish')).toBe(2);
    const dir = mkdtempSync(join(tmpdir(), 'site-lane-cli-'));
    try {
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const env: Record<string, string> = { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: out, GITHUB_EVENT_NAME: 'pull_request', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
      const r = Bun.spawnSync([process.execPath, 'run', join(repoRoot, 'scripts/site-lane.ts'), 'range'], { cwd: repoRoot, env });
      expect(r.exitCode).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe('eligible=false\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
