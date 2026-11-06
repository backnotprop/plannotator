import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { check, load } from '../src/node/index.ts';
import { commitAt, drawingDir, git, isolateGitConfig, repoRoot, smallDrawing, tempDir, writeTree } from './helpers.ts';

// This repo's own drawing, as a test of the repo. A later PR that renames a
// file the drawing cites must not turn this red: the drawing says what it was
// drawn from (`sources.repos.self.at`), and the gate, not this test, says
// when it may be out of date.
//
// - At HEAD, everything that does not ask whether a file exists is a hard
//   test: system.yaml and every sheet load, the schema, the ids, the refs
//   between sheets (load.test.ts, "the committed drawing", holds the rest).
// - The cited paths are checked at the drawing's own commit. CI clones one
//   commit, so that commit is fetched (depth 1) when it is missing; when it
//   cannot be, the test is skipped and its name says why.
// - Cited paths gone at HEAD are a printed warning, never a failure.

const drawn = (await load(drawingDir)).model;
const at = drawn?.sources?.repos.self?.at ?? '';
const state = commitAt(repoRoot, at);
if (!state.ok) console.warn(`[system] cited paths not checked at the drawing's commit: ${state.reason}`);

describe('the committed drawing', () => {
  test('loads clean at HEAD: system.yaml, every sheet, the schema, the ids and the refs between sheets', async () => {
    const r = await load(drawingDir);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.model).not.toBeNull();
    expect(at).toMatch(/^[0-9a-f]{40}$/);
  });

  test.skipIf(!state.ok)(
    `cites only paths that exist at its own commit${state.ok ? ` (${state.at.slice(0, 12)}, ${state.how})` : ` [SKIPPED: ${state.reason}]`}`,
    async () => {
      expect(await check({ dir: drawingDir, root: repoRoot })).toEqual({ errors: [], warnings: [], missing: [] });
    },
  );

  test('a cited path gone at HEAD is a printed warning, never a failure', async () => {
    const head = await check({ dir: drawingDir, root: repoRoot, at: 'HEAD' });
    // the loader's own errors are hard; what is missing or symlinked at HEAD is only reported
    expect(head.errors.filter((e) => !/is a symlink; cite/.test(e.message))).toEqual([]);
    const stale = [...head.missing, ...head.errors.map((e) => e.message)];
    if (stale.length) console.warn(`[system] the drawing cites ${stale.length} path(s) not at HEAD; the gate will ask for a redraw:\n  ${stale.join('\n  ')}`);
  });
});

// The same rule in temp repos, so both arms run on every machine: the
// drawing's commit present after a fetch, and absent with a reason.
describe("the drawing's own commit in a one-commit clone", () => {
  isolateGitConfig();
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((f) => f()));
  const temp = () => {
    const t = tempDir();
    cleanups.push(t.done);
    return t.dir;
  };
  const commit = (root: string, msg: string) => {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', msg);
    return git(root, 'rev-parse', 'HEAD').trim();
  };
  /** An origin where the drawing was drawn at one commit and a later commit renamed a cited file. */
  function origin() {
    const root = temp();
    git(root, 'init', '-q');
    writeTree(root, { 'src/main.ts': '', 'src/api/index.ts': '' });
    const drawnAt = commit(root, 'code');
    writeTree(join(root, '.plannotator', 'system'), {
      ...smallDrawing(),
      'system.yaml': smallDrawing()['system.yaml']!.replace('at: 1a2b3c4', `at: ${drawnAt}`),
    });
    git(root, 'mv', 'src/main.ts', 'src/entry.ts');
    const head = commit(root, 'rename the entry');
    return { root, drawnAt, head };
  }
  /** What CI has: a clone of one commit, by file:// so depth applies. */
  function ciClone(from: string) {
    const root = join(temp(), 'clone');
    git(from, 'clone', '-q', '--depth=1', '--no-local', `file://${from}`, root);
    return root;
  }

  test('present: the commit is fetched at depth 1, the cited paths are clean there, and the rename at HEAD is only stale', async () => {
    const o = origin();
    const clone = ciClone(o.root);
    expect(git(clone, 'rev-parse', '--is-shallow-repository').trim()).toBe('true');
    expect(git(clone, 'rev-list', '--all').trim().split('\n')).toEqual([o.head]);
    const dir = join(clone, '.plannotator', 'system');

    const s = commitAt(clone, o.drawnAt);
    expect(s).toEqual({ ok: true, at: o.drawnAt, how: 'fetched' });
    expect(git(clone, 'rev-parse', '--is-shallow-repository').trim()).toBe('true');
    expect(await check({ dir, root: clone })).toEqual({ errors: [], warnings: [], missing: [] });
    expect((await check({ dir, root: clone, at: 'HEAD' })).missing).toEqual(['src/main.ts']);
    // a second look finds it without fetching
    expect(commitAt(clone, o.drawnAt)).toEqual({ ok: true, at: o.drawnAt, how: 'present' });
  });

  test('absent: origin does not have the commit, so the check is skipped with a reason that names it', () => {
    const o = origin();
    const clone = ciClone(o.root);
    const elsewhere = temp();
    git(elsewhere, 'init', '-q');
    writeTree(elsewhere, { 'x.ts': '' });
    const missing = commit(elsewhere, 'not in origin');
    const s = commitAt(clone, missing);
    expect(s.ok).toBe(false);
    if (!s.ok) {
      expect(s.reason).toContain(`${missing} is not in this clone`);
      expect(s.reason).toContain('git fetch --depth=1 origin');
    }
  });

  test('absent: no origin to fetch from, and an id that is not a commit id, each say so', () => {
    const o = origin();
    const lone = temp();
    git(lone, 'init', '-q');
    writeTree(lone, { 'x.ts': '' });
    commit(lone, 'alone');
    const s = commitAt(lone, o.drawnAt);
    expect(s).toEqual({ ok: false, at: o.drawnAt, reason: `${o.drawnAt} is not in this clone, and it has no origin to fetch it from` });
    expect(commitAt(lone, '--upload-pack=touch')).toEqual({ ok: false, at: '--upload-pack=touch', reason: '--upload-pack=touch is not a commit id' });
  });
});
