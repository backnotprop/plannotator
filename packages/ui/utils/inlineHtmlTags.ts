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
 * unclosed tags stays bounded; same-name tags nest, and the search stops at a
 * code span, so a close tag shown in backticks never closes anything.
 */
import { DROPPED_HTML_BLOCK_TAGS, HTML_BLOCK_OPEN_RE, isHtmlTagSpelling } from '@plannotator/core/markdown-structure';

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

/** Where a code span starting at `at` (a run of backticks) ends, or -1 when the run has no closing run (it is text). */
function codeSpanEnd(text: string, at: number, limit: number): number {
  let n = 0;
  while (text[at + n] === '`') n++;
  for (let i = at + n; i < limit; ) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let m = 0;
    while (text[i + m] === '`') m++;
    if (m === n) return i + m;
    i += m;
  }
  return -1;
}

/**
 * The close tag that ends the `name` element opened just before `from`: same-name tags nest (each opener
 * needs its own close), and the search never enters or passes a code span (`</script>` written in backticks
 * is shown, not markup). Null when there is none within MAX_ELEMENT_CHARS.
 */
function closeAfter(text: string, from: number, name: string): { at: number; length: number } | null {
  const limit = Math.min(text.length, from + MAX_ELEMENT_CHARS);
  const tagRe = new RegExp(`^<(/?)${name}(?=[\\s/>])(?:\\s(?:[^>"']|"[^"]*"|'[^']*')*)?(/?)>`, 'i');
  let depth = 1;
  for (let i = from; i < limit; i++) {
    const ch = text[i];
    if (ch === '`') {
      if (codeSpanEnd(text, i, limit) !== -1) return null;
      while (text[i + 1] === '`') i++;
      continue;
    }
    if (ch !== '<') continue;
    const tag = tagRe.exec(text.slice(i, Math.min(limit, i + 512)));
    if (!tag) continue;
    if (tag[1]) {
      depth--;
      if (depth === 0) return { at: i, length: tag[0].length };
    } else if (!tag[2]) {
      depth++;
    }
    i += tag[0].length - 1;
  }
  return null;
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

/**
 * Whether an HTML block opens with a tag the sanitizer drops (`<iframe …>`, `<script>`): before these were
 * HTML blocks, the line printed as a paragraph of text.
 */
export function opensDroppedHtmlTag(content: string): boolean {
  const tag = HTML_BLOCK_OPEN_RE.exec(content.trim())?.[1];
  return tag !== undefined && DROPPED_HTML_BLOCK_TAGS.has(tag.toLowerCase()) && isHtmlTagSpelling(tag);
}

const TAG_OPEN_RE = /<([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])/g;

/** Whether `source` holds a tag the sanitizer drops (`<iframe`, `<SCRIPT`), spelled as HTML spells it. */
export function holdsDroppedHtmlTag(source: string): boolean {
  for (const match of source.matchAll(TAG_OPEN_RE)) {
    if (DROPPED_HTML_BLOCK_TAGS.has(match[1]!.toLowerCase()) && isHtmlTagSpelling(match[1]!)) return true;
  }
  return false;
}

/**
 * Whether a paragraph's text is nothing but raw HTML the sanitizer drops (and white space): such a
 * paragraph is drawn hidden, so it leaves no gap, and it stays a `<p>` so the page's paragraphs keep
 * their numbers (a comment saved when it printed as text still finds its place).
 */
export function inlineHtmlDrawsNothing(text: string): boolean {
  let i = 0;
  let dropped = false;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) {
      i++;
      continue;
    }
    // A closed HTML comment draws nothing (InlineMarkdown skips it first); alone it is not dropped HTML.
    const comment = text.startsWith('<!--', i) ? /^<!--[\s\S]*?-->/.exec(text.slice(i)) : null;
    if (comment) {
      i += comment[0].length;
      continue;
    }
    const match = text[i] === '<' ? matchInlineHtml(text.slice(i)) : null;
    if (!match) return false;
    if (match.kind === 'element') return false;
    if (match.kind === 'unwrap' && !inlineHtmlDrawsNothing(match.inner) && match.inner.trim() !== '') return false;
    dropped = true;
    i += match.length;
  }
  return dropped;
}
