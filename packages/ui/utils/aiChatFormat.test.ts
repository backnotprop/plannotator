/**
 * Ask AI answer rendering: the sanitizer allowlist against what marked writes.
 *
 * What regresses if these fail:
 * - an answer's markdown loses its structure: DOMPurify drops every tag or
 *   attribute missing from CHAT_SANITIZE_CONFIG and keeps only the text, which
 *   is how GFM tables rendered as one run-together line (#2069);
 * - the allowlist is widened past markup (scripts, event handlers, styles).
 *
 * No DOM: happy-dom cannot host DOMPurify (see packages/ui/test-setup/
 * diagramSvg.ts), so this checks the allowlist against marked's own output,
 * the step DOMPurify runs on, instead of running DOMPurify.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CHAT_SANITIZE_CONFIG, chatMarkdownToHtml, renderChatMarkdown } from './aiChatFormat';

function tagsIn(html: string): string[] {
  return [...new Set([...html.matchAll(/<([a-z][a-z0-9]*)\b/gi)].map((m) => m[1].toLowerCase()))];
}

function attrsIn(html: string): string[] {
  const attrs = new Set<string>();
  for (const tag of html.matchAll(/<[a-z][a-z0-9]*\b([^>]*)>/gi)) {
    for (const attr of tag[1].matchAll(/([a-z-]+)=/gi)) attrs.add(attr[1].toLowerCase());
  }
  return [...attrs];
}

describe('Ask AI answers keep their markdown structure', () => {
  test('every tag and attribute marked writes for a GFM table is allowed', () => {
    const html = chatMarkdownToHtml(
      [
        '| Option | Cost | Notes |',
        '|:--|--:|:-:|',
        '| `NotificationBus` | low | **reuse** |',
        '| Polling | high | |',
      ].join('\n'),
    );

    const tags = tagsIn(html);
    expect(tags).toEqual(expect.arrayContaining(['table', 'thead', 'tbody', 'tr', 'th', 'td']));
    for (const tag of tags) expect(CHAT_SANITIZE_CONFIG.ALLOWED_TAGS).toContain(tag);
    expect(attrsIn(html)).toContain('align');
    for (const attr of attrsIn(html)) expect(CHAT_SANITIZE_CONFIG.ALLOWED_ATTR).toContain(attr);
  });

  test('allows no script, embed, style or event handler', () => {
    const tags = CHAT_SANITIZE_CONFIG.ALLOWED_TAGS;
    for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'img', 'svg', 'form']) {
      expect(tags).not.toContain(tag);
    }
    for (const attr of CHAT_SANITIZE_CONFIG.ALLOWED_ATTR) {
      expect(attr.startsWith('on')).toBe(false);
      expect(attr).not.toBe('style');
      expect(attr).not.toBe('src');
      expect(attr).not.toBe('class');
    }
    expect(CHAT_SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(false);
    expect(CHAT_SANITIZE_CONFIG.ALLOW_ARIA_ATTR).toBe(false);
  });
});

describe('renderChatMarkdown never throws', () => {
  test('deeply nested input renders as escaped text with its line breaks', () => {
    const text = `${'>'.repeat(20000)} deep\nsecond line`;
    expect(() => chatMarkdownToHtml(text)).toThrow();
    const html = renderToStaticMarkup(renderChatMarkdown(text) as never);
    expect(html).toContain('white-space:pre-wrap');
    expect(html).toContain('&gt;&gt;&gt;');
    expect(html).toContain('deep\nsecond line');
    expect(html).not.toContain('<blockquote');
  });

  test('a script in the fallback stays text', () => {
    const text = `${'>'.repeat(20000)}\n<script>window.x = 1</script>`;
    const html = renderToStaticMarkup(renderChatMarkdown(text) as never);
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });
});
