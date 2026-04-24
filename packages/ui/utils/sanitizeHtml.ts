import DOMPurify from 'dompurify';
import { marked } from 'marked';

const ALLOWED_TAGS = [
  'sub', 'sup', 'b', 'i', 'em', 'strong', 'br', 'hr', 'p', 'span',
  'del', 'ins', 'mark', 'small', 'abbr', 'kbd', 'var', 'samp',
  'details', 'summary', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'img', 'div', 'section', 'article', 'aside', 'header', 'footer',
];

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'rel', 'target', 'width', 'height', 'align',
  'open', // preserve <details open> default-expanded state
];

/**
 * Render and sanitize the content of a raw HTML block for injection via
 * innerHTML. Content is first run through `marked` so that markdown nested
 * between HTML tags (e.g. `**bun**` inside `<details>…</details>`) renders
 * as real `<strong>`, matching GitHub's flavored behavior. Then DOMPurify
 * strips anything outside the allowlist — no event handlers, no inline
 * styles, no scripts.
 */
export function sanitizeBlockHtml(html: string): string {
  const rendered = marked.parse(html, { async: false, gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(rendered, { ALLOWED_TAGS, ALLOWED_ATTR });
}
