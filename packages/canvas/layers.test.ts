import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The layer rule: a folder imports only from itself and the folders listed
 * for it. `react` and `snapshot` importing each other, or `model` reaching
 * for the screen, fails here.
 */
const MAY_IMPORT: Record<string, string[]> = {
  model: [],
  events: ['model'],
  view: ['model', 'events'],
  react: ['model', 'events', 'view'],
  snapshot: ['model', 'events', 'view', 'react'],
  // Server-side: no screen, no store.
  unfurl: ['model'],
};

const root = import.meta.dir;
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s+['"](\.\.?\/[^'"]+)['"]|import\s+['"](\.\.?\/[^'"]+)['"]/g;

describe('layers', () => {
  for (const [layer, allowed] of Object.entries(MAY_IMPORT)) {
    test(`${layer}/ imports only ${allowed.length ? allowed.join(', ') : 'itself'}`, () => {
      const upward: string[] = [];
      for (const file of readdirSync(join(root, layer))) {
        if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
        const source = readFileSync(join(root, layer, file), 'utf8');
        for (const match of source.matchAll(IMPORT_RE)) {
          const target = (match[1] ?? match[2]).split('/');
          if (target[0] !== '..') continue;
          if (!allowed.includes(target[1])) upward.push(`${layer}/${file} imports ${target.slice(1).join('/')}`);
        }
      }
      expect(upward).toEqual([]);
    });
  }

  test('every source folder has a rule', () => {
    const folders = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !['node_modules', 'demo', 'bench'].includes(entry.name))
      .map((entry) => entry.name);
    expect(folders.sort()).toEqual(Object.keys(MAY_IMPORT).sort());
  });
});
