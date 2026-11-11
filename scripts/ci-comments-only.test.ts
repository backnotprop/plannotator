import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compareSource, verifyCommentsOnly } from './ci-comments-only';

const passes: [string, string, string, string][] = [
  ['comment deleted', 'a.ts', 'const a = 1; // why\nexport { a };', 'const a = 1;\nexport { a };'],
  ['comment shortened', 'a.ts', '// one long line of history\nconst a = 1;', '// short\nconst a = 1;'],
  ['JSDoc removed', 'a.ts', '/**\n * Adds.\n * @param x the x\n */\nexport function f(x: number) { return x + 1; }', 'export function f(x: number) { return x + 1; }'],
  ['catch block emptied', 'a.ts', 'try { f(); } catch {\n  // ignore\n}', 'try { f(); } catch {}'],
  ['JSX comment child removed', 'a.tsx', 'const v = (\n  <div>\n    {/* the list */}\n    <ul />\n  </div>\n);', 'const v = (\n  <div>\n    <ul />\n  </div>\n);'],
  ['comment in multi-line call removed', 'a.ts', 'f(\n  1, // first\n  2,\n);', 'f(\n  1,\n  2,\n);'],
];

const fails: [string, string, string, string, RegExp][] = [
  ['string changed', 'a.ts', 'const a = "x";', 'const a = "y";', /code changed/],
  ['identifier changed', 'a.ts', 'const a = b;', 'const a = c;', /code changed/],
  ['regex changed', 'a.ts', 'const r = /a+/g;', 'const r = /a*/g;', /code changed/],
  ['JSX text changed', 'a.tsx', 'const v = <p>Hello</p>;', 'const v = <p>Hi</p>;', /code changed/],
  ['JSX comment removal joins two words', 'a.tsx', 'const v = (\n  <p>\n    Hello\n    {/* c */}\n    world\n  </p>\n);', 'const v = (\n  <p>\n    Hello\n    world\n  </p>\n);', /code changed/],
  ['@ts-expect-error removed', 'a.ts', '// @ts-expect-error wrong on purpose\nconst a: number = "x";', 'const a: number = "x";', /directive/],
  ['eslint-disable removed', 'a.ts', '/* eslint-disable no-console */\nconsole.log(1);', 'console.log(1);', /directive/],
  ['comment between @ts-ignore and its line removed', 'a.ts', '// @ts-ignore\n// note\nf();', '// @ts-ignore\nf();', /directive/],
  ['comment holding a line break after return removed', 'a.ts', 'function f() { return /*\n*/ 1; }', 'function f() { return 1; }', /code changed/],
];

describe('compareSource', () => {
  test.each(passes)('passes: %s', (_name, path, before, after) => {
    expect(compareSource(path, before, after)).toBeNull();
  });

  test.each(fails)('fails: %s', (_name, path, before, after, reason) => {
    expect(compareSource(path, before, after)).toMatch(reason);
  });
});

describe('verifyCommentsOnly on a git repo', () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  });

  const gitIn = (repo: string, ...args: string[]) => {
    const run = Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args]);
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  };

  const commitFiles = (repo: string, files: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(files)) {
      const full = join(repo, path);
      if (text === null) rmSync(full);
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
    }
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'c');
  };

  const verdictFor = (change: Record<string, string | null>) => {
    const repo = mkdtempSync(join(tmpdir(), 'comments-only-'));
    repos.push(repo);
    gitIn(repo, 'init', '-q', '-b', 'main');
    commitFiles(repo, { 'src/a.ts': 'const a = 1; // why\n', 'README.md': '# r\n' });
    gitIn(repo, 'checkout', '-q', '-b', 'sweep');
    commitFiles(repo, change);
    return verifyCommentsOnly(repo, 'main', 'sweep');
  };

  test('a comment deletion is verified', () => {
    expect(verdictFor({ 'src/a.ts': 'const a = 1;\n' }).commentsOnly).toBe(true);
  });

  test.each([
    ['a non-ts file changed', { 'src/a.ts': 'const a = 1;\n', 'README.md': '# readme\n' }, 'README.md'],
    ['a file added', { 'src/a.ts': 'const a = 1;\n', 'src/b.ts': '// only a comment\n' }, 'src/b.ts'],
    ['a file deleted', { 'src/a.ts': null }, 'src/a.ts'],
  ] as const)('%s is refused', (_name, change, path) => {
    const verdict = verdictFor(change);
    expect(verdict.commentsOnly).toBe(false);
    expect(verdict.problems.map((p) => p.path)).toContain(path);
  });
});

describe('workflow wiring', () => {
  type Step = { uses?: string; run?: string; with?: Record<string, unknown>; 'working-directory'?: string };
  type Job = { if?: string; needs?: string | string[]; uses?: string; steps?: Step[] };
  const workflow = (file: string) =>
    Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows', file), 'utf8')) as {
      permissions?: Record<string, string>;
      jobs: Record<string, Job>;
    };
  const SKIP_ONLY_WHEN_VERIFIED = "${{ !cancelled() && needs.comments-only.outputs.verified != 'true' }}";

  test('the verdict comes from the base branch copy of the verifier, with read-only access', () => {
    const wf = workflow('comments-only.yml');
    expect(wf.permissions).toEqual({ contents: 'read' });
    const steps = wf.jobs.verified.steps!;
    const base = steps.find((step) => step.with?.path === 'base')!;
    expect(base.with?.ref).toBe('${{ github.event.pull_request.base.sha }}');
    for (const step of steps.filter((step) => step.uses?.startsWith('actions/checkout'))) {
      expect(step.with?.['persist-credentials']).toBe(false);
    }
    for (const step of steps.filter((step) => step.run)) expect(step['working-directory']).toBe('base');
    expect(JSON.stringify(wf)).not.toContain('secrets.');
  });

  test.each(['test.yml', 'browser-smoke.yml'])('%s skips a job only on the verifier\'s verdict', (file) => {
    const { jobs } = workflow(file);
    expect(jobs['comments-only'].uses).toBe('./.github/workflows/comments-only.yml');
    for (const [id, job] of Object.entries(jobs)) {
      if (id === 'comments-only') continue;
      expect([job.needs].flat(), id).toContain('comments-only');
      expect(job.if, id).toBe(id === 'checks' ? '${{ !cancelled() }}' : SKIP_ONLY_WHEN_VERIFIED);
    }
  });
});
