/**
 * Where version-diff comments land in exported feedback.
 *
 * A comment made in the plan/version diff view carries `blockId`
 * `diff-block-N`: N indexes the diff against the selected base, and nothing on
 * the annotation maps it back to a document block. They used to rank -1 and
 * print FIRST in a document's feedback, ahead of comments that come before the
 * changed text.
 *
 * Failures to catch:
 *  - Diff comments sorting ahead of the document's own comments again.
 *  - Diff comments out of diff order (diff-block-10 before diff-block-2).
 *  - The `[In diff content]` label disappearing.
 *  - Any change to the order of a document with NO diff comments (the root
 *    export must stay byte-identical; fuzzed against the pre-fix comparator).
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation, type Block } from '../types';
import { exportAnnotations, exportLinkedDocAnnotations, parseMarkdownToBlocks } from './parser';

const MARKDOWN = Array.from({ length: 12 }, (_, i) => `Paragraph number ${i + 1} text.`).join('\n\n');
const BLOCKS = parseMarkdownToBlocks(MARKDOWN);

function ann(id: string, blockId: string, text: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    blockId,
    startOffset: 0,
    endOffset: 9,
    type: AnnotationType.COMMENT,
    text,
    originalText: 'Paragraph',
    createdA: 1,
    ...extra,
  };
}

const MIXED: Annotation[] = [
  ann('d10', 'diff-block-10', 'DIFF-TEN', { diffContext: 'added', originalText: 'New paragraph' }),
  ann('late', 'block-11', 'AFTER-THE-CHANGE'),
  ann('d2', 'diff-block-2', 'DIFF-TWO', { diffContext: 'modified', originalText: '- old\n+ new' }),
  ann('early', 'block-1', 'BEFORE-THE-CHANGE'),
];

function positions(out: string, markers: string[]): number[] {
  return markers.map((m) => {
    const at = out.indexOf(m);
    expect(at).toBeGreaterThanOrEqual(0);
    return at;
  });
}

describe('version-diff comments in exported feedback', () => {
  test('root export: document comments first, then diff comments in diff order', () => {
    const out = exportAnnotations(BLOCKS, MIXED);
    const order = positions(out, ['BEFORE-THE-CHANGE', 'AFTER-THE-CHANGE', 'DIFF-TWO', 'DIFF-TEN']);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain('## 3. [In diff content] Feedback on:');
    expect(out).toContain('## 4. [In diff content] Feedback on: "New paragraph"');
  });

  test('linked document export puts them in the same place, with and without blocks', () => {
    for (const withBlocks of [true, false]) {
      const out = exportLinkedDocAnnotations(new Map([['/repo/doc.md', {
        annotations: MIXED,
        globalAttachments: [],
        markdown: MARKDOWN,
        ...(withBlocks ? { blocks: BLOCKS } : {}),
      }]]));
      const order = positions(out, ['BEFORE-THE-CHANGE', 'AFTER-THE-CHANGE', 'DIFF-TWO', 'DIFF-TEN']);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
  });

  test('a global comment keeps its place ahead of the document', () => {
    const global = ann('g', '', 'GLOBAL-NOTE', { type: AnnotationType.GLOBAL_COMMENT, originalText: '' });
    const out = exportAnnotations(BLOCKS, [...MIXED, global]);
    const order = positions(out, ['GLOBAL-NOTE', 'BEFORE-THE-CHANGE', 'DIFF-TWO']);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // The pre-fix comparator, verbatim: with no diff comments the export must
  // not move a single entry.
  const preFixSort = (annotations: Annotation[], blocks: Block[]) => {
    const order = new Map<string, number>();
    blocks.forEach((blk, index) => order.set(blk.id, index));
    return [...annotations].sort((a, b) => {
      if (a.blockId !== b.blockId) {
        const byBlock = (order.get(a.blockId) ?? -1) - (order.get(b.blockId) ?? -1);
        if (byBlock) return byBlock;
      }
      return a.startOffset - b.startOffset;
    });
  };

  test('without diff comments the root export is byte-identical to the pre-fix order (fuzzed)', () => {
    let seed = 1696;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const ids = [...BLOCKS.map((b) => b.id), '', 'external', 'global', 'block-99'];
    for (let round = 0; round < 200; round += 1) {
      const count = 1 + rand(8);
      const annotations = Array.from({ length: count }, (_, i) => ann(
        `a${round}-${i}`,
        ids[rand(ids.length)]!,
        `TEXT-${round}-${i}`,
        { startOffset: rand(5) },
      ));
      // Every entry's text is unique, so its position in the output is its rank.
      const out = exportAnnotations(BLOCKS, annotations);
      const expected = preFixSort(annotations, BLOCKS).map((a) => a.text!);
      for (const text of expected) expect(out).toContain(text);
      const emitted = [...expected].sort((x, y) => out.indexOf(x) - out.indexOf(y));
      expect(emitted).toEqual(expected);
    }
  });
});
