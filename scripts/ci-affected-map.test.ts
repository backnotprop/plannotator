/**
 * Guard for what a PR's CI runs (scripts/ci-affected.ts).
 *
 * What can regress, and the test that says so:
 *  - a workflow job the map does not know, or a gated job that a failed or
 *    missing gate would skip instead of run (the "every job" rows);
 *  - a rule that matches no file any more, a top-level entry or a file kind the
 *    picker does not know in today's tree (the "rules" rows);
 *  - a self-hosted runner reachable from a fork or bot PR, or a
 *    pull_request_target trigger;
 *  - the picker skipping where it must run everything: the lockfile, a
 *    manifest, a tsconfig, a helper, a workflow, deleted code, an unknown kind,
 *    an unresolved import, a run that is not a PR (the "plan" rows);
 *  - the picker missing a test a change reaches by import, path string,
 *    vendored copy or file name, or a DOM-list line (the "plan" rows and the
 *    real-graph rows);
 *  - a tree-scanning test alone starting a job, or lanes that do not cover the
 *    picked files;
 *  - a path built from parts (join, resolve, new URL, a template, a folder and
 *    a name) making no edge, a read of the checkout by a path the graph cannot
 *    tell not making a tree-scanning test, a deleted non-code file reaching no
 *    test, a preload or an importer-side unresolved import not running
 *    everything (the "paths built from parts" rows and the real-graph rows);
 *  - the smoke skipping a file the binary is built from, a manual preview's
 *    partial Semgrep scan reaching main's alerts or cancelling its scan, or
 *    deploy.yml taking a preview for a passed Test run;
 *  - a push to main planning from anything but the last passed main commit
 *    (deploy.yml's base), planning a range that changes more than the site and
 *    docs, or planning at all when that base cannot be read (the "a push to
 *    main" rows).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  CORE_GUARDS, GATES, GATE_JOB, HEAVY_FAIL_SAFE, JOB_MAP, KNOWN_TOP, PASSED_MAIN_RUNS, RUN_ALL, SMOKE_ROOTS, buildGraph, builtPathRefs, ciChanges, decideGates, gatePaths,
  knownKind, lastPassedSha, listsCheckout, nativeAppFile, pathReasons, plan, preloadClosure, pushChanges, pushLight, repoRoot, semgrepPlan,
  type Change, type Graph, type Node, type PathRead, type RepoApi,
} from './ci-affected';
import { HEAVY_LANES, domList, laneNames } from './ci-test-lane';

type Step = { name?: string; if?: string; run?: string };
type Job = { name?: string; if?: string; needs?: string | string[]; 'runs-on'?: string; outputs?: Record<string, string>; steps?: Step[] };
type Workflow = { on: Record<string, { paths?: string[] } | null>; jobs: Record<string, Job> };
const WF_DIR = join(repoRoot, '.github/workflows');
const workflow = (file: string) => Bun.YAML.parse(readFileSync(join(WF_DIR, file), 'utf8')) as Workflow;
const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml')).sort();
const needsOf = (job: Job) => (job.needs === undefined ? [] : [job.needs].flat());
const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: repoRoot }).stdout.toString().split('\n').filter(Boolean);

describe('every job', () => {
  test('every workflow and every job has an entry in JOB_MAP, and no other', () => {
    expect(Object.keys(JOB_MAP).sort()).toEqual(files);
    for (const file of files) expect(Object.keys(JOB_MAP[file]!).sort(), file).toEqual(Object.keys(workflow(file).jobs).sort());
  });

  for (const file of files) {
    test(`${file}: each job is decided the way the map says`, () => {
      const wf = workflow(file);
      for (const [id, kind] of Object.entries(JOB_MAP[file]!)) {
        const job = wf.jobs[id]!;
        const cond = job.if ?? '';
        if (kind.startsWith('gate:')) {
          const key = kind.slice(5);
          const gate = GATE_JOB[file]!;
          expect(needsOf(job), `${id} needs its gate`).toContain(gate);
          // !cancelled(): runs even when the gate failed; "!= 'false'": a missing answer runs it.
          const want = key === 'semgrep'
            ? `\${{ !cancelled() && needs.${gate}.outputs.semgrep != 'skip' }}`
            : `\${{ !cancelled() && needs.${gate}.outputs.${key} != 'false' }}`;
          expect(cond, id).toBe(want);
          if (key !== 'semgrep') expect(GATES[file]!.map((g) => g.key), id).toContain(key);
        } else if (kind === 'always') {
          expect(cond, id).not.toContain('labels');
          expect(cond, id).toBe('');
        } else if (kind === 'code') {
          expect(cond, id).toBe("${{ !cancelled() && needs.plan.outputs.mode != 'docs' }}");
        } else if (kind === 'lanes') {
          expect(cond, id).toBe(`\${{ !cancelled() && needs.plan.outputs.${id}_lanes != '[]' }}`);
        } else if (kind === 'paths') {
          const paths = wf.on.pull_request?.paths ?? [];
          expect(paths, `${file} has a PR path list`).toContain(`.github/workflows/${file}`);
          expect(cond, id).not.toContain('labels');
        } else if (kind === 'no-pr') {
          // No PR trigger, or a job whose `if` names only events that are not a PR.
          if (wf.on.pull_request !== undefined) expect(cond, id).toMatch(/^\$\{\{ github\.event_name == '(schedule|workflow_dispatch)'( \|\| github\.event_name == '(schedule|workflow_dispatch)')* \}\}$/);
        } else if (kind === 'tag') {
          expect(cond, id).toContain("startsWith(github.ref, 'refs/tags/v')");
        }
      }
    });
  }

  test('each gate job runs the picker and hands on exactly its gates', () => {
    for (const [file, id] of Object.entries(GATE_JOB)) {
      const job = workflow(file).jobs[id]!;
      expect(job['runs-on'], `${file} ${id}`).toBe('ubuntu-24.04');
      expect(job.if, `${file} ${id}`).toBeUndefined();
      const runs = (job.steps ?? []).map((s) => s.run?.trim());
      const name = file.replace(/\.yml$/, '');
      expect(runs, file).toContain(file === 'test.yml' ? 'bun run scripts/ci-affected.ts plan' : `bun run scripts/ci-affected.ts gate ${name}`);
      const keys = Object.keys(job.outputs ?? {});
      for (const g of GATES[file] ?? []) expect(keys, `${file} hands on ${g.key}`).toContain(g.key);
      if (file === 'security.yml') expect(keys).toEqual(expect.arrayContaining(['semgrep', 'semgrep_files']));
      // The manual preview's paths reach the picker through env, never inline in a script.
      const picker = (job.steps ?? []).find((s) => s.run?.includes('ci-affected.ts')) as Step & { env?: Record<string, string> };
      expect(picker.env?.CI_AFFECTED_AS_IF, file).toBe('${{ inputs.as_if_changed }}');
      expect(picker.run, file).not.toContain('${{');
      const dispatch = workflow(file).on.workflow_dispatch as { inputs?: Record<string, { required?: boolean }> } | null;
      expect(dispatch?.inputs?.as_if_changed?.required, file).toBe(false);
    }
  });

  test("test.yml's step gates read the plan the same way, and every test.yml gate is read", () => {
    const text = readFileSync(join(WF_DIR, 'test.yml'), 'utf8');
    for (const g of GATES['test.yml']!) expect(text, g.key).toContain(`needs.plan.outputs.${g.key} != 'false'`);
    const checks = workflow('test.yml').jobs.checks!;
    for (const step of checks.steps ?? []) if (step.if?.includes('needs.plan')) expect(step.if, step.name).toMatch(/^needs\.plan\.outputs\.\w+ != 'false'$/);
  });

  test('the Checks job runs every core guard, and they exist', () => {
    const guard = workflow('test.yml').jobs.checks!.steps!.find((s) => s.name?.startsWith('Guard the tree'))!;
    expect(guard.if).toBeUndefined();
    expect(guard.run!.split(/\s+/).filter((w) => w.endsWith('.ts'))).toEqual(CORE_GUARDS);
    for (const f of CORE_GUARDS) expect(existsSync(join(repoRoot, f)), f).toBe(true);
  });

  test("the lane matrices fall back to every lane, as the picker's `all` plan does", () => {
    const text = readFileSync(join(WF_DIR, 'test.yml'), 'utf8');
    const fallback = [...text.matchAll(/lane: \$\{\{ fromJSON\(needs\.plan\.outputs\.(\w+)_lanes \|\| '(\[[^']*\])'\) \}\}/g)];
    expect(fallback.map((m) => m[1])).toEqual(['unit', 'dom']);
    const all = plan({ files: [], graph: {} }, { changes: [], docsOnly: false, forceAll: 'test' });
    expect(JSON.parse(fallback[0]![2]!)).toEqual(all.unit.lanes);
    expect(JSON.parse(fallback[1]![2]!)).toEqual(all.dom.lanes);
    expect([...all.unit.lanes, ...all.dom.lanes].sort()).toEqual(laneNames().sort());
  });

  test("a manual preview's partial Semgrep scan is never uploaded outside a PR, never cancels main's scan, and never passes for deploy", () => {
    const sec = workflow('security.yml') as Workflow & { concurrency: { group: string } };
    const upload = sec.jobs.semgrep!.steps!.find((s) => s.name === 'Upload Semgrep SARIF')!;
    expect(upload.if!.replace(/\s+/g, ' ')).toContain("(github.event_name != 'pull_request' && needs.changes.outputs.semgrep != 'files')");
    expect(sec.concurrency.group).toContain("inputs.as_if_changed && format('preview-{0}', github.run_id)");
    const test = readFileSync(join(WF_DIR, 'test.yml'), 'utf8');
    expect((Bun.YAML.parse(test) as { 'run-name': string })['run-name']).toContain("inputs.as_if_changed && format('Test preview: as if {0} changed'");
    expect(readFileSync(join(WF_DIR, 'deploy.yml'), 'utf8')).toContain('startswith("Test preview:") | not');
  });

  test('a self-hosted runner never runs a fork or bot PR, and no workflow uses pull_request_target', () => {
    const guard = "github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot'";
    for (const file of files) {
      const wf = workflow(file);
      expect(Object.keys(wf.on ?? {}), file).not.toContain('pull_request_target');
      for (const [id, job] of Object.entries(wf.jobs)) {
        const on = String(job['runs-on'] ?? '');
        if (on.includes('vars.') && wf.on.pull_request !== undefined) expect(on, `${file} ${id}`).toContain(guard);
      }
    }
  });
});

describe('rules', () => {
  test('every rule glob matches a tracked file', () => {
    const globs = new Set([
      ...RUN_ALL.map((r) => r.glob), ...HEAVY_FAIL_SAFE, ...Object.values(GATES).flat().flatMap(gatePaths),
      ...['release.yml', 'inbox-pi.yml', 'inbox-claude-code.yml', 'relay.yml', 'mobile-ios.yml'].flatMap((f) => workflow(f).on.pull_request?.paths ?? []),
    ]);
    const dead = [...globs].filter((g) => !tracked.some((f) => new Bun.Glob(g).match(f)));
    // The picker is in the tree once this lands; until then the guard runs from a branch. The app contract's
    // generated Swift arrives with the contract kit (docs/agent-guides/mobile.md); mobile-ios.yml names it already.
    expect(dead.filter((g) => g !== 'scripts/ci-affected.ts' && g !== 'apps/mobile/contract/generated/swift/**')).toEqual([]);
  });

  test('every tracked top-level entry and every tracked file kind is known to the picker', () => {
    expect([...new Set(tracked.map((f) => f.split('/')[0]!))].filter((t) => !KNOWN_TOP.includes(t))).toEqual([]);
    // The native app's files are left out of every plan instead (nativeAppFile).
    expect(tracked.filter((f) => !knownKind(f) && !nativeAppFile(f))).toEqual([]);
  });

  test('the test-file gates name files the workflow runs', () => {
    const text = readFileSync(join(WF_DIR, 'test.yml'), 'utf8');
    for (const f of ['packages/ui/components/html-viewer/bridgeAsset.test.ts', 'packages/ui/hooks/useFileBrowser.test.tsx', 'tests/entry-assets.test.ts', 'apps/opencode-plugin/inbox-v2.test.ts', 'apps/opencode-plugin/inbox.test.ts']) {
      expect(text, f).toContain(f);
      expect(GATES['test.yml']!.some((g) => g.tests?.(f)), f).toBe(true);
    }
  });
});

// A synthetic graph: plan() over it needs no checkout.
const N = (imports: string[] = [], extra: Partial<Node> = {}): Node => ({ imports, refs: [], lits: [], unresolved: [], listsRepo: false, ...extra });
const DOM_FILE = domList()[0]!;
const HEAVY_FILE = HEAVY_LANES['heavy-mod']![0]!;
function graph(): Graph {
  const g: Record<string, Node> = {
    'packages/a/src.ts': N(),
    'packages/a/mid.ts': N(['packages/a/src.ts']),
    'packages/a/mid.test.ts': N(['packages/a/mid.ts']),
    'packages/b/other.ts': N(),
    'packages/b/other.test.ts': N(['packages/b/other.ts']),
    'scripts/reads.test.ts': N([], { refs: ['packages/a/data.json'] }),
    'scripts/named.test.ts': N([], { lits: ['SKILL.md'] }),
    'tests/scan.test.ts': N([], { listsRepo: true }),
    'apps/pi-extension/generated/src.ts': N([], { vendored: 'packages/a/src.ts' }),
    'apps/pi-extension/pi.test.ts': N(['apps/pi-extension/generated/src.ts']),
    [DOM_FILE]: N(['packages/b/other.ts']),
    [HEAVY_FILE]: N(['packages/c/heavy.ts']),
    'packages/c/heavy.ts': N(),
    'tests/never-touch-the-real-inbox.test.ts': N([], { listsRepo: true }),
  };
  return { files: [...Object.keys(g), 'packages/a/data.json', 'apps/x/SKILL.md'], graph: g };
}
const ch = (path: string, status = 'M', added: string[] = [], removed: string[] = []): Change => ({ status, path, added, removed });
const run = (changes: Change[], docsOnly = false) => plan(graph(), { changes, docsOnly });
const picked = (changes: Change[]) => run(changes).tests.map((t) => t.path);

describe('plan', () => {
  test('a change picks the tests that reach it by import, through other files, and the tree-scanning tests; nothing else', () => {
    const p = run([ch('packages/a/src.ts')]);
    expect(p.mode).toBe('subset');
    const by = Object.fromEntries(p.tests.map((t) => [t.path, t.why]));
    expect(by['packages/a/mid.test.ts']).toBe('reached');
    expect(by['apps/pi-extension/pi.test.ts'], "Pi's vendored copy").toBe('reached');
    expect(by['tests/scan.test.ts']).toBe('scanner');
    expect(by['packages/b/other.test.ts']).toBeUndefined();
    expect(p.tests.find((t) => t.path === 'packages/a/mid.test.ts')!.via).toBe('packages/a/src.ts');
  });

  test('a path string and a file name reach their readers; a changed test picks itself', () => {
    expect(picked([ch('packages/a/data.json')])).toContain('scripts/reads.test.ts');
    expect(picked([ch('apps/x/SKILL.md')])).toContain('scripts/named.test.ts');
    expect(picked([ch('packages/b/other.test.ts')])).toContain('packages/b/other.test.ts');
  });

  test('a file added to the DOM list runs', () => {
    expect(picked([ch('tests/dom-test-list.txt', 'M', [DOM_FILE])])).toContain(DOM_FILE);
  });

  test('everything runs on any doubt', () => {
    for (const r of RUN_ALL) {
      const path = r.glob.replace('**/', '').replace('/**', '/x.ts').replace('*', '');
      expect(run([ch(path)]).mode, `${r.glob} as ${path}`).toBe('all');
    }
    expect(run([ch('packages/a/src.ts', 'D')]).mode, 'deleted code').toBe('all');
    expect(run([ch('packages/a/src.ts', 'R100')]).mode, 'renamed code').toBe('all');
    expect(run([ch('newtop/x.ts')]).mode, 'unknown top-level entry').toBe('all');
    expect(run([ch('packages/a/thing.weird')]).mode, 'unknown file kind').toBe('all');
    expect(run([ch('packages/a/package.json', 'M', ['"version": "2"'], ['"version": "1"'])]).mode, 'a manifest').toBe('all');
    expect(run([]).mode, 'an empty diff').toBe('all');
    expect(plan(graph(), { changes: [ch('packages/a/src.ts')], docsOnly: false, forceAll: 'not a pull_request run' }).mode).toBe('all');
    const g = graph();
    g.graph['packages/a/src.ts']!.unresolved.push('./gone');
    expect(plan(g, { changes: [ch('packages/a/src.ts')], docsOnly: false }).mode, 'unresolved import').toBe('all');
  });

  test('a run that is not a PR plans everything, unless a manual run previews named paths', () => {
    const at = (env: Record<string, string>) => ciChanges(env as NodeJS.ProcessEnv);
    expect('why' in at({ GITHUB_EVENT_NAME: 'push' }), 'a push').toBe(true);
    expect('why' in at({ GITHUB_EVENT_NAME: 'workflow_dispatch' }), 'a manual run').toBe(true);
    expect('why' in at({ GITHUB_EVENT_NAME: 'push', CI_AFFECTED_AS_IF: 'README.md' }), 'as-if only on a manual run').toBe(true);
    expect('why' in at({ GITHUB_EVENT_NAME: 'workflow_dispatch', CI_AFFECTED_AS_IF: 'README.md', CI_AFFECTED: 'off' }), 'off wins').toBe(true);
    expect('why' in at({ GITHUB_EVENT_NAME: 'workflow_dispatch', CI_AFFECTED_AS_IF: '../x.ts' }), 'a path outside').toBe(true);
    expect('why' in at({ GITHUB_EVENT_NAME: 'workflow_dispatch', CI_AFFECTED_AS_IF: 'a.ts;b' }), 'an odd path').toBe(true);
    // The ci:full label on the PR, read from the event payload.
    const dir = mkdtempSync(join(tmpdir(), 'ci-affected-label-'));
    const payload = (labels: string[]) => { const f = join(dir, `${labels.join('-') || 'none'}.json`); writeFileSync(f, JSON.stringify({ pull_request: { labels: labels.map((name) => ({ name })) } })); return f; };
    expect(at({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: payload(['ci:full', 'bug']) })).toEqual({ why: 'the PR has the ci:full label' });
    expect(at({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: payload(['bug']) })).not.toEqual({ why: 'the PR has the ci:full label' });
    const docs = at({ GITHUB_EVENT_NAME: 'workflow_dispatch', CI_AFFECTED_AS_IF: 'README.md' });
    expect(docs).toMatchObject({ docsOnly: true, preview: true, changes: [{ status: 'M', path: 'README.md' }] });
    const code = at({ GITHUB_EVENT_NAME: 'workflow_dispatch', CI_AFFECTED_AS_IF: ' scripts/ci-test-lane.ts  packages/none/gone.ts ' });
    expect(code).toMatchObject({ docsOnly: false, changes: [{ status: 'M', path: 'scripts/ci-test-lane.ts' }, { status: 'D', path: 'packages/none/gone.ts' }] });
  });

  test('a deleted or renamed file that is not code still reaches the tests that name it', () => {
    expect(picked([ch('apps/x/SKILL.md', 'D')])).toContain('scripts/named.test.ts');
  });

  test('an import that did not resolve on the importer side runs everything when it may be the changed file', () => {
    const g = graph();
    g.graph['packages/a/mid.ts']!.unresolvedAt = ['packages/b/other'];
    expect(plan(g, { changes: [ch('packages/b/other.ts')], docsOnly: false }).mode).toBe('all');
    expect(plan(g, { changes: [ch('packages/a/src.ts')], docsOnly: false }).mode).toBe('subset');
    g.graph['packages/a/mid.ts']!.unresolvedAt = ['packages/b'];
    expect(plan(g, { changes: [ch('packages/b/other.ts')], docsOnly: false }).mode, 'a workspace package folder').toBe('all');
    // A file no test runs does not count.
    g.graph['packages/a/mid.ts']!.unresolvedAt = [];
    g.graph['tests/manual/x.ts'] = N([], { unresolvedAt: ['packages/b/other'] });
    expect(plan(g, { changes: [ch('packages/b/other.ts')], docsOnly: false }).mode).toBe('subset');
  });

  test('a manifest that only adds exports plans file by file', () => {
    expect(run([ch('packages/a/package.json', 'M', ['"./x": "./x.ts",'], [])]).mode).toBe('subset');
  });

  test('docs only runs no test and no gated job', () => {
    const p = run([ch('README.md')], true);
    expect(p.mode).toBe('docs');
    expect(p.tests).toEqual([]);
    expect([...p.unit.lanes, ...p.dom.lanes]).toEqual([]);
    expect(p.gates.every((d) => !d.run)).toBe(true);
    expect(p.semgrep.mode).toBe('skip');
  });

  test('lanes: a small set gets one lane per kind, a heavy lane only for its files, the guards stay in Checks', () => {
    const p = run([ch('packages/b/other.ts')]);
    expect(p.unit.lanes).toEqual(['unit-1']);
    expect(p.dom.lanes).toEqual(['dom-1']);
    expect(p.dom.files).toEqual([DOM_FILE]);
    expect(p.unit.files).toContain(DOM_FILE);
    expect(p.unit.files).not.toContain('tests/never-touch-the-real-inbox.test.ts');
    expect(run([ch('packages/c/heavy.ts')]).unit.lanes).toEqual(['heavy-mod', 'unit-1']);
  });

  test('a tree-scanning test alone starts no job; a reached test does', () => {
    const g = graph();
    g.graph['tests/entry-assets.test.ts'] = N([], { listsRepo: true });
    g.graph['packages/ui/hooks/useFileBrowser.test.tsx'] = N(['packages/ui/hooks/useFileBrowser.ts']);
    g.graph['packages/ui/hooks/useFileBrowser.ts'] = N();
    g.files.push('tests/entry-assets.test.ts', 'packages/ui/hooks/useFileBrowser.test.tsx', 'packages/ui/hooks/useFileBrowser.ts');
    const gate = (p: ReturnType<typeof plan>, key: string) => p.gates.find((d) => d.key === key)!.run;
    expect(gate(plan(g, { changes: [ch('packages/b/other.ts')], docsOnly: false }), 'opencode')).toBe(false);
    expect(gate(plan(g, { changes: [ch('packages/ui/hooks/useFileBrowser.ts')], docsOnly: false }), 'file_browser')).toBe(true);
  });
});

describe('the native app (apps/mobile)', () => {
  const lanesOf = (p: ReturnType<typeof plan>) => ({ mode: p.mode, tests: p.tests, unit: p.unit, dom: p.dom, gates: p.gates, semgrep: p.semgrep });

  test('a PR that changes only the app\'s Swift, Xcode or Gradle files plans no lane, no Checks and no gated job', () => {
    for (const paths of [['apps/mobile/ios/App.swift'], ['apps/mobile/ios/Inbox.xcodeproj/project.pbxproj', 'apps/mobile/ios/App/Assets.xcassets/AppIcon.appiconset/Contents.json', 'apps/mobile/android/app/build.gradle.kts', 'apps/mobile/android/app/src/main/res/values/strings.xml']]) {
      // docsOnly false: the picker decides this alone, whatever scripts/ci-docs-only.sh says.
      const p = run(paths.map((f) => ch(f, 'A')));
      expect(p.mode, paths[0]).toBe('docs');
      expect(p.tests).toEqual([]);
      expect([...p.unit.lanes, ...p.dom.lanes]).toEqual([]);
      expect(p.gates.some((d) => d.run)).toBe(false);
      expect(pathReasons(paths.map((f) => ch(f))), 'the other workflows\' gates').toEqual([]);
    }
    expect(Object.values(Object.fromEntries(decideGates('security.yml', 'subset', [], [ch('apps/mobile/ios/App.swift')]).map((d) => [d.key, d.run])))).toEqual([false, false]);
    expect(semgrepPlan('subset', [ch('apps/mobile/ios/App.swift'), ch('apps/mobile/ios/ci.sh')]), 'Semgrep still scans its shell').toMatchObject({ mode: 'files', files: ['apps/mobile/ios/ci.sh'] });
  });

  test('the app\'s files add nothing to an ordinary change, and its code files keep the ordinary rules', () => {
    expect(lanesOf(run([ch('packages/a/src.ts'), ch('apps/mobile/ios/App.swift')]))).toEqual(lanesOf(run([ch('packages/a/src.ts')])));
    // The app's own ignore file (Swift's and Xcode's build output) is one of the native kinds; one anywhere else is not.
    for (const f of ['apps/mobile/ios/App/.gitignore', 'apps/mobile/ios/InboxCore/.gitignore']) expect(nativeAppFile(f), f).toBe(true);
    for (const f of ['.gitignore', 'apps/mobile/.gitignore', 'apps/mobile/contract/.gitignore', 'apps/mobile/ios/x.gitignore.ts']) expect(nativeAppFile(f), f).toBe(false);
    for (const f of ['apps/mobile/ios/tool.ts', 'apps/mobile/ios/x.test.ts', 'apps/mobile/ios/package.json', 'apps/mobile/ios/ci.sh', 'apps/mobile/ios/tsconfig.json', 'apps/mobile/ios/bunfig.toml', 'apps/mobile/ios/tool.py', 'apps/mobile/ios/x.yml', 'apps/mobile/ios/InboxCore/Package.resolved', 'apps/mobile/android/build.sh', 'apps/mobile/android/x.json']) {
      expect(nativeAppFile(f), f).toBe(false);
    }
  });

  test('a file of another kind under the app keeps the ordinary rules: skipping is the risky direction', () => {
    expect(run([ch('apps/mobile/ios/x.sh', 'A')]).mode, 'a shell script alone').not.toBe('docs');
    expect(run([ch('apps/mobile/ios/App.swift', 'A')]).mode, 'a Swift file alone').toBe('docs');
    expect(run([ch('apps/mobile/ios/tsconfig.json')]).mode, 'a tsconfig under ios/').toBe(run([ch('packages/x/tsconfig.json')]).mode);
    expect(run([ch('apps/mobile/ios/InboxCore/Package.resolved')]).mode, 'a Swift lockfile: data, not skipped and not everything').toBe('subset');
    expect(run([ch('apps/mobile/other/Thing.swift')]).mode, 'Swift outside ios/ and the contract').toBe('all');
  });

  test('a contract file reaches only the tests that name it; generated Swift and the contract number are data', () => {
    const g = graph();
    const data = ['apps/mobile/contract/vectors/x.json', 'apps/mobile/contract/generated/swift/Wire.swift', 'apps/mobile/contract/VERSION'];
    g.graph['tests/mobile-x.test.ts'] = N([], { refs: data });
    g.files.push('tests/mobile-x.test.ts', ...data);
    for (const f of data) {
      const p = plan(g, { changes: [ch(f)], docsOnly: false });
      expect(p.mode, f).toBe('subset');
      expect(p.tests.filter((t) => t.why !== 'scanner').map((t) => t.path), f).toEqual(['tests/mobile-x.test.ts']);
    }
  });

  test('no Bun code reads the app\'s ios/ or android/ files, so dropping them from a plan skips no test', () => {
    const r = Bun.spawnSync(['git', 'grep', '-l', '-E', 'apps/mobile/(ios|android)', '--', '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', ':!scripts/ci-affected*', ':!scripts/ci-docs-only*'], { cwd: repoRoot });
    expect(r.stdout.toString().split('\n').filter(Boolean)).toEqual([]);
  });

  test('mobile-ios.yml stays apart: its own paths, a group per job, a pinned macOS, and no other workflow builds the app', () => {
    const wf = workflow('mobile-ios.yml') as Workflow & { concurrency?: unknown; on: Record<string, { paths?: string[]; branches?: string[] } | null> };
    const paths = ['apps/mobile/ios/**', 'apps/mobile/contract/generated/swift/**', '.github/workflows/mobile-ios.yml'];
    expect(wf.on.pull_request).toEqual({ branches: ['main'], paths });
    expect(wf.on.push).toEqual({ branches: ['main'], paths });
    // No workflow-wide group: a pull request's run (its job skipped or not) never cancels the nightly.
    expect(wf.concurrency).toBeUndefined();
    const jobs = wf.jobs as Record<string, Job & { 'timeout-minutes'?: number; concurrency?: unknown }>;
    expect(jobs.ios!.concurrency, 'a push cancels only its own branch\'s older run').toEqual({ group: 'mobile-ios-${{ github.ref }}', 'cancel-in-progress': true });
    expect(jobs['ios-nightly']!.concurrency, 'the nightly never cancels and is never cancelled').toEqual({ group: 'mobile-ios-nightly', 'cancel-in-progress': false });
    expect(Object.values(jobs).map((j) => j['runs-on'])).toEqual(['macos-15', 'macos-15']);
    expect(jobs.ios!['timeout-minutes']).toBe(20);
    expect(jobs['ios-nightly']!['timeout-minutes']).toBe(60);
    expect(jobs.ios!.if).toContain("vars.MOBILE_CI != 'nightly'");
    for (const file of files.filter((f) => f !== 'mobile-ios.yml')) {
      const text = readFileSync(join(WF_DIR, file), 'utf8');
      // mobile-contract.yml checks the contract's files and builds nothing.
      if (file !== 'mobile-contract.yml') expect(text, file).not.toContain('apps/mobile');
      expect(text, file).not.toMatch(/xcodebuild|swift (build|test)/);
    }
  });

  test("the contract check and the ledger's clock run only in mobile-contract.yml, never in a `bun test` or on an Inbox pull request", () => {
    // A mobile debt must never turn the Inbox's checks, main's full run or a release red: the clock is a script
    // (bun test runs only *.test.ts), one job runs it, and no test file reads the ledger's dates.
    const runners = (script: string) => files.flatMap((file) =>
      Object.entries(workflow(file).jobs).flatMap(([id, job]) => ((job.steps ?? []).some((s) => s.run?.includes(script)) ? [`${file} ${id}`] : [])),
    );
    expect(runners('parity-debts')).toEqual(['mobile-contract.yml ledger']);
    expect(runners('scripts/mobile/check.ts')).toEqual(['mobile-contract.yml contract']);
    const wf = workflow('mobile-contract.yml') as Workflow & { on: Record<string, { paths?: string[]; branches?: string[] } | null> };
    expect(wf.jobs.ledger!.steps!.map((s) => s.run).filter(Boolean)).toEqual(['bun scripts/mobile/parity-debts.ts']);
    expect(Object.values(wf.jobs).map((j) => j['runs-on'])).toEqual(['ubuntu-24.04', 'ubuntu-24.04']);
    expect(wf.on.pull_request).toEqual({ branches: ['main'], paths: ['apps/mobile/contract/**', 'scripts/mobile/**', '.github/workflows/mobile-contract.yml'] });
    const testFiles = tracked.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$|_(test|spec)\.[cm]?[jt]sx?$/.test(f));
    expect(testFiles.filter((f) => f.includes('debts'))).toEqual(['tests/mobile-parity-debts.test.ts']);
    expect(readFileSync(join(repoRoot, 'tests/mobile-parity-debts.test.ts'), 'utf8')).not.toContain('ledger.json');
  });

  test('an Inbox pull request starts no mobile job, and a ledger row starts no macOS build', () => {
    const started = (changed: string[], pick: (file: string, job: Job) => boolean) => files.flatMap((file) => {
      const wf = workflow(file);
      const pr = wf.on.pull_request;
      if (pr === undefined) return [];
      const paths = pr?.paths;
      if (paths && !changed.some((f) => paths.some((g) => new Bun.Glob(g).match(f)))) return [];
      return Object.entries(wf.jobs).flatMap(([id, job]) => (pick(file, job) ? [`${file} ${id}`] : []));
    });
    // A new route module is added to ROUTE_FILES in inbox-window-routes.ts (an invented module stands for it).
    const inbox = ['packages/server/inbox.ts', 'packages/core/inbox-types.ts', 'packages/inbox/api.ts', 'packages/inbox/components/Thread.tsx', 'packages/server/inbox-window-routes.ts', 'packages/server/inbox-new-route.ts', 'docs/agent-guides/server-and-storage.md'];
    const mobile = (file: string, job: Job) => file.startsWith('mobile-') || String(job['runs-on'] ?? '').includes('macos');
    expect(started(inbox, mobile), 'an Inbox-only pull request').toEqual([]);
    // Nor does any other workflow run a mobile script (a `bun scripts/mobile/all.ts --check` step in test.yml, say).
    const runsMobile = files.filter((f) => !f.startsWith('mobile-')).flatMap((file) =>
      Object.entries(workflow(file).jobs).flatMap(([id, job]) => (job.steps ?? []).filter((st) => st.run?.includes('scripts/mobile/')).map(() => `${file} ${id}`)),
    );
    expect(runsMobile, 'a workflow other than mobile-*.yml running scripts/mobile/').toEqual([]);
    const macos = (_: string, job: Job) => String(job['runs-on'] ?? '').includes('macos');
    expect(started(['apps/mobile/contract/parity/ledger.json', 'apps/mobile/contract/parity/surface.json', ...inbox], macos), 'a ledger row').toEqual([]);
  });
});

describe('the Inbox\'s tests and the mobile contract', () => {
  /**
   * The only scripts/mobile/ modules a test may import, each with why. Each imports nothing but node: builtins and
   * the others here, so no Inbox change can break a test through it. Everything else there (the generators, door.ts,
   * schema.ts, words.ts, ledger.ts, rules.ts, check.ts) reads the live product against tables only the mobile scripts
   * keep: that is scripts/mobile/check.ts's, in the mobile-contract workflow.
   */
  const ALLOWED: Record<string, string> = {
    'scripts/mobile/lib.ts': "paths, JSON text and emit, which a test runs on a temp folder",
    'scripts/mobile/tokens.ts': 'the color conversions, on fixed values (its CSS read is buildTokens, which a test never calls)',
    'scripts/mobile/parity.ts': 'the ledger rules, on fixed ledgers',
    'scripts/mobile/parity-debts.ts': 'the clock, on fixed dates',
    'scripts/mobile/flows.ts': 'the list of flow files: tests/mobile-flows.test.ts checks their citation form, and only a mobile pull request edits a flow',
  };
  /** What a test that imports one of them must not call: a generator or builder, a contract path, a read of the checkout, a check of committed files. */
  const LIVE = /\b(generate|build)[A-Z]\w*\(|\bOUT\.|VERSION_FILE|STREAM_FIXTURE|STREAM_VECTORS|readRepoText\(|emit\((?:[^()]|\([^()]*\))*,\s*true\s*\)/;
  const transpilers = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }), js: new Bun.Transpiler({ loader: 'js' }) };
  const transpiler = (f: string) => (f.endsWith('.tsx') ? transpilers.tsx : /\.[cm]?ts$/.test(f) ? transpilers.ts : transpilers.js);
  const trackedSet = new Set(tracked);
  const code = (f: string) => readFileSync(join(repoRoot, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  /** The repository files a file imports by a relative path. */
  const importsOf = (f: string) => transpiler(f).scanImports(readFileSync(join(repoRoot, f), 'utf8')).flatMap(({ path }) => {
    if (!path.startsWith('.')) return [path];
    const base = relative(repoRoot, resolve(repoRoot, dirname(f), path));
    return [['', '.ts', '.tsx', '/index.ts'].map((x) => base + x).find((c) => trackedSet.has(c)) ?? base];
  });
  const testFiles = tracked.filter((f) => /\.test\.[cm]?[jt]sx?$/.test(f));

  test('a test imports from scripts/mobile/ only the modules that read nothing of the product, and reads no contract file', () => {
    const reaching = testFiles.flatMap((f) => importsOf(f).filter((i) => i.startsWith('scripts/mobile/') && !(i in ALLOWED)).map((i) => `${f} imports ${i}`));
    expect(reaching).toEqual([]);
    for (const [module] of Object.entries(ALLOWED)) {
      expect(importsOf(module).filter((i) => !i.startsWith('node:') && !(i in ALLOWED)), `${module} imports only node: and the allowed modules`).toEqual([]);
    }
    const users = testFiles.filter((f) => importsOf(f).some((i) => i in ALLOWED));
    expect(users.filter((f) => LIVE.test(code(f))), 'a test calling a generator or reading a contract file through the allowed modules').toEqual([]);
    // The picker's own tests name contract paths as changes to plan, never read them.
    const picker = (f: string) => /^scripts\/ci-[\w-]+\.test\.ts$/.test(f);
    expect(testFiles.filter((f) => !picker(f) && code(f).includes('apps/mobile/contract/')), 'a test naming a contract file').toEqual([]);
  });

  test('the guard sees what it guards: a forbidden import, a generator call and a check of committed files', () => {
    expect(LIVE.test("expect(emit(generateDoor(), true)).toEqual([])")).toBe(true);
    expect(LIVE.test("emit(outputs, true, dir)")).toBe(false);
    expect(LIVE.test("readRepoText(OUT.schema)")).toBe(true);
    expect(importsOf('tests/mobile-parity.test.ts')).toContain('scripts/mobile/parity.ts');
  });
});

