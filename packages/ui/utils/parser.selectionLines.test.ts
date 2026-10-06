/**
 * `selectionSourceLines`: the lines an Ask AI question names for a text
 * selection (#1731). Failure to catch: the question naming a line the
 * selection is not on, or a different span than the exported annotation
 * made from the same selection would name.
 */
import { describe, expect, test } from 'bun:test';
import { parseMarkdownToBlocks, selectionSourceLines } from './parser';

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

  test('unknown and diff-view block ids name no line', () => {
    expect(selectionSourceLines(blocks, [])).toBeNull();
    expect(selectionSourceLines(blocks, ['nope', 'diff-block-3'])).toBeNull();
  });
});
