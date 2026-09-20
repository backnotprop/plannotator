/**
 * Compound-token stitching for the diff's syntax-highlighted token spans.
 *
 * Shiki can fragment one identifier across several spans, and Pierre's token
 * transformer stamps each span with `data-char` — the zero-based column of the
 * span's first character within its line. Adjacent spans whose offsets are
 * contiguous are therefore provably the same run of source text, which is what
 * lets this walk rebuild `withRetry` from `with` + `Retry` without guessing.
 *
 * It deliberately does NOT join across `.` or `::`: code-nav searches with
 * `--word-regexp`, where a dotted path matches nothing, so the segment is the
 * searchable unit. The punctuation span fails the fragment test and the walk
 * stops there on its own.
 *
 * Returning null means "no hover": this filter is the first-line cost control,
 * so punctuation, operators, keywords and one-character names never reach the
 * wire.
 */

/** A single span's text: word characters only, no leading-character rule — a
 *  fragment may legitimately start mid-identifier (`2bar` of `foo2bar`). */
const FRAGMENT = /^[\w$]+$/;

/** What the whole stitched run must look like to be worth searching for. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const MIN_SYMBOL_LENGTH = 2;

/**
 * Language keywords are never symbols worth resolving, and they are the most
 * frequently hovered tokens in any diff. Small and generic on purpose: a
 * per-language list would have to be kept in step with the highlighter.
 */
const KEYWORD_STOPLIST = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'import', 'export', 'from', 'class', 'new', 'type', 'interface', 'async',
  'await', 'pub', 'fn', 'def', 'self', 'this',
]);

function readCharOffset(element: Element | null): number | null {
  const raw = element?.getAttribute('data-char');
  if (raw == null) return null;
  const offset = Number.parseInt(raw, 10);
  return Number.isNaN(offset) ? null : offset;
}

export interface StitchedToken {
  symbol: string;
  /** Column of the stitched run's first character within its line. */
  charStart: number;
}

export function stitchTokenIdentifier(
  tokenElement: HTMLElement,
): StitchedToken | null {
  const charStart = readCharOffset(tokenElement);
  if (charStart == null) return null;

  const text = tokenElement.textContent ?? '';
  if (!FRAGMENT.test(text)) return null;

  let symbol = text;
  let start = charStart;
  let end = charStart + text.length;

  for (
    let sibling = tokenElement.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    const offset = readCharOffset(sibling);
    const siblingText = sibling.textContent ?? '';
    if (offset == null || !FRAGMENT.test(siblingText)) break;
    if (offset + siblingText.length !== start) break;
    symbol = siblingText + symbol;
    start = offset;
  }

  for (
    let sibling = tokenElement.nextElementSibling;
    sibling;
    sibling = sibling.nextElementSibling
  ) {
    const offset = readCharOffset(sibling);
    const siblingText = sibling.textContent ?? '';
    if (offset == null || !FRAGMENT.test(siblingText)) break;
    if (offset !== end) break;
    symbol += siblingText;
    end = offset + siblingText.length;
  }

  if (!IDENTIFIER.test(symbol)) return null;
  if (symbol.length < MIN_SYMBOL_LENGTH) return null;
  if (KEYWORD_STOPLIST.has(symbol)) return null;

  return { symbol, charStart: start };
}