describe('paths built from parts', () => {
  const repo = '/r';
  const files = new Set(['packages/review-editor/App.tsx', 'packages/shared/inbox/connection.ts', 'packages/ui/themes/dark.css', 'packages/ui/themes/light.css', 'packages/x/a/package.json', 'packages/x/b/package.json', 'tests/fixtures/x.ts']);
  const refs = (code: string, at = '/r/packages/review-editor/utils/pin.test.ts', trace?: PathRead[]) => builtPathRefs(code, at, repo, files, trace).sort();

  test('a join or resolve of literal segments from the file, the repo root or a local binding', () => {
    expect(refs("readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf8')"), 'the source pin').toEqual(['packages/review-editor/App.tsx']);
    expect(refs("const ROOT = resolve(import.meta.dir, '../../..');\nconst x = join(ROOT, 'packages', 'shared', 'inbox', 'connection.ts');"), 'a ROOT binding').toEqual(['packages/shared/inbox/connection.ts']);
    expect(refs("contract(join(import.meta.dir, '..', '..', 'shared', 'inbox', 'connection.ts'))"), 'the drift guard').toEqual(['packages/shared/inbox/connection.ts']);
    expect(refs("const f = join(someDir(), 'packages', 'shared', 'inbox', 'connection.ts')"), 'a base it cannot tell: from the repo root').toEqual(['packages/shared/inbox/connection.ts']);
  });

  test('new URL, a template, a folder joined with one of the file\'s own names', () => {
    expect(refs("readFile(new URL('../App.tsx', import.meta.url))")).toEqual(['packages/review-editor/App.tsx']);
    expect(refs("const R = resolve(import.meta.dir, '../../..'); const p = `${R}/packages/review-editor/App.tsx`")).toEqual(['packages/review-editor/App.tsx']);
    expect(refs("const T = join(import.meta.dir, '../../ui/themes');\nfor (const f of ['dark.css', 'light.css']) readFileSync(join(T, f))")).toEqual(['packages/ui/themes/dark.css', 'packages/ui/themes/light.css']);
    expect(refs("const P = resolve(import.meta.dir, '../../x');\nfor (const id of ids) readFileSync(join(P, id, 'package.json'))")).toEqual(['packages/x/a/package.json', 'packages/x/b/package.json']);
  });

  test('a read of the checkout by a path it cannot tell is flagged; a read of a temp folder is not', () => {
    const trace: PathRead[] = [];
    refs("const ROOT = resolve(import.meta.dir, '..');\nfunction read(name: string) { return readFileSync(join(ROOT, name), 'utf8'); }", undefined, trace);
    expect(trace.some((r) => r.fn === 'readFileSync' && r.checkout)).toBe(true);
    const scratch: PathRead[] = [];
    refs("const dir = mkdtempSync(join(tmpdir(), 'x-'));\nreadFileSync(join(dir, name))", undefined, scratch);
    expect(scratch.some((r) => r.checkout)).toBe(false);
  });
});

