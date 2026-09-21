/**
 * CI allowlist guard for DOM-gated tests.
 *
 * A DOM-gated test file skips itself unless `DOM_TESTS=1` puts happy-dom
 * globals in place, so the plain `bun test` sweep runs none of its assertions.
 * The only place those files execute is the hand-maintained list of paths in
 * `.github/workflows/test.yml`, and every feature that adds one has to
 * remember to append to it — which is exactly what stopped happening: three
 * PRs in one release added seven files and 34 tests that never ran in CI,
 * guarding controls that had just shipped.
 *
 * The failure this catches: a DOM-gated test file that exists, passes locally,
 * and is dead weight in CI.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const WORKFLOW = '.github/workflows/test.yml';
/** Where test files live. `legacy/` is reference-only and is not run. */
const SEARCH_ROOTS = ['packages', 'apps', 'tests', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
/** This file names every DOM_TESTS token it reasons about, so it would
 *  otherwise flag itself. It needs no DOM and runs in the default sweep. */
const SELF = 'scripts/dom-test-allowlist.test.ts';

function testFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) testFiles(full, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(relative(repoRoot, full));
  }
  return out;
}

/**
 * A file is DOM-gated when it skips itself without happy-dom: the repo's
 * convention is a `hasDom` constant feeding `describe.if` / `test.if` /
 * `skipIf`. Files that merely document `DOM_TESTS=1` in a header comment count
 * too — that comment is the author saying the file needs the flag.
 */
function isDomGated(source: string): boolean {
  if (/\b(describe|test|it)\.(if|skipIf)\(!?hasDom\)/.test(source)) return true;
  return /DOM_TESTS/.test(source);
}

describe('DOM test allowlist', () => {
  test('every DOM-gated test file is named in a DOM_TESTS step of the CI workflow', () => {
    const workflow = readFileSync(join(repoRoot, WORKFLOW), 'utf8');
    const listed = new Set(workflow.match(/[\w./-]+\.test\.tsx?/g) ?? []);

    const gated = SEARCH_ROOTS
      .flatMap((root) => testFiles(join(repoRoot, root)))
      .filter((file) => file !== SELF)
      .filter((file) => isDomGated(readFileSync(join(repoRoot, file), 'utf8')));

    // Sanity: a matcher that silently stopped matching would make this test
    // pass forever. The repo has well over a hundred DOM-gated files.
    expect(gated.length).toBeGreaterThan(50);

    const missing = gated.filter((file) => !listed.has(file)).sort();
    expect(missing).toEqual([]);
  });
});
