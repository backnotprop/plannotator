/**
 * GFM's extended autolinks (`www.` and e-mail addresses) and HTML character
 * references in prose, as InlineMarkdown draws them: links only where GFM
 * makes them, never in code or inside another link, never with a scheme
 * other than https or mailto, and hostile text stays text.
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineMarkdown } from './InlineMarkdown';
import { decodeHtmlEntities, matchEmailAutolink, matchWwwAutolink, trimAutolinkTail } from '../utils/inlineAutolinks';

const render = (text: string): string => renderToStaticMarkup(createElement(InlineMarkdown, { text }));
const hrefs = (html: string): string[] => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const textOf = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

describe('www. autolinks', () => {
  test('a www. address links over https, trailing punctuation outside', () => {
    const html = render('Visit www.example.org, then www.example.com/docs.');
    expect(hrefs(html)).toEqual(['https://www.example.org', 'https://www.example.com/docs']);
    expect(textOf(html)).toBe('Visit www.example.org, then www.example.com/docs.');
  });

  test('parentheses: a balanced pair stays, the closing one of the sentence does not', () => {
    expect(hrefs(render('(see www.example.com/wiki/Foo_(bar))'))).toEqual(['https://www.example.com/wiki/Foo_(bar)']);
    expect(hrefs(render('(www.example.com)'))).toEqual(['https://www.example.com']);
  });

  test('an address holding _, @ or # is linked whole', () => {
    expect(hrefs(render('at www.example.com/a_b/@c#d now'))).toEqual(['https://www.example.com/a_b/@c#d']);
  });

  test('not linked: inside code, inside a link or its label, mid-word, or without a dot after www.', () => {
    expect(hrefs(render('`www.example.com`'))).toEqual([]);
    expect(hrefs(render('[www.example.com](https://other.example)'))).toEqual(['https://other.example']);
    expect(hrefs(render('https://www.example.com/x'))).toEqual(['https://www.example.com/x']);
    expect(hrefs(render('awww.example.com and www.example'))).toEqual([]);
  });

  test('matchWwwAutolink and trimAutolinkTail follow GFM', () => {
    expect(matchWwwAutolink('www.commonmark.org/he<lp')).toBe('www.commonmark.org/he');
    expect(matchWwwAutolink('www.a_b.cd.com')).toBe('www.a_b.cd.com');
    expect(matchWwwAutolink('www.a_b.c_d.com')).toBeNull();
    expect(matchWwwAutolink('www.example.c_m')).toBeNull();
    expect(trimAutolinkTail('www.google.com/search?q=commonmark&hl;')).toBe('www.google.com/search?q=commonmark');
    expect(trimAutolinkTail('www.example.com/a)).')).toBe('www.example.com/a');
    expect(trimAutolinkTail('www.example.com/(a)&amp;).')).toBe('www.example.com/(a)');
  });

  test('a link followed by 200 KB of ) or of &a;. pairs is trimmed in one pass, not one recount per character', () => {
    const parens = 'www.a.co' + ')'.repeat(200_000);
    const entities = 'www.a.co' + '&a;.'.repeat(50_000);
    const t0 = performance.now();
    expect(trimAutolinkTail(parens)).toBe('www.a.co');
    expect(trimAutolinkTail(entities)).toBe('www.a.co');
    expect(hrefs(render(`see ${parens}`))).toEqual(['https://www.a.co']);
    // Linear work is a few milliseconds; the old per-character recount took seconds.
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('e-mail autolinks', () => {
  test('a bare address is a mailto link, the sentence period outside', () => {
    const html = render('Mail someone@example.com. Or first.last+tag@mail.example.co.uk');
    expect(hrefs(html)).toEqual(['mailto:someone@example.com', 'mailto:first.last+tag@mail.example.co.uk']);
    expect(textOf(html)).toBe('Mail someone@example.com. Or first.last+tag@mail.example.co.uk');
  });

  test('an address whose local part holds _ is linked whole', () => {
    expect(hrefs(render('ask snake_case@example.com'))).toEqual(['mailto:snake_case@example.com']);
  });

  test('code-ish text is not mail: versions, scp remotes, @mentions, code, file:line', () => {
    for (const text of ['react@18.2.0', '@scope/pkg@1.2.3', 'git@github.com:org/repo.git', 'ping @someone', '`a@example.com`', 'see file.ts:12 and v1.2.3']) {
      expect(hrefs(render(text)).filter((h) => h.startsWith('mailto:'))).toEqual([]);
    }
  });
});

describe('hostile input stays text', () => {
  test('javascript: and friends never become links, typed bare', () => {
    for (const text of ['javascript:alert(1)', 'www.javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:msgbox']) {
      const html = render(text);
      expect(hrefs(html).some((h) => /^(javascript|data|vbscript):/i.test(h))).toBe(false);
      expect(html).not.toContain('<b>');
    }
  });

  test('quotes and angle brackets end a www. link and never reach an attribute or markup', () => {
    const html = render('www.example.com"onmouseover="alert(1) www.example.com/<script>alert(1)</script>');
    expect(hrefs(html)).toEqual(['https://www.example.com', 'https://www.example.com/']);
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<[^>]*onmouseover/i);
  });

  test('an e-mail-looking string with script content links only the address', () => {
    const html = render('x@example.com<script>alert(1)</script> "><img src=x onerror=alert(1)>@evil.com');
    expect(hrefs(html)).toEqual(['mailto:x@example.com']);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
  });
});

describe('HTML character references', () => {
  test('decoded in prose; an unknown name stays as written', () => {
    expect(textOf(render('&copy; 2026 A &amp; B &mdash; &lt;tag&gt; &#8212; &#x1F600; &unknownentity;'))).toBe('© 2026 A & B — <tag> — 😀 &unknownentity;');
  });

  test('literal inside code, and a decoded &lt; is never markup', () => {
    const html = render('`&amp; &copy;` and &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&amp;amp; &amp;copy;');
    expect(html).not.toContain('<script');
    expect(textOf(html)).toBe('&amp; &copy; and <script>alert(1)</script>');
  });

  test('a reference to no character, or to one that is invisible or reorders text, stays as written', () => {
    const hidden = [
      '&#0;', '&#1;', '&#x1F;', '&#x7F;', '&#x85;', '&#9;', '&#10;', // NUL, C0, DEL, C1
      '&#xAD;', '&shy;', '&#x200B;', '&#x200D;', '&zwj;', '&zwnj;', '&#xFEFF;', '&#x2060;', // soft hyphen, zero-width
      '&#x200E;', '&#x200F;', '&#x61C;', '&#x202A;', '&#8238;', '&#x2066;', '&#x2069;', // direction marks, overrides, isolates
      '&#xD800;', '&#xDFFF;', '&#xFDD0;', '&#xFFFE;', '&#x1FFFF;', '&#1114112;', // surrogates, non-characters, past U+10FFFF
    ];
    for (const ref of hidden) {
      expect(decodeHtmlEntities(ref)).toBe(ref);
      expect(textOf(render(`a ${ref} b`))).toBe(`a ${ref} b`);
    }
    // Visible ones still decode, the no-break space included.
    expect(decodeHtmlEntities('&#x41;&#xE9;&nbsp;&#x1F600;')).toBe('A\u00e9\u00a0\u{1F600}');
    expect(textOf(render('a &#8212 b'))).toBe('a &#8212 b');
  });

  test('&#123; is a character, not an issue reference', () => {
    expect(hrefs(renderToStaticMarkup(createElement(InlineMarkdown, { text: 'x &#35;1 &#123; y', githubRepo: 'owner/repo' })))).toEqual([]);
  });
});

test('matchEmailAutolink needs a letter in the last label and no trailing - or _', () => {
  expect(matchEmailAutolink('a@b.co')).toBe('a@b.co');
  expect(matchEmailAutolink('a@b.c')).toBeNull();
  expect(matchEmailAutolink('a@1.2')).toBeNull();
  expect(matchEmailAutolink('a@b.com_')).toBe('a@b.com');
});
