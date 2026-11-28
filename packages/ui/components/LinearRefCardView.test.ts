/**
 * The Linear card shows Linear's text as text (htmlAsText). What can regress: a raw HTML line from a Linear
 * description or comment reaching the renderer's HTML path (an `html` block, sanitized but still HTML), at the top
 * level or inside a quote (whose lines are parsed again as blocks), also after a `~~~` line the parser reads as plain
 * text, while fenced code and plain prose stay as they are; a directive (`:::question`, `:::note`) from Linear drawing
 * a question card or a callout inside any container; and Open in Linear leaving linear.app.
 */
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ForgeRef, ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { parseMarkdownToBlocks } from '../utils/parser';
import { htmlAsText, LinearRefCardView } from './LinearRefCardView';

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

test('a `~~~` line (plain text to the parser) or a fence the parser reads differently lets no HTML through', () => {
  expect(types(htmlAsText(['~~~', '<img src=x onerror=alert(1)>', '<details open>', 'x', '</details>'].join('\n')))).not.toContain('html');
  // Display math swallows the backtick line, so the parser sees no fence where a line scan would.
  expect(types(htmlAsText(['$$', '```', '$$', '', '<div>after</div>'].join('\n')))).not.toContain('html');
});

const href = 'https://linear.app/acme/issue/ENG-1';
const target = { platform: 'linear', host: 'linear.app', owner: 'acme', repo: 'ENG', number: 1, kind: 'issue' } as unknown as ForgeRef;
const card = (fields: { url?: string; body?: string; comment?: string }) => {
  const data = { platform: 'linear', kind: 'issue', repo: 'ENG', number: 1, url: fields.url ?? href, title: 'T', state: 'open', author: null, createdAt: '', updatedAt: '', closedAt: null, labels: [], assignees: [], comments: fields.comment ? 1 : 0, body: fields.body ?? '', bodyCut: false, lastComment: fields.comment ? { author: null, createdAt: '', body: fields.comment } : null, linked: [], linear: { identifier: 'ENG-1', team: 'Eng', stateName: 'Todo', stateType: 'unstarted', stateColor: '888888', priority: null, project: null, estimate: null } };
  return renderToStaticMarkup(createElement(LinearRefCardView, { target, href, result: { ok: true, data, fetchedAt: 0 } as unknown as ForgeRefCardResult }));
};

const QUESTION = [':::question', 'Ship it?', '', '- [ ] Yes', '- [ ] No', ':::'];
const quoted = (lines: string[], indent = '') => lines.map((line) => `${indent}> ${line}`.trimEnd());

// One per container the renderer draws blocks inside (or could, for a block type added later): the text itself, a
// quote, a quote inside a list, an alert, a list item, a heading, a table cell, and a directive's own body.
const CONTAINERS: Array<[string, string[]]> = [
  ['a question at the top level', QUESTION],
  ['a note directive', [':::note', 'Heads up', ':::']],
  ['a question in a quote', quoted(QUESTION)],
  ['a question in a quote in a list', ['- Item', ...quoted(QUESTION, '  ')]],
  ['a question in a quote on a list line', ['- > :::question', '  > Ship it?', '  >', '  > - [ ] Yes', '  > :::']],
  ['a question in a nested quote', quoted(quoted(QUESTION))],
  ['a question in an alert', ['> [!NOTE]', ...quoted(QUESTION)]],
  ['HTML at the top level', ['<details open><summary>Zq</summary>', 'x', '</details>']],
  ['HTML in a quote in a list', ['1. Item', '   > <details open><summary>Zq</summary>x</details>']],
  ['HTML in an alert', ['> [!WARNING]', '> <details open><summary>Zq</summary>x</details>']],
  ['HTML in a list item', ['- <details open><summary>Zq</summary>x</details>', '- [ ] <details open>Zq</details>']],
  ['HTML in a heading', ['## <details open><summary>Zq</summary>x</details>']],
  ['HTML in a table cell', ['| a |', '| - |', '| <details open><summary>Zq</summary>x</details> |']],
  ['HTML inside a directive', [':::question', '<details open><summary>Zq</summary>x</details>', '- [ ] Yes', ':::']],
];

test('Linear text never draws a question card, a directive or raw HTML, in any container, and keeps the text', () => {
  for (const [name, lines] of CONTAINERS) {
    const text = lines.join('\n');
    for (const markup of [card({ body: text }), card({ comment: text })]) {
      // No answerable card, and no directive drawn as a callout either (a quote draws a question as one).
      expect({ name, question: /data-question-/.test(markup) }).toEqual({ name, question: false });
      expect({ name, directive: /data-directive-kind/.test(markup) }).toEqual({ name, directive: false });
      expect({ name, html: /<details/i.test(markup) }).toEqual({ name, html: false });
      // The source survives as text: the directive marker or the escaped tag is on the card.
      expect({ name, text: markup.includes(':::') || markup.includes('&lt;details') }).toEqual({ name, text: true });
    }
  }
});

test('Open in Linear goes only to an https linear.app link, else to the link the message had', () => {
  const open = (url: string) => /data-ref-card-open=""[^>]*href="([^"]+)"|href="([^"]+)"[^>]*data-ref-card-open/.exec(card({ url }))?.slice(1).find(Boolean);
  expect(open('https://linear.app/acme/issue/ENG-1/slug')).toBe('https://linear.app/acme/issue/ENG-1/slug');
  expect(open('javascript:alert(1)')).toBe(href);
  expect(open('https://evil.example/acme/issue/ENG-1')).toBe(href);
});

test('fenced code and prose are left as they are', () => {
  const body = ['Plain **bold** text.', '```html', '<div>in a fence</div>', '```', 'After.'].join('\n');
  expect(htmlAsText(body)).toBe(body);
});
