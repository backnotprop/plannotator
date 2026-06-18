import { describe, expect, test } from 'bun:test';
import { dirnameBrowserPath, normalizeBrowserPath, pathIsInsideDir } from './sourceDocumentPaths';

describe('source document path helpers', () => {
  test('normalizes separators and trailing slashes', () => {
    expect(normalizeBrowserPath('C:\\repo\\docs\\')).toBe('C:/repo/docs');
    expect(normalizeBrowserPath('/repo/docs/')).toBe('/repo/docs');
    expect(normalizeBrowserPath('/')).toBe('/');
  });

  test('returns a browser-style dirname', () => {
    expect(dirnameBrowserPath('/repo/docs/a.md')).toBe('/repo/docs');
    expect(dirnameBrowserPath('/a.md')).toBe('/');
    expect(dirnameBrowserPath('a.md')).toBe('a.md');
  });

  test('checks whether a file is inside a watched directory', () => {
    expect(pathIsInsideDir('/repo/docs/a.md', '/repo/docs/')).toBe(true);
    expect(pathIsInsideDir('/repo/docs-extra/a.md', '/repo/docs')).toBe(false);
    expect(pathIsInsideDir('C:\\repo\\docs\\a.md', 'C:/repo/docs')).toBe(true);
  });
});
