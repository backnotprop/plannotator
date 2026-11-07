import { describe, expect, test } from 'bun:test';
import { fileRefOf, looksLikeFilePath } from './fileRefs';

describe('what names a file (design prototype file-refs-open-pane)', () => {
  test('a code span names code, documents, pictures and films, with its lines', () => {
    expect(fileRefOf('src/retry/worker.ts:42')).toEqual({ path: 'src/retry/worker.ts', line: 42 });
    expect(fileRefOf('src/a.ts:6-13')).toEqual({ path: 'src/a.ts', line: 6, lineEnd: 13 });
    expect(fileRefOf('README.md')).toEqual({ path: 'README.md' });
    expect(fileRefOf('shots/after.png')).toEqual({ path: 'shots/after.png' });
    expect(fileRefOf('demo/clip.mp4')).toEqual({ path: 'demo/clip.mp4' });
  });
  test('words that are not a file stay words', () => {
    for (const words of ['Node.js', 'e.g.', 'RETRY_KEY_V2', 'backoffMs', 'https://example.com/a.md', 'a b.md', 'charge.lookup', '#123', 'docs/']) {
      expect(looksLikeFilePath(words)).toBe(false);
    }
  });
  test('a bare path in the text needs a folder', () => {
    expect(looksLikeFilePath('plan.md', true)).toBe(false);
    expect(looksLikeFilePath('docs/plan.md', true)).toBe(true);
  });
});
