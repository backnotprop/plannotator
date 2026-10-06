/**
 * `selectionSourceLines`: the lines an Ask AI question names for a text
 * selection (#1731). Failure to catch: the question naming a line the
 * selection is not on, or a different span than the exported annotation
 * made from the same selection would name.
 */
import { describe, expect, test } from 'bun:test';
import { exportAnnotations, parseMarkdownToBlocks, selectionSourceLines } from './parser';
import { buildDefaultPrompt } from '../hooks/useAIChat';
import { AnnotationType } from '../types';

const DOC = [
  '---',
  'title: Frontmatter shifts every line',
  '---',
  '# Rollout',
  '',
  'Retry the job once.',
  '',
  'A paragraph that wraps',
  'over two source lines.',
  '',
  '- Retry the job once.',
  '',
  '```ts',
  'retry();',
  '```',
].join('\n');

const blocks = parseMarkdownToBlocks(DOC);
const idOf = (pred: (content: string, type: string) => boolean) => {
  const block = blocks.find((b) => pred(b.content, b.type));
  if (!block) throw new Error('block not found');
  return block.id;
};

describe('selectionSourceLines', () => {
  test('a one-line block names its own file line (frontmatter counted)', () => {
    const id = idOf((c, t) => t === 'paragraph' && c === 'Retry the job once.');
    expect(selectionSourceLines(blocks, [id])).toEqual({ lineStart: 6, lineEnd: 6 });
  });

  test('the same phrase in another block names that block\'s line', () => {
    const id = idOf((c, t) => t === 'list-item' && c === 'Retry the job once.');
    expect(selectionSourceLines(blocks, [id])).toEqual({ lineStart: 11, lineEnd: 11 });
  });

  test('a wrapped paragraph names its full span, like its exported annotation', () => {
    const id = idOf((c) => c.startsWith('A paragraph'));
    expect(selectionSourceLines(blocks, [id])).toEqual({ lineStart: 8, lineEnd: 9 });
  });

  test('a code block spans its fences', () => {
    const id = idOf((_, t) => t === 'code');
    expect(selectionSourceLines(blocks, [id])).toEqual({ lineStart: 13, lineEnd: 15 });
  });

  test('a selection over several blocks runs from the first start to the last end', () => {
    const first = idOf((c, t) => t === 'paragraph' && c === 'Retry the job once.');
    const last = idOf((c) => c.startsWith('A paragraph'));
    expect(selectionSourceLines(blocks, [last, first])).toEqual({ lineStart: 6, lineEnd: 9 });
  });

  // The question and the exported annotation from the same single-block
  // selection must name the same lines (multi-block selections are a range,
  // while the export names only the first block).
  test.each([
    ['a one-line paragraph after frontmatter', (c: string, t: string) => t === 'paragraph' && c === 'Retry the job once.', 'Retry the job'],
    ['a wrapped paragraph', (c: string) => c.startsWith('A paragraph'), 'A paragraph'],
  ])('for %s the question names the span the export heading prints', (_name, pred, quote) => {
    const id = idOf(pred);
    const lines = selectionSourceLines(blocks, [id])!;
    const prompt = buildDefaultPrompt({
      prompt: 'q',
      scope: { kind: 'selection', text: quote, sourcePath: '/d.md', ...lines },
    });
    const label = /Source: \/d\.md, (lines? [\d–]+)\n/.exec(prompt)?.[1];
    expect(label).toBeDefined();
    const exported = exportAnnotations(blocks, [{
      id: 'a1', blockId: id, startOffset: 0, endOffset: quote.length, type: AnnotationType.COMMENT,
      text: 'why?', originalText: quote, createdA: 0,
    }]);
    expect(exported).toContain(`(${label}) `);
  });

  test('unknown and diff-view block ids name no line', () => {
    expect(selectionSourceLines(blocks, [])).toBeNull();
    expect(selectionSourceLines(blocks, ['nope', 'diff-block-3'])).toBeNull();
  });
});