describe('tree-scanning tests', () => {
  test('a listing of the checkout, or of a folder it cannot trace, makes a scanner; a listing of a temp folder does not', () => {
    expect(listsCheckout("const files = Bun.spawnSync(['git', 'ls-files'])")).toBe(true);
    expect(listsCheckout("readdirSync(join(import.meta.dir, 'fixtures'))")).toBe(true);
    expect(listsCheckout('function walk(dir: string) { for (const e of readdirSync(dir)) {} }'), 'a parameter').toBe(true);
    expect(listsCheckout("const root = mkdtempSync(join(tmpdir(), 'x'));\nconst pids = join(root, 'pids');\nreaddirSync(pids)")).toBe(false);
    expect(listsCheckout("let dir: string | null = null;\nbeforeEach(() => { dir = mkdtempSync('/tmp/x'); });\nreaddirSync(join(dir!, 'data'))")).toBe(false);
    expect(listsCheckout("expect(readdirSync(join(w.dataDir, 'inbox'))).toEqual([])")).toBe(false);
  });
});

describe('gates', () => {
  const runs = (wf: string, changes: Change[], mode: 'subset' | 'all' | 'docs' = 'subset', reasons: string[] = [], g?: Graph) =>
    Object.fromEntries(decideGates(wf, mode, reasons, changes, undefined, g).map((d) => [d.key, d.run]));

  test('the smoke runs for what the binary is built from, and skips the rest', () => {
    const bin: Graph = { files: [], graph: { [SMOKE_ROOTS[0]!]: N(['apps/hook/server/cli.ts']), 'apps/hook/server/cli.ts': N(['packages/server/vcs.ts']) } };
    expect(runs('browser-smoke.yml', [ch('packages/server/vcs.ts')], 'subset', [], bin).smoke, 'in the closure of the binary entry').toBe(true);
    expect(runs('browser-smoke.yml', [ch('packages/inbox/x.tsx')], 'subset', [], bin).smoke, "inbox-e2e.yml's list").toBe(true);
    expect(runs('browser-smoke.yml', [ch('apps/marketing/src/x.astro')], 'subset', [], bin).smoke).toBe(false);
    expect(runs('browser-smoke.yml', [ch('apps/marketing/src/x.astro')]).smoke, 'no graph to check: it runs').toBe(true);
  });

  test('fast-tier gates all run on a run-everything change; Windows only for its own paths and its fail-safe', () => {
    const helper = [ch('tests/helpers/x.ts')];
    expect(Object.values(runs('security.yml', helper, 'all', ['helper']))).toEqual([true, true]);
    expect(Object.values(runs('windows.yml', helper, 'all', ['helper'])).some(Boolean)).toBe(false);
    expect(Object.values(runs('windows.yml', [ch('bun.lock')], 'all', ['lockfile'])).every(Boolean)).toBe(true);
    expect(Object.values(runs('windows.yml', [], 'all', ['not a pull_request run'])).every(Boolean)).toBe(true);
    const win = runs('windows.yml', [ch('scripts/install.cmd')]);
    expect(win.install_cmd && win.qwen && win.uninstall).toBe(true);
    expect(win.install_ps1 || win.diagram_engine || win.pi_runtime).toBe(false);
  });

  test('Trivy and zizmor run for .github, Trivy also for a manifest', () => {
    expect(runs('security.yml', [ch('.github/dependabot.yml')])).toEqual({ trivy: true, zizmor: true });
    expect(runs('security.yml', [ch('apps/x/package.json')])).toEqual({ trivy: true, zizmor: false });
    expect(runs('security.yml', [ch('packages/shared/call-flow-runtime/x/package-lock.json')]).trivy, 'a lockfile Trivy reads').toBe(true);
    expect(runs('security.yml', [ch('packages/a/src.ts')])).toEqual({ trivy: false, zizmor: false });
  });

  test('Semgrep scans the changed files it reads, everything on its config or a doubt, nothing for docs', () => {
    expect(semgrepPlan('subset', [ch('packages/a/src.ts'), ch('packages/a/x.css'), ch('packages/a/gone.ts', 'D')])).toMatchObject({ mode: 'files', files: ['packages/a/src.ts'] });
    expect(semgrepPlan('subset', [ch('packages/a/x.css')]).mode).toBe('skip');
    expect(semgrepPlan('subset', [ch('.semgrep.yml')]).mode).toBe('full');
    expect(semgrepPlan('subset', [ch('packages/a/we ird.ts')]).mode).toBe('full');
    expect(semgrepPlan('all', []).mode).toBe('full');
    expect(semgrepPlan('docs', [ch('README.md')]).mode).toBe('skip');
  });
});

