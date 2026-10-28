/** A link's or image's destination: one level of balanced parentheses, bounded at any other `(`. */
export const INLINE_DESTINATION = String.raw`\((?:[^()]|\([^()]*\))*\)`;
const IMAGE_RE = new RegExp(String.raw`!\[[^\][]*\]` + INLINE_DESTINATION, 'g');
// A link's label may hold one level of balanced brackets (`[a [nested] label](x.html)`), as the
// inline renderer reads it. Each nested pair closes at the next `]`, so the label still stops at
// any other `[`: a run of brackets is read in linear time.
const LINK_RE = new RegExp(String.raw`\[((?:[^\][]|\[[^\][]*\])*)\]` + INLINE_DESTINATION, 'g');

/**
 * Inline markdown's markup taken out, its words kept: images out, link and
 * wiki-link labels kept, HTML tags out (kept with `keepTags`: a choice label
 * the card draws as `Array<string>`). Emphasis and code marks are left to
 * the caller (the Inbox's `cleanInline` protects code spans and escapes around
 * this; the question parser's `normalizeQuestionText` drops the marks).
 *
 * Imports nothing, so core/question-block and core/inbox-folding can both use
 * it with no cycle (Pi vendors it beside question-block: apps/pi-extension/vendor.sh).
 *
 * Every pattern stops at the next opener (`[`, `<`; a link's destination at
 * a `(` it does not close; a link label at a `[` past its one nested pair),
 * so a label of thousands of `[`, `[[`, `![` or `<a` is read in linear time,
 * not scanned to the end from each one. A link's or image's destination may
 * hold one level of balanced parentheses
 * (`[Foo](https://en.wikipedia.org/wiki/Foo_(bar))`, `[page](app/(shop)/page.tsx)`),
 * and a link's label one level of balanced brackets (`[a [nested] label](x.html)`).
 */
export function stripInlineMarkup(text: string, options: { keepTags?: boolean } = {}): string {
  const out = text
    .replace(IMAGE_RE, '')
    .replace(LINK_RE, '$1')
    .replace(/\[\[([^\][|]*)(?:\|([^\][]*))?\]\]/g, (_m, target: string, label?: string) => label ?? target);
  return options.keepTags ? out : out.replace(/<\/?[A-Za-z][^<>]*>/g, '');
}
