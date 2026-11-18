import { describe, expect, test } from 'bun:test';
import { parseMarkdownToBlocks } from './parser';
import { footnoteBody, indexFootnotes } from './footnotes';
import { computePlanDiff } from './planDiffEngine';

const parse = (md: string) => parseMarkdownToBlocks(md, { frontmatter: false });

describe('footnote definitions in the parser', () => {
  test('a definition is one paragraph block tagged with its label, written as it was', () => {
    const blocks = parse('Claim.[^1]\n\n[^1]: The note.\n\nAfter.');
    expect(blocks.map((b) => [b.type, b.content, b.footnoteLabel])).toEqual([
      ['paragraph', 'Claim.[^1]', undefined],
      ['paragraph', '[^1]: The note.', '1'],
      ['paragraph', 'After.', undefined],
    ]);
    expect(blocks[1].startLine).toBe(3);
  });

  test('consecutive definitions are separate notes; a lazy line and indented paragraphs stay in theirs', () => {
    const blocks = parse(['[^a]: First', 'lazy line.', '', '    Second paragraph.', '', '    - a list item', '[^b]: Bee.', '', 'Text.'].join('\n'));
    expect(blocks.map((b) => b.footnoteLabel ?? b.content)).toEqual(['a', 'b', 'Text.']);
    expect(footnoteBody(blocks[0].content)).toBe('First\nlazy line.\n\nSecond paragraph.\n\n- a list item');
    expect(blocks[2].startLine).toBe(9);
  });

  test('a heading, list or fence right after a note is not part of it', () => {
    const blocks = parse('[^a]: Note.\n# Heading\n[^b]: Other.\n- item\n[^c]: Third.\n```\ncode\n```');
    expect(blocks.map((b) => b.type + (b.footnoteLabel ? `:${b.footnoteLabel}` : ''))).toEqual([
      'paragraph:a', 'heading', 'paragraph:b', 'list-item', 'paragraph:c', 'code',
    ]);
  });

  test('a definition inside a code fence or written in a list continuation is not one', () => {
    const blocks = parse('```\n[^x]: in code\n```\n\n- item\n  [^y]: continuation');
    expect(blocks.some((b) => b.footnoteLabel !== undefined)).toBe(false);
  });
});

describe('indexFootnotes', () => {
  test('null for a document without a definition, so nothing about its drawing changes', () => {
    expect(indexFootnotes(parse('A ref [^1] with no note.\n\n[link]: https://example.com'))).toBeNull();
  });

  test('numbers follow the first reference; repeated references share a number; labels ignore case', () => {
    const blocks = parse('B first[^b], then a[^A], b again[^B].\n\n[^a]: Ay.\n[^b]: Bee.\n[^unused]: Nobody cites me.');
    const index = indexFootnotes(blocks)!;
    expect(index.notes.map((n) => [n.key, n.number, n.referenced])).toEqual([
      ['b', 1, true], ['a', 2, true], ['unused', 3, false],
    ]);
    expect(index.bodyBlocks.map((b) => b.content)).toEqual(['B first[^b], then a[^A], b again[^B].']);
    expect([...index.numbers]).toEqual([['b', 1], ['a', 2]]);
  });

  test('a reference inside a code span does not number a note; a note citing another comes next', () => {
    const index = indexFootnotes(parse('Code `[^a]` then real[^b].\n\n[^a]: Ay.\n[^b]: Bee, see[^a].'))!;
    expect(index.notes.map((n) => [n.key, n.number])).toEqual([['b', 1], ['a', 2]]);
  });
});

describe('plan diff with footnotes and bare links', () => {
  const base = '# Plan\n\nShip it with care.\n\nThen measure.\n';
  test('adding then removing a footnote and a bare link diffs as added and removed text', () => {
    const withBoth = '# Plan\n\nShip it with care.[^1] See www.example.com.\n\nThen measure.\n\n[^1]: Care means tests.\n';
    const added = computePlanDiff(base, withBoth);
    expect(added.stats.additions + added.stats.modifications).toBeGreaterThan(0);
    const addedText = added.blocks.filter((b) => b.type !== 'unchanged').map((b) => b.content).join('\n');
    expect(addedText).toContain('[^1]: Care means tests.');
    expect(addedText).toContain('www.example.com');

    const removed = computePlanDiff(withBoth, base);
    expect(removed.stats.deletions + removed.stats.modifications).toBeGreaterThan(0);
    expect(removed.blocks.filter((b) => b.type === 'removed' || b.type === 'modified').map((b) => b.oldContent ?? b.content).join('\n')).toContain('[^1]: Care means tests.');
  });
});
