/**
 * Where a hunk's "Call tree" entry goes and which function it opens.
 *
 * Regressions guarded:
 *  - the entry drawn on a line the diff does not show (it would vanish) or
 *    below the change instead of just above it;
 *  - a deletion-only hunk read on the new side;
 *  - sem's outer class chosen over the inner method around the hunk;
 *  - a hunk with no tree still getting an entry.
 */
import { describe, expect, test } from 'bun:test';
import type { SemanticDiffChange } from '@plannotator/shared/semantic-diff-types';
import { callTreeHunkTargets, functionAroundHunk, listPatchHunks } from './callTreeHunks';

const patch = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,6 +10,7 @@ class Note {',
  '   context10',
  '   context11',
  '   context12',
  '+  added13',
  '   context14',
  '   context15',
  '   context16',
  '@@ -40,4 +41,3 @@',
  '-  removed40',
  '   context41',
  '   context42',
  '   context43',
].join('\n');

function change(name: string, start: number, end: number, oldStart = start, oldEnd = end): SemanticDiffChange {
  return {
    entityId: name, changeType: 'modified', entityType: 'function', entityName: name, oldEntityName: null,
    filePath: 'src/a.ts', oldFilePath: null, startLine: start, endLine: end, oldStartLine: oldStart, oldEndLine: oldEnd, structuralChange: true,
  };
}

describe('listPatchHunks', () => {
  test('anchors under the last context line before the first change; a hunk starting with a change anchors on it', () => {
    const hunks = listPatchHunks({ path: 'src/a.ts', patch });
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ newStart: 10, newEnd: 16, firstChange: { side: 'new', line: 13 }, anchor: { side: 'new', line: 12 } });
    expect(hunks[1]).toMatchObject({ oldStart: 40, oldEnd: 43, firstChange: { side: 'old', line: 40 }, anchor: { side: 'old', line: 40 } });
  });
});

describe('functionAroundHunk', () => {
  test('picks the innermost changed entity around the first change, on the right side', () => {
    const [first, second] = listPatchHunks({ path: 'src/a.ts', patch });
    const changes = [change('Note', 1, 100), change('measure', 11, 20), change('other', 30, 50, 38, 45)];
    expect(functionAroundHunk(changes, first!)?.name).toBe('measure');
    // Old line 40 is inside `other` on the old side only.
    expect(functionAroundHunk(changes, second!)?.name).toBe('other');
    expect(functionAroundHunk([], first!)).toBeUndefined();
  });
});

describe('callTreeHunkTargets', () => {
  test('gives an entry only to hunks the analysis has a tree for', () => {
    const trees = [{
      entry: 'run',
      tree: {
        key: 'run', label: 'run()', status: 'same' as const, file: 'src/main.ts', line: 1,
        children: [{
          key: 'measure', label: 'note.measure()', status: 'same' as const, file: 'src/main.ts', line: 3,
          children: [{ key: 'x', label: 'added13()', status: 'added' as const, file: 'src/a.ts', line: 13, children: [] }],
        }],
      },
    }];
    const targets = callTreeHunkTargets([{ path: 'src/a.ts', patch }], trees, [change('measure', 11, 20)]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.hunk.index).toBe(0);
    expect(targets[0]!.doc.title).toBe('measure');
    expect(targets[0]!.doc.trail).toEqual(['run']);
  });
});
