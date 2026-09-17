/**
 * The export's location line for a comment made on a rendered diagram part.
 *
 * What regresses: the agent reading the feedback sees `Feedback on:
 * "Approve?"` with no way to find the node in the fence — the part id and
 * the document line are the grep handles; or a malformed anchor from
 * another writer throws instead of being skipped; or every other
 * annotation's export changes.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation, type Block } from '../types';
import { exportAnnotations, parseMarkdownToBlocks } from './parser';

const MARKDOWN = ['# Plan', '', 'Some prose.', '', '```mermaid', 'flowchart LR', '  U --> D{Approve?}', '  D -->|Yes| M', '```', '', 'More prose.'].join('\n');

function blocks(): Block[] {
  return parseMarkdownToBlocks(MARKDOWN);
}

describe('exportAnnotations: diagram anchors', () => {
  test('a diagram comment prints the location line under its heading', () => {
    const fence = blocks().find((b) => b.type === 'code')!;
    const ann: Annotation = {
      id: 'd1',
      blockId: fence.id,
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.COMMENT,
      text: 'Rename this step',
      originalText: 'Approve?',
      createdA: 1,
      diagramAnchor: { v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [7, 7] },
    };
    const out = exportAnnotations(blocks(), [ann]);
    expect(out).toContain('Feedback on: "Approve?"\nDiagram node Approve? (D), line 7\n> Rename this step');
    // The fence's own line range still leads the heading.
    expect(out).toContain('(lines 5–9) Feedback on: "Approve?"');
  });

  test('a malformed anchor is skipped and a text comment is byte-identical to before', () => {
    const fence = blocks().find((b) => b.type === 'code')!;
    const base: Annotation = {
      id: 't1',
      blockId: fence.id,
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.COMMENT,
      text: 'note',
      originalText: 'Approve?',
      createdA: 1,
    };
    const plain = exportAnnotations(blocks(), [base]);
    const malformed = exportAnnotations(blocks(), [{ ...base, diagramAnchor: { kind: 'node' } as never }]);
    expect(malformed).toBe(plain);
    expect(plain).not.toContain('Diagram node');
  });
});
