import { describe, expect, test } from 'bun:test';
import {
  buildSourceWatchSubscription,
  dirnameBrowserPath,
  normalizeBrowserPath,
  pathIsInsideDir,
} from './sourceDocumentPaths';

describe('source document path helpers', () => {
  test('normalizes separators and trailing slashes', () => {
    expect(normalizeBrowserPath('C:\\repo\\docs\\')).toBe('C:/repo/docs');
    expect(normalizeBrowserPath('/repo/docs//plan.md')).toBe('/repo/docs/plan.md');
    expect(normalizeBrowserPath('/repo/docs/')).toBe('/repo/docs');
    expect(normalizeBrowserPath('/')).toBe('/');
    expect(normalizeBrowserPath('C:/')).toBe('C:/');
  });

  test('returns a browser-style dirname', () => {
    expect(dirnameBrowserPath('/repo/docs/a.md')).toBe('/repo/docs');
    expect(dirnameBrowserPath('/a.md')).toBe('/');
    expect(dirnameBrowserPath('C:\\note.md')).toBe('C:/');
    expect(dirnameBrowserPath('C:\\repo\\note.md')).toBe('C:/repo');
    expect(dirnameBrowserPath('a.md')).toBe('a.md');
  });

  test('checks whether a file is inside a watched directory', () => {
    expect(pathIsInsideDir('/repo/docs/a.md', '/repo/docs/')).toBe(true);
    expect(pathIsInsideDir('/repo/docs/a.md', '/')).toBe(true);
    expect(pathIsInsideDir('/repo/docs-extra/a.md', '/repo/docs')).toBe(false);
    expect(pathIsInsideDir('C:\\repo\\docs\\a.md', 'C:/repo/docs')).toBe(true);
    expect(pathIsInsideDir('C:\\note.md', 'C:/')).toBe(true);
    expect(pathIsInsideDir('/repo/docs/a.md', '')).toBe(false);
  });

  test('builds a stable exact-file watch subscription from Unix paths', () => {
    const subscription = buildSourceWatchSubscription([
      '/repo/docs/b.md',
      '',
      '/repo/docs/a.md',
      '/repo/docs/a.md',
      '/repo/notes/c.md',
    ]);

    expect(subscription).toEqual({
      query: [
        'filePath=%2Frepo%2Fdocs%2Fa.md',
        'filePath=%2Frepo%2Fdocs%2Fb.md',
        'filePath=%2Frepo%2Fnotes%2Fc.md',
      ].join('&'),
      dirs: ['/repo/docs', '/repo/notes'],
      key: ['/repo/docs/a.md', '/repo/docs/b.md', '/repo/notes/c.md'].join('\n'),
    });
  });

  test('normalizes and deduplicates Windows paths before building a subscription', () => {
    const subscription = buildSourceWatchSubscription([
      'C:\\repo\\notes\\b.md',
      'C:/repo/docs/a.md',
      'C:\\repo\\docs\\a.md',
      'C:\\repo\\notes\\b.md',
    ]);

    expect(subscription).toEqual({
      query: 'filePath=C%3A%2Frepo%2Fdocs%2Fa.md&filePath=C%3A%2Frepo%2Fnotes%2Fb.md',
      dirs: ['C:/repo/docs', 'C:/repo/notes'],
      key: 'C:/repo/docs/a.md\nC:/repo/notes/b.md',
    });
  });
});
