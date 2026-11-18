/**
 * Footnote references and the notes list as RenderedMarkdown (the shared
 * BlockRenderer path) draws them: a reference to a defined note is a
 * superscript link, anything else stays literal, each document's ids are its
 * own, and hostile labels never become markup.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RenderedMarkdown } from '../RenderedMarkdown';
import { InlineMarkdown } from '../InlineMarkdown';

const render = (markdown: string): string => renderToStaticMarkup(createElement(RenderedMarkdown, { markdown }));
const refs = (html: string) =>
  [...html.matchAll(/<sup class="pn-footnote-ref"><a href="#([^"]+)" role="doc-noteref" aria-label="Footnote (\d+)" data-footnote-ref="([^"]*)"[^>]*>(\d+)<\/a><\/sup>/g)]
    .map((m) => ({ target: m[1], number: m[2], label: m[3], shown: m[4] }));
const noteIds = (html: string) => [...html.matchAll(/<li id="([^"]+)" value="(\d+)"/g)].map((m) => [m[1], m[2]]);

describe('footnotes', () => {
  const DOC = 'A claim.[^1] A named one[^Note] and the first again.[^1] Undefined: [^missing]. Code: `[^1]`.\n\n[^1]: First note.\n[^note]: Named **note**.';

  test('references are superscript links to the notes, numbered by first use; undefined and code stay literal', () => {
    const html = render(DOC);
    const found = refs(html);
    expect(found.map((r) => [r.number, r.label])).toEqual([['1', '1'], ['2', 'Note'], ['1', '1']]);
    const ids = noteIds(html);
    expect(ids.map(([, n]) => n)).toEqual(['1', '2']);
    // Every reference points at a note that exists.
    for (const r of found) expect(ids.some(([id]) => id === r.target)).toBe(true);
    expect(html).toContain('Undefined: [^missing].');
    expect(html).toContain('<code class="px-1.5 py-0.5 rounded bg-muted text-sm font-mono">[^1]</code>');
    // The definitions are not drawn in the flow, only in the list.
    expect(html).not.toContain('[^1]: First note.');
    expect(html).toContain('role="doc-endnotes"');
    expect((html.match(/role="doc-backlink"/g) ?? []).length).toBe(2);
  });

  test('two documents on one page never share an id', () => {
    const html = renderToStaticMarkup(createElement('div', null, createElement(RenderedMarkdown, { markdown: DOC }), createElement(RenderedMarkdown, { markdown: DOC })));
    const ids = noteIds(html).map(([id]) => id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  test('a document without a definition renders exactly as without footnote support', () => {
    const md = 'Text with [^1] and www-less words.\n\n- item [^x]';
    const html = render(md);
    expect(html).not.toContain('doc-endnotes');
    expect(html).not.toContain('<sup');
    expect(html).toContain('Text with [^1] and');
  });

  test('without a document scope (InlineMarkdown alone) a reference stays literal', () => {
    expect(renderToStaticMarkup(createElement(InlineMarkdown, { text: 'A[^1]' }))).toBe('A[^1]');
  });

  test('a hostile label is text and an attribute value, never markup', () => {
    const md = 'X[^"><img src=x onerror=alert(1)>] Y[^<script>alert(1)</script>] Z[^a"b\'c]\n\n[^"><img src=x onerror=alert(1)>]: one\n[^<script>alert(1)</script>]: two\n[^a"b\'c]: three';
    const html = render(md);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<[^>]* onerror=/);
    const found = refs(html);
    // A label with white space is no label: that one stays text.
    expect(found.map((r) => r.label)).toEqual(['&lt;script&gt;alert(1)&lt;/script&gt;', 'a&quot;b&#x27;c']);
  });
});
