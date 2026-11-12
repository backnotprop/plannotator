import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BUMP_FILES,
  FEEDBACK_INDEX_FILE,
  FEEDBACK_INDEX_TEST,
  JSON_VERSION_FILES,
  MARKETPLACE_FILE,
  OPENPACKAGE_FILE,
  decide,
  outputs,
  type Deps,
} from './release-test-reuse';

const REPO = 'owner/repo';
const ENV = { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: REPO, GITHUB_REF: 'refs/tags/v1.0.1' };

let repo = '';
const scratchDirs: string[] = [];
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
const savedSystem = process.env.GIT_CONFIG_NOSYSTEM;
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterAll(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  if (savedSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = savedSystem;
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const spawnGit = (args: string[]) =>
  Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, stdin: 'ignore' });
const git = (...args: string[]) => {
  const r = spawnGit(args);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
const commit = (files: Record<string, string | null>, message: string) => {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) {
      git('rm', '-q', file);
      continue;
    }
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD').trim();
};

const pkg = (version: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ name: 'p', version, ...extra }, null, 2)}\n`;
const marketplace = (version: string, description = 'Copilot') =>
  `${JSON.stringify({ name: 'plannotator', plugins: [{ name: 'plannotator-copilot', description, version }] }, null, 2)}\n`;
const openpackage = (version: string, description = 'Plans') => `name: plannotator\nversion: ${version}\ndescription: ${description}\n`;
const index = (titles: string[]) => `${JSON.stringify({ features: [], links: titles.map((title, i) => ({ title, path: `issues/${i + 1}` })) }, null, 1)}\n`;

const bumpFiles = (version: string, indexTitles = ['a']): Record<string, string> => ({
  ...Object.fromEntries(JSON_VERSION_FILES.map((f) => [f, pkg(version)])),
  [MARKETPLACE_FILE]: marketplace(version),
  [OPENPACKAGE_FILE]: openpackage(version),
  [FEEDBACK_INDEX_FILE]: index(indexTitles),
});

const fresh = () => {
  repo = mkdtempSync(join(tmpdir(), 'release-test-reuse-'));
  scratchDirs.push(repo);
  git('init', '-q');
  return commit({ ...bumpFiles('1.0.0'), 'src/a.ts': 'export const a = 1;\n' }, 'base');
};

type FakeRun = Record<string, unknown>;
const passedRun = (id: number, sha: string, over: FakeRun = {}): FakeRun => ({
  id,
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  path: '.github/workflows/test.yml',
  head_repository: { full_name: REPO },
  ...over,
});

const deps = (runs: FakeRun[] | Error, calls: string[] = []): Deps => ({
  git: (args) => git(...args),
  gitCode: (args) => spawnGit(args).exitCode ?? -1,
  api: (path) => {
    calls.push(path);
    if (runs instanceof Error) throw runs;
    return { workflow_runs: runs };
  },
});

describe('a version-only tag reuses the nearest passed Test run on main', () => {
  test('a full bump (10 version files, the search index, release notes) on a passed commit is reused', () => {
    const base = fresh();
    const mid = commit({ 'src/a.ts': 'export const a = 2;\n' }, 'feature');
    commit({ ...bumpFiles('1.0.1', ['a', 'b']), 'RELEASE_NOTES_v1.0.1.md': '# notes\n' }, 'chore: bump version to 1.0.1');
    const calls: string[] = [];
    const d = decide(ENV, deps([passedRun(20, mid), passedRun(10, base)], calls));
    expect(d.reuse).toBe(true);
    expect(d.run).toEqual({ id: 20, url: `https://github.com/${REPO}/actions/runs/20`, sha: mid });
    expect(d.indexChanged).toBe(true);
    expect(outputs(d)).toBe('reuse=true\nindex-changed=true\n');
    expect(calls).toEqual([`repos/${REPO}/actions/workflows/test.yml/runs?branch=main&event=push&status=success&per_page=100`]);
  });

  test('the tag on the very commit Test passed is reused, and an unchanged index runs no index test', () => {
    fresh();
    const bump = commit(bumpFiles('1.0.1'), 'bump');
    const d = decide(ENV, deps([passedRun(5, bump)]));
    expect(d).toMatchObject({ reuse: true, indexChanged: false, run: { sha: bump } });
  });

  test('the nearest ancestor wins even when an older commit has the newer run (a rerun)', () => {
    const base = fresh();
    const mid = commit({ 'src/a.ts': 'export const a = 2;\n' }, 'feature');
    commit(bumpFiles('1.0.1'), 'bump');
    expect(decide(ENV, deps([passedRun(30, base), passedRun(20, mid)])).run?.sha).toBe(mid);
  });

  test('a manual run on the tag reuses too', () => {
    fresh();
    const bump = commit(bumpFiles('1.0.1'), 'bump');
    expect(decide({ ...ENV, GITHUB_EVENT_NAME: 'workflow_dispatch' }, deps([passedRun(5, bump)])).reuse).toBe(true);
  });
});

