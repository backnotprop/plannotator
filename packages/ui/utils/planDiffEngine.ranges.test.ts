/**
 * Source line ranges on PlanDiffBlock (oldStart/oldEnd/newStart/newEnd) and
 * the unchanged-run folding helper. Code review's rendered Markdown diff
 * names these lines in its gutter; plan review ignores them, so the other
 * fields must stay exactly what they were.
 */
import { describe, expect, test } from 'bun:test';
import { computePlanDiff, foldUnchangedPlanDiff, type PlanDiffBlock } from './planDiffEngine';

type Ranges = Pick<PlanDiffBlock, 'type' | 'oldStart' | 'oldEnd' | 'newStart' | 'newEnd'>;

function ranges(blocks: PlanDiffBlock[]): Ranges[] {
  return blocks.map(({ type, oldStart, oldEnd, newStart, newEnd }) => {
    const out: Ranges = { type };
    if (oldStart !== undefined) Object.assign(out, { oldStart, oldEnd });
    if (newStart !== undefined) Object.assign(out, { newStart, newEnd });
    return out;
  });
}

function withoutRanges(blocks: PlanDiffBlock[]) {
  return blocks.map(({ oldStart: _a, oldEnd: _b, newStart: _c, newEnd: _d, ...rest }) => rest);
}

/** Slice 1-based inclusive lines out of a text, to check a range points at the block. */
function linesOf(text: string, start: number, end: number): string {
  return text.split('\n').slice(start - 1, end).join('\n');
}

