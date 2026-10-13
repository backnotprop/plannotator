/**
 * A linked/folder document's feedback is rendered by the SAME entry renderer
 * as the root document's (`exportAnnotations`), so it carries the same
 * fidelity.
 *
 * Failures to catch:
 *  - Entries in string order of their block ids (block-10 before block-2)
 *    instead of document order.
 *  - A reply exported as its own numbered entry instead of nested under its
 *    parent's **Replies:**.
 *  - A version-diff comment losing its `[In diff content]` label.
 *  - A quick label exported as a plain quote, losing its `[Label]` heading,
 *    its tip and the Label Summary.
 *  - Plain comment/deletion/global output for linked docs drifting from the
 *    format main shipped.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation } from '../types';
import { exportAnnotations, exportLinkedDocAnnotations, parseMarkdownToBlocks } from './parser';

const DOC = '/repo/docs/long.md';
const MARKDOWN = Array.from({ length: 12 }, (_, i) => `Paragraph number ${i + 1} text.`).join('\n\n');
const BLOCKS = parseMarkdownToBlocks(MARKDOWN);

function comment(id: string, blockId: string, text: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    blockId,
    startOffset: 0,
    endOffset: 9,
    type: AnnotationType.COMMENT,
    text,
    originalText: 'Paragraph',
    createdA: Number(id.replace(/\D/g, '')) || 1,
    ...extra,
  };
}

const ANNOTATIONS: Annotation[] = [
  comment('c10', 'block-10', 'ON-BLOCK-TEN'),
  comment('c2', 'block-2', 'ON-BLOCK-TWO'),
  comment('r1', 'block-2', 'A-REPLY', { inReplyTo: 'c2', author: 'agent', createdA: 50 }),
  comment('d1', 'block-5', 'IN-THE-DIFF', { diffContext: 'added' }),
  comment('q1', 'block-7', 'Needs tests', { isQuickLabel: true, quickLabelTip: 'Add a test for this.' } as Partial<Annotation>),
];

function linked(annotations: Annotation[], withBlocks = true): string {
  return exportLinkedDocAnnotations(new Map([[DOC, {
    annotations,
    globalAttachments: [],
    markdown: MARKDOWN,
    ...(withBlocks ? { blocks: BLOCKS } : {}),
  }]]));
}

describe('linked-document export fidelity', () => {
  test('entries follow document order, block 2 before block 10', () => {
    const out = linked(ANNOTATIONS);
    expect(out.indexOf('ON-BLOCK-TWO')).toBeLessThan(out.indexOf('ON-BLOCK-TEN'));
    expect(out).toContain('### 1. (line 5)');
    // Without blocks the ids still compare numerically.
    const bare = linked(ANNOTATIONS, false);
    expect(bare.indexOf('ON-BLOCK-TWO')).toBeLessThan(bare.indexOf('ON-BLOCK-TEN'));
  });

  test('a reply nests under its parent instead of taking a number', () => {
    const out = linked(ANNOTATIONS);
    expect(out).toContain('**Replies:**\n- **Reply (agent):** A-REPLY\n');
    expect(out.indexOf('A-REPLY')).toBeGreaterThan(out.indexOf('ON-BLOCK-TWO'));
    expect(out.indexOf('A-REPLY')).toBeLessThan(out.indexOf('IN-THE-DIFF'));
    // Four numbered entries (the reply is not one).
    expect(out).toContain('### 4. ');
    expect(out).not.toContain('### 5. ');
  });

  test('a version-diff comment keeps its [In diff content] label', () => {
    expect(linked(ANNOTATIONS)).toContain('[In diff content] Feedback on: "Paragraph"');
  });

  test('a quick label keeps its heading, tip and Label Summary', () => {
    const out = linked(ANNOTATIONS);
    expect(out).toContain('[Needs tests] Feedback on: "Paragraph"\n> Add a test for this.\n');
    expect(out).toContain('### Label Summary\n\n- **Needs tests**: 1\n');
  });

  test('a linked document renders the same entries the root export does', () => {
    // Same renderer: the root's entries one heading level up.
    const root = exportAnnotations(BLOCKS, ANNOTATIONS, [], 'Plan Feedback', 'document');
    const rootEntries = root.slice(root.indexOf('## 1. '), root.indexOf('---\n'));
    const out = linked(ANNOTATIONS);
    const linkedEntries = out.slice(out.indexOf('### 1. '), out.indexOf('### Label Summary'));
    expect(linkedEntries).toBe(rootEntries.replace(/^## /gm, '### '));
  });

  test('plain comments, deletions and globals keep the format main shipped', () => {
    const out = exportLinkedDocAnnotations(new Map([[DOC, {
      annotations: [
        { ...comment('c1', 'block-0', 'Rename this'), createdA: 1 },
        {
          id: 'x1', blockId: 'block-1', startOffset: 0, endOffset: 9,
          type: AnnotationType.DELETION, originalText: 'Paragraph', createdA: 2,
        },
        {
          id: 'g1', blockId: '', startOffset: 0, endOffset: 0,
          type: AnnotationType.GLOBAL_COMMENT, text: 'Overall fine', originalText: '', createdA: 3,
        },
      ],
      globalAttachments: [],
      markdown: MARKDOWN,
      blocks: BLOCKS,
    }]]));
    // Pinned on purpose: this is the agent-facing export format, unchanged for
    // these annotation kinds by the shared renderer.
    expect(out).toBe(
      '\n# Linked Document Feedback\n\nThe following feedback is on documents referenced in the plan.\n\n' +
      `## ${DOC}\n\n` +
      "I've reviewed this document and have 3 pieces of feedback:\n\n" +
      '### 1. General feedback about the document\n> Overall fine\n\n' +
      '### 2. (line 1) Feedback on: "Paragraph"\n> Rename this\n\n' +
      '### 3. (line 3) Remove this\n```\nParagraph\n```\n> I don\'t want this in the document.\n\n' +
      '---\n',
    );
  });
});

describe('main-document order for block ids missing from the document', () => {
  // Failure caught: two comments whose (different) block ids are both absent
  // from `blocks` tied at position -1 and kept insertion order, reordering the
  // root export that main sorted by offset.
  test('ties on block position fall through to the offset', () => {
    const stale = comment('s1', 'block-stale', 'LATER-OFFSET', { startOffset: 40 });
    const general = comment('g1', '', 'EARLIER-OFFSET', { startOffset: 0 });
    const out = exportAnnotations(BLOCKS, [stale, general]);
    expect(out.indexOf('EARLIER-OFFSET')).toBeLessThan(out.indexOf('LATER-OFFSET'));
  });
});
