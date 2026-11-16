/**
 * The Linear card shows Linear's text as text (htmlAsText). What can regress: a raw HTML line from a Linear
 * description or comment reaching the renderer's HTML path (an `html` block, sanitized but still HTML), at the top
 * level or inside a quote (whose lines are parsed again as blocks), while fenced code and plain prose stay as they are.
 */
import { expect, test } from 'bun:test';
import { parseMarkdownToBlocks } from '../utils/parser';
import { htmlAsText } from './LinearRefCardView';

const types = (markdown: string) => parseMarkdownToBlocks(markdown).map((block) => block.type);

test('no raw HTML from Linear becomes an html block', () => {
  const body = ['Intro.', '', '<details open><summary>More</summary>', 'hidden', '</details>', '', '<div onclick="x()">hi</div>', '', '<img src=x onerror=alert(1)>'].join('\n');
  expect(types(body)).toContain('html');
  expect(types(htmlAsText(body))).not.toContain('html');
  expect(htmlAsText(body)).toContain('<details open><summary>More</summary>');

  const quoted = htmlAsText('> <div>quoted</div>');
  expect(types(quoted.replace(/^>\s?/, ''))).not.toContain('html');

  // A backtick in the line still yields one code span around the whole line.
  expect(types(htmlAsText('<div>`tick`</div>'))).not.toContain('html');
});

test('fenced code and prose are left as they are', () => {
  const body = ['Plain **bold** text.', '```html', '<div>in a fence</div>', '```', 'After.'].join('\n');
  expect(htmlAsText(body)).toBe(body);
});
