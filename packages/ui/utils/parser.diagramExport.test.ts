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
import { exportAnnotationEntry, exportAnnotations, exportLinkedDocAnnotations, parseMarkdownToBlocks } from './parser';

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

describe('the other two export paths carry the location line too', () => {
  // What regresses: a folder / linked-doc annotate submit, and a single
  // copied entry, lose `Diagram node Approve? (D), line 7` while the main
  // export keeps it.
  const ann = (blockId: string): Annotation => ({
    id: 'd1',
    blockId,
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: 'Rename this step',
    originalText: 'Approve?',
    createdA: 1,
    diagramAnchor: { v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [7, 7] },
  });

  test('exportLinkedDocAnnotations', () => {
    const docBlocks = blocks();
    const fence = docBlocks.find((b) => b.type === 'code')!;
    const out = exportLinkedDocAnnotations(new Map([['docs/plan.md', { annotations: [ann(fence.id)], globalAttachments: [], blocks: docBlocks }]]));
    expect(out).toContain('Feedback on: "Approve?"\nDiagram node Approve? (D), line 7\n> Rename this step');
  });

  test('exportAnnotationEntry', () => {
    expect(exportAnnotationEntry(ann('block-x'))).toContain('Feedback on: "Approve?"\nDiagram node Approve? (D), line 7\n> Rename this step');
  });

  test('a whole-diagram comment prints the family and the fence range', () => {
    const whole: Annotation = { ...ann('block-x'), originalText: 'flowchart LR', diagramAnchor: { v: 1, family: 'flowchart', kind: 'diagram', label: 'flowchart LR', sourceLine: [6, 8] } };
    expect(exportAnnotationEntry(whole)).toContain('Diagram (flowchart), lines 6–8\n');
  });
});
