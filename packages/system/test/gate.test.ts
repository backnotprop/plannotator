import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gate, globMatch, isIgnoredPath, loadFiles, type ChangedFile, type SystemModel } from '../src/index.ts';
import { gateRepo, load, parseNameStatus } from '../src/node/index.ts';
import { drawingDir, edited, fixturesDir, git, isolateGitConfig, tempDir } from './helpers.ts';

let plannotator: SystemModel;
beforeAll(async () => {
  plannotator = (await load(drawingDir)).model!;
});

function recorded(pr: number): ChangedFile[] {
  return readFileSync(join(fixturesDir, 'prs', `pr-${pr}.txt`), 'utf8').trim().split('\n').map((line) => {
    const [s, a, b] = line.split('\t');
    return s![0] === 'R' ? { status: 'R', from: a!, path: b! } : { status: s as ChangedFile['status'], path: a! };
  });
}

describe('the gate on real merged plannotator PRs', () => {
  test('PR 2543 (the daily ping) adds a Worker and a client: wake', () => {
    const r = gate({ files: recorded(2543), model: plannotator });
    expect(r.wake).toBe(true);
    expect(r.why).toContainEqual({ path: 'apps/telemetry/src/handler.ts', reason: 'added' });
    expect(r.why).toContainEqual({ path: 'packages/shared/daily-ping.ts', reason: 'added' });
    expect(r.why).toContainEqual({ path: '.github/workflows/release.yml', reason: 'watched' });
    expect(r.touched.parts).toEqual(expect.arrayContaining(['ping', 'cliEntry', 'iserver', 'piSrv', 'hkopencode']));
    expect(r.ignored).toEqual(expect.arrayContaining(['bun.lock', 'docs/agent-guides/environment.md', 'packages/shared/daily-ping.test.ts']));
  });

  test('PR 2563 (the Inbox wakes T3 Code) adds the waker: wake', () => {
    const r = gate({ files: recorded(2563), model: plannotator });
    expect(r.wake).toBe(true);
    expect(r.why).toEqual([
      { path: 'packages/core/inbox-t3.ts', reason: 'added' },
      { path: 'packages/server/inbox-t3-wake.ts', reason: 'added' },
    ]);
    expect(r.touched.parts).toEqual(expect.arrayContaining(['it3', 'iserver', 'shim']));
    expect(r.touched.flows).toEqual(expect.arrayContaining(['i_t3stdio', 'i_wt3', 'i_shim']));
  });

  test('PR 2600 (Show me in the code review) adds a command, a store and a layer: wake', () => {
    const r = gate({ files: recorded(2600), model: plannotator });
    expect(r.wake).toBe(true);
    expect(r.why).toContainEqual({ path: 'apps/hook/server/review-draw-command.ts', reason: 'added' });
    expect(r.why).toContainEqual({ path: 'packages/server/inbox-review-drawings.ts', reason: 'added' });
    expect(r.touched.parts).toEqual(expect.arrayContaining(['iserver', 'iwindow', 'cliEntry']));
  });

  test('PR 2644 edits only cited files: no wake, the touched parts named', () => {
    const r = gate({ files: recorded(2644), model: plannotator });
    expect(r.wake).toBe(false);
    expect(r.why).toEqual([]);
    expect(r.touched).toEqual({ parts: ['inbox', 'iwindow'], flows: ['answer'] });
    expect(r.ignored.sort()).toEqual([
      'docs/agent-guides/inbox-notifications-and-agents.md', 'packages/inbox/history.test.ts', 'packages/inbox/notifyHook.test.tsx',
      'tests/e2e/notifications.spec.ts',
    ]);
  });

  test('an ignored file never wakes the gate, even inside a cited folder', () => {
    for (const pr of [2543, 2563, 2600, 2644]) {
      const r = gate({ files: recorded(pr), model: plannotator });
      expect(r.why.filter((w) => isIgnoredPath(w.path))).toEqual([]);
    }
  });
});

