/** A link's or image's destination: one level of balanced parentheses, bounded at any other `(`. */
export const INLINE_DESTINATION = String.raw`\((?:[^()]|\([^()]*\))*\)`;
const IMAGE_RE = new RegExp(String.raw`!\[[^\][]*\]` + INLINE_DESTINATION, 'g');
const LINK_RE = new RegExp(String.raw`\[((?:[^\][]|\[[^\][]*\])*)\]` + INLINE_DESTINATION, 'g');

export function stripInlineMarkup(text: string, options: { keepTags?: boolean } = {}): string {
  const out = text
    .replace(IMAGE_RE, '')
    .replace(LINK_RE, '$1')
    .replace(/\[\[([^\][|]*)(?:\|([^\][]*))?\]\]/g, (_m, target: string, label?: string) => label ?? target);
  return options.keepTags ? out : out.replace(/<\/?[A-Za-z][^<>]*>/g, '');
}
