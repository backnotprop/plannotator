/**
 * The kind of a changed file: code, tests, or generated. One rule for the code
 * review file tree, diff headers and Guided Reviews (approved design record
 * "review-file-kinds"). Pure and browser-safe: it reads the path only.
 *
 * - **Generated:** the host's generated set when it has one (the review
 *   server's `generatedFiles`, which already applies `.gitattributes`);
 *   without one, the built-in name list below.
 * - **Tests:** a test file name (`*.test.*`, `*.spec.*`, `*_test.*`,
 *   `test_*.py`, `*.stories.*`, `*.snap`) or a file under a test folder
 *   (`__tests__`, `test`, `tests`, `spec`, `e2e`, `fixtures`, ...).
 * - **Code:** everything else, docs and config included.
 */

export type FileKind = 'code' | 'test' | 'generated';

/** Display order of the kinds: code first, then tests, then generated. */
export const FILE_KINDS: readonly FileKind[] = ['code', 'test', 'generated'];

/**
 * Built-in name-based generated defaults: files GitHub's linguist collapses
 * without any `.gitattributes`. Exact entries match a path's last segment
 * verbatim; `*.`-prefixed entries match by extension suffix (at least one
 * character before the suffix, so a bare `.min.js` dotfile does not match).
 * The review server refines this list with `.gitattributes`
 * (`packages/shared/generated-files.ts`).
 */
export const DEFAULT_GENERATED_PATTERNS: readonly string[] = [
  // JavaScript ecosystems
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  // Other language ecosystems
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'go.sum',
  'flake.lock',
  'packages.lock.json',
  // Build artifacts
  '*.min.js',
  '*.min.css',
  '*.map',
];

const DEFAULT_EXACT_NAMES = new Set(DEFAULT_GENERATED_PATTERNS.filter((p) => !p.startsWith('*.')));
const DEFAULT_SUFFIXES = DEFAULT_GENERATED_PATTERNS.filter((p) => p.startsWith('*.')).map((p) => p.slice(1));

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Does the path's LAST segment match a built-in generated default? */
export function isDefaultGeneratedPath(path: string): boolean {
  const name = lastSegment(path);
  if (name.length === 0) return false;
  if (DEFAULT_EXACT_NAMES.has(name)) return true;
  return DEFAULT_SUFFIXES.some((suffix) => name.length > suffix.length && name.endsWith(suffix));
}

/** Folder names that hold tests, compared case-insensitively against each
 *  folder of the path (never the file name itself). */
const TEST_FOLDERS = new Set([
  '__tests__',
  '__snapshots__',
  '__fixtures__',
  '__mocks__',
  'test',
  'tests',
  'spec',
  'e2e',
  'fixtures',
  'testdata',
]);

/**
 * Test file names. Each marker needs a name before it, so `test.ts`,
 * `contest.ts`, `latest.ts` and `testing-library.config.js` stay code:
 * - `foo.test.ts`, `foo.spec.tsx`, `Button.stories.tsx` (a `.test.` / `.spec.`
 *   / `.stories.` part followed by an extension);
 * - Go and Python `foo_test.go`, `foo_test.py`;
 * - Python `test_foo.py`;
 * - Jest snapshots `foo.snap`.
 */
const TEST_NAME = /^[^.].*\.(test|spec|stories)\.[^/]+$|^.+_test\.[A-Za-z0-9]+$|^test_.+\.py$|^.+\.snap$/;

/** Is the path a test, by its name or a test folder above it? */
export function isTestPath(path: string): boolean {
  const segments = path.split('/');
  const name = segments.pop() ?? '';
  if (TEST_NAME.test(name)) return true;
  return segments.some((segment) => TEST_FOLDERS.has(segment.toLowerCase()));
}

/**
 * The kind of one changed file. `generated` is the host's generated set when
 * it has one; without it the built-in name list decides.
 */
export function fileKind(path: string, generated?: ReadonlySet<string> | null): FileKind {
  if (generated ? generated.has(path) : isDefaultGeneratedPath(path)) return 'generated';
  return isTestPath(path) ? 'test' : 'code';
}

export interface FileKindGroup<T> {
  kind: FileKind;
  items: T[];
}

/**
 * Split items into kind groups, in `FILE_KINDS` order, keeping each item's
 * original order within its group. Empty groups are left out.
 */
export function groupByFileKind<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  generated?: ReadonlySet<string> | null,
): FileKindGroup<T>[] {
  const byKind = new Map<FileKind, T[]>();
  for (const item of items) {
    const kind = fileKind(pathOf(item), generated);
    const list = byKind.get(kind);
    if (list) list.push(item);
    else byKind.set(kind, [item]);
  }
  return FILE_KINDS.filter((kind) => byKind.has(kind)).map((kind) => ({ kind, items: byKind.get(kind)! }));
}