describe('computePlanDiff line ranges', () => {
  test('added, removed, modified and unchanged blocks name their own lines', () => {
    const oldText = ['# Title', '', 'Intro.', '', 'Old paragraph.', '', 'Gone paragraph.', '', '## End', ''].join('\n');
    const newText = ['# Title', '', 'Intro.', '', 'New paragraph.', '', '## End', '', 'Added tail.', ''].join('\n');
    const { blocks } = computePlanDiff(oldText, newText);

    for (const block of blocks) {
      if (block.oldStart !== undefined) {
        const source = block.type === 'modified' ? block.oldContent! : block.content;
        expect(linesOf(oldText, block.oldStart, block.oldEnd!)).toBe(source.trim());
      }
      if (block.newStart !== undefined) {
        expect(linesOf(newText, block.newStart, block.newEnd!)).toBe(block.content.trim());
      }
    }
    expect(ranges(blocks)).toEqual([
      { type: 'unchanged', oldStart: 1, oldEnd: 3, newStart: 1, newEnd: 3 },
      { type: 'modified', oldStart: 5, oldEnd: 5, newStart: 5, newEnd: 5 },
      // A blank line diffLines kept as its own chunk: no lines on either side.
      { type: 'unchanged' },
      { type: 'removed', oldStart: 7, oldEnd: 7 },
      { type: 'unchanged', oldStart: 9, oldEnd: 9, newStart: 7, newEnd: 7 },
      { type: 'added', newStart: 9, newEnd: 9 },
    ]);
  });

  test('a fenced code block is one atomic change spanning its whole fence', () => {
    const oldText = ['Intro.', '', '```ts', 'const a = 1;', '}', '```', '', 'Outro.', ''].join('\n');
    const newText = ['Intro.', '', '```ts', 'const a = 2;', '}', '```', '', 'Outro.', ''].join('\n');
    const { blocks } = computePlanDiff(oldText, newText);
    const modified = blocks.find((b) => b.type === 'modified')!;
    expect(modified).toMatchObject({ oldStart: 3, oldEnd: 6, newStart: 3, newEnd: 6 });
    expect(blocks.at(-1)).toMatchObject({ type: 'unchanged', oldStart: 8, newStart: 8 });
  });

  test('a table row change keeps the line numbers of the rows around it', () => {
    const oldText = ['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |', ''].join('\n');
    const newText = ['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 5 |', '| 6 | 7 |', ''].join('\n');
    const { blocks } = computePlanDiff(oldText, newText);
    expect(ranges(blocks)).toEqual([
      { type: 'unchanged', oldStart: 1, oldEnd: 3, newStart: 1, newEnd: 3 },
      { type: 'modified', oldStart: 4, oldEnd: 4, newStart: 4, newEnd: 5 },
    ]);
  });

  test('a document without a trailing newline', () => {
    const { blocks } = computePlanDiff('one\ntwo', 'one\ntwo\nthree');
    // diffLines sees "two" (no newline) replaced by "two\nthree".
    expect(ranges(blocks)).toEqual([
      { type: 'unchanged', oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 },
      { type: 'modified', oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 3 },
    ]);
  });

  test('leading and trailing blank lines are not part of a range', () => {
    const { blocks } = computePlanDiff('\n\nA\n\n\n', '\n\nA\n\nB\n\n');
    expect(ranges(blocks)).toEqual([
      // "\n\nA\n\n": the two blank lines before A and after it are not counted.
      { type: 'unchanged', oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 3 },
      { type: 'added', newStart: 5, newEnd: 5 },
      { type: 'unchanged' },
    ]);
  });

  test('a new file is one added block over all of its lines; a deleted file one removed block', () => {
    const doc = '# Title\n\nBody.\n';
    expect(ranges(computePlanDiff('', doc).blocks)).toEqual([{ type: 'added', newStart: 1, newEnd: 3 }]);
    expect(ranges(computePlanDiff(doc, '').blocks)).toEqual([{ type: 'removed', oldStart: 1, oldEnd: 3 }]);
  });

  test('an all-blank chunk has no range on either side', () => {
    const { blocks } = computePlanDiff('A\n', 'A\n\n\n');
    const blank = blocks.find((b) => b.type === 'added')!;
    expect(blank.newStart).toBeUndefined();
    expect(blank.oldStart).toBeUndefined();
  });

  test('every other field is exactly what it was without the ranges', () => {
    const oldText = '# Plan\n\nStep one.\n\nStep two.\n';
    const newText = '# Plan\n\nStep one, revised.\n\nStep two.\n\nStep three.\n';
    expect(withoutRanges(computePlanDiff(oldText, newText).blocks)).toEqual([
      { type: 'unchanged', content: '# Plan\n\n', lines: 2 },
      {
        type: 'modified',
        content: 'Step one, revised.\n',
        oldContent: 'Step one.\n',
        lines: 1,
        inlineTokens: [
          { type: 'unchanged', value: 'Step one' },
          { type: 'added', value: ', revised' },
          { type: 'unchanged', value: '.' },
        ],
        inlineWrap: { type: 'paragraph' },
      },
      { type: 'unchanged', content: '\nStep two.\n', lines: 2 },
      { type: 'added', content: '\nStep three.\n', lines: 2 },
    ]);
  });
});

