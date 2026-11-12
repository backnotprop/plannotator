import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function specifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /^\s*(?:import|export)\b[^'";]*?\bfrom\s*(['"])([^'"]+)\1/gm,
    /^\s*import\s*(['"])([^'"]+)\1/gm,
    /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[2]!);
  return out;
}

const NODE_BUILTINS = ['fs', 'path', 'child_process', 'os', 'crypto', 'url', 'util', 'stream', 'process', 'module'];

function graph(entry: string, seen = new Set<string>(), bad: string[] = []): string[] {
  if (seen.has(entry)) return bad;
  seen.add(entry);
  const text = readFileSync(entry, 'utf8');
  if (/\bBun\./.test(text) || /\bprocess\./.test(text)) bad.push(`${entry}: uses Bun or process`);
  if (/\bimport\s*\(\s*[^'"`\s)]/.test(text)) bad.push(`${entry}: imports a computed path`);
  for (const spec of specifiers(text)) {
    if (spec.startsWith('.')) graph(resolve(dirname(entry), spec), seen, bad);
    else if (spec.startsWith('node:') || spec === 'bun' || spec.startsWith('bun:') || NODE_BUILTINS.includes(spec.split('/')[0]!)) {
      bad.push(`${entry}: imports ${spec}`);
    }
  }
  return bad;
}

describe('the browser entry', () => {
  test('reaches no Node or Bun code', () => {
    expect(graph(join(import.meta.dir, '..', 'src', 'index.ts'))).toEqual([]);
  });

  test('the React entry (the drawing, SystemThumb, SystemView) reaches no Node or Bun code', () => {
    const seen = new Set<string>();
    expect(graph(join(import.meta.dir, '..', 'src', 'react.ts'), seen)).toEqual([]);
    expect([...seen].some((f) => f.endsWith('SystemView.tsx'))).toBe(true);
    expect([...seen].some((f) => f.endsWith('route.ts'))).toBe(true);
  });

  test('the import scan sees every form of import', () => {
    const text = [
      `import { a } from "node:fs";`,
      `import 'node:path';`,
      `export * from './x.ts';`,
      `const m = await import("child_process");`,
      `const r = require('os');`,
      `import type { T } from 'bun:test';`,
    ].join('\n');
    expect(specifiers(text).sort()).toEqual(['./x.ts', 'bun:test', 'child_process', 'node:fs', 'node:path', 'os']);
  });
});
