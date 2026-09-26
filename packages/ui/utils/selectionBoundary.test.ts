import { describe, expect, test } from 'bun:test';
import { trimWhitespaceOnlyBoundaryNodes, type SelectedNodeLike } from './selectionBoundary';

// Failure this guards: a triple-click leaves the selection's end boundary on the
// NEXT block's text node at offset 0, so web-highlighter's splitText(0) hands the
// painter an empty (or pure-indentation) boundary node. Wrapping that node in a
// styled <mark> paints a visible sliver on the following line. A boundary node
// with no non-whitespace character must never reach the painter, while
// whitespace BETWEEN real nodes must survive, or genuine multi-node selections
// lose their inter-node spacing.
//
// Lives here rather than in useAnnotationHighlighter.test.tsx because that suite
// is DOM-gated (skipped unless DOM_TESTS=1) and so guards nothing in CI.

const nodes = (...texts: (string | null)[]): SelectedNodeLike[] =>
  texts.map((textContent) => ({ $node: { textContent } }));

const texts = (list: SelectedNodeLike[]): (string | null)[] =>
  list.map((node) => node.$node.textContent);

describe('trimWhitespaceOnlyBoundaryNodes', () => {
  test('drops an empty trailing node (the splitText(0) sliver)', () => {
    expect(texts(trimWhitespaceOnlyBoundaryNodes(nodes('a line of text', '')))).toEqual([
      'a line of text',
    ]);
  });

  test('drops a trailing pure-indentation node', () => {
    expect(texts(trimWhitespaceOnlyBoundaryNodes(nodes('a line of text', '\n    ')))).toEqual([
      'a line of text',
    ]);
  });

  test('drops leading whitespace-only nodes', () => {
    expect(texts(trimWhitespaceOnlyBoundaryNodes(nodes('\n  ', '', 'a line of text')))).toEqual([
      'a line of text',
    ]);
  });

  test('trims both ends at once', () => {
    expect(
      texts(trimWhitespaceOnlyBoundaryNodes(nodes('  ', 'first', 'second', '\n\t'))),
    ).toEqual(['first', 'second']);
  });

  test('keeps whitespace-only nodes between content nodes', () => {
    expect(texts(trimWhitespaceOnlyBoundaryNodes(nodes('first', ' ', 'second')))).toEqual([
      'first',
      ' ',
      'second',
    ]);
  });

  test('returns nothing when every node is whitespace-only', () => {
    expect(trimWhitespaceOnlyBoundaryNodes(nodes('', ' ', '\n  '))).toEqual([]);
  });

  test('leaves an ordinary selection untouched', () => {
    const selection = nodes('first', 'second', 'third');
    expect(trimWhitespaceOnlyBoundaryNodes(selection)).toEqual(selection);
  });

  test('treats a null textContent as whitespace-only', () => {
    expect(texts(trimWhitespaceOnlyBoundaryNodes(nodes(null, 'text', null)))).toEqual(['text']);
  });

  test('handles an empty node list', () => {
    expect(trimWhitespaceOnlyBoundaryNodes([])).toEqual([]);
  });
});
