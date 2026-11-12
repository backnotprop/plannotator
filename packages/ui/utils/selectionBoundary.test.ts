import { describe, expect, test } from 'bun:test';
import { dropEmptyNodes, trimWhitespaceOnlyBoundaryNodes, type SelectedNodeLike } from './selectionBoundary';

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

describe('dropEmptyNodes', () => {
  test('drops empty nodes between real ones, and keeps a space', () => {
    expect(texts(dropEmptyNodes(nodes('Stripe answers ', '', 'idempotency key', '', ' ', 'in flight')))).toEqual([
      'Stripe answers ',
      'idempotency key',
      ' ',
      'in flight',
    ]);
  });
});
