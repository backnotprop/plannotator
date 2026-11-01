import DOMPurify from 'dompurify';
import { Marked, marked } from 'marked';

import { CHAT_SANITIZE_CONFIG } from '../../utils/aiChatFormat';

/** The characters HTML gives meaning to, as text. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The one way out to the DOM. DOMPurify hands its input back untouched where it
 * cannot run (no real DOM), so there the source goes out as plain text instead.
 * The allowlist is the Ask AI panel's: no scripts, no handlers, no images, so an
 * agent's text cannot load a remote address.
 */
function sanitize(html: string, source: string): string {
  if (!DOMPurify.isSupported) return escapeHtml(source);
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...CHAT_SANITIZE_CONFIG.ALLOWED_TAGS],
    ALLOWED_ATTR: [...CHAT_SANITIZE_CONFIG.ALLOWED_ATTR],
  });
}

/** An agent's text as sanitized HTML. */
export function chatMarkdownHtml(markdown: string): string {
  return sanitize(marked.parse(markdown, { async: false, gfm: true, breaks: false }), markdown);
}

/** `marked` hands every raw HTML token to the `html` renderer; this one writes
 * it back as escaped text. */
const personMarkdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

/** The markdown step of {@link personMarkdownHtml}, before sanitizing. */
export function personMarkdownToHtml(markdown: string): string {
  return personMarkdown.parse(markdown, { async: false });
}

/** A person's message: markdown, but HTML they typed stays the literal text
 * they typed. The sanitizer still runs after, as for every message. */
export function personMarkdownHtml(markdown: string): string {
  return sanitize(personMarkdownToHtml(markdown), markdown);
}