describe('foldUnchangedPlanDiff', () => {
  const sections = (n: number, prefix = 'S') =>
    Array.from({ length: n }, (_, i) => `## ${prefix}${i + 1}\n\nText ${prefix}${i + 1}.\n`).join('\n');

  test('keeps one section of context next to a change and folds the rest', () => {
    const oldText = `${sections(6)}\nOld end.\n`;
    const newText = `${sections(6)}\nNew end.\n`;
    const { blocks } = computePlanDiff(oldText, newText);
    const segments = foldUnchangedPlanDiff(blocks);

    // At the document start no context: everything before the last
    // section-pair piece next to the change folds.
    expect(segments[0].kind).toBe('fold');
    const fold = segments[0] as Extract<(typeof segments)[number], { kind: 'fold' }>;
    expect(fold.headings).toEqual(['S1', 'S2', 'S3']);
    expect(fold.sectionCount).toBe(fold.pieces.length);
    expect(fold.newStart).toBe(1);
    // The visible context piece directly before the change.
    const context = segments[1];
    expect(context.kind).toBe('block');
    if (context.kind === 'block') {
      expect(context.block.type).toBe('unchanged');
      expect(context.block.content.trim()).toBe('Text S6.');
    }
    expect(segments.at(-1)).toMatchObject({ kind: 'block', block: { type: 'modified' } });

    // Pieces are the exact source text: fold + context concatenate back to the chunk.
    const unchanged = blocks[0];
    const pieces = [...fold.pieces.map((p) => p.content), context.kind === 'block' ? context.block.content : ''];
    expect(pieces.join('')).toBe(unchanged.content);
    // Each piece's range points at its own lines.
    for (const piece of fold.pieces) {
      expect(linesOf(newText, piece.newStart!, piece.newEnd!)).toBe(piece.content.trim());
      expect(linesOf(oldText, piece.oldStart!, piece.oldEnd!)).toBe(piece.content.trim());
    }
  });

  test('context on both sides of a run between two changes', () => {
    const oldText = `First old.\n\n${sections(5)}\nLast old.\n`;
    const newText = `First new.\n\n${sections(5)}\nLast new.\n`;
    const { blocks } = computePlanDiff(oldText, newText);
    const kinds = foldUnchangedPlanDiff(blocks).map((s) => (s.kind === 'fold' ? `fold:${s.sectionCount}` : s.block.type));
    // 10 pieces (5 headings + 5 paragraphs): 1 context, 8 folded, 1 context.
    expect(kinds).toEqual(['modified', 'unchanged', 'fold:8', 'unchanged', 'modified']);
  });

  test('a run too short to fold stays whole and untouched', () => {
    const { blocks } = computePlanDiff('A.\n\nB.\n\nC old.\n', 'A.\n\nB.\n\nC new.\n');
    const segments = foldUnchangedPlanDiff(blocks, { minHidden: 2 });
    // Two pieces before the change: one context, one hidden — under minHidden.
    expect(segments).toEqual([
      { kind: 'block', block: blocks[0], index: 0 },
      { kind: 'block', block: blocks[1], index: 1 },
    ]);
  });

  test('context and minHidden are configurable', () => {
    const oldText = `${sections(4)}\nEnd old.\n`;
    const newText = `${sections(4)}\nEnd new.\n`;
    const { blocks } = computePlanDiff(oldText, newText);
    const none = foldUnchangedPlanDiff(blocks, { context: 0, minHidden: 1 });
    expect(none[0]).toMatchObject({ kind: 'fold', sectionCount: 8 });
    const three = foldUnchangedPlanDiff(blocks, { context: 3 });
    expect(three.map((s) => s.kind)).toEqual(['fold', 'block', 'block']);
    expect((three[0] as { sectionCount: number }).sectionCount).toBe(5);
  });

  test('an unchanged document folds whole; a change at the start keeps context only after it', () => {
    const doc = sections(4);
    const same = foldUnchangedPlanDiff(computePlanDiff(doc, doc).blocks);
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ kind: 'fold', sectionCount: 8, newStart: 1 });

    const { blocks } = computePlanDiff(`Old top.\n\n${doc}`, `New top.\n\n${doc}`);
    const segments = foldUnchangedPlanDiff(blocks);
    expect(segments.map((s) => s.kind)).toEqual(['block', 'block', 'fold']);
    expect((segments[1] as { block: PlanDiffBlock }).block.content).toContain('## S1');
  });

  test('fold keys are stable for the same diff', () => {
    const { blocks } = computePlanDiff(`${sections(5)}\nA\n`, `${sections(5)}\nB\n`);
    const keys = (s: ReturnType<typeof foldUnchangedPlanDiff>) => s.filter((x) => x.kind === 'fold').map((x) => (x as { key: string }).key);
    expect(keys(foldUnchangedPlanDiff(blocks))).toEqual(keys(foldUnchangedPlanDiff(blocks)));
    expect(keys(foldUnchangedPlanDiff(blocks))[0]).toBe('fold-0-0');
  });

  test('fold headings drop inline markdown markers and stop at three', () => {
    const doc = ['# **Bold** title', '', 'a', '', '## `code` and [link](x)', '', 'b', '', '## _three_', '', 'c', '', '## four', '', 'd', ''].join('\n');
    const [fold] = foldUnchangedPlanDiff(computePlanDiff(doc, doc).blocks);
    expect(fold).toMatchObject({ kind: 'fold', headings: ['Bold title', 'code and link', 'three'] });
  });
});