describe('the gate rules', () => {
  const model = loadFiles(edited('system.yaml', (t) => `${t}watch: [deploy/*.toml]\n`)).model!;
  const run = (...files: ChangedFile[]) => gate({ files, model });

  test('a modified file no part cites does nothing', () => {
    expect(run({ path: 'src/util.ts', status: 'M' })).toEqual({ touched: { parts: [], flows: [] }, wake: false, why: [], ignored: [] });
  });

  test('a modified cited file is touched but does not wake', () => {
    expect(run({ path: 'src/main.ts', status: 'M' })).toMatchObject({ touched: { parts: ['app'], flows: [] }, wake: false });
    expect(run({ path: 'src/api/routes.ts', status: 'M' }).touched.parts).toEqual(['api']);
  });

  test('a modified watched file wakes', () => {
    expect(run({ path: 'deploy/prod.toml', status: 'M' }).why).toEqual([{ path: 'deploy/prod.toml', reason: 'watched' }]);
  });

  test('added, deleted and renamed files wake; a cited path gone says so', () => {
    expect(run({ path: 'src/queue.ts', status: 'A' }).why).toEqual([{ path: 'src/queue.ts', reason: 'added' }]);
    expect(run({ path: 'src/old.ts', status: 'D' }).why).toEqual([{ path: 'src/old.ts', reason: 'deleted' }]);
    expect(run({ path: 'src/b.ts', from: 'src/a.ts', status: 'R' }).why).toEqual([{ path: 'src/b.ts', reason: 'renamed' }]);
    expect(run({ path: 'src/main.ts', status: 'D' }).why).toEqual([{ path: 'src/main.ts', reason: 'cited-gone' }]);
    const moved = run({ path: 'src/entry.ts', from: 'src/main.ts', status: 'R' });
    expect(moved.why).toEqual([{ path: 'src/main.ts', reason: 'cited-gone' }]);
    expect(moved.touched.parts).toEqual(['app']);
  });

  test('tests, docs, lockfiles and the drawing itself are ignored', () => {
    const r = run(
      { path: 'src/api/routes.test.ts', status: 'A' }, { path: 'README.md', status: 'M' }, { path: 'bun.lock', status: 'M' },
      { path: '.plannotator/system/sheets/L-102.yaml', status: 'A' }, { path: 'tests/e2e/a.spec.ts', status: 'D' },
    );
    expect(r).toEqual({
      touched: { parts: [], flows: [] }, wake: false, why: [],
      ignored: ['src/api/routes.test.ts', 'README.md', 'bun.lock', '.plannotator/system/sheets/L-102.yaml', 'tests/e2e/a.spec.ts'],
    });
  });

  test('a doc the drawing names by its own path counts', () => {
    const m = loadFiles(edited('system.yaml', (t) => t.replace('src/main.ts: the entry', 'docs/setup.md: how it starts'))).model!;
    expect(gate({ files: [{ path: 'docs/setup.md', status: 'D' }], model: m }).why).toEqual([{ path: 'docs/setup.md', reason: 'cited-gone' }]);
  });

  test('globs', () => {
    expect(globMatch('apps/*/wrangler.toml', 'apps/relay/wrangler.toml')).toBe(true);
    expect(globMatch('apps/*/wrangler.toml', 'apps/a/b/wrangler.toml')).toBe(false);
    expect(globMatch('apps/**/wrangler.toml', 'apps/a/b/wrangler.toml')).toBe(true);
    expect(globMatch('**/channels.json', 'channels.json')).toBe(true);
    expect(globMatch('a.b', 'aXb')).toBe(false);
  });
});

describe('gateRepo on a real repo', () => {
  isolateGitConfig();
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((f) => f()));

  test('an add, a delete, a rename, a watched edit and an unwatched edit, each from its own commit', async () => {
    const t = tempDir();
    cleanups.push(t.done);
    const root = t.dir;
    const write = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    const commit = (msg: string) => {
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', msg);
      return git(root, 'rev-parse', 'HEAD').trim();
    };
    git(root, 'init', '-q');
    write('src/main.ts', 'export const main = 1;\n');
    write('src/api/index.ts', 'export const api = 1;\n');
    write('src/util.ts', 'export const util = 1;\n');
    write('src/old.ts', 'export const old = 1;\n');
    write('deploy/prod.toml', 'name = "small"\n');
    write('src/move-me.ts', Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};\n`).join(''));
    const base = commit('base');
    const model = loadFiles(edited('system.yaml', (s) => `${s}watch: [deploy/*.toml]\n`)).model!;
    const step = async (change: () => void) => {
      const from = git(root, 'rev-parse', 'HEAD').trim();
      change();
      const to = commit('step');
      return gateRepo({ root, from, to, model });
    };

    expect((await step(() => write('src/queue.ts', 'export const q = 1;\n'))).why).toEqual([{ path: 'src/queue.ts', reason: 'added' }]);
    expect((await step(() => rmSync(join(root, 'src/old.ts')))).why).toEqual([{ path: 'src/old.ts', reason: 'deleted' }]);
    expect((await step(() => renameSync(join(root, 'src/move-me.ts'), join(root, 'src/moved.ts')))).why).toEqual([{ path: 'src/moved.ts', reason: 'renamed' }]);
    expect((await step(() => write('deploy/prod.toml', 'name = "small"\nregion = "eu"\n'))).why).toEqual([{ path: 'deploy/prod.toml', reason: 'watched' }]);
    const unwatched = await step(() => write('src/util.ts', 'export const util = 2;\n'));
    expect(unwatched).toEqual({ touched: { parts: [], flows: [] }, wake: false, why: [], ignored: [] });
    const cited = await step(() => write('src/api/index.ts', 'export const api = 2;\n'));
    expect(cited).toMatchObject({ touched: { parts: ['api'], flows: ['use'] }, wake: false });
    expect((await gateRepo({ root, from: base, to: 'HEAD', model })).why.map((w) => w.reason).sort()).toEqual(['added', 'deleted', 'renamed', 'watched']);
  });

  test('a ref git could read as an option is refused before git runs', async () => {
    const model = loadFiles(edited('system.yaml', (s) => s)).model!;
    await expect(gateRepo({ root: drawingDir, from: '--output=/dev/null', to: 'HEAD', model })).rejects.toThrow('is not a git ref');
    await expect(gateRepo({ root: drawingDir, from: 'HEAD', to: '-p', model })).rejects.toThrow('is not a git ref');
  });

  test('parseNameStatus reads renames, copies and type changes', () => {
    expect(parseNameStatus('R087\0a.ts\0b.ts\0C100\0c.ts\0d.ts\0T\0e.ts\0M\0f g.ts\0')).toEqual([
      { path: 'b.ts', status: 'R', from: 'a.ts' }, { path: 'd.ts', status: 'A' }, { path: 'e.ts', status: 'M' }, { path: 'f g.ts', status: 'M' },
    ]);
  });
});
