/** Where the sanitizer cannot be trusted, nothing goes out as HTML. */
import { describe, expect, test } from 'bun:test';

import { chatMarkdownHtml, personMarkdownHtml, personMarkdownToHtml } from './chatMarkdown';

describe('where the sanitizer cannot run', () => {
  test.each([
    ['an agent', chatMarkdownHtml],
    ['a person', personMarkdownHtml],
  ])('%s\'s markup goes out as text, never as HTML', (_who, render) => {
    const html = render('<img src=x onerror="alert(1)"><script>alert(2)</script>\n[x](javascript:alert(3))');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<a ');
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
