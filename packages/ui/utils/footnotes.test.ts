import { describe, expect, test } from 'bun:test';
import { parseMarkdownToBlocks } from './parser';
import { footnoteBody, indexFootnotes, quoteVariantsAsRendered } from './footnotes';
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
    const blocks = parse(['Cites[^a][^b].', '', '[^a]: First', 'lazy line.', '', '    Second paragraph.', '', '    - a list item', '[^b]: Bee.', '', 'Text.'].join('\n'));
    expect(blocks.map((b) => b.footnoteLabel ?? b.content)).toEqual(['Cites[^a][^b].', 'a', 'b', 'Text.']);
    expect(footnoteBody(blocks[1].content)).toBe('First\nlazy line.\n\nSecond paragraph.\n\n- a list item');
    expect(blocks[3].startLine).toBe(11);
  });

  test('a heading, list or fence right after a note is not part of it; nor is an indented fence or directive', () => {
    const blocks = parse('Cites[^a][^b][^c][^d].\n[^a]: Note.\n# Heading\n[^b]: Other.\n- item\n[^c]: Third.\n```\ncode\n```\n[^d]: Fourth.\n\n    ```\n    indented fence\n    ```');
    expect(blocks.map((b) => b.type + (b.footnoteLabel ? `:${b.footnoteLabel}` : ''))).toEqual([
      'paragraph', 'paragraph:a', 'heading', 'paragraph:b', 'list-item', 'paragraph:c', 'code', 'paragraph:d', 'code',
    ]);
  });

  test('a [^label]: line is a note only when the document cites that label outside code', () => {
    const md = 'A regex: `[^0-9]`.\n\n[^0-9]: anything but digits\n\nCited[^x].\n\n[^x]: Real note.\n[^y]: Nobody cites me.\n\n[^z]: Nor me.';
    const blocks = parse(md);
    expect(blocks.map((b) => [b.content, b.footnoteLabel])).toEqual([
      ['A regex: `[^0-9]`.', undefined],
      ['[^0-9]: anything but digits', undefined],
      ['Cited[^x].', undefined],
      // An uncited line right under a note ends it and stays a paragraph where it is written.
      ['[^x]: Real note.', 'x'],
      ['[^y]: Nobody cites me.', undefined],
      ['[^z]: Nor me.', undefined],
    ]);
    // Uncited lines are drawn where they are written, not in the notes list.
    const body = indexFootnotes(blocks)!.bodyBlocks.map((b) => b.content);
    expect(body).toContain('[^y]: Nobody cites me.');
    expect(body).toContain('[^z]: Nor me.');
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
    const blocks = parse('B first[^b], then a[^A], b again[^B].\n\n[^a]: Ay.\n[^b]: Bee.');
    const index = indexFootnotes(blocks)!;
    expect(index.notes.map((n) => [n.key, n.number, n.referenced])).toEqual([
      ['b', 1, true], ['a', 2, true],
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

describe('quoteVariantsAsRendered (old quotes, as the page draws them now)', () => {
  const page = () => {
    const root = { querySelectorAll: () => [{ getAttribute: () => '1', textContent: '1' }] } as unknown as ParentNode;
    return root;
  };
  test('a reference the page draws leaves the quote; entities decode', () => {
    expect(quoteVariantsAsRendered('a footnote.[^1] And &amp; more', page())).toEqual(['a footnote. And & more']);
  });
  test('a whole old definition paragraph loses its marker, which the list draws as its number', () => {
    expect(quoteVariantsAsRendered('[^1]: The first note.', page())).toContain('The first note.');
    expect(quoteVariantsAsRendered('Intro\n[^1]: The first note.', page())).toContain('Intro\nThe first note.');
  });
  test('nothing to change: no variants', () => {
    expect(quoteVariantsAsRendered('plain words', page())).toEqual([]);
  });
});
