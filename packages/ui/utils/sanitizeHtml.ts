import DOMPurify from 'dompurify';
import { marked } from 'marked';

const ALLOWED_TAGS = [
  'sub', 'sup', 'b', 'i', 'em', 'strong', 'br', 'hr', 'p', 'span',
  'del', 'ins', 'mark', 'small', 'abbr', 'kbd', 'var', 'samp',
  'details', 'summary', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'img', 'div', 'section', 'article', 'aside', 'header', 'footer',
  'video', 'source', 'picture',
];

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'rel', 'target', 'width', 'height', 'align',
  'open',
  'controls', 'poster', 'muted', 'loop', 'playsinline', 'type',
  'srcset', 'media', 'sizes',
];

export function sanitizeBlockHtml(html: string): string {
  const rendered = marked.parse(html, { async: false, gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(rendered, { ALLOWED_TAGS, ALLOWED_ATTR });
}

export function sanitizeInlineHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}
