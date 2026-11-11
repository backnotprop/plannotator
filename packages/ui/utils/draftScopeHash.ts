/**
 * FNV-1a over the text, with its length, so two different targets that share a name never share
 * a kept draft.
 */
export function hashDraftScope(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}.${text.length.toString(36)}`;
}
