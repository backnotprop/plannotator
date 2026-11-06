import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// The Inbox window imports @plannotator/system. If anything it reaches imports
// node:fs, git or a Bun API, the window's bundle breaks. Walk the import graph
// from the browser entry and fail on the first Node or Bun import.
function graph(entry: string, seen = new Set<string>(), bad: string[] = []): string[] {
  if (seen.has(entry)) return bad;
  seen.add(entry);
  const text = readFileSync(entry, 'utf8');
  if (/\bBun\./.test(text) || /\bprocess\./.test(text)) bad.push(`${entry}: uses Bun or process`);
  for (const m of text.matchAll(/^\s*(?:import|export)[^'"]*from\s+'([^']+)'/gm)) {
    const spec = m[1]!;
    if (spec.startsWith('.')) graph(resolve(dirname(entry), spec), seen, bad);
    else if (spec.startsWith('node:') || spec.startsWith('bun') || ['fs', 'path', 'child_process', 'os'].includes(spec)) bad.push(`${entry}: imports ${spec}`);
  }
  return bad;
}

describe('the browser entry', () => {
  test('reaches no Node or Bun code', () => {
    expect(graph(join(import.meta.dir, '..', 'src', 'index.ts'))).toEqual([]);
  });
});
