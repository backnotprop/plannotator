import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Shape's board (packages/ui/components/shape) draws in the Inbox, in the
// standalone Shapes page and in hosts that are not Plannotator at all; each
// passes a ShapeHost. A request, a read of the page's address or storage, or an
// import of an app's own code (the guide chain, code review, the Inbox, the
// server-side shared package) in this folder is the regression this guards:
// the board would work in one host and fail in the next. The guide chain and
// the code hover card come in as props for exactly this reason.

const root = resolve(import.meta.dir, '..');
const UI = join(root, 'packages/ui');
const SHAPE = join(UI, 'components/shape');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]!);
}

/** ui's own files and the dependencies ui already ships with. */
function allowedImport(file: string, specifier: string): boolean {
  if (specifier.startsWith('.')) return resolve(dirname(file), specifier).startsWith(`${UI}/`);
  return /^(react|react-dom|@plannotator\/core|@pierre\/diffs|dompurify)(\/|$)/.test(specifier);
}

const REACHES_THE_HOST: readonly [RegExp, string][] = [
  [/\bfetch\s*\(|\bEventSource\b|\bXMLHttpRequest\b|\bnew WebSocket\b|\/api\//, 'a request to a server'],
  [/\blocation\.(hash|href|search|pathname)\b|\bhashchange\b|\bhistory\.(push|replace)State\b/, "the page's address"],
  [/\bdocument\.cookie\b|\blocalStorage\b|\bsessionStorage\b/, "the browser's storage"],
];

describe('the Shape board stays host-neutral', () => {
  const files = sourceFiles(SHAPE);

  test('the folder has files to check', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  test('it imports only ui, core, React and ui’s own dependencies', () => {
    const offenders = files.flatMap((file) =>
      importsOf(withoutComments(readFileSync(file, 'utf8')))
        .filter((specifier) => !allowedImport(file, specifier))
        .map((specifier) => `${relative(root, file)}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  test('it makes no request and reads no address, cookie or storage', () => {
    const offenders = files.flatMap((file) =>
      withoutComments(readFileSync(file, 'utf8'))
        .split('\n')
        .flatMap((line, index) =>
          REACHES_THE_HOST.filter(([pattern]) => pattern.test(line)).map(([, what]) => `${relative(root, file)}:${index + 1}: ${what}: ${line.trim()}`),
        ),
    );
    expect(offenders).toEqual([]);
  });
});
