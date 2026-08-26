/**
 * Out-of-diff annotation round-trip: snippet resolution → export.
 *
 * The regression these guard is the one the design doc names as the single
 * integration fix full-file review needs. `extractLinesFromPatch` only walks
 * hunk lines, so before this an annotation on expanded context — or on any
 * line of a full-file view — reached the agent with an EMPTY snippet and no
 * indication its lines were absent from the patch. The agent then hunted for
 * `file.ts:500` in a diff whose only hunk is at line 3.
 */
import { describe, expect, it } from 'bun:test';
import {
  extractLinesFromContent,
  extractLinesFromPatch,
  resolveAnnotationSnippet,
} from './patchParser';
import { exportReviewFeedback } from './exportFeedback';
import type { CodeAnnotation } from '@plannotator/ui/types';

// A patch touching only lines 1-3 of a much longer file.
const PATCH = [
  'diff --git a/src/alpha.ts b/src/alpha.ts',
  '--- a/src/alpha.ts',
  '+++ b/src/alpha.ts',
  '@@ -1,3 +1,3 @@',
  '-const a = 0;',
  '+const a = 1;',
  ' const b = 2;',
  ' const c = 3;',
].join('\n');

const FILE_CONTENT = [
  'const a = 1;', // 1
  'const b = 2;', // 2
  'const c = 3;', // 3
  'const d = 4;', // 4
  'const e = 5;', // 5
  'const f = 6;', // 6
].join('\n');

const ann = (overrides: Partial<CodeAnnotation> = {}): CodeAnnotation => ({
  id: '1',
  type: 'comment',
  filePath: 'src/alpha.ts',
  lineStart: 5,
  lineEnd: 6,
  side: 'new',
  text: 'This helper is dead code',
  createdAt: 1,
  ...overrides,
});

describe('extractLinesFromContent', () => {
  it('slices a 1-based inclusive range', () => {
    expect(extractLinesFromContent(FILE_CONTENT, 5, 6)).toBe('const e = 5;\nconst f = 6;');
    expect(extractLinesFromContent(FILE_CONTENT, 1, 1)).toBe('const a = 1;');
  });

  it('returns empty for nonsense ranges rather than throwing', () => {
    expect(extractLinesFromContent(FILE_CONTENT, 0, 2)).toBe('');
    expect(extractLinesFromContent(FILE_CONTENT, 4, 2)).toBe('');
    expect(extractLinesFromContent('', 1, 2)).toBe('');
  });
});

describe('resolveAnnotationSnippet', () => {
  it('returns nothing from the patch alone for lines outside every hunk', () => {
    // This is the pre-existing bug, pinned so the fallback below is meaningful.
    expect(extractLinesFromPatch(PATCH, 5, 6, 'new')).toBe('');
  });

  it('falls back to file content for lines outside every hunk', () => {
    expect(resolveAnnotationSnippet(PATCH, FILE_CONTENT, 5, 6, 'new')).toBe(
      'const e = 5;\nconst f = 6;',
    );
  });

  it('still prefers the patch for lines inside a hunk', () => {
    // The patch is the authority where it has an answer: it distinguishes
    // sides, which raw file content cannot.
    expect(resolveAnnotationSnippet(PATCH, FILE_CONTENT, 1, 1, 'new')).toBe('const a = 1;');
    expect(resolveAnnotationSnippet(PATCH, FILE_CONTENT, 1, 1, 'old')).toBe('const a = 0;');
  });

  it('works with no patch at all (a file absent from the diff)', () => {
    expect(resolveAnnotationSnippet('', FILE_CONTENT, 2, 3, 'new')).toBe(
      'const b = 2;\nconst c = 3;',
    );
  });

  it('never quotes working-tree content for an old-side range', () => {
    // The working tree is the NEW side; using it for an old-side range would
    // quote text that never existed at the base.
    expect(resolveAnnotationSnippet(PATCH, FILE_CONTENT, 5, 6, 'old')).toBe('');
  });
});

describe('exportReviewFeedback with out-of-diff annotations', () => {
  it('labels the annotation and fences the code the patch does not contain', () => {
    const output = exportReviewFeedback([
      ann({ outsideDiff: true, originalCode: 'const e = 5;\nconst f = 6;' }),
    ]);

    expect(output).toContain('src/alpha.ts');
    expect(output).toContain('Lines 5-6');
    // The label — deliberate wording so the agent stops looking in the patch.
    expect(output).toContain('Outside diff');
    expect(output).toContain('not part of the diff under review');
    // The code itself, fenced.
    expect(output).toContain('**Code at these lines:**');
    expect(output).toContain('const e = 5;\nconst f = 6;');
    // Not mislabeled as a suggestion: nothing is being replaced.
    expect(output).not.toContain('**Replaces:**');
  });

  it('leaves ordinary in-diff annotations untouched', () => {
    const output = exportReviewFeedback([ann({ lineStart: 1, lineEnd: 1 })]);
    expect(output).not.toContain('Outside diff');
    expect(output).not.toContain('**Code at these lines:**');
  });

  it('keeps the Replaces block when an out-of-diff comment carries a suggestion', () => {
    // A suggestion still needs its verifiable anchor, and printing the same
    // lines twice would invite the agent to apply them twice.
    const output = exportReviewFeedback([
      ann({
        outsideDiff: true,
        originalCode: 'const e = 5;',
        suggestedCode: 'const e = 50;',
      }),
    ]);
    expect(output).toContain('Outside diff');
    expect(output).toContain('**Replaces:**');
    expect(output).toContain('**Suggested code:**');
    expect(output).not.toContain('**Code at these lines:**');
  });

  it('carries the label through a mixed in-diff and out-of-diff review', () => {
    const output = exportReviewFeedback([
      ann({ id: 'a', lineStart: 1, lineEnd: 1, text: 'in the diff' }),
      ann({
        id: 'b',
        lineStart: 5,
        lineEnd: 6,
        text: 'outside the diff',
        outsideDiff: true,
        originalCode: 'const e = 5;\nconst f = 6;',
      }),
    ]);
    expect(output).toContain('in the diff');
    expect(output).toContain('outside the diff');
    expect(output.match(/Outside diff/g)?.length).toBe(1);
  });
});
