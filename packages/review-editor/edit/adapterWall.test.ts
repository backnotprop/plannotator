import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Adapter-wall invariant: every reference to Pierre's experimental
 * `@pierre/diffs/edit` entry must live in exactly one module,
 * packages/review-editor/edit/pierreEditAdapter.ts, so an upstream rename is
 * a one-file fix. App code imports the adapter, never the entry.
 */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SCAN_ROOTS = ['packages', 'apps'];
const ALLOWED = 'packages/review-editor/edit/pierreEditAdapter.ts';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'vendor', 'legacy']);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) yield full;
  }
}

describe('pierre edit adapter wall', () => {
  test('only pierreEditAdapter.ts references @pierre/diffs/edit', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        if (rel === ALLOWED || rel.endsWith('adapterWall.test.ts')) continue;
        const content = readFileSync(file, 'utf8');
        if (content.includes('@pierre/diffs/edit')) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the adapter itself only imports the edit entry lazily or as types', () => {
    const content = readFileSync(join(REPO_ROOT, ALLOWED), 'utf8');
    // Static VALUE imports of the edit entry would defeat the lazy chunk.
    // `import type` and `typeof import(...)` are type-only; the single
    // runtime reference must be a dynamic import().
    const staticValueImport = /^import\s+(?!type\b)[^;]*from\s+['"]@pierre\/diffs\/edit['"]/m;
    expect(staticValueImport.test(content)).toBe(false);
    expect(content.includes("import('@pierre/diffs/edit')")).toBe(true);
  });
});
