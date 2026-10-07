/**
 * `formatDraftAnnotationsForAsk` (#1748): the reviewer's unsubmitted
 * annotations as a plain list for an agent that answers a question, never in
 * the submitted-feedback shape it would carry out.
 */
import { describe, expect, test } from 'bun:test';
import { formatDraftAnnotationsForAsk, parseMarkdownToBlocks } from './parser';
import { AnnotationType, type Annotation, type CodeAnnotation } from '../types';

const BLOCKS = parseMarkdownToBlocks('# Plan\n\nStep one.\n\nStep two.\n');

function ann(id: string, fields: Partial<Annotation>): Annotation {
  return { id, blockId: 'block-1', startOffset: 0, endOffset: 0, type: AnnotationType.COMMENT, originalText: '', createdA: 1, ...fields } as Annotation;
}

describe('formatDraftAnnotationsForAsk', () => {
  test('one line per draft across the document, other documents and code files', () => {
    const list = formatDraftAnnotationsForAsk({
      annotations: [
        ann('g', { type: AnnotationType.GLOBAL_COMMENT, blockId: '', text: 'Overall:\n  too long' }),
        ann('c', { blockId: 'block-2', originalText: 'Step two.', text: 'why?', images: [{ path: '/tmp/a.png', name: 'mock' }] }),
        ann('r', { blockId: 'block-2', originalText: 'Step two.', text: 'never mind', inReplyTo: 'c' } as Partial<Annotation>),
        ann('q', { blockId: 'block-1', originalText: 'Step one.', text: 'Looks good', isQuickLabel: true } as Partial<Annotation>),
        ann('x', { blockId: 'block-1', originalText: 'Step one.', text: 'unused import', source: 'eslint' }),
      ],
      blocks: BLOCKS,
      globalAttachments: [{ path: '/tmp/ref.png', name: 'ref' }],
      documents: new Map([
        ['/repo/notes.md', { annotations: [ann('d', { text: 'stale', originalText: 'Old' })], globalAttachments: [] }],
      ]),
      codeAnnotations: [
        { id: 'k', type: 'comment', filePath: 'src/a.ts', lineStart: 3, lineEnd: 4, side: 'new', text: 'rename', originalCode: 'let x = 1;' } as CodeAnnotation,
      ],
    });

    expect(list.split('\n')).toEqual([
      'Draft 1: general note — Overall: too long',
      'Draft 2 (line 3): label "Looks good" on "Step one."',
      'Draft 3 (line 3): comment on "Step one." — unused import (from eslint)',
      'Draft 4 (line 5): comment on "Step two." — why? (attached: [mock] /tmp/a.png)',
      'Draft 5 (line 5): reply to draft 4 — never mind',
      'Draft 6 (/repo/notes.md): comment on "Old" — stale',
      'Draft 7 (src/a.ts, lines 3–4): comment on "let x = 1;" — rename',
      'Reference images: [ref] /tmp/ref.png',
    ]);
    expect(list).not.toContain('Feedback on');
    expect(list).not.toContain('piece');
  });

  test('empty when there are no drafts', () => {
    expect(formatDraftAnnotationsForAsk({ annotations: [] })).toBe('');
  });
});
