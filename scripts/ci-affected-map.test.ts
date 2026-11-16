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
 *    picked files.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORE_GUARDS, GATES, GATE_JOB, HEAVY_FAIL_SAFE, JOB_MAP, KNOWN_TOP, RUN_ALL, buildGraph, ciChanges, decideGates, gatePaths, knownKind, listsCheckout, plan,
  repoRoot, semgrepPlan, type Change, type Graph, type Node,
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
          expect(wf.on.pull_request, file).toBeUndefined();
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
      ...['release.yml', 'inbox-pi.yml', 'inbox-claude-code.yml', 'relay.yml'].flatMap((f) => workflow(f).on.pull_request?.paths ?? []),
    ]);
    const dead = [...globs].filter((g) => !tracked.some((f) => new Bun.Glob(g).match(f)));
    // The picker is in the tree once this lands; until then the guard runs from a branch.
    expect(dead.filter((g) => g !== 'scripts/ci-affected.ts')).toEqual([]);
  });

  test('every tracked top-level entry and every tracked file kind is known to the picker', () => {
    expect([...new Set(tracked.map((f) => f.split('/')[0]!))].filter((t) => !KNOWN_TOP.includes(t))).toEqual([]);
    expect(tracked.filter((f) => !knownKind(f))).toEqual([]);
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
    const docs = at({ GITHUB_EVENT_NAME: 'workflow_dispatch', CI_AFFECTED_AS_IF: 'README.md' });
    expect(docs).toMatchObject({ docsOnly: true, preview: true, changes: [{ status: 'M', path: 'README.md' }] });
    const code = at({ GITHUB_EVENT_NAME: 'workflow_dispatch', CI_AFFECTED_AS_IF: ' scripts/ci-test-lane.ts  packages/none/gone.ts ' });
    expect(code).toMatchObject({ docsOnly: false, changes: [{ status: 'M', path: 'scripts/ci-test-lane.ts' }, { status: 'D', path: 'packages/none/gone.ts' }] });
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
  const runs = (wf: string, changes: Change[], mode: 'subset' | 'all' | 'docs' = 'subset', reasons: string[] = []) =>
    Object.fromEntries(decideGates(wf, mode, reasons, changes).map((d) => [d.key, d.run]));

  test('the smoke runs for what the binary is built from, and skips the rest', () => {
    expect(runs('browser-smoke.yml', [ch('packages/inbox/x.tsx')]).smoke).toBe(true);
    expect(runs('browser-smoke.yml', [ch('apps/marketing/src/x.astro')]).smoke).toBe(false);
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

  test('the tree-scanning set includes the guards that read the whole tree', () => {
    const p = plan(g, { changes: [ch('README.md')], docsOnly: false });
    const scanners = p.tests.filter((t) => t.why === 'scanner').map((t) => t.path);
    expect(scanners).toContain('scripts/dom-test-allowlist.test.ts');
    expect(scanners.length).toBeLessThan(p.total / 5);
  });
});
