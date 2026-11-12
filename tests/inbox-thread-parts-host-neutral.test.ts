import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const UI = join(root, 'packages/ui');
const PARTS = join(UI, 'components/inbox-thread');

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
  const found = source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g);
  return [...found].map((match) => match[1]!);
}

function allowedImport(file: string, specifier: string): boolean {
  if (specifier.startsWith('.')) return resolve(dirname(file), specifier).startsWith(`${UI}/`);
  return /^(react|react-dom|@base-ui\/react|@plannotator\/core)(\/|$)/.test(specifier);
}

const REACHES_THE_HOST: readonly [RegExp, string][] = [
  [/\bfetch\s*\(|\bEventSource\b|\bXMLHttpRequest\b|\bnew WebSocket\b|\/api\//, 'a request to a server'],
  [/\blocation\.(hash|href|search|pathname)\b|\bhashchange\b|\bhistory\.(push|replace)State\b/, "the page's address"],
  [/\bdocument\.cookie\b|\blocalStorage\b|\bsessionStorage\b/, "the browser's storage"],
];

describe('the Inbox thread parts stay host-neutral', () => {
  const files = sourceFiles(PARTS);

  test('the folder has parts to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test('a part imports only ui, core, React and Base UI', () => {
    const offenders = files.flatMap((file) => {
      const source = withoutComments(readFileSync(file, 'utf8'));
      return importsOf(source)
        .filter((specifier) => !allowedImport(file, specifier))
        .map((specifier) => `${relative(root, file)}: ${specifier}`);
    });
    expect(offenders).toEqual([]);
  });

  test('a part makes no request and reads no address, cookie or storage', () => {
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
