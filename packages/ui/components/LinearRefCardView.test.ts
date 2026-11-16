/**
 * The Linear card shows Linear's text as text (htmlAsText). What can regress: a raw HTML line from a Linear
 * description or comment reaching the renderer's HTML path (an `html` block, sanitized but still HTML), at the top
 * level or inside a quote (whose lines are parsed again as blocks), also after a `~~~` line the parser reads as plain
 * text, while fenced code and plain prose stay as they are; and Open in Linear leaving linear.app.
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

test('Open in Linear goes only to an https linear.app link, else to the link the message had', () => {
  const href = 'https://linear.app/acme/issue/ENG-1';
  const target = { platform: 'linear', host: 'linear.app', owner: 'acme', repo: 'ENG', number: 1, kind: 'issue' } as unknown as ForgeRef;
  const open = (url: string) => {
    const data = { platform: 'linear', kind: 'issue', repo: 'ENG', number: 1, url, title: 'T', state: 'open', author: null, createdAt: '', updatedAt: '', closedAt: null, labels: [], assignees: [], comments: 0, body: '', bodyCut: false, lastComment: null, linked: [], linear: { identifier: 'ENG-1', team: 'Eng', stateName: 'Todo', stateType: 'unstarted', stateColor: '888888', priority: null, project: null, estimate: null } };
    const markup = renderToStaticMarkup(createElement(LinearRefCardView, { target, href, result: { ok: true, data, fetchedAt: 0 } as unknown as ForgeRefCardResult }));
    return /data-ref-card-open=""[^>]*href="([^"]+)"|href="([^"]+)"[^>]*data-ref-card-open/.exec(markup)?.slice(1).find(Boolean);
  };
  expect(open('https://linear.app/acme/issue/ENG-1/slug')).toBe('https://linear.app/acme/issue/ENG-1/slug');
  expect(open('javascript:alert(1)')).toBe(href);
  expect(open('https://evil.example/acme/issue/ENG-1')).toBe(href);
});

test('fenced code and prose are left as they are', () => {
  const body = ['Plain **bold** text.', '```html', '<div>in a fence</div>', '```', 'After.'].join('\n');
  expect(htmlAsText(body)).toBe(body);
});
