import { describe, test, expect } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineMarkdown, trimUrlTail } from './InlineMarkdown';

function renderInline(text: string): string {
  return renderToStaticMarkup(createElement(InlineMarkdown, { text }));
}

describe('trimUrlTail', () => {
  test('trims trailing period', () => {
    expect(trimUrlTail('https://foo.com.')).toBe('https://foo.com');
  });

  test('trims trailing comma / semicolon / question mark', () => {
    expect(trimUrlTail('https://foo.com,')).toBe('https://foo.com');
    expect(trimUrlTail('https://foo.com;')).toBe('https://foo.com');
    expect(trimUrlTail('https://foo.com?')).toBe('https://foo.com?'.replace(/\?$/, ''));
  });

  test('keeps closing paren when it balances an opener', () => {
    expect(trimUrlTail('https://en.wikipedia.org/wiki/Function_(mathematics)')).toBe(
      'https://en.wikipedia.org/wiki/Function_(mathematics)',
    );
  });

  test('trims unbalanced closing paren', () => {
    expect(trimUrlTail('https://foo.com/path)')).toBe('https://foo.com/path');
  });

  test('keeps closing bracket when balanced', () => {
    expect(trimUrlTail('https://foo.com/[a]')).toBe('https://foo.com/[a]');
  });

  test('trims unbalanced closing bracket', () => {
    expect(trimUrlTail('https://foo.com]')).toBe('https://foo.com');
  });

  test('trims stacked punctuation', () => {
    expect(trimUrlTail('https://foo.com).')).toBe('https://foo.com');
  });

  test('leaves URL alone when no trailing punctuation', () => {
    expect(trimUrlTail('https://foo.com/path')).toBe('https://foo.com/path');
  });
});

describe('InlineMarkdown angle autolinks', () => {
  test('keeps xref contents literal', () => {
    const html = renderInline('For more information, see the <xref:path_to_api`22?hello> class.');

    expect(html).toContain('<span>&lt;xref:path_to_api`22?hello&gt;</span>');
    expect(html).not.toContain('<code');
    expect(html).not.toContain('<em');
  });

  test('keeps URL and email autolinks clickable', () => {
    const html = renderInline('Visit <https://www.example.com> or <user@example.com>.');

    expect(html).toContain('href="https://www.example.com"');
    expect(html).toContain('href="mailto:user@example.com"');
  });

  test('keeps comparison text as plain prose', () => {
    const html = renderInline('Math: x < y > z.');

    expect(html).toBe('Math: x &lt; y &gt; z.');
  });

  test('keeps other scheme autolinks literal', () => {
    const html = renderInline('Open <file://path/to/file> or <custom:value_with-dash.ext>.');

    expect(html).toContain('<span>&lt;file://path/to/file&gt;</span>');
    expect(html).toContain('<span>&lt;custom:value_with-dash.ext&gt;</span>');
  });

  test('does not consume incomplete angle autolinks', () => {
    const html = renderInline('Broken <xref:path_to_api`22?hello is plain.');

    expect(html).toBe('Broken &lt;xref:path_to_api`22?hello is plain.');
  });

  test('preserves incomplete angle autolink prose', () => {
    const html = renderInline('Try <custom:scheme!');

    expect(html).toBe('Try &lt;custom:scheme!');
  });

  test('treats angle-bracket comparisons as prose', () => {
    const html = renderInline('Use a < b > c < d > e.');

    expect(html).toBe('Use a &lt; b &gt; c &lt; d &gt; e.');
  });

  test('renders adjacent angle autolinks correctly', () => {
    const html = renderInline('See <https://a.com> then <https://b.com>.');

    expect(html).toContain('href="https://a.com"');
    expect(html).toContain('href="https://b.com"');
  });
});

describe('InlineMarkdown math', () => {
  test('renders inline math with KaTeX markup', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Area is $A=\\pi r^2$.' }));
    expect(html).toContain('katex');
    expect(html).toContain('math-inline');
    expect(html).toContain('mord mathnormal');
  });

  test('does not render escaped dollar-delimited text as math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Price is \\$5$ today' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$5$ today');
  });

  test('does not treat spaced dollar text as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Keep $ not math $ here' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$ not math $ here');
  });

  test('renders spaced dollar-delimited TeX as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: '$ \\varepsilon \\sim \\mathcal{N}(0,\\sigma^2) $' }));
    expect(html).toContain('katex');
    expect(html).toContain('math-inline');
    expect(html).toContain('data-math-tex="\\varepsilon \\sim \\mathcal{N}(0,\\sigma^2)"');
  });

  test('renders spaced single-variable dollar math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Target is $ y $.' }));
    expect(html).toContain('katex');
    expect(html).toContain('data-math-tex="y"');
  });

  test('does not treat spaced numeric dollar text as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Price is $ 5 $ today' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$ 5 $ today');
  });

  test('renders parenthesized inline math with KaTeX markup', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Area is \\(A=\\pi r^2\\).' }));
    expect(html).toContain('katex');
    expect(html).toContain('math-inline');
    expect(html).toContain('mord mathnormal');
  });

  test('leaves double-dollar text to the block parser', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: '$$x$$' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$$x$$');
  });

  test('does not render a dollar-amount range as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'This costs $5-$10 depending on tier.' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$5-$10 depending on tier.');
  });

  test('does not render comma-separated dollar amounts as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Budget: $50,000-$100,000 this year.' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$50,000-$100,000 this year.');
  });

  test('does not render per-unit dollar prices spanning prose as inline math', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Tier A is $5/mo and tier B is $10/mo.' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('$5/mo and tier B is $10/mo.');
  });

  test('still renders a leading-digit formula not abutting a later amount', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Coefficient $2x + 1$ grows.' }));
    expect(html).toContain('katex');
    expect(html).toContain('data-math-tex="2x + 1"');
  });
});
