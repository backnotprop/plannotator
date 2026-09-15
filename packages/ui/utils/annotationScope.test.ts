/**
 * Cross-file annotation scope.
 *
 * Regressions guarded:
 *  - The open document must sort first no matter where its path falls
 *    alphabetically; everything else is ordered by path so the list is stable
 *    across navigations (a creation-time or Map-insertion order would reshuffle
 *    the panel every time a file is opened).
 *  - Documents with no feedback must not produce empty groups: the view answers
 *    "where is my feedback", and empty headers would bury the real ones.
 *  - The default-scope rule: an open file with nothing on it while other files
 *    carry feedback is exactly the situation the feature exists for, so it must
 *    open on All files even though the stored preference says This file.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation } from '../types';
import {
  documentLabel,
  groupAnnotationsByDocument,
  resolveInitialAnnotationScope,
} from './annotationScope';

function ann(id: string): Annotation {
  return {
    id,
    blockId: 'b1',
    startOffset: 0,
    endOffset: 1,
    type: AnnotationType.COMMENT,
    originalText: 'x',
    createdA: 1,
  };
}

describe('groupAnnotationsByDocument', () => {
  test('puts the open document first and orders the rest by path', () => {
    const groups = groupAnnotationsByDocument(
      [
        { path: '/repo/notes/zeta.md', annotations: [ann('z1')] },
        { path: '/repo/notes/middle.md', annotations: [ann('m1'), ann('m2')] },
        { path: '/repo/notes/alpha.md', annotations: [ann('a1')] },
      ],
      '/repo/notes/zeta.md',
      ['/repo/notes'],
    );

    expect(groups.map((g) => g.path)).toEqual([
      '/repo/notes/zeta.md',
      '/repo/notes/alpha.md',
      '/repo/notes/middle.md',
    ]);
    expect(groups[0].isCurrent).toBe(true);
    expect(groups.slice(1).every((g) => !g.isCurrent)).toBe(true);
    expect(groups[2].annotations).toHaveLength(2);
  });

  test('drops documents with no annotations, including the open one', () => {
    const groups = groupAnnotationsByDocument(
      [
        { path: '/repo/open.md', annotations: [] },
        { path: '/repo/other.md', annotations: [ann('o1')] },
      ],
      '/repo/open.md',
      ['/repo'],
    );

    expect(groups.map((g) => g.path)).toEqual(['/repo/other.md']);
  });

  test('labels documents relative to the deepest containing root', () => {
    expect(documentLabel('/repo/docs/deep/notes.md', ['/repo'])).toBe('docs/deep/notes.md');
    expect(documentLabel('/repo/docs/deep/notes.md', ['/repo', '/repo/docs'])).toBe('deep/notes.md');
    // No root contains it — the bare file name is still a usable handle.
    expect(documentLabel('/elsewhere/notes.md', ['/repo'])).toBe('notes.md');
  });

  test('normalizes separators so a Windows path matches its root and the open document', () => {
    const groups = groupAnnotationsByDocument(
      [{ path: 'C:\\repo\\docs\\a.md', annotations: [ann('a1')] }],
      'C:/repo/docs/a.md',
      ['C:\\repo'],
    );

    expect(groups[0].isCurrent).toBe(true);
    expect(groups[0].label).toBe('docs/a.md');
  });
});

describe('resolveInitialAnnotationScope', () => {
  test('opens on All files when the open document is empty and others are not', () => {
    expect(resolveInitialAnnotationScope({ saved: 'current', currentCount: 0, otherCount: 3 })).toBe('all');
    expect(resolveInitialAnnotationScope({ saved: null, currentCount: 0, otherCount: 1 })).toBe('all');
  });

  test('keeps This file when the open document has feedback of its own', () => {
    expect(resolveInitialAnnotationScope({ saved: null, currentCount: 2, otherCount: 5 })).toBe('current');
    expect(resolveInitialAnnotationScope({ saved: 'current', currentCount: 1, otherCount: 0 })).toBe('current');
  });

  test('keeps This file when nothing exists anywhere', () => {
    expect(resolveInitialAnnotationScope({ saved: null, currentCount: 0, otherCount: 0 })).toBe('current');
  });

  test('honours a saved All files choice across navigation', () => {
    expect(resolveInitialAnnotationScope({ saved: 'all', currentCount: 4, otherCount: 0 })).toBe('all');
  });
});
