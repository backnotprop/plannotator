/**
 * `keepBlankLines` (the Inbox's person-typed text) records a run of 2+ blank lines before a
 * paragraph. Without it, plan review and annotate parse exactly as before: the block list
 * carries no such field.
 */
import { expect, test } from 'bun:test';
import { parseMarkdownToBlocks } from './parser';

const SRC = 'a\n\n\n\n\nb\n\n```\nx\n\n\n\ny\n```\n\n\n- item\n\n\nc';

test('default parse never sets blankLinesBefore (plan review, annotate)', () => {
  expect(parseMarkdownToBlocks(SRC).some((b) => 'blankLinesBefore' in b)).toBe(false);
});

test('keepBlankLines marks only paragraphs after 2+ blank lines; fenced blank lines are code', () => {
  const blocks = parseMarkdownToBlocks(SRC, { keepBlankLines: true });
  const marked = blocks.filter((b) => b.blankLinesBefore).map((b) => [b.content, b.blankLinesBefore]);
  expect(marked).toEqual([['b', 4], ['c', 2]]);
  expect(blocks.find((b) => b.type === 'code')!.content).toBe('x\n\n\n\ny');
});

test('a run of blank lines is capped at 10', () => {
  const blocks = parseMarkdownToBlocks(`a${'\n'.repeat(500)}b`, { keepBlankLines: true });
  expect(blocks.map((b) => b.blankLinesBefore)).toEqual([undefined, 10]);
});