describe('anything else runs the full tests', () => {
  const withExtra = (extra: Record<string, string | null>) => {
    const base = fresh();
    commit({ ...bumpFiles('1.0.1'), ...extra }, 'bump plus');
    return decide(ENV, deps([passedRun(9, base)]));
  };

  test('a source file changed since the passed commit', () => {
    const d = withExtra({ 'src/a.ts': 'export const a = 2;\n' });
    expect(d.reuse).toBe(false);
    expect(d.why).toContain('src/a.ts changed, and it is not a release bump file');
    expect(outputs(d)).toBe('reuse=false\nindex-changed=false\n');
  });

  test('a release notes file outside the repo root, or the workflow itself', () => {
    expect(withExtra({ 'docs/RELEASE_NOTES_v1.md': 'x\n' }).reuse).toBe(false);
    expect(withExtra({ '.github/workflows/release.yml': 'on: push\n' }).reuse).toBe(false);
  });

  test('a version file with more than its version changed (scripts, dependencies, the marketplace entry, the YAML)', () => {
    expect(withExtra({ 'package.json': pkg('1.0.1', { scripts: { test: 'true' } }) }).why).toContain('package.json changed more than its version');
    expect(withExtra({ 'apps/pi-extension/package.json': pkg('1.0.1', { dependencies: { x: '1' } }) }).reuse).toBe(false);
    expect(withExtra({ [MARKETPLACE_FILE]: marketplace('1.0.1', 'Other') }).reuse).toBe(false);
    expect(withExtra({ [OPENPACKAGE_FILE]: openpackage('1.0.1', 'Other') }).reuse).toBe(false);
    expect(withExtra({ [OPENPACKAGE_FILE]: `${openpackage('1.0.1')}version: 2\n` }).reuse).toBe(false);
  });

  test('a version file deleted, or one that no longer parses', () => {
    expect(withExtra({ 'apps/copilot/plugin.json': null }).reuse).toBe(false);
    expect(withExtra({ 'packages/server/package.json': '{ "version": "1.0.1", \n' }).reuse).toBe(false);
  });

  test('a search index that is not valid JSON or lost its lists', () => {
    expect(withExtra({ [FEEDBACK_INDEX_FILE]: '{"features": [' }).reuse).toBe(false);
    expect(withExtra({ [FEEDBACK_INDEX_FILE]: '{"features": []}\n' }).reuse).toBe(false);
  });

  test('a new search index (not a rewrite of the one Test saw)', () => {
    const base = fresh();
    git('rm', '-q', FEEDBACK_INDEX_FILE);
    const without = commit({}, 'no index');
    commit({ [FEEDBACK_INDEX_FILE]: index(['a']) }, 'index back');
    expect(base).not.toBe(without);
    expect(decide(ENV, deps([passedRun(9, without)])).reuse).toBe(false);
  });

  test('no passed run in the tag history: a run on a side branch commit, or none at all', () => {
    const base = fresh();
    git('checkout', '-q', '-b', 'side');
    const side = commit({ 'src/a.ts': 'export const a = 9;\n' }, 'side');
    git('checkout', '-q', 'main');
    commit(bumpFiles('1.0.1'), 'bump');
    expect(decide(ENV, deps([passedRun(9, side)])).why).toContain('no passed Test run on main');
    expect(decide(ENV, deps([])).reuse).toBe(false);
    expect(decide(ENV, deps([passedRun(9, 'f'.repeat(40))])).reuse).toBe(false);
    expect(decide(ENV, deps([passedRun(9, base)])).reuse).toBe(true);
  });

  test('a run that is not a passed Test push to main of this repo is never reused', () => {
    const base = fresh();
    commit(bumpFiles('1.0.1'), 'bump');
    const not: FakeRun[] = [
      { conclusion: 'failure' },
      { conclusion: null, status: 'in_progress' },
      { event: 'pull_request' },
      { event: 'workflow_dispatch' },
      { head_branch: 'feature' },
      { path: '.github/workflows/windows.yml' },
      { head_repository: { full_name: 'fork/repo' } },
      { head_repository: null },
    ];
    for (const over of not) expect(decide(ENV, deps([passedRun(9, base, over)])).reuse).toBe(false);
    expect(decide(ENV, deps([passedRun(9, base)])).reuse).toBe(true);
  });

  test('a pull_request run, an unknown event or no repository', () => {
    const base = fresh();
    commit(bumpFiles('1.0.1'), 'bump');
    const runs = [passedRun(9, base)];
    expect(decide({ ...ENV, GITHUB_EVENT_NAME: 'pull_request' }, deps(runs)).reuse).toBe(false);
    expect(decide({ ...ENV, GITHUB_EVENT_NAME: undefined }, deps(runs)).reuse).toBe(false);
    expect(decide({ ...ENV, GITHUB_REPOSITORY: undefined }, deps(runs)).reuse).toBe(false);
  });

  test('the API failing or answering something else', () => {
    const base = fresh();
    commit(bumpFiles('1.0.1'), 'bump');
    const failed = decide(ENV, deps(new Error('HTTP 403: Resource not accessible by integration')));
    expect(failed.reuse).toBe(false);
    expect(failed.why).toContain('the lookup failed: Error: HTTP 403');
    const odd: Deps = { ...deps([passedRun(9, base)]), api: () => ({ message: 'Not Found' }) };
    expect(decide(ENV, odd).reuse).toBe(false);
  });

  test('git failing', () => {
    const base = fresh();
    commit(bumpFiles('1.0.1'), 'bump');
    const broken: Deps = { ...deps([passedRun(9, base)]), git: () => { throw new Error('git broke'); } };
    expect(decide(ENV, broken)).toMatchObject({ reuse: false, why: 'the lookup failed: Error: git broke' });
  });
});

describe('the bump file list', () => {
  const root = join(import.meta.dir, '..');

  test('is exactly the files scripts/check-release-version.mjs checks, plus the search index', () => {
    const checker = readFileSync(join(root, 'scripts/check-release-version.mjs'), 'utf8');
    const checked = [...checker.matchAll(/"([^"\s]+\.(?:json|yml))"/g)].map((m) => m[1]);
    expect([...checked].sort()).toEqual(BUMP_FILES.filter((f) => f !== FEEDBACK_INDEX_FILE).sort());
  });

  test('names files that exist, and the index test reads the shipped index', () => {
    for (const file of BUMP_FILES) expect(Bun.file(join(root, file)).size).toBeGreaterThan(0);
    expect(readFileSync(join(root, FEEDBACK_INDEX_TEST), 'utf8')).toContain("from './feedbackSearch.data.json'");
  });
});
