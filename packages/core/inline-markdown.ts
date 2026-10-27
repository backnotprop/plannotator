/** A link's or image's destination: one level of balanced parentheses, bounded at any other `(`. */
const DESTINATION = String.raw`\((?:[^()]|\([^()]*\))*\)`;
const IMAGE_RE = new RegExp(String.raw`!\[[^\][]*\]` + DESTINATION, 'g');
const LINK_RE = new RegExp(String.raw`\[([^\][]*)\]` + DESTINATION, 'g');

/**
 * Inline markdown's markup taken out, its words kept: images out, link and
 * wiki-link labels kept, HTML tags out. Emphasis and code marks are left to
 * the caller (the Inbox's `cleanInline` protects code spans around this; the
 * question parser's `normalizeQuestionText` drops the marks).
 *
 * Imports nothing, so core/question-block and core/inbox-folding can both use
 * it with no cycle (Pi vendors it beside question-block: apps/pi-extension/vendor.sh).
 *
 * Every pattern stops at the next opener (`[`, `<`; a link's destination at
 * a `(` it does not close), so a label of thousands of `[`, `[[`, `![` or
 * `<a` is read in linear time, not scanned to the end from each one. A link's
 * or image's destination may hold one level of balanced parentheses
 * (`[Foo](https://en.wikipedia.org/wiki/Foo_(bar))`, `[page](app/(shop)/page.tsx)`).
 * Nested brackets in a label never match.
 */
export function stripInlineMarkup(text: string): string {
  return text
    .replace(IMAGE_RE, '')
    .replace(LINK_RE, '$1')
    .replace(/\[\[([^\][|]*)(?:\|([^\][]*))?\]\]/g, (_m, target: string, label?: string) => label ?? target)
    .replace(/<\/?[A-Za-z][^<>]*>/g, '');
}
