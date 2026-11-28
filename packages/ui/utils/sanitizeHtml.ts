import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { parseAuthorColor, parseColorStyle, type AuthorColor } from './authorColor';

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
  'open', // preserve <details open> default-expanded state
  // <video>/<source> — deliberately no `autoplay`, so embedded clips don't play
  // on their own when a comment/description scrolls into view.
  'controls', 'poster', 'muted', 'loop', 'playsinline', 'type',
  // <picture>/<source> and responsive <img> — without these the alternate-format
  // selection is inert and <source> renders as a no-op.
  'srcset', 'media', 'sizes',
];

type Purifier = typeof DOMPurify;

/** The colour each `<span style>` / `<font color>` of a pass carries, read before DOMPurify drops the attribute. */
const authorColors = new WeakMap<Node, AuthorColor>();
let purifier: Purifier | null = null;

/**
 * A private instance (a hook on the shared one would reach every other
 * caller) that keeps an author's text colour and nothing else of a style.
 * `style` stays off the allowlist, so DOMPurify removes every author style;
 * the hooks read the colour first and write back `color: <value>` built from
 * the parsed value. `<font>` is let in only to be read: `toHtml` turns each
 * into a `<span>`, so no `<font>` reaches the page.
 */
function purify(): Purifier | null {
  if (purifier) return purifier;
  if (typeof window === 'undefined') return null;
  purifier = DOMPurify(window);
  purifier.addHook('uponSanitizeAttribute', (node, data) => {
    const color =
      node.nodeName === 'SPAN' && data.attrName === 'style' ? parseColorStyle(data.attrValue)
        : node.nodeName === 'FONT' && data.attrName === 'color' ? parseAuthorColor(data.attrValue)
          : null;
    if (color) authorColors.set(node, color);
  });
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const color = node.nodeName === 'SPAN' ? authorColors.get(node) : undefined;
    if (color) node.setAttribute('style', `color: ${color.css}`);
  });
  return purifier;
}

const PURIFY_CONFIG = { ALLOWED_TAGS: [...ALLOWED_TAGS, 'font'], ALLOWED_ATTR };

function toHtml(fragment: DocumentFragment): string {
  // Innermost first, so a font inside a font is already a span when its parent moves.
  for (const font of Array.from(fragment.querySelectorAll('font')).reverse()) {
    const color = authorColors.get(font);
    if (!color) {
      font.replaceWith(...Array.from(font.childNodes));
      continue;
    }
    const span = font.ownerDocument.createElement('span');
    span.setAttribute('style', `color: ${color.css}`);
    span.append(...Array.from(font.childNodes));
    font.replaceWith(span);
  }
  const holder = fragment.ownerDocument.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}

function sanitize(html: string): string {
  const p = purify();
  if (!p) return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
  return toHtml(p.sanitize(html, { ...PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true }));
}

/**
 * Render and sanitize the content of a raw HTML block for injection via
 * innerHTML. Content is first run through `marked` so that markdown nested
 * between HTML tags (e.g. `**bun**` inside `<details>…</details>`) renders
 * as real `<strong>`, matching GitHub's flavored behavior. Then DOMPurify
 * strips anything outside the allowlist — no event handlers, no scripts, no
 * inline style but an author's text colour (`authorColor.ts`).
 */
export function sanitizeBlockHtml(html: string): string {
  const rendered = marked.parse(html, { async: false, gfm: true, breaks: false }) as string;
  return sanitize(rendered);
}

/**
 * Sanitize inline HTML that is already HTML (no markdown pass) — same allowlist
 * as {@link sanitizeBlockHtml}. Used for inline GitHub content (e.g. PR comment
 * spans) so the allowlist lives in exactly one place.
 */
export function sanitizeInlineHtml(html: string): string {
  return sanitize(html);
}

/**
 * Whether sanitized markup draws nothing: no text but white space, and no
 * image, video, picture, rule or table. A raw HTML block the sanitizer
 * emptied (`<iframe …></iframe>`, `<div><script>…</script></div>`) is then
 * not drawn at all, so it leaves no empty gap in the document. Without a DOM
 * (server render) it answers false.
 */
export function sanitizedHtmlDrawsNothing(sanitized: string): boolean {
  if (typeof document === 'undefined') return false;
  if (!sanitized.trim()) return true;
  const known = drawsNothingCache.get(sanitized);
  if (known !== undefined) return known;
  const template = document.createElement('template');
  template.innerHTML = sanitized;
  const content = template.content;
  const answer = !(content.textContent ?? '').trim() && !content.querySelector('img, video, picture, hr, table');
  // One parse per distinct block, not per mount or per keystroke elsewhere in the document.
  if (drawsNothingCache.size >= DRAWS_NOTHING_CACHE_MAX) drawsNothingCache.delete(drawsNothingCache.keys().next().value!);
  drawsNothingCache.set(sanitized, answer);
  return answer;
}

const DRAWS_NOTHING_CACHE_MAX = 500;
const drawsNothingCache = new Map<string, boolean>();
