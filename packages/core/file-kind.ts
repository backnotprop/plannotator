export type FileKind = 'code' | 'test' | 'generated';

export const FILE_KINDS: readonly FileKind[] = ['code', 'test', 'generated'];

export const DEFAULT_GENERATED_PATTERNS: readonly string[] = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'go.sum',
  'flake.lock',
  'packages.lock.json',
  '*.min.js',
  '*.min.css',
  '*.map',
];

const DEFAULT_EXACT_NAMES = new Set(DEFAULT_GENERATED_PATTERNS.filter((p) => !p.startsWith('*.')));
const DEFAULT_SUFFIXES = DEFAULT_GENERATED_PATTERNS.filter((p) => p.startsWith('*.')).map((p) => p.slice(1));

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function isDefaultGeneratedPath(path: string): boolean {
  const name = lastSegment(path);
  if (name.length === 0) return false;
  if (DEFAULT_EXACT_NAMES.has(name)) return true;
  return DEFAULT_SUFFIXES.some((suffix) => name.length > suffix.length && name.endsWith(suffix));
}

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
  'testfixtures',
]);

const SOURCE_SET_TEST = /^[a-z][A-Za-z0-9]*Test$/;
const DOTNET_TEST_PROJECT = /^.+\.(Unit)?Tests$/;

const CODE_EXT =
  '(?:[cm]?[jt]sx?|rb|py|go|rs|java|kts?|swift|cs|fs|ex|exs|php|scala|dart|groovy|clj[cs]?|lua|erl|hs|ml|jl|r|c|cc|cpp|h|hpp|m|mm|vue|svelte)';

const TEST_NAME = new RegExp(
  `^[^.].*\\.(?:test|spec|cy|e2e|test-d)\\.${CODE_EXT}$|^.+_test\\.${CODE_EXT}$|` +
    `^[^.].*\\.stories\\.[^/]+$|^test_.+\\.py$|^(?:conftest|tests)\\.py$|^.+\\.snap$`,
  'i',
);

export function isTestPath(path: string): boolean {
  const segments = path.split('/');
  const name = segments.pop() ?? '';
  if (TEST_NAME.test(name)) return true;
  return segments.some(
    (segment, i) =>
      TEST_FOLDERS.has(segment.toLowerCase()) ||
      DOTNET_TEST_PROJECT.test(segment) ||
      (i > 0 && segments[i - 1] === 'src' && SOURCE_SET_TEST.test(segment)),
  );
}

export function fileKind(path: string, generated?: ReadonlySet<string> | null): FileKind {
  if (generated ? generated.has(path) : isDefaultGeneratedPath(path)) return 'generated';
  return isTestPath(path) ? 'test' : 'code';
}

export interface FileKindGroup<T> {
  kind: FileKind;
  items: T[];
}

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
