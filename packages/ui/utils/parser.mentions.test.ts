/**
 * `Annotation.mentions` is host data, not feedback: the ids a host's `@`
 * picker produced mean nothing to the coding agent reading the export, and
 * printing them would leak an opaque host identifier into the prompt.
 *
 * What this catches: an export helper that starts rendering the field — the
 * output of an annotation carrying `mentions` must stay byte-identical to the
 * same annotation without it, on all three helpers.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation } from '../types';
import {
  exportAnnotationEntry,
  exportAnnotations,
  exportLinkedDocAnnotations,
  parseMarkdownToBlocks,
  type LinkedDocAnnotationEntry,
} from './parser';

const PLAN = '# Plan\n\nRotate the key on every deploy.\n\nShip behind a flag.\n';
const blocks = parseMarkdownToBlocks(PLAN);

function comment(quote: string, extra: Partial<Annotation> = {}): Annotation {
  const block = blocks.find((b) => b.content.includes(quote))!;
  return {
    id: 'ann-1',
    blockId: block.id,
    startOffset: block.content.indexOf(quote),
    endOffset: block.content.indexOf(quote) + quote.length,
    type: AnnotationType.COMMENT,
    text: 'Ask Dana about the grace window.',
    originalText: quote,
    createdA: 1,
    author: 'ramos',
    ...extra,
  };
}

const MENTIONS = ['user_2', 'user_7'] as const;

describe('exported feedback ignores Annotation.mentions', () => {
  test('exportAnnotations is byte-identical with and without the field', () => {
    const plain = comment('Rotate the key');
    const tagged = comment('Rotate the key', { mentions: MENTIONS });
    const withField = exportAnnotations(blocks, [tagged]);
    expect(withField).toBe(exportAnnotations(blocks, [plain]));
    expect(withField).not.toContain('user_2');
    expect(withField).not.toContain('mentions');
  });

  test('exportAnnotationEntry is byte-identical with and without the field', () => {
    const withField = exportAnnotationEntry(comment('Ship behind a flag', { mentions: MENTIONS }));
    expect(withField).toBe(exportAnnotationEntry(comment('Ship behind a flag')));
    expect(withField).not.toContain('user_2');
  });

  test('exportLinkedDocAnnotations is byte-identical with and without the field', () => {
    const entry = (annotations: Annotation[]): Map<string, LinkedDocAnnotationEntry> =>
      new Map([['docs/keys.md', { annotations, globalAttachments: [], blocks }]]);
    const withField = exportLinkedDocAnnotations(entry([comment('Rotate the key', { mentions: MENTIONS })]));
    expect(withField).toBe(exportLinkedDocAnnotations(entry([comment('Rotate the key')])));
    expect(withField).not.toContain('user_2');
  });
});