describe('a push to main', () => {
  const RUN = 500;
  const sha = (c: string) => c.repeat(40);

  test("its base is the newest passed main run older than this one, as deploy.yml's BEFORE_SHA; anything else is no base", () => {
    const runs = { workflow_runs: [{ id: 700, head_sha: sha('c') }, { id: RUN, head_sha: sha('b') }, { id: 420, head_sha: sha('a') }, { id: 300, head_sha: sha('9') }] };
    expect(lastPassedSha(runs, RUN), 'a newer run and this one are left out').toBe(sha('a'));
    expect(lastPassedSha({ workflow_runs: [{ id: 700, head_sha: sha('c') }] }, RUN), 'the first run on main').toBeNull();
    expect(lastPassedSha({ workflow_runs: [{ id: 400, head_sha: 'main' }] }, RUN), 'not a commit id').toBeNull();
    for (const odd of [null, {}, { workflow_runs: 'x' }, { message: 'Bad credentials' }]) expect(lastPassedSha(odd, RUN)).toBeNull();
    // deploy.yml reads the same list and takes the same run, so the plan starts where the last deploy came from.
    const deploy = readFileSync(join(WF_DIR, 'deploy.yml'), 'utf8');
    expect(deploy).toContain(`repos/\${REPOSITORY}/${PASSED_MAIN_RUNS}`);
    expect(deploy).toContain('BEFORE_SHA="$(jq -r "[.workflow_runs[] | select(.id < ${TEST_RUN_ID})] | first | .head_sha // empty" <<< "$RUNS")"');
  });

  test('only the marketing site, the docs and root Markdown are light; product code, skills, workflows and manifests are not', () => {
    for (const f of ['apps/marketing/src/styles/spaces/page.css', 'apps/marketing/src/pages/index.astro', 'apps/marketing/public/assets/x.png', 'docs/agent-guides/inbox.md', 'adr/0001-x.md', 'README.md', 'AGENTS.md', 'LICENSE-MIT', '.github/assets/shot.png', 'apps/mobile/ios/App.swift']) {
      expect(pushLight(f), f).toBe(true);
    }
    for (const f of ['packages/server/inbox.ts', 'apps/hook/server/index.ts', 'apps/skills/core/plannotator/SKILL.md', 'apps/opencode-plugin/commands/plannotator-review.md', 'packages/ui/README.md', '.github/workflows/test.yml', 'bun.lock', 'package.json', 'scripts/ci-affected.ts', 'apps/portal/index.html', 'apps/mobile/ios/ci.sh']) {
      expect(pushLight(f), f).toBe(false);
    }
  });

  test('a site file the product fetches at runtime is never light, so a picker miss cannot reach people through a light push', () => {
    for (const f of [
      'apps/marketing/public/assets/icon-sets/v1/index.json', 'apps/marketing/public/assets/decisions/v1/banner-dark.png',
      'apps/marketing/public/assets/hosted/personal-agents-b-light.webp', 'apps/marketing/public/assets/inbox-film-poster.jpg',
      'apps/marketing/public/assets/ask-this-session-poster.jpg', 'apps/marketing/public/assets/tui-herdr-lite-poster.jpg',
      'apps/marketing/src/lib/inbox-cloud-agent.md', 'apps/marketing/src/lib/inbox-muse.md', 'apps/marketing/src/pages/[inbox]/muse.md.ts',
    ]) expect(pushLight(f), f).toBe(false);
    // Every plannotator.ai asset or agent page the shipped code names maps to a path that is not light
    // (a new one fails here until PUSH_RUNTIME_SITE covers it). `${MEDIA_BASE_URL}/x` is the announcement dialogs' form.
    const lines = Bun.spawnSync(['git', 'grep', '-h', '-E', 'https://plannotator\\.ai/(assets|inbox/[A-Za-z0-9-]+\\.md)|MEDIA_BASE_URL\\}/', '--', 'packages', 'apps', ':!apps/marketing', ':!*.test.*', ':!**/test/**', ':!**/tests/**'], { cwd: repoRoot }).stdout.toString();
    const paths = new Set<string>();
    for (const m of lines.matchAll(/https:\/\/plannotator\.ai\/assets\/([^"'`\s$]+)/g)) paths.add(`apps/marketing/public/assets/${m[1]}`);
    for (const m of lines.matchAll(/MEDIA_BASE_URL\}\/([^"'`\s]+)/g)) paths.add(`apps/marketing/public/assets/${m[1]}`);
    for (const m of lines.matchAll(/https:\/\/plannotator\.ai\/inbox\/([A-Za-z0-9-]+)\.md/g)) paths.add(`apps/marketing/src/lib/inbox-${m[1]}.md`).add(`apps/marketing/src/pages/[inbox]/${m[1]}.md.ts`);
    expect(paths.size).toBeGreaterThan(5);
    expect([...paths].filter((p) => pushLight(p))).toEqual([]);
  });

  // A throwaway main with history: base (code, site, docs), then the pushes.
  const dir = mkdtempSync(join(tmpdir(), 'ci-affected-push-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@example.invalid' };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: dir, env: gitEnv });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };
  let writes = 0;
  const commit = (...files: string[]) => {
    for (const f of files) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), `${f} ${writes++}\n`); }
    git('add', '-A');
    git('commit', '-q', '-m', files.join(' '));
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const base = commit('packages/server/x.ts', 'apps/marketing/src/styles/page.css', 'docs/guide.md', 'README.md');
  const site = commit('apps/marketing/src/styles/page.css');
  const code = commit('packages/server/x.ts');
  const site2 = commit('apps/marketing/src/styles/page.css');
  const docs = commit('README.md', 'docs/guide.md');

  /** The plan's view of a push of HEAD, with main's passed runs and the compare answer faked (no network, no gh). */
  const at = async (head: string, passed: string | null, opts: { env?: Record<string, string>; compare?: string; fails?: boolean } = {}) => {
    git('checkout', '-q', '--detach', head);
    const calls: string[] = [];
    const api: RepoApi = async (p) => {
      calls.push(p);
      if (opts.fails) throw new Error('GitHub API 502');
      if (p === PASSED_MAIN_RUNS) return { workflow_runs: [{ id: RUN + 1, head_sha: head }, ...(passed ? [{ id: RUN - 1, head_sha: passed }] : [])] };
      const [from, to] = p.replace(/^compare\//, '').split('...');
      if (opts.compare) return { status: opts.compare };
      return { status: from === to ? 'identical' : Bun.spawnSync(['git', 'merge-base', '--is-ancestor', from!, to!], { cwd: dir }).exitCode === 0 ? 'ahead' : 'behind' };
    };
    const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: String(RUN), ...opts.env } as NodeJS.ProcessEnv;
    return { got: await pushChanges(env, api, dir), calls };
  };

  test('a site-only range plans from the last passed commit, over every commit since, never just the parent', async () => {
    const one = (await at(site, base)).got;
    expect(one).toMatchObject({ base, docsOnly: false, changes: [{ status: 'M', path: 'apps/marketing/src/styles/page.css' }] });
    // site2's parent is code: a run that diffed from the parent would skip code's tests if code's own run was replaced.
    const replaced = (await at(site2, site)).got;
    expect('why' in replaced && replaced.why).toContain('packages/server/x.ts');
    expect((await at(site2, code)).got).toMatchObject({ base: code, changes: [{ path: 'apps/marketing/src/styles/page.css' }] });
    expect((await at(docs, site2)).got, 'docs only').toMatchObject({ docsOnly: true });
  });

  test('a code range runs everything, whichever commit holds the code', async () => {
    for (const [head, passed] of [[code, site], [code, base], [site2, base], [docs, site]] as const) {
      const got = (await at(head, passed)).got;
      expect('why' in got && got.why, `${head.slice(0, 7)} from ${passed.slice(0, 7)}`).toContain('change more than the site and docs (packages/server/x.ts)');
    }
  });

  test('no base, an API error, a rewritten history, CI_AFFECTED=off or another branch runs everything', async () => {
    const why = async (...args: Parameters<typeof at>) => { const got = (await at(...args)).got; return 'why' in got ? got.why : 'planned'; };
    expect(await why(site, null)).toContain('no earlier passed Test run');
    expect(await why(site, base, { fails: true })).toContain('could not be read: GitHub API 502');
    expect(await why(site, base, { compare: 'diverged' })).toContain('diverged');
    expect(await why(site, site), 'the same commit again: an empty range').toContain('identical');
    expect(await why(site, base, { env: { CI_AFFECTED: 'off' } })).toBe('the repo variable CI_AFFECTED is off');
    expect(await why(site, base, { env: { GITHUB_REF: 'refs/heads/other' } })).toContain('not a pull_request run or a push to main');
    expect(await why(site, base, { env: { GITHUB_RUN_ID: '' } })).toContain('without a run id');
    expect((await at(site, base, { env: { CI_AFFECTED: 'off' } })).calls, 'off asks nothing').toEqual([]);
  });

  test('a light range still gets every safety valve of the plan', () => {
    // pushChanges only lets the range through; plan() still runs everything on a manifest, a tsconfig or deleted code there.
    expect(run([ch('apps/marketing/package.json', 'M', ['"astro": "6"'], ['"astro": "5"'])]).mode).toBe('all');
    expect(run([ch('apps/marketing/tsconfig.json')]).mode).toBe('all');
    expect(run([ch('apps/marketing/src/lib/x.ts', 'D')]).mode).toBe('all');
  });

  test('the plan job reads runs with a read-only token, handed only to the picker and only on a push', () => {
    const job = workflow('test.yml').jobs.plan! as Job & { permissions?: Record<string, string> };
    expect(job.permissions).toEqual({ contents: 'read', actions: 'read' });
    const picker = job.steps!.find((s) => s.run?.includes('ci-affected.ts')) as Step & { env?: Record<string, string> };
    expect(picker.env?.GH_TOKEN).toBe("${{ github.event_name == 'push' && github.token || '' }}");
    for (const s of job.steps!) if (s !== picker) expect(JSON.stringify(s), s.name ?? s.run).not.toContain('github.token');
  });
});

// The real graph of this checkout: needs `bun install` and vendor.sh (the Checks job runs both first).
describe('the real graph', () => {
  const generated = existsSync(join(repoRoot, 'apps/pi-extension/generated'));
  const g = buildGraph();

  test('a change to a source file picks the test files that import it', () => {
    const p = plan(g, { changes: [ch('packages/ui/hooks/useFileBrowser.ts')], docsOnly: false });
    expect(p.mode).toBe('subset');
    expect(p.tests.map((t) => t.path)).toContain('packages/ui/hooks/useFileBrowser.test.tsx');
    expect(p.gates.find((d) => d.key === 'file_browser')!.run).toBe(true);
  });

  test.skipIf(!generated)("a change to vendored source reaches Pi's tests through the generated copy", () => {
    const copy = g.files.find((f) => f.startsWith('apps/pi-extension/generated/') && g.graph[f]?.vendored)!;
    const source = g.graph[copy]!.vendored!;
    const p = plan(g, { changes: [ch(source)], docsOnly: false });
    expect(p.tests.some((t) => t.path.startsWith('apps/pi-extension/') && t.via === source), `${source} via ${copy}`).toBe(true);
  });

  test("the drift, parity and source-pin guards run for the file they read by a built path (the reviewer's misses)", () => {
    const cases: [string, string[]][] = [
      ['packages/review-editor/App.tsx', ['packages/review-editor/utils/autoViewedCallSites.test.ts', 'packages/review-editor/utils/codeNavHoverHandoff.test.ts', 'packages/review-editor/utils/decisionDraftGeneration.test.ts']],
      ['packages/shared/inbox/connection.ts', ['apps/hook/hooks/mod/inbox-contract.test.ts']],
      ['packages/shared/plannotator-tool.ts', ['apps/hook/hooks/mod/tool.test.ts']],
      ['packages/system/src/react.ts', ['packages/system/test/browser-safe.test.ts']],
      ['apps/amp-plugin/plannotator.ts', ['tests/data-dir-mirrors.test.ts']],
      ['apps/vscode-extension/src/guides/mcp/relay-script.ts', ['apps/vscode-extension/src/guides/ask/session.test.ts', 'apps/vscode-extension/src/guides/generation.test.ts', 'apps/vscode-extension/src/guides/vscode/asks.test.ts']],
      ['packages/shared/config.ts', ['scripts/install.test.ts']],
      ['packages/t3-code/hook.ts', ['scripts/install.test.ts']],
    ];
    for (const [source, tests] of cases) {
      const p = plan(g, { changes: [ch(source)], docsOnly: false });
      expect(p.mode, source).toBe('subset');
      for (const t of tests) expect(p.tests.map((x) => x.path), `${source} -> ${t}`).toContain(t);
    }
  });

  test('a deleted fixture, command or skill reaches the tests that name it', () => {
    const cases: [string, string][] = [
      ['apps/guides-show/build/fallback-viewer-pin.json', 'apps/guides-show/build/fallback-viewer-pin.test.ts'],
      ['apps/opencode-plugin/commands/plannotator-review.md', 'apps/opencode-plugin/postinstall.test.ts'],
      ['apps/skills/core/plannotator/SKILL.md', 'apps/pi-extension/bundled-skill.test.ts'],
    ];
    for (const [gone, t] of cases) expect(plan(g, { changes: [ch(gone, 'D')], docsOnly: false }).tests.map((x) => x.path), gone).toContain(t);
  });

  test("what a test preload loads runs everything; the smoke runs for the binary entry's own imports", () => {
    expect(preloadClosure(g)).toContain('packages/shared/data-dir.ts');
    expect(plan(g, { changes: [ch('packages/shared/data-dir.ts')], docsOnly: false }).mode).toBe('all');
    const smoke = (path: string) => decideGates('browser-smoke.yml', 'subset', [], [ch(path)], undefined, g)[0]!.run;
    expect(smoke('apps/hook/server/cli.ts')).toBe(true);
    expect(smoke('apps/marketing/src/pages/index.astro')).toBe(false);
  });

  test('an ordinary Inbox change plans exactly as before beside an app change; an app change alone plans nothing', () => {
    const keep = (p: ReturnType<typeof plan>) => ({ mode: p.mode, tests: p.tests, unit: p.unit, dom: p.dom, gates: p.gates });
    const inbox = plan(g, { changes: [ch('packages/core/inbox-types.ts')], docsOnly: false });
    expect(inbox.mode).toBe('subset');
    expect(keep(plan(g, { changes: [ch('packages/core/inbox-types.ts'), ch('apps/mobile/ios/App.swift', 'A')], docsOnly: false }))).toEqual(keep(inbox));
    const app = plan(g, { changes: [ch('apps/mobile/ios/App.swift', 'A')], docsOnly: false });
    expect([app.mode, app.tests.length, app.unit.lanes.length, app.dom.lanes.length]).toEqual(['docs', 0, 0, 0]);
  });

  test("no mobile test runs for a wire change, the window's code or the shared UI's (the contract's check is the mobile-contract workflow)", () => {
    // Picked at all: a tree-scanning mobile test would run on every pull request. tests/mobile-flows.test.ts may run
    // (the flows name the window's files it cites), but it reads only the flow files, which only a mobile PR edits.
    const picks = (path: string) => plan(g, { changes: [ch(path)], docsOnly: false }).tests.filter((t) => t.path.startsWith('tests/mobile-') && t.path !== 'tests/mobile-flows.test.ts').map((t) => t.path);
    for (const changed of ['packages/core/inbox-wire-models.ts', 'packages/core/inbox-types.ts', 'packages/core/inbox-scheduled-types.ts', 'packages/server/inbox-devices.ts', 'packages/core/inbox-delivery-line.ts', 'packages/inbox/api.ts', 'packages/inbox/sharedEvents.ts', 'packages/inbox/components/Thread.tsx', 'packages/ui/components/Viewer.tsx']) {
      expect(picks(changed), changed).toEqual([]);
    }
  });

  test('a site-only push plans the light set: no full lane, no OpenCode 2 package, no mod harness, no UI smoke', () => {
    const p = plan(g, { changes: [ch('apps/marketing/src/styles/spaces/page.css')], docsOnly: false });
    expect(p.mode).toBe('subset');
    expect(p.unit.files.length).toBeLessThan(p.total / 5);
    expect(p.unit.lanes.every((l) => l.startsWith('unit-')), 'no heavy lane').toBe(true);
    expect(p.gates.filter((d) => d.run).map((d) => d.key)).toEqual([]);
  });

  test('the tree-scanning set includes the guards that read the whole tree', () => {
    const p = plan(g, { changes: [ch('README.md')], docsOnly: false });
    const scanners = p.tests.filter((t) => t.why === 'scanner').map((t) => t.path);
    expect(scanners).toContain('scripts/dom-test-allowlist.test.ts');
    expect(scanners.length).toBeLessThan(p.total / 5);
  });
});
