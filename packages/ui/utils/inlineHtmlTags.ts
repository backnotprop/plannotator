/**
 * Raw HTML tags inside a line of text (InlineMarkdown), read the way the block
 * sanitizer (utils/sanitizeHtml) would treat them, without ever handing markup
 * to the page: what renders is React elements and text.
 *
 * - `<sub>`, `<sup>`, `<kbd>`, `<mark>` with their close tag draw as those
 *   elements, their content as markdown (all four are on the sanitizer's
 *   allow-list). `<mark>` draws as a `<span data-html-mark>`: the annotation
 *   highlighter paints comments with `<mark>`, and web-highlighter numbers
 *   parents by tag, so an author's `<mark>` would renumber with every comment.
 * - A tag the sanitizer drops (DROPPED_HTML_BLOCK_TAGS: `iframe`, `script`,
 *   `form`, `svg`…) is dropped. Its content goes too where the sanitizer drops
 *   it (`script`, `style`, `iframe`, `svg`…: code, never prose); elsewhere its
 *   words stay (`<form>…<button>Go</button></form>` keeps "Go", an `<object>`
 *   keeps its fallback link).
 * - A bare mention in prose stays text: `<iframe>` with no attributes and no
 *   close tag after it ("replace the <iframe> with a <video>") is a word, not
 *   markup. So is a tag name that merely starts like one (`<scriptless>`), and
 *   anything inside a code span (InlineMarkdown never reaches it), and a
 *   capitalised component name (`<Button>`, `<Form>`) as MDX and JSX write it.
 *
 * The close tag is looked for within MAX_ELEMENT_CHARS, so a long run of
 * unclosed tags stays linear.
 */
import { DROPPED_HTML_BLOCK_TAGS, isHtmlTagSpelling } from '@plannotator/core/markdown-structure';

export type InlineHtmlElement = 'sub' | 'sup' | 'kbd' | 'mark';

const ELEMENTS: ReadonlySet<string> = new Set<InlineHtmlElement>(['sub', 'sup', 'kbd', 'mark']);

/**
 * Dropped tags whose content the sanitizer (DOMPurify's default FORBID_CONTENTS)
 * drops with them. Every other dropped tag keeps its words, as a block does:
 * a `<button>`'s label, an `<object>`'s or `<canvas>`'s fallback, a
 * `<textarea>`'s or `<select>`'s text.
 */
const CONTENT_DROPPED: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'svg', 'math']);

const MAX_ELEMENT_CHARS = 5000;

/** An opening or closing tag at the start of the text: 1 slash, 2 name, 3 attributes, 4 self-closing slash. */
const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?)(\/?)>/;

export type InlineHtmlMatch =
  /** Draw `tag` around `inner` (markdown). */
  | { kind: 'element'; tag: InlineHtmlElement; inner: string; length: number }
  /** Draw `inner` (markdown) without the tags around it. */
  | { kind: 'unwrap'; inner: string; length: number }
  /** Draw nothing for these characters. */
  | { kind: 'drop'; length: number };

function closeAfter(text: string, from: number, name: string): { at: number; length: number } | null {
  const close = new RegExp(`</${name}\\s*>`, 'i').exec(text.slice(from, from + MAX_ELEMENT_CHARS));
  return close ? { at: from + close.index, length: close[0].length } : null;
}

/** What the raw HTML at the start of `text` draws as, or null when it is text. */
export function matchInlineHtml(text: string): InlineHtmlMatch | null {
  if (text[0] !== '<') return null;
  const tag = TAG_RE.exec(text);
  if (!tag) return null;
  const [whole, slash, rawName, attributes, selfClosing] = tag;
  const name = rawName!.toLowerCase();
  // A capitalised name (`<Button>`, `<Kbd>`) is an MDX or JSX component: text, as before.
  if (slash || !isHtmlTagSpelling(rawName!)) return null;
  if (ELEMENTS.has(name)) {
    if (selfClosing) return null;
    const close = closeAfter(text, whole!.length, name);
    if (!close) return null;
    return { kind: 'element', tag: name as InlineHtmlElement, inner: text.slice(whole!.length, close.at), length: close.at + close.length };
  }
  if (!DROPPED_HTML_BLOCK_TAGS.has(name)) return null;
  const close = selfClosing ? null : closeAfter(text, whole!.length, name);
  if (close) {
    return CONTENT_DROPPED.has(name)
      ? { kind: 'drop', length: close.at + close.length }
      : { kind: 'unwrap', inner: text.slice(whole!.length, close.at), length: close.at + close.length };
  }
  // No close: markup only when it is written as markup (attributes, or `/>`).
  return attributes!.trim() || selfClosing ? { kind: 'drop', length: whole!.length } : null;
}
