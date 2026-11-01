/**
 * DOMPurify cannot run here: with no real DOM (and under happy-dom) it reports
 * itself unsupported and hands input back untouched. These tests hold the two
 * things that can be held without a browser: what happens in that state, and
 * the markdown step DOMPurify runs on.
 */
import { describe, expect, test } from 'bun:test';
import DOMPurify from 'dompurify';

import { chatMarkdownHtml, personMarkdownHtml, personMarkdownToHtml } from './chatMarkdown';

describe.if(!DOMPurify.isSupported)('where the sanitizer cannot run', () => {
  test.each([
    ['an agent', chatMarkdownHtml],
    ['a person', personMarkdownHtml],
  ])('%s\'s markup goes out as text, never as HTML', (_who, render) => {
    const html = render('<img src=x onerror="alert(1)"><script>alert(2)</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('a person\'s message', () => {
  test('HTML they typed stays literal, block and inline alike', () => {
    expect(personMarkdownToHtml('See <b>this</b>')).toContain('&lt;b&gt;this&lt;/b&gt;');
    expect(personMarkdownToHtml('<div onclick="x()">block</div>')).toContain('&lt;div onclick=');
    expect(personMarkdownToHtml('<div onclick="x()">block</div>')).not.toContain('<div');
  });

  test('their markdown still renders', () => {
    expect(personMarkdownToHtml('**bold** and `code`')).toContain('<strong>bold</strong>');
    expect(personMarkdownToHtml('**bold** and `code`')).toContain('<code>code</code>');
  });
});
