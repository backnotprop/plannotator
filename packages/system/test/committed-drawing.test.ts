import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { check, load } from '../src/node/index.ts';
import { commitAt, drawingDir, FETCH_STEP, git, isolateGitConfig, repoRoot, smallDrawing, tempDir, writeTree } from './helpers.ts';

// This repo's own drawing, as a test of the repo. A later PR that renames a
// file the drawing cites must not turn this red: the drawing says what it was
// drawn from (`sources.repos.self.at`), and the gate, not this test, says
// when it may be out of date.
//
// - At HEAD, everything that does not ask whether a file exists is a hard
//   test: system.yaml and every sheet load, the schema, the ids, the refs
//   between sheets (load.test.ts, "the committed drawing", holds the rest).
// - The cited paths are checked at the drawing's own commit. The test stays
//   offline: CI clones one commit and fetches the drawing's commit in a step
//   before the tests. When the commit is not in the clone, the test is
//   skipped and the reason is printed (and is in its name).
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
    `cites only paths that exist at its own commit${state.ok ? ` (${state.at.slice(0, 12)})` : ` [SKIPPED: ${state.reason}]`}`,
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
// drawing's commit present (fetched the way the CI step does, from a local
// origin), and absent, with a reason and no fetch.
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
  const commits = (root: string) => git(root, 'rev-list', '--all').trim().split('\n');

  test('absent: the one-commit clone lacks it, nothing is fetched, and the reason names the commit and the CI step', () => {
    const o = origin();
    const clone = ciClone(o.root);
    const s = commitAt(clone, o.drawnAt);
    expect(s).toEqual({ ok: false, at: o.drawnAt, reason: `${o.drawnAt} is not in this clone (CI fetches it before the tests: ${FETCH_STEP})` });
    // no fetch was tried: the clone still holds the one commit, and git wrote no FETCH_HEAD
    expect(commits(clone)).toEqual([o.head]);
    expect(existsSync(join(clone, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  test("present: after the CI step's depth-1 fetch, the cited paths are clean at it and the rename at HEAD is only stale", async () => {
    const o = origin();
    const clone = ciClone(o.root);
    git(clone, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', o.drawnAt);
    expect(git(clone, 'rev-parse', '--is-shallow-repository').trim()).toBe('true');
    expect(commitAt(clone, o.drawnAt)).toEqual({ ok: true, at: o.drawnAt });
    const dir = join(clone, '.plannotator', 'system');
    expect(await check({ dir, root: clone })).toEqual({ errors: [], warnings: [], missing: [] });
    expect((await check({ dir, root: clone, at: 'HEAD' })).missing).toEqual(['src/main.ts']);
  });

  test('an id that is not a commit id is refused before git runs', () => {
    expect(commitAt(temp(), '--upload-pack=touch')).toEqual({ ok: false, at: '--upload-pack=touch', reason: '--upload-pack=touch is not a commit id' });
  });
});
