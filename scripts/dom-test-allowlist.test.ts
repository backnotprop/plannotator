/**
 * CI allowlist guard for DOM-gated tests.
 *
 * A DOM-gated test file skips itself unless `DOM_TESTS=1` puts happy-dom
 * globals in place, so the plain `bun test` sweep runs none of its assertions.
 * The only place those files execute is the hand-maintained list in
 * `tests/dom-test-list.txt` (run by the `dom-*` lanes of
 * `.github/workflows/test.yml`) or one of that workflow's own-process DOM
 * steps, and every feature that adds one has to remember to append to it — which is exactly what stopped happening: three
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
const DOM_LIST = 'tests/dom-test-list.txt';
/** Where test files live. `legacy/` is reference-only and is not run. */
const SEARCH_ROOTS = ['packages', 'apps', 'tests', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
/** These files name the DOM_TESTS token they reason about, so they would
 *  otherwise flag themselves. They need no DOM and run in the default sweep. */
const SELF = new Set([
  'scripts/dom-test-allowlist.test.ts',
  // The lane guard names the DOM lane's environment variable; it needs no DOM either.
  'scripts/ci-test-lanes.test.ts',
]);

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

/** The paths in the DOM list, comment lines left out. */
function listFiles(): string[] {
  return readFileSync(join(repoRoot, DOM_LIST), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * The files the workflow's own-process DOM steps run: the test paths in a step
 * whose command is a `DOM_TESTS=1 bun test`, YAML comments left out. A path
 * that only appears in a comment, or in any other step, runs nowhere with
 * happy-dom, so it does not count.
 */
function ownProcessDomStepFiles(): string[] {
  const workflow = readFileSync(join(repoRoot, WORKFLOW), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  return workflow
    .split(/^\s*- name:/m)
    .filter((step) => /DOM_TESTS=1 bun test/.test(step))
    .flatMap((step) => step.match(/[\w./-]+\.test\.tsx?/g) ?? []);
}

describe('DOM test allowlist', () => {
  test('every DOM-gated test file is in tests/dom-test-list.txt or an own-process DOM step of the CI workflow', () => {
    const listed = new Set([...listFiles(), ...ownProcessDomStepFiles()]);

    const gated = SEARCH_ROOTS
      .flatMap((root) => testFiles(join(repoRoot, root)))
      .filter((file) => !SELF.has(file))
      .filter((file) => isDomGated(readFileSync(join(repoRoot, file), 'utf8')));

    // Sanity: a matcher that silently stopped matching would make this test
    // pass forever. The repo has well over a hundred DOM-gated files.
    expect(gated.length).toBeGreaterThan(50);

    const missing = gated.filter((file) => !listed.has(file)).sort();
    expect(missing).toEqual([]);
  });
});
