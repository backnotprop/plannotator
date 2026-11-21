/**
 * Which test files need happy-dom, and where CI runs them: shared by
 * scripts/dom-test-allowlist.test.ts (every DOM-gated file runs somewhere in CI)
 * and scripts/test-sandbox.ts (run a file the way CI does, or refuse it).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
export const WORKFLOW = '.github/workflows/test.yml';
export const DOM_LIST = 'tests/dom-test-list.txt';

/** These files name the DOM_TESTS token they reason about, so they would
 *  otherwise flag themselves. They need no DOM and run in the default sweep. */
export const DOM_GATE_SELF = new Set([
  'scripts/dom-test-allowlist.test.ts',
  // The lane guard names the DOM lane's environment variable; it needs no DOM either.
  'scripts/ci-test-lanes.test.ts',
  // The sandbox command's proof checks that it sets and drops that variable; it needs no DOM either.
  'scripts/test-sandbox.test.ts',
]);

/**
 * A file is DOM-gated when it skips itself without happy-dom: the repo's
 * convention is a `hasDom` constant feeding `describe.if` / `test.if` /
 * `skipIf`. Files that merely document `DOM_TESTS=1` in a header comment count
 * too — that comment is the author saying the file needs the flag.
 */
export function isDomGated(source: string): boolean {
  if (/\b(describe|test|it)\.(if|skipIf)\(!?hasDom\)/.test(source)) return true;
  return /DOM_TESTS/.test(source);
}

/** The paths in the DOM list, comment lines left out. */
export function domListFiles(): string[] {
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
export function ownProcessDomStepFiles(): string[] {
  const workflow = readFileSync(join(repoRoot, WORKFLOW), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  return workflow
    .split(/^\s*- name:/m)
    .filter((step) => /DOM_TESTS=1 bun test/.test(step))
    .flatMap((step) => step.match(/[\w./-]+\.test\.tsx?/g) ?? []);
}
